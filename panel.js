import {
  BACK_TRANSLATION_MODES,
  DEFAULT_PROVIDER,
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  clone,
  clampInteger,
  isCurrentDraftSend,
  isEnglishRevisionCurrent,
  isClaudeUrl,
  normalizeBackTranslationMode,
  normalizeText,
  randomId,
  sleep,
  targetContextMatches,
  timestampLabel
} from "./lib/shared.js";
import {
  clearSecrets,
  getSecretForProvider,
  hardenStorageAccess,
  loadDraftState,
  loadSettings,
  normalizeStoredProvider,
  normalizeStoredSettings,
  normalizeStoredDraft,
  providerCredentialBinding,
  saveActiveDraft,
  saveBehaviorSettings,
  saveDiagnostics,
  saveHistory,
  saveConfiguration,
  secretRecordMetadata
} from "./lib/storage.js";
import {
  applyReasoning,
  normalizeReasoning,
  reasoningDialectsForTransport
} from "./lib/reasoning.js";
import {
  buildHeaders,
  ensureProviderPermission,
  filterLikelyTextModels,
  listModels,
  normalizeBaseUrl,
  normalizedApiProtocol,
  permissionPatternForBaseUrl,
  ProviderError,
  sanitizeExtraHeaders
} from "./lib/provider.js";
import {
  backTranslate,
  testTranslationConnection,
  translateDraft,
  TranslationValidationError
} from "./lib/translator.js";

const $ = (selector) => document.querySelector(selector);
const MAX_SOURCE_CODEPOINTS = 50_000;

function codePointLength(value, stopAfter = Number.POSITIVE_INFINITY) {
  let count = 0;
  for (const _point of String(value ?? "")) {
    count += 1;
    if (count > stopAfter) return count;
  }
  return count;
}
const ui = {
  providerSummary: $("#providerSummary"),
  targetDot: $("#targetDot"),
  targetLabel: $("#targetLabel"),
  targetDetail: $("#targetDetail"),
  bindButton: $("#bindButton"),
  statusBar: $("#statusBar"),
  staleBanner: $("#staleBanner"),
  manualBanner: $("#manualBanner"),
  keepManualButton: $("#keepManualButton"),
  regenerateButton: $("#regenerateButton"),
  baselineButton: $("#baselineButton"),
  sourceText: $("#sourceText"),
  sourceCount: $("#sourceCount"),
  automationMode: $("#automationMode"),
  translateButton: $("#translateButton"),
  pauseButton: $("#pauseButton"),
  clearDraftButton: $("#clearDraftButton"),
  longTextHint: $("#longTextHint"),
  correctionSection: $("#correctionSection"),
  correctionList: $("#correctionList"),
  ambiguitySection: $("#ambiguitySection"),
  ambiguityList: $("#ambiguityList"),
  warningSection: $("#warningSection"),
  warningList: $("#warningList"),
  englishText: $("#englishText"),
  syncBadge: $("#syncBadge"),
  syncButton: $("#syncButton"),
  clearTargetButton: $("#clearTargetButton"),
  copyEnglishButton: $("#copyEnglishButton"),
  backText: $("#backText"),
  backBadge: $("#backBadge"),
  backLabel: $("#backLabel"),
  backModeHint: $("#backModeHint"),
  settingsButton: $("#settingsButton"),
  historyButton: $("#historyButton"),
  diagnosticsButton: $("#diagnosticsButton"),
  settingsDialog: $("#settingsDialog"),
  historyDialog: $("#historyDialog"),
  diagnosticsDialog: $("#diagnosticsDialog"),
  settingsForm: $("#settingsForm"),
  providerPreset: $("#providerPreset"),
  providerName: $("#providerName"),
  baseUrl: $("#baseUrl"),
  apiProtocol: $("#apiProtocol"),
  reasoningMode: $("#reasoningMode"),
  reasoningDialect: $("#reasoningDialect"),
  reasoningEffort: $("#reasoningEffort"),
  reasoningDetails: $("#reasoningDetails"),
  reasoningPreview: $("#reasoningPreview"),
  authHeader: $("#authHeader"),
  authPrefix: $("#authPrefix"),
  apiKey: $("#apiKey"),
  keyStorage: $("#keyStorage"),
  extraHeaders: $("#extraHeaders"),
  detectModelsButton: $("#detectModelsButton"),
  showAllModels: $("#showAllModels"),
  modelList: $("#modelList"),
  modelTranslate: $("#modelTranslate"),
  backTranslationMode: $("#backTranslationMode"),
  backTranslationModeHelp: $("#backTranslationModeHelp"),
  independentBackSettings: $("#independentBackSettings"),
  modelBackTranslate: $("#modelBackTranslate"),
  testProviderButton: $("#testProviderButton"),
  providerTestResult: $("#providerTestResult"),
  debounceMs: $("#debounceMs"),
  longTextThreshold: $("#longTextThreshold"),
  requestTimeoutMs: $("#requestTimeoutMs"),
  backTranslateDelayMs: $("#backTranslateDelayMs"),
  streamPreview: $("#streamPreview"),
  strictReviewGate: $("#strictReviewGate"),
  allowFocusWrite: $("#allowFocusWrite"),
  protectedTerms: $("#protectedTerms"),
  clearKeyButton: $("#clearKeyButton"),
  historyList: $("#historyList"),
  diagnosticSummary: $("#diagnosticSummary"),
  diagnosticLog: $("#diagnosticLog"),
  refreshDiagnosticButton: $("#refreshDiagnosticButton"),
  manualBindButton: $("#manualBindButton"),
  diagnosticWriteButton: $("#diagnosticWriteButton"),
  diagnosticClearButton: $("#diagnosticClearButton")
};

function createEmptyDraft() {
  return {
    id: randomId("draft"),
    source: "",
    english: "",
    backTranslation: "",
    backTranslationKind: "",
    corrections: [],
    ambiguities: [],
    warnings: [],
    sourceRevision: 0,
    englishSourceRevision: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastSyncedAt: null,
    lastSyncedEnglish: "",
    providerName: "",
    model: ""
  };
}

function normalizeDraft(value) {
  const base = createEmptyDraft();
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  const normalized = normalizeStoredDraft(value);
  return {
    ...base,
    ...normalized,
    id: normalized.id || base.id,
    // v0.1.x always generated back translations through a second request.
    backTranslationKind: normalized.backTranslationKind
      || (normalized.backTranslation ? "independent" : "")
  };
}

const state = {
  settings: clone(DEFAULT_SETTINGS),
  provider: clone(DEFAULT_PROVIDER),
  draft: createEmptyDraft(),
  history: [],
  diagnostics: [],
  draftScope: "window-default",
  detectedModels: [],
  formCapabilitySignature: null,
  formCapabilities: null,
  // Snapshot of the capabilities as they exist in storage. Runtime learning
  // mutates state.provider.capabilities in-memory only; an ordinary settings
  // save must persist this snapshot, not the runtime-mutated values — only an
  // explicit connection test (formCapabilities) may persist new learning.
  persistedCapabilitySignature: null,
  persistedCapabilities: null,
  formRequestEpoch: 0,
  formController: null,
  translationCache: new Map(),
  sourceRevision: 0,
  composing: false,
  paused: false,
  // True only when the CURRENT pause was caused by a recoverable target loss
  // (writer port died: page reload / MV3 restart), not by the user. A
  // successful automatic re-bind then resumes without a manual 恢复 click.
  pausedByTargetLoss: false,
  // Why the CURRENT pause exists — decides how it may end:
  //   "user"     Esc / 暂停 button: only the explicit 恢复 button resumes.
  //   "review"   manual-edit banner shown: its own buttons resolve it.
  //   "incident" interrupted/unverified write: 恢复 or a user-clicked 定位.
  //   "system"   everything else (session switch, external clear, uncertain
  //              send, kept manual text…): self-heals on the next semantic
  //              source edit or a successful re-bind — no 恢复 click needed.
  pauseKind: null,
  // Set while a user-clicked 定位 is pending so its BOUND may also clear an
  // "incident" pause (the click itself is the human acknowledgement).
  userBindRequested: false,
  manualText: "",
  lastInputAt: 0,
  literalFragments: new Set(),
  statusText: "准备就绪",
  translatePhase: "idle",
  backPhase: "idle",
  targetPhase: "unbound",
  providerPhase: "ready",
  providerEpoch: 0,
  operationEpoch: 0,
  cooldownUntil: 0,
  target: {
    bound: false,
    tabId: null,
    windowId: null,
    active: false,
    connected: false,
    composerReady: false,
    writerSession: null,
    targetEpoch: 0,
    pluginOwned: false,
    strategy: null,
    requiresFocusWrite: false,
    currentText: ""
  },
  panelPort: null,
  panelReconnectTimer: null,
  bindRetryTimer: null,
  bindRetryCount: 0,
  bindRequestId: null,
  closing: false,
  pendingRequests: new Map(),
  debounceTimer: null,
  persistTimer: null,
  settingsSaveQueue: Promise.resolve(),
  draftSaveQueue: Promise.resolve(),
  historySaveQueue: Promise.resolve(),
  diagnosticsSaveQueue: Promise.resolve(),
  cooldownTimer: null,
  mainController: null,
  backController: null,
  clearPromise: null,
  diagnosticActive: false,
  diagnosticText: "",
  writeQueue: Promise.resolve(false),
  expectedStorageWrite: null,
  externalConfigurationChanged: false,
  externalStorageReloadTimer: null,
  externalStorageReasons: new Set()
};

let lastPersistenceWarningAt = 0;
function observeBackgroundTask(promise, label, { quietWhenClosing = true } = {}) {
  void Promise.resolve(promise).catch((error) => {
    if (quietWhenClosing && state.closing) return;
    const now = Date.now();
    const message = `${label}保存失败：${String(error?.message || error?.name || "storage_error").slice(0, 120)}`;
    state.diagnostics.unshift({ timestamp: now, message });
    state.diagnostics = state.diagnostics.slice(0, 80);
    renderDiagnostics();
    if (now - lastPersistenceWarningAt > 5000) {
      lastPersistenceWarningAt = now;
      setStatus(`${label}未能保存，请不要关闭侧栏`, "error");
    }
  });
}

function postBindRequest(tabId) {
  if (!state.panelPort || !Number.isInteger(tabId)) return null;
  const bindRequestId = randomId("bind");
  state.bindRequestId = bindRequestId;
  state.panelPort.postMessage({ type: "BIND_TAB", tabId, bindRequestId });
  return bindRequestId;
}

function setStatus(text, phase = null) {
  state.statusText = String(text);
  if (phase) state.translatePhase = phase;
  ui.statusBar.textContent = state.statusText;
}

function setBadge(element, text, kind = "") {
  element.textContent = text;
  element.className = `badge${kind ? ` ${kind}` : ""}`;
}

function maskSecret(secret) {
  const value = String(secret ?? "");
  if (!value) return "";
  return value.length > 4
    ? `已保存 Key（尾号 ${value.slice(-4)}；留空保留）`
    : "已保存 Key（留空保留）";
}

function currentBackTranslationMode(settings = state.settings) {
  return normalizeBackTranslationMode(settings?.backTranslationMode);
}

function backTranslationKindLabel(kind) {
  if (kind === BACK_TRANSLATION_MODES.SAME_REQUEST) return "同请求回译";
  if (kind === "independent" || kind === "manual_independent") return "独立回译";
  if (kind === BACK_TRANSLATION_MODES.OFF) return "无回译";
  return "";
}

function updateBackSettingsVisibility() {
  const mode = normalizeBackTranslationMode(ui.backTranslationMode.value);
  ui.independentBackSettings.classList.toggle(
    "hidden",
    mode !== BACK_TRANSLATION_MODES.INDEPENDENT
  );
  if (mode === BACK_TRANSLATION_MODES.SAME_REQUEST) {
    ui.backTranslationModeHelp.textContent = "同请求模式只使用主翻译模型；模型先生成英文，再在同一响应中生成中文回译。它是快速自检，不是独立验证。";
  } else if (mode === BACK_TRANSLATION_MODES.INDEPENDENT) {
    ui.backTranslationModeHelp.textContent = "独立模式会在英文稳定后发起第二次请求，回译模型只看到英文，核对价值更高但成本和延迟也更高。";
  } else {
    ui.backTranslationModeHelp.textContent = "关闭后只生成英文，不发起或要求任何回译。";
  }
}

function updateBackOutputPresentation() {
  const kind = state.draft.backTranslationKind || currentBackTranslationMode();
  if (kind === "independent" || kind === "manual_independent") {
    ui.backLabel.textContent = kind === "manual_independent" ? "人工英文独立回译中文" : "独立回译中文";
    ui.backText.placeholder = "独立请求只会看到英文，不会看到中文原稿";
    ui.backModeHint.textContent = kind === "manual_independent"
      ? "当前回译针对你在 Claude 中人工修改后的英文，由单独请求生成。"
      : "独立回译由第二次请求生成，回译模型只接收英文。";
    return;
  }
  if (kind === BACK_TRANSLATION_MODES.OFF) {
    ui.backLabel.textContent = "回译中文";
    ui.backText.placeholder = "当前设置已关闭回译";
    ui.backModeHint.textContent = "可在设置中开启同请求回译或独立回译。";
    return;
  }
  ui.backLabel.textContent = "AI 同请求回译中文";
  ui.backText.placeholder = "同一次模型响应会同时返回英文和中文回译";
  ui.backModeHint.textContent = "同请求回译可减少一次 API 调用，但它是模型自检，不等同于独立验证。";
}

function updateProviderSummary() {
  const model = state.provider.modelTranslate || "未选模型";
  const mode = currentBackTranslationMode();
  const modeLabel = mode === BACK_TRANSLATION_MODES.SAME_REQUEST
    ? "单次双译"
    : mode === BACK_TRANSLATION_MODES.INDEPENDENT
      ? "独立回译"
      : "仅英译";
  const protocolLabel = normalizedApiProtocol(state.provider) === "responses"
    ? " · Responses"
    : "";
  const reasoning = normalizeReasoning(state.provider.reasoning);
  const reasoningLabel = reasoning.mode === "inherit"
    ? ""
    : reasoning.mode === "off"
      ? " · 思考:关"
      : ` · 思考:${reasoning.effort}`;
  ui.providerSummary.textContent = `${state.provider.name || "Provider"} · ${model} · ${modeLabel}${protocolLabel}${reasoningLabel}`;
}

function updateTargetUI() {
  ui.targetDot.className = "dot dot-off";
  if (!state.target.bound) {
    ui.targetLabel.textContent = "未绑定 Claude";
    ui.targetDetail.textContent = "打开 claude.ai 后绑定当前标签页";
    ui.bindButton.textContent = "绑定当前页";
    return;
  }

  ui.bindButton.textContent = "重新绑定";
  if (!state.target.connected) {
    ui.targetLabel.textContent = "Claude 连接已断开";
    ui.targetDetail.textContent = "刷新页面后重新绑定";
    return;
  }

  if (!state.target.active) {
    ui.targetDot.className = "dot dot-warn";
    ui.targetLabel.textContent = "已绑定，但标签页不在前台";
    ui.targetDetail.textContent = `标签页 ${state.target.tabId} · 自动写入暂停`;
    return;
  }

  if (!state.target.composerReady) {
    ui.targetDot.className = "dot dot-warn";
    ui.targetLabel.textContent = "已绑定，未找到输入框";
    ui.targetDetail.textContent = "可打开页面诊断并手动绑定";
    return;
  }

  ui.targetDot.className = "dot dot-ready";
  ui.targetLabel.textContent = "已绑定当前 Claude 标签页";
  ui.targetDetail.textContent = state.target.requiresFocusWrite && !state.settings.allowFocusWrite
    ? "富文本输入框 · 自动写入需先完成诊断并启用聚焦写入"
    : `输入框就绪${state.target.strategy ? ` · ${state.target.strategy}` : ""}`;
}

function updateDraftUI({ preserveSourceSelection = true } = {}) {
  if (ui.sourceText.value !== state.draft.source) {
    const start = preserveSourceSelection ? ui.sourceText.selectionStart : 0;
    const end = preserveSourceSelection ? ui.sourceText.selectionEnd : 0;
    ui.sourceText.value = state.draft.source;
    if (preserveSourceSelection) {
      const max = ui.sourceText.value.length;
      ui.sourceText.setSelectionRange(Math.min(start, max), Math.min(end, max));
    }
  }
  ui.englishText.value = state.draft.english;
  ui.backText.value = state.draft.backTranslation;
  // Count once per render. The previous implementation expanded the entire
  // source string three times, which became noticeably wasteful for long
  // pasted drafts even though automatic translation was already disabled.
  const sourceLength = codePointLength(state.draft.source);
  ui.sourceCount.textContent = sourceLength > MAX_SOURCE_CODEPOINTS
    ? `${sourceLength} / 50,000（超出，需拆分）`
    : `${sourceLength} / 50,000`;
  ui.automationMode.value = state.settings.automationMode ?? "auto_sync";
  ui.pauseButton.textContent = state.paused ? "恢复" : "暂停";
  ui.longTextHint.classList.toggle(
    "hidden",
    sourceLength <= state.settings.longTextThreshold
  );
  ui.translateButton.textContent = sourceLength > state.settings.longTextThreshold
    ? "翻译整段并同步"
    : "翻译并同步";

  if (!state.draft.english) setBadge(ui.syncBadge, "未生成");
  else if (state.targetPhase === "synced") setBadge(ui.syncBadge, "已同步", "success");
  else if (state.targetPhase === "manual") setBadge(ui.syncBadge, "人工修改", "danger-text");
  else if (state.draft.englishSourceRevision !== state.sourceRevision) setBadge(ui.syncBadge, "旧译文", "warn");
  else setBadge(ui.syncBadge, "待同步", "warn");

  updateBackOutputPresentation();
  const backMode = currentBackTranslationMode();
  if (!state.draft.backTranslation) {
    if (state.backPhase === "working") setBadge(ui.backBadge, "回译中", "warn");
    else if (state.backPhase === "waiting") setBadge(ui.backBadge, "等待回译", "warn");
    else if (state.backPhase === "error") setBadge(ui.backBadge, "回译失败", "danger-text");
    else if (backMode === BACK_TRANSLATION_MODES.OFF || state.draft.backTranslationKind === BACK_TRANSLATION_MODES.OFF) setBadge(ui.backBadge, "已关闭");
    else setBadge(ui.backBadge, "未生成");
  } else if (state.draft.englishSourceRevision !== state.sourceRevision) {
    setBadge(ui.backBadge, "旧回译", "warn");
  } else if (["independent", "manual_independent"].includes(state.draft.backTranslationKind)) {
    setBadge(ui.backBadge, "独立", "success");
  } else {
    setBadge(ui.backBadge, "同请求", "success");
  }

  const englishIsCurrent = Boolean(state.draft.english)
    && state.draft.englishSourceRevision === state.sourceRevision;
  ui.syncButton.disabled = !englishIsCurrent;
  ui.copyEnglishButton.disabled = !englishIsCurrent;
  renderNotices();
  updateStaleBanner();
}

function updateStaleBanner(customMessage = "") {
  let message = customMessage;
  if (!message && state.targetPhase === "stale-uncleared" && state.target.currentText) {
    message = "Claude 输入框中可能仍保留旧英文。请不要发送，等待新译文或手动清空。";
  } else if (!message && state.draft.english && state.draft.englishSourceRevision !== state.sourceRevision) {
    message = "中文已经修改，当前英文预览已过期。";
  }
  ui.staleBanner.textContent = message;
  ui.staleBanner.classList.toggle("hidden", !message);
}

function clearElement(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function renderNotices() {
  clearElement(ui.correctionList);
  for (const correction of state.draft.corrections) {
    const item = document.createElement("div");
    item.className = "notice-item";
    const line = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = `“${correction.original}” → 按“${correction.interpreted_as}”理解`;
    line.append(strong);
    const reason = document.createElement("p");
    reason.className = "muted compact";
    reason.textContent = correction.reason || "模型判断为上下文中近乎唯一的明显输入错误";
    const actions = document.createElement("div");
    actions.className = "button-row";
    const literalButton = document.createElement("button");
    literalButton.type = "button";
    literalButton.className = "secondary-button";
    literalButton.textContent = "按字面重译";
    literalButton.addEventListener("click", () => {
      state.literalFragments.add(correction.original);
      void translateNow({ forceSync: true, forceOverwrite: false, reason: "literal_retry" });
    });
    const acceptButton = document.createElement("button");
    acceptButton.type = "button";
    acceptButton.className = "ghost-button";
    acceptButton.textContent = "接受本次解释";
    acceptButton.addEventListener("click", () => {
      state.draft.corrections = state.draft.corrections.filter((entry) => entry !== correction);
      state.draft.updatedAt = Date.now();
      schedulePersist();
      renderNotices();
    });
    actions.append(literalButton, acceptButton);
    item.append(line, reason, actions);
    ui.correctionList.append(item);
  }
  ui.correctionSection.classList.toggle("hidden", state.draft.corrections.length === 0);

  clearElement(ui.ambiguityList);
  for (const ambiguity of state.draft.ambiguities) {
    const item = document.createElement("div");
    item.className = "notice-item";
    const fragment = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = `“${ambiguity.fragment}”`;
    fragment.append(strong);
    const reading = document.createElement("p");
    reading.textContent = `本次采用：${ambiguity.reading_used || "最字面的可行解释"}`;
    const alternatives = document.createElement("p");
    alternatives.className = "muted compact";
    alternatives.textContent = ambiguity.alternatives?.length
      ? `其他可能：${ambiguity.alternatives.join("；")}`
      : "请直接修改中文原稿来消除歧义";
    item.append(fragment, reading, alternatives);
    ui.ambiguityList.append(item);
  }
  ui.ambiguitySection.classList.toggle("hidden", state.draft.ambiguities.length === 0);

  clearElement(ui.warningList);
  for (const warning of state.draft.warnings) {
    const item = document.createElement("li");
    item.textContent = warning;
    ui.warningList.append(item);
  }
  ui.warningSection.classList.toggle("hidden", state.draft.warnings.length === 0);
}

function targetContextSnapshot() {
  return {
    tabId: state.target.tabId,
    writerSession: state.target.writerSession,
    targetEpoch: state.target.targetEpoch
  };
}

function targetIdentitySnapshot() {
  return {
    tabId: state.target.tabId,
    writerSession: state.target.writerSession
  };
}

function capturePanelFocus() {
  const active = document.activeElement;
  return active instanceof HTMLElement ? active : null;
}

function restorePanelFocus(element, focusUsed) {
  if (!focusUsed || !element?.isConnected || state.composing) return;
  queueMicrotask(() => {
    try {
      element.focus({ preventScroll: true });
    } catch {
      // Focus restoration is best effort.
    }
  });
}

// Every pause goes through here so paused/pauseKind/pausedByTargetLoss can
// never drift apart. Kinds: "user" | "review" | "incident" | "system" — see
// the state comment for how each one is allowed to end.
function pauseAutomation(kind) {
  state.paused = true;
  state.pauseKind = kind;
  state.pausedByTargetLoss = false;
}

function resumeAutomation() {
  state.paused = false;
  state.pauseKind = null;
  state.pausedByTargetLoss = false;
}

// A "system" pause is bookkeeping, not a user decision: the next clear signal
// of intent (typing new Chinese, a successful re-bind, switching automation
// back on) lifts it automatically instead of demanding a 恢复 click.
function resumeSystemPause(reason) {
  if (!state.paused || state.pauseKind !== "system") return false;
  resumeAutomation();
  addDiagnostic(`系统性暂停已自动恢复（${reason}）`);
  return true;
}

function showManualBanner(text) {
  abortInFlight();
  state.manualText = String(text ?? "");
  state.targetPhase = "manual";
  pauseAutomation("review");
  ui.manualBanner.classList.remove("hidden");
  setStatus("检测到人工修改，自动覆盖已暂停", "paused");
  updateDraftUI();
}

function hideManualBanner() {
  ui.manualBanner.classList.add("hidden");
  state.manualText = "";
}

function persistDraftSnapshot(draft = state.draft) {
  const snapshot = clone(draft);
  const run = state.draftSaveQueue.then(
    () => saveActiveDraft(snapshot, state.draftScope),
    () => saveActiveDraft(snapshot, state.draftScope)
  );
  state.draftSaveQueue = run.catch(() => undefined);
  return run;
}

function schedulePersist() {
  if (state.persistTimer) clearTimeout(state.persistTimer);
  state.persistTimer = setTimeout(() => {
    state.persistTimer = null;
    observeBackgroundTask(persistDraftSnapshot(state.draft), "当前草稿");
  }, 180);
}

function persistHistorySnapshot(history = state.history) {
  const snapshot = clone(history);
  const run = state.historySaveQueue.then(
    () => saveHistory(snapshot, state.draftScope),
    () => saveHistory(snapshot, state.draftScope)
  );
  state.historySaveQueue = run.catch(() => undefined);
  return run;
}

function persistDiagnosticsSnapshot(entries = state.diagnostics) {
  const snapshot = clone(entries);
  const run = state.diagnosticsSaveQueue.then(
    () => saveDiagnostics(snapshot, state.draftScope),
    () => saveDiagnostics(snapshot, state.draftScope)
  );
  state.diagnosticsSaveQueue = run.catch(() => undefined);
  return run;
}

function addDiagnostic(message) {
  state.diagnostics.unshift({ timestamp: Date.now(), message: String(message).slice(0, 240) });
  state.diagnostics = state.diagnostics.slice(0, 80);
  observeBackgroundTask(persistDiagnosticsSnapshot(state.diagnostics), "诊断记录");
  renderDiagnostics();
}

function abortInFlight() {
  state.operationEpoch += 1;
  state.mainController?.abort();
  state.backController?.abort();
  state.mainController = null;
  state.backController = null;
  // Nulling mainController above means the aborted translateNow's finally
  // (identity-guarded since 0.2.5) will no longer re-enable the button. With
  // nothing in flight anymore the button must be clickable again — otherwise
  // any abort while translating (pause, SW restart, rebind, draft clear)
  // leaves 立即翻译 permanently disabled.
  ui.translateButton.disabled = false;
  // An aborted independent back-translation exits through the AbortError guard
  // and therefore never reaches its normal ready/error state assignment. Reset
  // transient phases here so the UI cannot remain stuck on “回译中/等待回译”
  // after Pause, provider changes, navigation, or manual-edit takeover.
  if (["waiting", "working"].includes(state.backPhase)) state.backPhase = "idle";
  if (["waiting", "working"].includes(state.translatePhase)) state.translatePhase = "idle";
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = null;
}

async function hasProviderPermission(baseUrl) {
  try {
    return chrome.permissions.contains({ origins: [permissionPatternForBaseUrl(baseUrl)] });
  } catch {
    return false;
  }
}

async function getActiveSecret(provider = state.provider) {
  return getSecretForProvider(provider);
}

function providerConfigForRequest(provider = state.provider, settings = state.settings) {
  return {
    ...clone(provider),
    timeoutMs: settings.requestTimeoutMs,
    extraHeaders: sanitizeExtraHeaders(provider.extraHeaders, provider.authHeader)
  };
}

function providerContextSnapshot() {
  const provider = clone(state.provider);
  const settings = clone(state.settings);
  return {
    epoch: state.providerEpoch,
    provider,
    settings,
    config: providerConfigForRequest(provider, settings),
    modelTranslate: provider.modelTranslate,
    modelBackTranslate: provider.modelBackTranslate || provider.modelTranslate,
    backTranslationMode: normalizeBackTranslationMode(settings.backTranslationMode)
  };
}

function providerContextIsCurrent(context) {
  return Boolean(context && context.epoch === state.providerEpoch);
}

function persistSettings(settings = state.settings) {
  const settingsSnapshot = clone(settings);
  const run = state.settingsSaveQueue.then(
    () => saveBehaviorSettings(settingsSnapshot),
    () => saveBehaviorSettings(settingsSnapshot)
  );
  state.settingsSaveQueue = run.catch(() => undefined);
  return run;
}

function persistConfiguration(settings, provider, secret, credentialId) {
  const settingsSnapshot = clone(settings);
  const providerSnapshot = clone(provider);
  const secretSnapshot = String(secret ?? "");
  const run = state.settingsSaveQueue.then(
    () => saveConfiguration(settingsSnapshot, providerSnapshot, secretSnapshot, credentialId),
    () => saveConfiguration(settingsSnapshot, providerSnapshot, secretSnapshot, credentialId)
  );
  state.settingsSaveQueue = run.catch(() => undefined);
  return run;
}

function clearStoredSecrets() {
  const run = state.settingsSaveQueue.then(
    () => clearSecrets(),
    () => clearSecrets()
  );
  state.settingsSaveQueue = run.catch(() => undefined);
  return run;
}

function clearCooldown({ announce = false } = {}) {
  if (state.cooldownTimer) clearInterval(state.cooldownTimer);
  state.cooldownTimer = null;
  state.cooldownUntil = 0;
  state.providerPhase = "ready";
  if (announce && !state.paused) setStatus("限流冷却结束，可继续翻译", "idle");
}

function invalidateRuntimeContext({ abort = true } = {}) {
  state.providerEpoch += 1;
  clearCooldown();
  // The cache key includes the provider target, but a provider/settings
  // change is still the natural trust boundary for replayed results.
  state.translationCache.clear();
  if (abort) abortInFlight();
}

const TRANSLATION_CACHE_LIMIT = 50;

// Session-scoped translation memory. Undo/redo typing, restoring drafts and
// repeated phrases replay instantly instead of re-billing a Provider request.
// Entries are full result objects; corrections and warnings replay with them
// so every downstream safety check behaves exactly like a fresh result.
function translationCacheKey(providerContext, source) {
  try {
    return JSON.stringify([
      normalizeBaseUrl(providerContext.provider.baseUrl),
      normalizedApiProtocol(providerContext.provider),
      providerContext.modelTranslate,
      providerContext.backTranslationMode,
      providerContext.settings.protectedTerms,
      [...state.literalFragments].sort(),
      normalizeText(source)
    ]);
  } catch {
    return null;
  }
}

function readTranslationCache(key) {
  if (!key || !state.translationCache.has(key)) return null;
  const entry = state.translationCache.get(key);
  state.translationCache.delete(key);
  state.translationCache.set(key, entry);
  return clone(entry);
}

function writeTranslationCache(key, result) {
  if (!key || !result) return;
  // capabilityPatch/usage/reasoningTokens are request-time facts, not
  // translation content; replaying a stale patch could resurrect a
  // degradation the gateway no longer needs, and a replay spends no
  // reasoning tokens.
  const entry = clone({ ...result, capabilityPatch: null, usage: null, reasoningTokens: null });
  state.translationCache.delete(key);
  state.translationCache.set(key, entry);
  while (state.translationCache.size > TRANSLATION_CACHE_LIMIT) {
    state.translationCache.delete(state.translationCache.keys().next().value);
  }
}

function applyCapabilityPatch(patch, context) {
  if (!patch || typeof patch !== "object" || !providerContextIsCurrent(context)) return;
  const next = {
    ...state.provider.capabilities,
    ...patch
  };
  if (JSON.stringify(next) === JSON.stringify(state.provider.capabilities)) return;
  // Runtime compatibility learning must not persist an entire stale Provider
  // snapshot. The explicit settings connection test persists capabilities when
  // the user saves the form; ordinary translations keep the patch in-memory.
  state.provider.capabilities = next;
  // Keep the frozen request context internally consistent for a same-operation
  // independent back-translation. This does not make an old context current;
  // providerContextIsCurrent() remains the outer epoch gate.
  if (context?.provider) context.provider.capabilities = clone(next);
  if (context?.config) context.config.capabilities = clone(next);
}

function rememberPersistedCapabilities(provider) {
  state.persistedCapabilitySignature = null;
  state.persistedCapabilities = null;
  try {
    state.persistedCapabilitySignature = `${normalizeBaseUrl(provider.baseUrl)}\n${provider.modelTranslate || ""}\n${normalizedApiProtocol(provider)}`;
    state.persistedCapabilities = clone(provider.capabilities);
  } catch {
    // A stored Base URL that predates current validation cannot anchor a
    // capability snapshot; capabilities re-learn from defaults after a save.
  }
}

function normalizedProviderSignature(provider) {
  return JSON.stringify(normalizeStoredProvider(provider));
}

function normalizedSettingsSignature(settings) {
  return JSON.stringify(normalizeStoredSettings(settings));
}

function activeExpectedStorageWrite() {
  const expected = state.expectedStorageWrite;
  if (!expected) return null;
  if (Date.now() <= expected.until) return expected;
  state.expectedStorageWrite = null;
  return null;
}

function markExpectedConfigurationWrite(settings, provider) {
  const normalizedProvider = normalizeStoredProvider(provider);
  state.expectedStorageWrite = {
    kind: "configuration",
    until: Date.now() + 10_000,
    providerSignature: normalizedProviderSignature(normalizedProvider),
    settingsSignature: normalizedSettingsSignature(settings),
    credentialId: normalizedProvider.credentialId,
    selectedSecretArea: normalizedProvider.keyStorage,
    staleSecretArea: normalizedProvider.keyStorage === "session" ? "local" : "session"
  };
}

function markExpectedSecretClear() {
  state.expectedStorageWrite = {
    kind: "clear_secrets",
    until: Date.now() + 10_000
  };
}

function clearExpectedConfigurationWrite() {
  state.expectedStorageWrite = null;
}

function isRemovalChange(change) {
  return Boolean(change && !Object.hasOwn(change, "newValue"));
}

function expectedStorageChange(key, change, areaName) {
  const expected = activeExpectedStorageWrite();
  if (!expected) return false;

  if (expected.kind === "clear_secrets") {
    return (
      (key === STORAGE_KEYS.LOCAL_SECRET && areaName === "local")
      || (key === STORAGE_KEYS.SESSION_SECRET && areaName === "session")
    ) && isRemovalChange(change);
  }

  if (key === STORAGE_KEYS.PROVIDER && areaName === "local") {
    return normalizedProviderSignature(change?.newValue) === expected.providerSignature;
  }
  if (key === STORAGE_KEYS.SETTINGS && areaName === "local") {
    return normalizedSettingsSignature(change?.newValue) === expected.settingsSignature;
  }

  const secretArea = key === STORAGE_KEYS.LOCAL_SECRET && areaName === "local"
    ? "local"
    : key === STORAGE_KEYS.SESSION_SECRET && areaName === "session"
      ? "session"
      : null;
  if (!secretArea) return false;
  if (secretArea === expected.staleSecretArea && isRemovalChange(change)) return true;
  if (secretArea !== expected.selectedSecretArea || isRemovalChange(change)) return false;
  return secretRecordMetadata(change?.newValue)?.credentialId === expected.credentialId;
}

function relevantStorageChanges(changes, areaName) {
  const keys = [];
  if (areaName === "local") {
    for (const key of [STORAGE_KEYS.SETTINGS, STORAGE_KEYS.PROVIDER, STORAGE_KEYS.LOCAL_SECRET]) {
      const change = changes?.[key];
      if (!change || expectedStorageChange(key, change, areaName)) continue;
      // Same-context behavior-setting writes update state before storage.set().
      // Ignore value-identical echoes while still treating secret changes as
      // security-relevant even when the Provider record itself is unchanged.
      if (
        key === STORAGE_KEYS.SETTINGS
        && normalizedSettingsSignature(change.newValue) === normalizedSettingsSignature(state.settings)
      ) continue;
      if (
        key === STORAGE_KEYS.PROVIDER
        && normalizedProviderSignature(change.newValue) === normalizedProviderSignature(state.provider)
      ) continue;
      keys.push(key);
    }
  } else if (areaName === "session" && changes?.[STORAGE_KEYS.SESSION_SECRET]) {
    const key = STORAGE_KEYS.SESSION_SECRET;
    if (!expectedStorageChange(key, changes[key], areaName)) keys.push(key);
  }
  return keys;
}

function scheduleExternalConfigurationReload(reasons) {
  for (const reason of reasons) state.externalStorageReasons.add(reason);
  if (state.externalStorageReloadTimer) clearTimeout(state.externalStorageReloadTimer);
  state.externalStorageReloadTimer = setTimeout(async () => {
    state.externalStorageReloadTimer = null;
    const reasonList = [...state.externalStorageReasons];
    state.externalStorageReasons.clear();
    if (state.closing) return;
    try {
      const { settings, provider } = await loadSettings();
      if (state.closing) return;
      invalidateFormRequests();
      invalidateRuntimeContext();
      state.provider = provider;
      rememberPersistedCapabilities(provider);
      state.settings = {
        ...settings,
        backTranslationMode: normalizeBackTranslationMode(settings.backTranslationMode)
      };
      // Adopt-and-continue: the reload above succeeded, so the new
      // configuration is valid and there is nothing for the user to fix.
      // Pausing here only manufactured a 恢复 click after every settings save
      // in another window. In-flight requests were already invalidated.
      state.externalConfigurationChanged = true;
      state.formCapabilitySignature = null;
      state.formCapabilities = null;
      ui.automationMode.value = state.settings.automationMode ?? "auto_sync";
      updateProviderSummary();
      updateBackOutputPresentation();
      updateDraftUI();
      if (ui.settingsDialog.open) {
        ui.providerTestResult.textContent = "另一个 Edge 窗口修改了 Provider、Key 或翻译设置；当前表单可能已过期，请关闭后重新打开，或明确确认覆盖。";
      }
      setStatus("已采纳另一个窗口的配置修改，自动流程继续", "idle");
      addDiagnostic(`检测到外部配置变化（${reasonList.join("、")}），已采纳新配置并继续`);
      scheduleTranslation();
    } catch (error) {
      invalidateFormRequests();
      invalidateRuntimeContext();
      pauseAutomation("incident");
      setStatus("检测到配置变化，但重新读取失败；自动流程已暂停", "error");
      addDiagnostic(`外部配置变化后读取失败：${String(error?.message || "storage_error").slice(0, 120)}`);
    }
  }, 80);
}

function handleStorageChanges(changes, areaName) {
  if (state.closing) return;
  const reasons = relevantStorageChanges(changes, areaName);
  if (reasons.length > 0) scheduleExternalConfigurationReload(reasons);
}

function providerErrorMessage(error) {
  if (error instanceof TranslationValidationError) return error.message;
  if (!(error instanceof ProviderError)) {
    return error?.message || "翻译失败，请检查设置与网络";
  }

  const gatewayNote = error.remoteMessage ? `（网关消息：${error.remoteMessage}）` : "";

  switch (error.code) {
    case "unauthorized":
      return "API Key、账户或模型权限无效";
    case "rate_limited":
      return "Provider 正在限流";
    case "timeout":
      return "Provider 请求超时";
    case "network_error":
      return "无法连接 Provider";
    case "provider_unavailable":
      return `Provider 网关返回 5xx${gatewayNote}${
        error.protocol === "responses"
          ? "；当前走 /v1/responses——若 Chat Completions 正常，请在设置里点“测试”做协议对比诊断"
          : ""
      }`;
    case "endpoint_not_found":
      return "Base URL 或接口路径不正确；请核对所选“接口协议”对应的端点（/chat/completions 或 /responses）";
    case "model_not_found":
      return "模型不存在、不可用，或当前 API Key 无权访问";
    case "incompatible_request":
      return "模型或网关不兼容当前请求格式，请运行连通测试";
    case "payload_too_large":
      return "文本超过 Provider 限制";
    case "output_truncated":
      return "模型输出被截断";
    case "model_refusal":
      return "模型拒绝了本次翻译";
    case "incomplete_response":
      return "模型没有返回完整的纯文本翻译";
    case "response_too_large":
      return "Provider 返回内容异常过大，已安全终止";
    case "empty_body":
      return "Provider 返回 HTTP 成功状态，但响应体为空";
    case "html_response":
      return error.routeHint === "missing_api_prefix_likely"
        ? "Provider 返回了网站 HTML，不是模型 JSON；Base URL 很可能缺少 API 前缀（常见为 /v1），或填成了网站首页"
        : "Provider 返回了 HTML 网页，不是模型 JSON；请核对官方 API Base URL 与路由";
    case "non_json_response":
      return "Provider 返回了非 JSON 内容；请核对 API Base URL、代理与网关配置";
    case "logical_api_error":
      return "Provider 以 HTTP 200 返回了逻辑错误";
    case "responses_api_response":
      return "Provider 返回了 Responses API 结构；请在设置中把“接口协议”切换为 Responses API 后重试";
    case "chat_completions_response":
      return "Provider 返回了 Chat Completions 结构；请在设置中把“接口协议”切换为 Chat Completions 后重试";
    case "unsupported_response_schema":
      return "Provider 响应结构与所选接口协议不符";
    case "reasoning_rejected":
      return "接口拒绝了当前思考参数；按严格策略未自动移除，请在设置中调整“思考策略/方言”或改回继承默认";
    case "empty_choices":
      return "Provider 返回了空 choices 数组";
    case "empty_assistant_content":
    case "empty_response":
      return "模型响应中没有可用的 assistant 文本";
    default:
      return error.message || "Provider 请求失败";
  }
}

function providerDiagnosticDetail(error) {
  const code = String(error?.code || error?.name || "error").slice(0, 80);
  if (!(error instanceof ProviderError)) return code;

  const details = [code];
  if (Number.isFinite(error.status)) details.push(`HTTP ${error.status}`);
  if (error.contentType) details.push(`type=${error.contentType}`);
  if (Number.isFinite(error.responseChars)) {
    details.push(`chars=${error.responseChars}`);
  }
  if (Number.isFinite(error.responseBytes)) {
    details.push(`bytes=${error.responseBytes}`);
  }
  if (error.responseKind) details.push(`kind=${error.responseKind}`);
  if (error.redirected) details.push("redirected=yes");
  if (error.endpoint) details.push(`endpoint=${error.endpoint}`);
  if (error.remoteCode) details.push(`remoteCode=${error.remoteCode}`);
  if (error.requestId) details.push(`requestId=${error.requestId}`);
  if (error.responseKeys?.length) {
    details.push(`keys=${error.responseKeys.join(",")}`);
  }
  if (error.routeHint) details.push(`hint=${error.routeHint}`);
  if (error.protocol) {
    details.push(`proto=${error.protocol}${error.streamedRequest ? "+sse" : ""}`);
  }
  if (error.remoteMessage) details.push(`msg=${error.remoteMessage}`);
  return details.join(" · ");
}

function providerFormErrorMessage(error) {
  const summary = providerErrorMessage(error);
  if (!(error instanceof ProviderError)) return summary;
  const detail = providerDiagnosticDetail(error);
  return `${summary} · ${detail}`.slice(0, 700);
}

function startCooldown(error, providerContext = null) {
  const rawDelay = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 15000;
  // Respect realistic Retry-After values. The previous five-minute cap could
  // resume paid requests while a provider explicitly requested a longer wait.
  // A 24-hour ceiling only protects the UI from malicious/overflowing headers.
  const delay = Math.min(86_400_000, Math.max(3000, rawDelay));
  const cooldownProviderEpoch = providerContext?.epoch ?? state.providerEpoch;
  clearCooldown();
  state.providerPhase = "rate-limited";
  state.cooldownUntil = Date.now() + delay;
  const update = () => {
    if (cooldownProviderEpoch !== state.providerEpoch) {
      clearCooldown();
      return;
    }
    const remaining = Math.max(0, state.cooldownUntil - Date.now());
    if (remaining <= 0) {
      clearCooldown({ announce: true });
      return;
    }
    if (!state.paused) {
      setStatus(`限流冷却 ${Math.ceil(remaining / 1000)} 秒`, "rate-limited");
    }
  };
  update();
  state.cooldownTimer = setInterval(update, 1000);
}

function requestWriter(type, payload = {}, timeoutMs = 7000) {
  if (!state.panelPort) return Promise.resolve({ ok: false, code: "panel_disconnected" });
  const requestId = randomId("req");
  const expectedType = `${type}_RESULT`;
  const guardedPayload = {
    ...(Number.isInteger(state.target.tabId) && !Object.hasOwn(payload, "expectedTabId")
      ? { expectedTabId: state.target.tabId }
      : {}),
    ...payload
  };
  // Prevent a command that timed out in the panel from being applied later by
  // a temporarily blocked service worker/content script queue.
  const deadline = Date.now() + Math.max(250, timeoutMs - 250);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pendingRequests.delete(requestId);
      resolve({ ok: false, code: "writer_timeout", message: "Claude 写入器响应超时" });
    }, timeoutMs);
    state.pendingRequests.set(requestId, {
      resolve,
      timer,
      expectedType,
      targetTabId: Number.isInteger(guardedPayload.expectedTabId)
        ? guardedPayload.expectedTabId
        : null
    });
    try {
      state.panelPort.postMessage({ type, requestId, ...guardedPayload, deadline });
    } catch {
      clearTimeout(timer);
      state.pendingRequests.delete(requestId);
      resolve({ ok: false, code: "panel_disconnected", message: "扩展后台连接已断开" });
    }
  });
}

function resolvePending(message) {
  if (!message?.requestId) return false;
  const pending = state.pendingRequests.get(message.requestId);
  if (!pending || pending.expectedType !== message.type) return false;
  if (
    Number.isInteger(pending.targetTabId)
    && Number.isInteger(message.tabId)
    && pending.targetTabId !== message.tabId
  ) return false;
  clearTimeout(pending.timer);
  state.pendingRequests.delete(message.requestId);
  pending.resolve(message);
  return pending;
}

async function bindCurrentTab() {
  abortInFlight();
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    setStatus("无法读取当前标签页", "error");
    return;
  }
  if (!tab?.id || !isClaudeUrl(tab.url ?? "")) {
    setStatus("请先在当前窗口打开 claude.ai", "error");
    return;
  }
  // The click itself is a human acknowledgement: its BOUND may also clear an
  // "incident" pause, which automatic re-binds never may.
  state.userBindRequested = true;
  state.bindRetryCount = 0;
  if (state.bindRetryTimer) clearTimeout(state.bindRetryTimer);
  state.bindRetryTimer = null;
  state.target.tabId = tab.id;
  state.target.windowId = tab.windowId;
  state.target.active = true;
  state.target.bound = false;
  state.target.connected = false;
  state.panelPort?.postMessage({ type: "PANEL_HELLO", windowId: tab.windowId });
  postBindRequest(tab.id);
  setStatus("正在绑定 Claude 标签页…", "binding");
}

function updateTargetFromWriterState(message) {
  const writerState = message.state ?? {};
  if (message.writerSession) state.target.writerSession = message.writerSession;
  if (Number.isInteger(writerState.targetEpoch)) state.target.targetEpoch = writerState.targetEpoch;
  state.target.composerReady = Boolean(writerState.composerReady);
  state.target.pluginOwned = Boolean(writerState.pluginOwned);
  state.target.strategy = writerState.strategy ?? state.target.strategy;
  state.target.requiresFocusWrite = Boolean(writerState.requiresFocusWrite);
  state.target.currentText = String(writerState.currentText ?? state.target.currentText ?? "");
  state.target.connected = true;
  updateTargetUI();
  if (
    state.target.currentText
    && !state.target.pluginOwned
    && state.targetPhase !== "manual"
    && state.targetPhase !== "syncing"
  ) {
    // v0.2.12: pre-existing user content in the composer is a NORMAL state,
    // not a conflict. Adopt the protective "manual" phase quietly — no banner,
    // no pause, no overwrite prompt. Auto-sync degrades to preview; the
    // explicit 同步(覆盖) and 清空输入框 buttons are the only ways to touch it.
    state.manualText = state.target.currentText;
    state.targetPhase = "manual";
    setStatus("Claude 输入框中已有内容；新译文只停在预览，需要时点“同步到 Claude”覆盖或用“清空输入框”", "idle");
    updateDraftUI();
  }
  renderDiagnostics();
}

function handlePanelMessage(message) {
  const resolvedPending = resolvePending(message);
  if (resolvedPending) return;

  const writerEventTypes = new Set([
    "WRITER_HELLO",
    "WRITER_STATE",
    "TARGET_MANUAL_EDIT",
    "TARGET_WRITE_RECOVERY_FAILED",
    "TARGET_CLEARED",
    "SEND_CONFIRMED",
    "WRITER_SESSION_CHANGED",
    "WRITE_TARGET_RESULT",
    "CLEAR_TARGET_IF_OWNED_RESULT",
    "CLEAR_TARGET_FORCE_RESULT"
  ]);
  if (
    writerEventTypes.has(message?.type)
    && Number.isInteger(message.tabId)
    && Number.isInteger(state.target.tabId)
    && message.tabId !== state.target.tabId
  ) return;

  switch (message?.type) {
    case "PANEL_READY":
      break;
    case "BIND_RESULT":
      if (
        message.bindRequestId
        && state.bindRequestId
        && message.bindRequestId !== state.bindRequestId
      ) {
        addDiagnostic(`忽略过期绑定响应：${message.tabId ?? message.code ?? "unknown"}`);
        return;
      }
      if (!message.ok) {
        state.target.bound = false;
        state.target.connected = false;
        if (message.code !== "writer_not_ready") {
          state.target.tabId = null;
          state.target.windowId = null;
          state.target.active = false;
        }
        setStatus(message.message || "绑定失败", "error");
        updateTargetUI();
        if (message.code === "writer_not_ready") scheduleBindRetry();
        return;
      }
      state.bindRetryCount = 0;
      state.bindRequestId = message.bindRequestId ?? state.bindRequestId;
      if (state.bindRetryTimer) clearTimeout(state.bindRetryTimer);
      state.bindRetryTimer = null;
      if (state.pausedByTargetLoss || (state.paused && state.pauseKind === "system")) {
        // A successful bind resolves every target-shaped pause (lost
        // connection, SPA session switch, external clear…). Requiring a
        // manual 恢复 here made each of those interrupt the workflow.
        resumeAutomation();
        addDiagnostic("目标连接已恢复，自动翻译与同步继续");
        scheduleTranslation();
      } else if (state.paused && state.pauseKind === "incident" && state.userBindRequested) {
        // The user clicked 定位 while an interrupted-write pause was active:
        // that click is the human acknowledgement the incident asked for.
        resumeAutomation();
        addDiagnostic("用户重新定位目标；中断事件视为已核对，自动流程继续");
        scheduleTranslation();
      }
      state.userBindRequested = false;
      state.target = {
        ...state.target,
        bound: true,
        tabId: message.tabId,
        windowId: message.windowId,
        active: Boolean(message.active),
        connected: true,
        composerReady: Boolean(message.composerReady),
        writerSession: message.writerSession,
        targetEpoch: message.targetEpoch ?? 0,
        pluginOwned: Boolean(message.pluginOwned),
        strategy: message.strategy ?? null,
        requiresFocusWrite: Boolean(message.requiresFocusWrite),
        currentText: String(message.currentText ?? "")
      };
      if (state.target.currentText && !state.target.pluginOwned) {
        showManualBanner(state.target.currentText);
      } else {
        hideManualBanner();
        // Plugin-owned text is only "synced" when it matches the English for
        // the current Chinese revision. A rebind must not flip stale content
        // back to a green 已同步 badge, and a stale target regains its
        // scheduled auto-clear that the rebind's abortInFlight cancelled.
        const englishCurrent = Boolean(state.draft.english)
          && state.draft.englishSourceRevision === state.sourceRevision
          && normalizeText(state.target.currentText) === normalizeText(state.draft.english);
        state.targetPhase = state.target.pluginOwned
          ? (englishCurrent ? "synced" : (state.target.currentText ? "stale-uncleared" : "empty"))
          : "empty";
        setStatus(state.target.composerReady ? "Claude 输入框已绑定" : "已绑定，但尚未找到输入框", "idle");
      }
      updateTargetUI();
      updateDraftUI();
      addDiagnostic(`绑定标签页 ${message.tabId}：${message.composerReady ? "输入框就绪" : "未定位输入框"}`);
      break;
    case "WRITER_HELLO":
    case "WRITER_STATE":
      updateTargetFromWriterState(message);
      break;
    case "ACTIVE_TAB_CHANGED":
      state.target.active = Boolean(message.isBoundActive);
      if (!state.target.active && state.target.bound) setStatus("目标标签页不在前台，自动写入暂停", "paused");
      else if (state.target.bound) setStatus("已回到绑定的 Claude 标签页", "idle");
      updateTargetUI();
      break;
    case "WRITE_TARGET_RESULT":
      // A result reaching this switch no longer has a matching pending request;
      // normally that means the panel timed out or changed context. The page
      // may still have been mutated, so adopt the real state and fail closed.
      if (message.ok) {
        abortInFlight();
        pauseAutomation("incident");
        state.target.writerSession = message.writerSession ?? state.target.writerSession;
        state.target.targetEpoch = message.targetEpoch ?? state.target.targetEpoch + 1;
        state.target.pluginOwned = true;
        state.target.strategy = message.strategy ?? state.target.strategy;
        state.target.currentText = String(message.readback ?? "");
        state.targetPhase = "stale-uncleared";
        setStatus("收到迟到的写入结果；自动流程已暂停，请核对 Claude 输入框", "error");
        updateStaleBanner("写入器在侧栏超时后才完成操作。Claude 输入框可能已变化，请人工核对后再继续。");
        updateTargetUI();
        updateDraftUI();
        addDiagnostic("接管迟到的 Writer 写入结果并暂停自动流程");
      }
      break;
    case "CLEAR_TARGET_IF_OWNED_RESULT":
    case "CLEAR_TARGET_FORCE_RESULT":
      if (message.ok) {
        state.target.writerSession = message.writerSession ?? state.target.writerSession;
        state.target.targetEpoch = message.targetEpoch ?? state.target.targetEpoch + 1;
        state.target.pluginOwned = false;
        state.target.currentText = "";
        state.targetPhase = "empty";
        hideManualBanner();
        setStatus("迟到的安全清理已完成；中文草稿仍保留", "paused");
        updateTargetUI();
        updateDraftUI();
        addDiagnostic("接管迟到的 Writer 清理结果");
      }
      break;
    case "TARGET_MANUAL_EDIT":
      state.target.targetEpoch = message.targetEpoch ?? state.target.targetEpoch + 1;
      state.target.pluginOwned = false;
      state.target.currentText = String(message.text ?? "");
      showManualBanner(message.text);
      addDiagnostic("检测到 Claude 输入框被人工修改，已暂停自动覆盖");
      break;
    case "TARGET_WRITE_RECOVERY_FAILED":
      state.target.targetEpoch = message.targetEpoch ?? state.target.targetEpoch + 1;
      state.target.pluginOwned = false;
      state.target.currentText = String(message.text ?? "");
      showManualBanner(message.text);
      setStatus("写入失败且未能完整恢复，请检查 Claude 输入框", "error");
      addDiagnostic("写入回滚失败；已停止所有自动覆盖");
      break;
    case "TARGET_CLEARED":
      abortInFlight();
      pauseAutomation("system");
      state.target.targetEpoch = message.targetEpoch ?? state.target.targetEpoch + 1;
      state.target.pluginOwned = false;
      state.target.currentText = "";
      state.targetPhase = "empty";
      hideManualBanner();
      setStatus("Claude 输入框被外部清空；中文草稿保留（继续输入即自动恢复同步）", "paused");
      updateTargetUI();
      updateDraftUI();
      addDiagnostic("检测到非发送式清空；未归档、未清除中文草稿");
      break;
    case "SEND_CONFIRMED":
      {
        abortInFlight();
        const sentText = String(message.sentText ?? "");
        const sentMatchesPreview = normalizeText(sentText) === normalizeText(state.draft.english);
        const sentMatchesManualTarget =
          state.targetPhase === "manual"
          && normalizeText(sentText) === normalizeText(state.target.currentText);
        const sourceVersionMatches = state.draft.englishSourceRevision === state.sourceRevision;
        const canResetDraft = isCurrentDraftSend({
          sentText,
          draftEnglish: state.draft.english,
          manualTargetText: state.target.currentText,
          englishSourceRevision: state.draft.englishSourceRevision,
          sourceRevision: state.sourceRevision,
          targetPhase: state.targetPhase
        });

      state.target.targetEpoch = message.targetEpoch ?? state.target.targetEpoch + 1;
      state.target.pluginOwned = false;
      state.target.currentText = "";
      state.targetPhase = "empty";
      if (state.diagnosticActive && normalizeText(sentText) === normalizeText(state.diagnosticText)) {
        state.diagnosticActive = false;
        addDiagnostic("诊断文字已由用户发送；请人工核对实际消息全文");
      } else if (canResetDraft) {
        observeBackgroundTask(archiveAndReset(sentText), "发送归档");
      } else {
        observeBackgroundTask(archiveUncertainSend(sentText, {
          sourceVersionMatches,
          sentMatchesPreview,
          sentMatchesManualTarget
        }), "发送归档");
      }
      break;
      }
    case "WRITER_SESSION_CHANGED": {
      // Pause only when the switch actually orphans plugin content in the old
      // conversation. With nothing synced/owned, an ordinary conversation
      // switch used to force a manual 恢复 on every navigation — pure
      // friction. In-flight translations are target-independent: their write
      // step re-validates the target identity and degrades to preview-only,
      // so aborting them here would only waste an already-billed request.
      const orphansPluginContent = state.target.pluginOwned
        || ["synced", "stale-uncleared", "syncing"].includes(state.targetPhase);
      state.target.writerSession = message.writerSession;
      state.target.targetEpoch = message.targetEpoch ?? 0;
      state.target.pluginOwned = false;
      state.target.composerReady = false;
      state.target.currentText = "";
      if (orphansPluginContent) {
        abortInFlight();
        pauseAutomation("system");
        state.targetPhase = "session-changed";
        setStatus("Claude 会话或路由已变化（重新定位或继续输入即自动恢复）", "paused");
        addDiagnostic("Claude SPA 会话变化；需要重新确认输入框状态");
      } else {
        state.targetPhase = state.draft.english ? "preview-only" : "empty";
        setStatus(
          state.draft.english
            ? "Claude 会话已切换；英文预览保留，需要时点“同步到 Claude”"
            : "Claude 会话已切换",
          "idle"
        );
        addDiagnostic("Claude SPA 会话变化；无插件内容受影响，自动流程继续");
      }
      hideManualBanner();
      updateTargetUI();
      updateDraftUI();
      break;
    }
    case "TARGET_UNAVAILABLE":
    case "TARGET_TAKEN":
      abortInFlight();
      // Remember whether this pause is newly caused by a recoverable
      // connection loss. A user-initiated pause — or any other pause reason,
      // every one of which resets this flag — must never auto-resume: a stale
      // flag surviving into an unrelated pause (e.g. external configuration
      // review) would let a later successful rebind cancel that pause.
      {
        const recoverableLoss = !state.paused
          && message.type === "TARGET_UNAVAILABLE"
          && Boolean(message.recoverable);
        // Target loss is never the user's decision: classify as a system pause
        // so a re-bind or continued typing resumes it. But an existing
        // user/review/incident pause must keep its stricter kind.
        if (!state.paused) pauseAutomation("system");
        else state.paused = true;
        state.pausedByTargetLoss = recoverableLoss;
      }
      state.userBindRequested = false;
      state.target.bound = false;
      state.target.connected = false;
      state.target.active = false;
      // Without these resets a closed tab leaves ghost "plugin owns target"
      // state: 清空草稿 then takes the stale-target branch and shows a false
      // "Claude 中仍可能保留旧英文" banner for a tab that no longer exists.
      state.target.composerReady = false;
      state.target.pluginOwned = false;
      state.target.strategy = null;
      state.targetPhase = "unbound";
      if (message.type === "TARGET_TAKEN" || !message.recoverable) {
        state.target.tabId = null;
        state.target.windowId = null;
        state.target.writerSession = null;
        state.target.currentText = "";
        state.bindRequestId = null;
        if (state.bindRetryTimer) clearTimeout(state.bindRetryTimer);
        state.bindRetryTimer = null;
        state.bindRetryCount = 0;
      }
      setStatus(message.message || "Claude 目标不可用", "error");
      updateTargetUI();
      updateDraftUI();
      if (message.type === "TARGET_UNAVAILABLE" && message.recoverable) scheduleBindRetry();
      break;
    case "MANUAL_BIND_ARMED":
      setStatus("请在 Claude 页面点击真正的消息输入框", "binding");
      addDiagnostic("手动绑定已进入等待点击状态");
      break;
    default:
      break;
  }
}

function connectPanelPort() {
  if (state.panelPort || state.closing) return;
  let nextPort;
  try {
    nextPort = chrome.runtime.connect({ name: "zh2en-panel" });
  } catch {
    schedulePanelReconnect();
    return;
  }

  state.panelPort = nextPort;
  nextPort.onMessage.addListener(handlePanelMessage);
  nextPort.onDisconnect.addListener(() => {
    if (state.panelPort !== nextPort) return;
    state.panelPort = null;
    for (const pending of state.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, code: "panel_disconnected" });
    }
    state.pendingRequests.clear();
    abortInFlight();
    state.target.connected = false;
    setStatus("扩展后台连接已重启，正在自动恢复…", "paused");
    updateTargetUI();
    schedulePanelReconnect();
  });

  if (Number.isInteger(state.target.windowId)) {
    nextPort.postMessage({ type: "PANEL_HELLO", windowId: state.target.windowId });
  }
  if (Number.isInteger(state.target.tabId)) {
    postBindRequest(state.target.tabId);
  }
}

function schedulePanelReconnect() {
  if (state.closing || state.panelReconnectTimer) return;
  state.panelReconnectTimer = setTimeout(() => {
    state.panelReconnectTimer = null;
    connectPanelPort();
  }, 500);
}

function scheduleBindRetry() {
  if (
    state.closing
    || state.bindRetryTimer
    || !state.panelPort
    || !Number.isInteger(state.target.tabId)
    || state.bindRetryCount >= 8
  ) return;
  const delay = Math.min(2500, 300 * (state.bindRetryCount + 1));
  state.bindRetryCount += 1;
  state.bindRetryTimer = setTimeout(() => {
    state.bindRetryTimer = null;
    if (!state.panelPort || state.closing || !Number.isInteger(state.target.tabId)) return;
    postBindRequest(state.target.tabId);
  }, delay);
}

// v0.2.12: only the explicit 清空草稿 flow calls this — every automatic
// invocation was removed so nothing visible ever disappears on its own. It
// still refuses anything that is not the plugin's own last-written text.
async function clearStaleTargetOwned({
  // Cleanup must never pull focus out of the side panel. An explicit user
  // action may opt into the already-diagnosed focus path.
  allowFocus = false
} = {}) {
  if (state.clearPromise) return state.clearPromise;

  const task = (async () => {
    if (
      !state.target.bound
      || !state.target.active
      || !state.target.connected
      || !state.target.pluginOwned
    ) {
      if (state.target.pluginOwned) {
        state.targetPhase = "stale-uncleared";
        updateDraftUI();
      }
      return { attempted: false, ok: false, code: "target_not_ready" };
    }

    const expectedTargetContext = targetContextSnapshot();
    const previousPanelFocus = capturePanelFocus();
    const result = await requestWriter("CLEAR_TARGET_IF_OWNED", {
      expectedWriterSession: expectedTargetContext.writerSession,
      expectedTargetEpoch: expectedTargetContext.targetEpoch,
      allowFocus: Boolean(allowFocus)
    });
    restorePanelFocus(previousPanelFocus, result.focusUsed);

    const sameIdentity = targetContextMatches(
      { tabId: expectedTargetContext.tabId, writerSession: expectedTargetContext.writerSession },
      state.target
    );
    const resultEpoch = Number.isInteger(result.targetEpoch) ? result.targetEpoch : null;
    const stateEpochCompatible =
      state.target.targetEpoch === expectedTargetContext.targetEpoch
      || (resultEpoch !== null && state.target.targetEpoch === resultEpoch);

    // A recovery/manual-edit event may arrive before the command result on the
    // same Port. Never let the later failure response downgrade that safety
    // state to a generic stale banner.
    if (state.targetPhase === "manual") {
      updateDraftUI();
      return { attempted: true, ...result };
    }
    if (!sameIdentity || !stateEpochCompatible) {
      state.targetPhase = "stale-uncleared";
      updateDraftUI();
      updateStaleBanner("Claude 输入框在清理期间发生变化；未采用旧清理响应，请人工核对。");
      return { attempted: true, ok: false, code: "target_changed" };
    }

    let bannerMessage;
    if (result.ok && resultEpoch === expectedTargetContext.targetEpoch + 1) {
      state.target.targetEpoch = resultEpoch;
      state.target.pluginOwned = false;
      state.target.currentText = "";
      state.targetPhase = "empty";
      bannerMessage = "Claude 中的旧译文已按操作清除。";
      addDiagnostic(`旧译文已安全清除${result.focusUsed ? "（短暂使用焦点）" : "（无焦点）"}`);
    } else if (["clear_failed_not_restored", "write_interrupted"].includes(result.code)) {
      state.target.targetEpoch = resultEpoch ?? state.target.targetEpoch;
      state.target.pluginOwned = false;
      state.targetPhase = "manual";
      pauseAutomation("incident");
      bannerMessage = "清理过程中 Claude 输入框发生变化，自动覆盖已停止；请人工核对当前内容。";
      addDiagnostic(`旧译文清理被中断或回滚失败：${result.code}`);
      void requestWriter("REQUEST_WRITER_STATE", {});
    } else {
      state.targetPhase = "stale-uncleared";
      bannerMessage = result.code === "focus_write_disabled"
        ? "中文已经修改，但当前富文本输入框无法无焦点清除。请不要发送旧英文；等待新译文覆盖，或手动清空。"
        : result.code === "protected_content_present"
          ? "Claude 输入框中含附件或不可安全替换的富文本，插件没有清除旧内容。请人工核对并手动处理。"
          : "中文已经修改，但 Claude 中可能仍保留旧英文。请不要发送，等待新译文或手动清空。";
      addDiagnostic(`旧译文未能自动清除：${result.code || "unknown"}`);
      void requestWriter("REQUEST_WRITER_STATE", {});
    }
    updateDraftUI();
    updateStaleBanner(bannerMessage);
    return { attempted: true, ...result };
  })();

  state.clearPromise = task;
  try {
    return await task;
  } finally {
    if (state.clearPromise === task) state.clearPromise = null;
  }
}

// Explicit 清空输入框 button: the ONLY path that may remove content the
// plugin did not write, and it never runs without a confirm.
async function clearTargetExplicit() {
  if (!state.target.bound || !state.target.connected || !state.target.composerReady) {
    setStatus("尚未绑定 Claude 输入框，无法清空", "error");
    return;
  }
  if (!confirm("清空 Claude 输入框中的全部内容？此操作不可撤销。")) return;
  const expectedTargetContext = targetContextSnapshot();
  const previousPanelFocus = capturePanelFocus();
  const result = await requestWriter("CLEAR_TARGET_FORCE", {
    expectedWriterSession: expectedTargetContext.writerSession,
    expectedTargetEpoch: expectedTargetContext.targetEpoch,
    allowFocus: Boolean(state.settings.allowFocusWrite)
  });
  restorePanelFocus(previousPanelFocus, result.focusUsed);
  const sameIdentity = targetContextMatches(
    { tabId: expectedTargetContext.tabId, writerSession: expectedTargetContext.writerSession },
    state.target
  );
  if (!sameIdentity) {
    setStatus("清空期间 Claude 目标已变化，请重新确认输入框状态", "error");
    void requestWriter("REQUEST_WRITER_STATE", {});
    return;
  }
  if (result.ok) {
    const resultEpoch = Number.isInteger(result.targetEpoch)
      ? result.targetEpoch
      : state.target.targetEpoch + 1;
    state.target.targetEpoch = resultEpoch;
    state.target.pluginOwned = false;
    state.target.currentText = "";
    state.targetPhase = "empty";
    hideManualBanner();
    updateStaleBanner("");
    setStatus("已按你的操作清空 Claude 输入框", "idle");
    addDiagnostic("用户显式清空 Claude 输入框");
  } else {
    setStatus(
      result.code === "protected_content_present"
        ? "输入框含附件或不可安全替换的内容，未清空；请在页面中手动处理"
        : result.code === "focus_write_disabled"
          ? "当前富文本输入框需要聚焦写入才能清空；请先完成页面诊断并在设置中启用"
          : `清空失败：${result.code || "未知"}`,
      "error"
    );
    void requestWriter("REQUEST_WRITER_STATE", {});
  }
  updateTargetUI();
  updateDraftUI();
}

function scheduleTranslation() {
  if (state.paused || state.composing || state.settings.automationMode === "manual") return;
  const length = codePointLength(state.draft.source, state.settings.longTextThreshold);
  if (!state.draft.source.trim() || length > state.settings.longTextThreshold) return;
  if (state.cooldownUntil > Date.now()) return;
  // Resume paths (Esc, 暂停 button, 自动 toggle) and a cancelled IME
  // composition reach here with an unchanged draft. The current revision
  // already has its English: re-issuing the request would bill a second time
  // and could silently replace already-verified, already-synced English with
  // a different regeneration. Explicit 立即翻译 still goes through
  // translateNow directly and is not affected by this guard.
  if (state.draft.english && state.draft.englishSourceRevision === state.sourceRevision) return;

  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  const sentenceEnding = /[。！？!?]\s*$|\n\s*$/u.test(state.draft.source);
  const delay = sentenceEnding ? state.settings.sentenceEndDelayMs : state.settings.debounceMs;
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    void translateNow({
      forceSync: state.settings.automationMode === "auto_sync",
      reason: "debounce"
    });
  }, delay);
  setStatus("等待翻译…", "waiting");
}

async function runTranslationWithRetry(args, revision, controller, providerContext) {
  try {
    return await translateDraft(args);
  } catch (error) {
    const retryable =
      error instanceof ProviderError
      && ["provider_unavailable", "network_error", "timeout"].includes(error.code);
    if (
      !retryable
      || controller.signal.aborted
      || revision !== state.sourceRevision
      || !providerContextIsCurrent(providerContext)
    ) throw error;
    await sleep(650, controller.signal);
    if (
      controller.signal.aborted
      || revision !== state.sourceRevision
      || !providerContextIsCurrent(providerContext)
    ) throw new DOMException("Aborted", "AbortError");
    return translateDraft(args);
  }
}

async function translateNow({ forceSync = false, forceOverwrite = false, reason = "manual" } = {}) {
  // A manual/Ctrl+Enter trigger supersedes the already-scheduled debounce.
  // Without this, one click can create a second paid Provider request when the
  // old timer fires a few hundred milliseconds later.
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = null;
  const sourceSnapshot = state.draft.source;
  if (!sourceSnapshot.trim()) {
    setStatus("请先输入中文", "idle");
    return;
  }
  if (codePointLength(sourceSnapshot, MAX_SOURCE_CODEPOINTS) > MAX_SOURCE_CODEPOINTS) {
    setStatus("中文草稿超过 50,000 字符，请拆分后翻译", "error");
    return;
  }
  if (state.cooldownUntil > Date.now()) {
    setStatus("Provider 仍在限流冷却中", "rate-limited");
    return;
  }

  state.mainController?.abort();
  state.backController?.abort();
  state.backController = null;
  // A directly aborted independent back-translation exits through its
  // AbortError guard without reaching a terminal phase; reset it here the
  // same way abortInFlight() does so the badge cannot stick on 等待回译.
  if (["waiting", "working"].includes(state.backPhase)) state.backPhase = "idle";
  const controller = new AbortController();
  state.mainController = controller;
  const operationEpoch = ++state.operationEpoch;
  const revision = state.sourceRevision;
  const providerContext = providerContextSnapshot();
  // The input epoch may legitimately advance while the Provider request is in
  // flight because an old plugin-owned translation is being cleared. Freeze
  // only the tab/session identity here; capture the current epoch immediately
  // before the eventual write.
  const expectedTargetIdentity = targetIdentitySnapshot();

  if (!providerContext.modelTranslate) {
    if (state.mainController === controller) state.mainController = null;
    // This return sits after the abort of any previous run but before this
    // run's try/finally. The aborted previous run no longer re-enables the
    // button itself (its finally is identity-guarded), so restore it here —
    // nothing is in flight anymore.
    ui.translateButton.disabled = false;
    setStatus("请先在设置中选择主翻译模型", "error");
    openSettings();
    return;
  }

  state.translatePhase = "working";
  setStatus(reason === "literal_retry" ? "正在按字面重新翻译…" : "正在翻译…", "working");
  ui.translateButton.disabled = true;

  const cacheKey = translationCacheKey(providerContext, sourceSnapshot);

  try {
    // A cache hit replays a full earlier result for the identical provider
    // target, mode, protections and normalized source — no network, no key,
    // no permission needed. Corrections/warnings replay with it, so the
    // review gate below applies exactly as it did the first time.
    let result = readTranslationCache(cacheKey);
    if (result) {
      addDiagnostic("翻译缓存命中，未发起 Provider 请求");
    } else {
      const apiKey = await getActiveSecret(providerContext.provider);
      if (
        controller.signal.aborted
        || revision !== state.sourceRevision
        || normalizeText(sourceSnapshot) !== normalizeText(state.draft.source)
        || !providerContextIsCurrent(providerContext)
      ) return;
      if (!apiKey) {
        setStatus("请先配置 API Key", "error");
        openSettings();
        return;
      }

      const permitted = await hasProviderPermission(providerContext.provider.baseUrl);
      if (
        controller.signal.aborted
        || revision !== state.sourceRevision
        || normalizeText(sourceSnapshot) !== normalizeText(state.draft.source)
        || !providerContextIsCurrent(providerContext)
      ) return;
      if (!permitted) {
        setStatus("Provider 域名权限已缺失，请在设置中重新保存或检测模型", "error");
        openSettings();
        return;
      }

      result = await runTranslationWithRetry({
        source: sourceSnapshot,
        config: providerContext.config,
        apiKey,
        model: providerContext.modelTranslate,
        protectedTerms: providerContext.settings.protectedTerms,
        literalFragments: [...state.literalFragments],
        backTranslationMode: providerContext.backTranslationMode,
        // Streamed preview only: the adopted English still comes exclusively
        // from the fully parsed and validated final response below.
        onEnglishPreview: providerContext.settings.streamPreview
          ? (previewText) => {
              if (
                controller.signal.aborted
                || revision !== state.sourceRevision
                || state.mainController !== controller
              ) return;
              ui.englishText.value = previewText;
            }
          : null,
        signal: controller.signal
      }, revision, controller, providerContext);
      // Cache before the staleness guards: a superseded result still warms
      // the cache for its exact source, so the money spent is not wasted.
      writeTranslationCache(cacheKey, result);
    }

    if (
      controller.signal.aborted
      || revision !== state.sourceRevision
      || normalizeText(sourceSnapshot) !== normalizeText(state.draft.source)
      || !providerContextIsCurrent(providerContext)
    ) return;

    applyCapabilityPatch(result.capabilityPatch, providerContext);
    if (Number.isFinite(result.reasoningTokens)) {
      addDiagnostic(`本次翻译的推理用量：${result.reasoningTokens} reasoning tokens`);
    }
    state.draft.english = result.english;
    state.draft.corrections = result.corrections;
    state.draft.ambiguities = result.ambiguities;
    state.draft.warnings = result.warnings;
    state.draft.backTranslation = result.backTranslation || "";
    state.draft.backTranslationKind = providerContext.backTranslationMode === BACK_TRANSLATION_MODES.SAME_REQUEST
      ? BACK_TRANSLATION_MODES.SAME_REQUEST
      : providerContext.backTranslationMode === BACK_TRANSLATION_MODES.OFF
        ? BACK_TRANSLATION_MODES.OFF
        : "";
    state.draft.englishSourceRevision = revision;
    state.draft.updatedAt = Date.now();
    state.draft.providerName = providerContext.provider.name;
    state.draft.model = providerContext.modelTranslate;
    // A "manual" phase survives translation: Claude still holds text the user
    // chose to keep, so the sync gate must stay armed — clobbering it to
    // "ready" here would let auto-sync bypass the kept-text protection.
    if (state.targetPhase !== "manual") state.targetPhase = "ready";
    state.translatePhase = "ready";
    state.backPhase = providerContext.backTranslationMode === BACK_TRANSLATION_MODES.SAME_REQUEST
      ? "ready"
      : providerContext.backTranslationMode === BACK_TRANSLATION_MODES.OFF
        ? "off"
        : "idle";
    setStatus(
      providerContext.backTranslationMode === BACK_TRANSLATION_MODES.SAME_REQUEST
        ? "翻译与回译完成，正在准备同步…"
        : "翻译完成，正在准备同步…",
      "ready"
    );
    schedulePersist();
    updateDraftUI();

    // Review reminders: corrections, ambiguities and quantity/echo warnings.
    // Advisory by default — the English syncs into Claude's composer (never
    // sent by us) and the reminders stay loudly visible for the user's own
    // pre-send read-through. With 严格评审 enabled they become a hard gate:
    // the English waits in the preview for an explicit 同步 click.
    const reviewReminders = result.corrections.length > 0
      || result.ambiguities.length > 0
      || result.warnings.some((warning) => /数字|复述|回答式|语序/.test(warning));
    if (reviewReminders && providerContext.settings.strictReviewGate) {
      if (state.targetPhase !== "manual") state.targetPhase = "ready";
      setStatus("翻译完成，但存在需人工确认的纠错/歧义/数量提示；请核对后点“同步到 Claude”", "paused");
      updateDraftUI();
      if (providerContext.backTranslationMode === BACK_TRANSLATION_MODES.INDEPENDENT) {
        scheduleBackTranslation(revision, result.english, providerContext, {
          kind: "independent",
          useDelay: true
        });
      }
      return;
    }

    const shouldSync = forceSync || providerContext.settings.automationMode === "auto_sync";
    if (shouldSync) {
      await syncEnglish({
        forceOverwrite,
        revision,
        expectedTargetIdentity,
        operationEpoch,
        signal: controller.signal
      });
    }
    if (
      controller.signal.aborted
      || revision !== state.sourceRevision
      || normalizeText(sourceSnapshot) !== normalizeText(state.draft.source)
      || !providerContextIsCurrent(providerContext)
    ) return;

    if (providerContext.backTranslationMode === BACK_TRANSLATION_MODES.INDEPENDENT) {
      scheduleBackTranslation(revision, result.english, providerContext, {
        kind: "independent",
        useDelay: true
      });
    } else if (providerContext.backTranslationMode === BACK_TRANSLATION_MODES.SAME_REQUEST) {
      if (state.targetPhase === "synced") setStatus("已同步；同请求回译已生成", "ready");
      else if (state.targetPhase === "ready") setStatus("翻译与同请求回译完成，请核对", "ready");
    } else if (state.targetPhase === "synced") {
      setStatus("已同步；回译已关闭", "ready");
    }
    if (reviewReminders && state.targetPhase === "synced") {
      setStatus("已同步；存在纠错/歧义/数量提醒（见下方），发送前请过目", "paused");
    }
  } catch (error) {
    if (
      controller.signal.aborted
      || error?.name === "AbortError"
      || revision !== state.sourceRevision
      || !providerContextIsCurrent(providerContext)
    ) return;
    state.translatePhase = "error";
    if (error instanceof ProviderError && error.code === "rate_limited") startCooldown(error, providerContext);
    else setStatus(providerErrorMessage(error), "error");
    if (error instanceof TranslationValidationError) {
      state.draft.warnings = [...new Set([...state.draft.warnings, ...error.errors, ...error.warnings])];
      updateDraftUI();
    }
    addDiagnostic(`翻译失败：${providerDiagnosticDetail(error)}`);
    // A failed run may have left streamed preview text in the textarea;
    // redraw from state so the preview never outlives its request.
    updateDraftUI();
  } finally {
    // Both cleanups must be identity-guarded: when this run was superseded by
    // a newer translateNow, that newer run still owns the disabled button. An
    // unconditional re-enable here would drop the only lock against clicking
    // in a third concurrent paid request while the newer one is in flight.
    if (state.mainController === controller) {
      state.mainController = null;
      ui.translateButton.disabled = false;
    }
  }
}

function syncEnglish(options = {}) {
  const guardedOptions = {
    ...options,
    operationEpoch: Number.isInteger(options.operationEpoch)
      ? options.operationEpoch
      : ++state.operationEpoch
  };
  const task = state.writeQueue
    .catch(() => false)
    .then(() => syncEnglishNow(guardedOptions));
  state.writeQueue = task.catch(() => false);
  return task;
}

async function syncEnglishNow({
  forceOverwrite = false,
  revision = state.sourceRevision,
  expectedTargetIdentity = null,
  operationEpoch = state.operationEpoch,
  signal = null
} = {}) {
  const operationIsCurrent = () => operationEpoch === state.operationEpoch && !signal?.aborted;
  const revisionIsCurrent = () => isEnglishRevisionCurrent({
    requestedRevision: revision,
    currentSourceRevision: state.sourceRevision,
    englishSourceRevision: state.draft.englishSourceRevision
  });

  if (!operationIsCurrent()) return false;
  if (!state.draft.english || !revisionIsCurrent()) {
    setStatus("英文不是当前中文版本，未写入 Claude", "error");
    return false;
  }

  const englishToWrite = state.draft.english;
  const initialIdentity = expectedTargetIdentity ?? targetIdentitySnapshot();
  if (!targetContextMatches(initialIdentity, state.target)) {
    state.targetPhase = "preview-only";
    setStatus("翻译期间 Claude 目标已变化；本次仅保留英文预览", "paused");
    addDiagnostic("目标标签页或 Writer Session 变化，已阻止跨会话写入");
    updateDraftUI();
    return false;
  }
  if (!state.target.bound || !state.target.connected || !state.target.active || !state.target.composerReady) {
    state.targetPhase = "preview-only";
    setStatus("英文已生成；目标 Claude 标签页未就绪，仅保留预览", "ready");
    updateDraftUI();
    return false;
  }

  const idleRemaining = state.settings.writeIdleGuardMs - (Date.now() - state.lastInputAt);
  if (idleRemaining > 0) {
    try {
      await sleep(idleRemaining + 20, signal);
    } catch (error) {
      if (error?.name === "AbortError") return false;
      throw error;
    }
  }
  if (!operationIsCurrent() || !revisionIsCurrent()) return false;
  if (!targetContextMatches(initialIdentity, state.target)) {
    state.targetPhase = "preview-only";
    setStatus("写入前 Claude 目标已变化；本次仅保留英文预览", "paused");
    addDiagnostic("写入护栏等待期间目标变化，已取消写入");
    updateDraftUI();
    return false;
  }

  // An in-flight explicit clear and a fresh write must never race with the
  // same old targetEpoch: wait for a started clear to finish before taking
  // the write CAS snapshot.
  if (state.clearPromise) {
    try {
      await state.clearPromise;
    } catch {
      // The following identity/epoch/readiness checks decide whether writing is
      // still safe; a failed cleanup is not by itself permission to overwrite.
    }
  }
  if (!operationIsCurrent() || !revisionIsCurrent()) return false;
  if (state.paused && !forceOverwrite) {
    // Never drop an explicit sync silently: without a status update the
    // 同步 button appears dead while paused, and the off-back-translation
    // flow would leave "正在准备同步…" on screen forever.
    setStatus("已暂停：英文未写入 Claude，点“恢复”后可同步", "paused");
    updateDraftUI();
    return false;
  }
  if (state.targetPhase === "manual" && !forceOverwrite) {
    // Kept manual text is never overwritten silently — but automation keeps
    // running: the fresh English stays in the preview and one explicit
    // 同步 click (with its own confirm) performs the overwrite.
    setStatus("英文已生成但未写入：Claude 输入框保留着你的人工文本；点“同步到 Claude”可覆盖", "ready");
    updateDraftUI();
    return false;
  }
  if (!targetContextMatches(initialIdentity, state.target)) {
    state.targetPhase = "preview-only";
    setStatus("清理旧译文期间 Claude 目标已变化；本次仅保留预览", "paused");
    updateDraftUI();
    return false;
  }
  if (!state.target.bound || !state.target.connected || !state.target.active || !state.target.composerReady) {
    state.targetPhase = "preview-only";
    setStatus("英文已生成；目标 Claude 标签页未就绪，仅保留预览", "ready");
    updateDraftUI();
    return false;
  }

  const writeTargetContext = targetContextSnapshot();
  const previousPanelFocus = capturePanelFocus();
  state.targetPhase = "syncing";
  setStatus("正在写入 Claude…", "syncing");
  const result = await requestWriter("WRITE_TARGET", {
    text: englishToWrite,
    expectedTabId: writeTargetContext.tabId,
    expectedWriterSession: writeTargetContext.writerSession,
    expectedTargetEpoch: writeTargetContext.targetEpoch,
    force: Boolean(forceOverwrite),
    allowFocus: Boolean(state.settings.allowFocusWrite)
  }, 9000);
  restorePanelFocus(previousPanelFocus, result.focusUsed);

  const resultEpoch = Number.isInteger(result.targetEpoch) ? result.targetEpoch : null;
  const sameTargetIdentity = targetContextMatches(
    { tabId: writeTargetContext.tabId, writerSession: writeTargetContext.writerSession },
    state.target
  );
  const responseSessionMatches =
    !result.writerSession || result.writerSession === writeTargetContext.writerSession;
  const successEpochMatches =
    result.ok && resultEpoch === writeTargetContext.targetEpoch + 1;
  const failureEpochMatches =
    !result.ok
    && (
      resultEpoch === writeTargetContext.targetEpoch
      || resultEpoch === state.target.targetEpoch
      || resultEpoch === null
    );
  const currentEpochCompatible =
    state.target.targetEpoch === writeTargetContext.targetEpoch
    || (resultEpoch !== null && state.target.targetEpoch === resultEpoch);

  if (
    !sameTargetIdentity
    || !responseSessionMatches
    || !currentEpochCompatible
    || (!successEpochMatches && !failureEpochMatches)
  ) {
    // TARGET_MANUAL_EDIT / TARGET_WRITE_RECOVERY_FAILED is emitted before the
    // corresponding command result. Preserve that stronger state instead of
    // replacing it with a generic preview-only status.
    if (state.targetPhase !== "manual") {
      state.targetPhase = "preview-only";
      setStatus("写入响应返回前 Claude 目标已变化；未采用旧响应", "paused");
      addDiagnostic("Writer 响应与当前标签页、会话或输入框版本不一致，已忽略");
      updateDraftUI();
    }
    return false;
  }

  if (!operationIsCurrent()) {
    if (successEpochMatches) {
      state.target.writerSession = result.writerSession || state.target.writerSession;
      state.target.targetEpoch = resultEpoch;
      state.target.pluginOwned = true;
      state.target.strategy = result.strategy;
      state.target.currentText = result.readback;
      state.targetPhase = "stale-uncleared";
      setStatus("操作取消时写入已完成；请核对 Claude 输入框", "paused");
      updateStaleBanner("你在写入过程中暂停或切换了上下文，但英文可能已经写入 Claude。插件已停止后续操作，请人工核对。");
      addDiagnostic("写入返回时操作已被取消；保留实际目标状态并停止自动流程");
    }
    updateTargetUI();
    updateDraftUI();
    return false;
  }

  if (!revisionIsCurrent()) {
    if (successEpochMatches) {
      state.target.writerSession = result.writerSession || state.target.writerSession;
      state.target.targetEpoch = resultEpoch;
      state.target.pluginOwned = true;
      state.target.strategy = result.strategy;
      state.target.currentText = result.readback;
      state.targetPhase = "stale-uncleared";
      // v0.2.12: no automatic deletion — the newer translation in flight will
      // simply replace this plugin-owned text on its own sync.
      addDiagnostic("中文在 Writer 响应返回前已变化；旧英文保留，等待新译文覆盖");
      updateStaleBanner("刚写入的英文对应旧版中文；新译文完成后会直接覆盖。");
    } else if (state.targetPhase !== "manual") {
      state.targetPhase = "stale";
    }
    setStatus("中文在写入期间已变化；旧英文未标记为同步", "paused");
    updateTargetUI();
    updateDraftUI();
    return false;
  }

  if (successEpochMatches) {
    state.target.writerSession = result.writerSession || state.target.writerSession;
    state.target.targetEpoch = resultEpoch;
    state.target.pluginOwned = true;
    state.target.strategy = result.strategy;
    state.target.currentText = result.readback;
    state.targetPhase = "synced";
    state.draft.lastSyncedAt = Date.now();
    state.draft.lastSyncedEnglish = englishToWrite;
    hideManualBanner();
    setStatus(`已同步到 Claude${result.focusUsed ? "（使用了短暂聚焦写入）" : ""}`, "synced");
    addDiagnostic(`写入成功：${result.strategy}${result.focusUsed ? "，使用焦点" : "，无焦点"}`);
    schedulePersist();
    updateTargetUI();
    updateDraftUI();
    return true;
  }

  if (state.targetPhase === "manual") {
    addDiagnostic(`Writer 已进入人工核对状态：${result.code || "manual"}`);
    updateTargetUI();
    updateDraftUI();
    return false;
  }

  if (result.code === "manual_edit") {
    const textResult = await requestWriter("GET_TARGET_TEXT", {
      expectedWriterSession: writeTargetContext.writerSession,
      expectedTargetEpoch: resultEpoch ?? state.target.targetEpoch
    });
    showManualBanner(textResult.ok ? textResult.text : state.target.currentText);
  } else if (["write_failed_not_restored", "write_interrupted"].includes(result.code)) {
    state.target.targetEpoch = resultEpoch ?? state.target.targetEpoch;
    state.target.pluginOwned = false;
    pauseAutomation("incident");
    state.targetPhase = "manual";
    setStatus("写入被中断或未能完整恢复，请人工核对 Claude 输入框", "error");
    void requestWriter("REQUEST_WRITER_STATE", {});
  } else if (result.code === "target_inactive") {
    state.target.active = false;
    state.targetPhase = "preview-only";
    setStatus("目标标签页不在前台，英文仅保留在预览区", "paused");
  } else if ([
    "target_changed",
    "writer_session_changed",
    "target_epoch_changed",
    "target_changed_during_write"
  ].includes(result.code)) {
    state.targetPhase = "stale";
    setStatus("Claude 输入框在写入前或写入中发生变化，本次未覆盖", "paused");
    void requestWriter("REQUEST_WRITER_STATE", {});
  } else if (result.code === "write_failed_rolled_back") {
    state.targetPhase = "write-failed";
    setStatus("自动写入未通过校验，已恢复 Claude 原内容", "error");
  } else if (result.code === "focus_write_disabled") {
    state.targetPhase = "preview-only";
    setStatus("当前富文本输入框需要聚焦写入；完成页面诊断后可在设置中启用", "paused");
  } else if (result.code === "protected_content_present") {
    state.targetPhase = "preview-only";
    setStatus("Claude 输入框含附件或不可安全替换的富文本；请复制英文后手动粘贴", "paused");
  } else {
    state.targetPhase = "write-failed";
    setStatus("自动写入失败，请使用复制英文或页面诊断", "error");
  }
  addDiagnostic(`写入失败：${result.code || "unknown"}`);
  updateTargetUI();
  updateDraftUI();
  return false;
}

function scheduleBackTranslation(
  revision,
  english,
  providerContext = providerContextSnapshot(),
  { kind = "independent", useDelay = true } = {}
) {
  state.backController?.abort();
  const controller = new AbortController();
  state.backController = controller;
  state.backPhase = useDelay ? "waiting" : "working";
  state.draft.backTranslation = "";
  state.draft.backTranslationKind = kind;
  updateDraftUI();

  void (async () => {
    try {
      if (useDelay) {
        await sleep(providerContext.settings.backTranslateDelayMs, controller.signal);
      }
      if (
        controller.signal.aborted
        || revision !== state.sourceRevision
        || english !== state.draft.english
        || !providerContextIsCurrent(providerContext)
      ) return;

      const [apiKey, permitted] = await Promise.all([
        getActiveSecret(providerContext.provider),
        hasProviderPermission(providerContext.provider.baseUrl)
      ]);
      if (
        controller.signal.aborted
        || revision !== state.sourceRevision
        || english !== state.draft.english
        || !providerContextIsCurrent(providerContext)
      ) return;
      if (!apiKey) throw new Error("没有可用的 API Key");
      if (!permitted) throw new Error("Provider 域名权限已缺失");

      if (
        controller.signal.aborted
        || revision !== state.sourceRevision
        || english !== state.draft.english
        || !providerContextIsCurrent(providerContext)
      ) return;
      state.backPhase = "working";
      setStatus(
        kind === "manual_independent"
          ? "正在独立回译人工英文…"
          : "英文已就绪，正在独立回译…",
        "back-translating"
      );
      updateDraftUI();

      const result = await backTranslate({
        english,
        sourceForWarnings: state.draft.source,
        protectedTerms: providerContext.settings.protectedTerms,
        config: providerContext.config,
        apiKey,
        model: providerContext.modelBackTranslate,
        signal: controller.signal
      });
      if (
        controller.signal.aborted
        || revision !== state.sourceRevision
        || !providerContextIsCurrent(providerContext)
      ) return;
      if (english !== state.draft.english) return;
      applyCapabilityPatch(result.capabilityPatch, providerContext);
      state.draft.backTranslation = result.chinese;
      state.draft.backTranslationKind = kind;
      state.draft.warnings = [...new Set([
        ...state.draft.warnings,
        ...(result.warnings ?? [])
      ])];
      state.draft.updatedAt = Date.now();
      state.backPhase = "ready";
      if (kind === "manual_independent") {
        setStatus("人工英文独立回译完成；自动同步仍暂停", "paused");
      } else {
        setStatus(state.targetPhase === "synced" ? "已同步；独立回译完成" : "独立回译完成，请核对", "ready");
      }
      schedulePersist();
      updateDraftUI();
    } catch (error) {
      if (
        controller.signal.aborted
        || error?.name === "AbortError"
        || revision !== state.sourceRevision
        || !providerContextIsCurrent(providerContext)
      ) return;
      state.backPhase = "error";
      if (error instanceof ProviderError && error.code === "rate_limited") {
        startCooldown(error, providerContext);
      } else {
        setStatus(`英文已保留，但回译失败：${providerErrorMessage(error)}`, "error");
      }
      addDiagnostic(`回译失败：${providerDiagnosticDetail(error)}`);
      updateDraftUI();
    } finally {
      if (state.backController === controller) state.backController = null;
    }
  })();
}

function handleSourceChange() {
  const value = ui.sourceText.value;
  if (value === state.draft.source) return;
  // Trailing whitespace/blank-line edits do not change what gets translated:
  // every comparison that matters normalizes first. Keeping the revision
  // stable preserves current English, keeps any in-flight request adoptable,
  // and skips an entire paid re-translation for a semantically no-op edit.
  if (normalizeText(value) === normalizeText(state.draft.source)) {
    state.draft.source = value;
    state.draft.updatedAt = Date.now();
    state.lastInputAt = Date.now();
    schedulePersist();
    updateDraftUI();
    return;
  }
  state.sourceRevision += 1;
  state.lastInputAt = Date.now();
  state.literalFragments.clear();
  state.draft.source = value;
  state.draft.sourceRevision = state.sourceRevision;
  state.draft.updatedAt = Date.now();
  abortInFlight();
  // Typing new Chinese is the clearest "keep going" signal there is. It lifts
  // system pauses only — an Esc/暂停 pause, an open manual-edit banner and an
  // unverified write incident all still require their explicit resolution.
  resumeSystemPause("输入了新内容");

  if (state.draft.english) {
    if (state.targetPhase === "manual") {
      state.targetPhase = "manual";
    } else if (state.target.pluginOwned) {
      // v0.2.12: the old translation stays in Claude untouched until the NEW
      // translation replaces it. Automatic deletion is retired — nothing the
      // user can see disappears without an explicit button press.
      state.targetPhase = "stale-uncleared";
    } else {
      state.targetPhase = "stale";
    }
  }

  if (!value.trim()) {
    state.draft.english = "";
    state.draft.backTranslation = "";
    state.draft.backTranslationKind = "";
    state.backPhase = "idle";
    state.draft.corrections = [];
    state.draft.ambiguities = [];
    state.draft.warnings = [];
    state.draft.englishSourceRevision = null;
    state.translatePhase = "idle";
    state.backPhase = currentBackTranslationMode() === BACK_TRANSLATION_MODES.OFF ? "off" : "idle";
    setStatus("草稿为空", "idle");
  } else {
    setStatus("输入中…", "typing");
  }
  schedulePersist();
  updateDraftUI();
  scheduleTranslation();
}

async function archiveAndReset(sentText) {
  const hasContent = state.draft.source.trim() || String(sentText ?? "").trim();
  if (hasContent) {
    const sentMatchesPreview = normalizeText(sentText) === normalizeText(state.draft.english);
    const archived = {
      id: randomId("history"),
      timestamp: Date.now(),
      source: state.draft.source,
      english: String(sentText ?? state.draft.english),
      backTranslation: sentMatchesPreview ? state.draft.backTranslation : "",
      backTranslationKind: sentMatchesPreview ? state.draft.backTranslationKind : "",
      providerName: state.draft.providerName || state.provider.name,
      model: state.draft.model || state.provider.modelTranslate,
      note: sentMatchesPreview ? "" : "最终发送前曾在 Claude 输入框中人工修改；历史记录保留实际发送英文，但不沿用旧回译。"
    };
    state.history.unshift(archived);
    state.history = state.history.slice(0, 20);
  }

  // Reset synchronously before the first await. Otherwise a fast typist could
  // begin the next draft while history storage is pending and have that new
  // text cleared when this function resumes.
  abortInFlight();
  state.sourceRevision += 1;
  state.draft = createEmptyDraft();
  state.draft.sourceRevision = state.sourceRevision;
  state.literalFragments.clear();
  state.translatePhase = "idle";
  state.backPhase = currentBackTranslationMode() === BACK_TRANSLATION_MODES.OFF ? "off" : "idle";
  state.targetPhase = "empty";
  resumeAutomation();
  hideManualBanner();
  setStatus("检测到可信发送；旧稿已归档，新草稿已建立", "idle");
  updateDraftUI({ preserveSourceSelection: false });
  renderHistory();
  addDiagnostic("可信发送意图后输入框清空：草稿已归档");
  ui.sourceText.focus({ preventScroll: true });

  const historySnapshot = clone(state.history);
  const emptyDraftSnapshot = clone(state.draft);
  await Promise.all([
    persistHistorySnapshot(historySnapshot),
    persistDraftSnapshot(emptyDraftSnapshot)
  ]);
}

async function archiveUncertainSend(sentText, details = {}) {
  abortInFlight();
  // Invalidate any WRITE_TARGET command already queued in the service worker.
  // The Chinese draft is intentionally preserved, but its previous English is
  // no longer considered current after an uncertain send.
  state.sourceRevision += 1;
  state.draft.sourceRevision = state.sourceRevision;
  state.draft.updatedAt = Date.now();
  const hasContent = state.draft.source.trim() || String(sentText ?? "").trim();
  if (hasContent) {
    const sentMatchesPreview = normalizeText(sentText) === normalizeText(state.draft.english);
    const archived = {
      id: randomId("history"),
      timestamp: Date.now(),
      source: state.draft.source,
      english: String(sentText ?? ""),
      backTranslation: sentMatchesPreview ? state.draft.backTranslation : "",
      backTranslationKind: sentMatchesPreview ? state.draft.backTranslationKind : "",
      providerName: state.draft.providerName || state.provider.name,
      model: state.draft.model || state.provider.modelTranslate,
      uncertain: true,
      note: "检测到可信发送，但发送内容与当前中文版本或侧栏译文不完全一致；活动中文草稿已保留。"
    };
    state.history.unshift(archived);
    state.history = state.history.slice(0, 20);
  }

  pauseAutomation("system");
  state.targetPhase = "empty";
  state.draft.warnings = [...new Set([
    ...state.draft.warnings,
    "刚才发送的英文与当前中文或侧栏译文版本不完全一致；中文原稿已保留，请核对历史记录"
  ])];
  hideManualBanner();
  setStatus("检测到发送，但版本一致性无法确认；中文草稿已保留（继续输入即自动恢复）", "error");
  updateDraftUI();
  updateStaleBanner("已发送的英文与当前中文/译文版本不完全一致。为防止丢稿，中文原稿没有清空；请核对历史记录后再继续。");
  renderHistory();
  addDiagnostic(
    `发送一致性未确认：source=${details.sourceVersionMatches ? "current" : "stale"}, preview=${details.sentMatchesPreview ? "match" : "mismatch"}, manual=${details.sentMatchesManualTarget ? "match" : "mismatch"}`
  );

  await Promise.all([
    persistHistorySnapshot(state.history),
    persistDraftSnapshot(state.draft)
  ]);
}

async function clearCurrentDraft() {
  const hasDraftContent = Boolean(
    state.draft.source.trim()
    || state.draft.english.trim()
    || state.draft.backTranslation.trim()
  );
  if (hasDraftContent && !confirm("清空当前中文、英文和回译？最近已发送草稿不会受影响。")) return;
  const revisionAtClick = state.sourceRevision;
  abortInFlight();
  let clearResult = null;
  if (state.target.pluginOwned) {
    clearResult = await clearStaleTargetOwned({
      allowFocus: Boolean(state.settings.allowFocusWrite)
    });
  }
  if (state.sourceRevision !== revisionAtClick) {
    setStatus("清空期间中文原稿发生了变化，本次清空已取消", "paused");
    updateDraftUI();
    return;
  }

  const remainingTargetText = normalizeText(state.target.currentText);
  const targetStillContainsText = Boolean(remainingTargetText) || state.target.pluginOwned;
  state.sourceRevision += 1;
  state.draft = createEmptyDraft();
  state.draft.sourceRevision = state.sourceRevision;
  state.literalFragments.clear();
  state.translatePhase = "idle";
  state.backPhase = currentBackTranslationMode() === BACK_TRANSLATION_MODES.OFF ? "off" : "idle";
  if (!targetStillContainsText) {
    resumeAutomation();
    state.targetPhase = "empty";
    hideManualBanner();
    setStatus("当前草稿已清空", "idle");
    updateDraftUI({ preserveSourceSelection: false });
  } else if (!state.target.pluginOwned && remainingTargetText) {
    // A recovery/manual-edit event may have arrived while the clear request was
    // in flight. Never overwrite that stronger safety state with an empty,
    // unpaused UI merely because the side-panel draft itself was reset.
    showManualBanner(remainingTargetText);
    setStatus("侧栏草稿已清空，但 Claude 输入框仍有内容；自动同步保持暂停", "error");
    updateDraftUI({ preserveSourceSelection: false });
  } else {
    pauseAutomation("system");
    state.targetPhase = "stale-uncleared";
    hideManualBanner();
    setStatus("侧栏草稿已清空，但 Claude 中仍保留旧英文（继续输入即自动恢复）", "error");
    updateDraftUI({ preserveSourceSelection: false });
    updateStaleBanner(
      clearResult?.code === "protected_content_present"
        ? "Claude 输入框中含附件或不可安全替换的内容，插件没有清除它。请人工核对并清空后再继续。"
        : "侧栏草稿已经清空，但 Claude 中仍可能保留插件上次写入的英文。请先手动清空 Claude 输入框，再继续。"
    );
  }
  ui.sourceText.focus({ preventScroll: true });
  await persistDraftSnapshot(state.draft);
}

async function copyEnglish() {
  if (!state.draft.english) return;
  try {
    await navigator.clipboard.writeText(state.draft.english);
    setStatus("英文已复制到剪贴板", "ready");
  } catch {
    const activeElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const selectionStart = ui.englishText.selectionStart;
    const selectionEnd = ui.englishText.selectionEnd;
    ui.englishText.removeAttribute("readonly");
    ui.englishText.focus({ preventScroll: true });
    ui.englishText.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    ui.englishText.setAttribute("readonly", "");
    try {
      ui.englishText.setSelectionRange(selectionStart, selectionEnd);
    } catch {
      // Selection restoration is best effort.
    }
    if (activeElement?.isConnected) activeElement.focus({ preventScroll: true });
    setStatus(
      copied ? "英文已复制到剪贴板" : "自动复制失败，请在英文预览中手动全选复制",
      copied ? "ready" : "error"
    );
  }
}

function presetValues(preset) {
  if (preset === "xai") return { name: "xAI", baseUrl: "https://api.x.ai/v1" };
  if (preset === "openai") return { name: "OpenAI", baseUrl: "https://api.openai.com/v1" };
  return { name: "自定义 Provider", baseUrl: "" };
}

function invalidateFormRequests() {
  state.formRequestEpoch += 1;
  state.formController?.abort();
  state.formController = null;
  ui.detectModelsButton.disabled = false;
  ui.testProviderButton.disabled = false;
}

function beginFormRequest(button) {
  invalidateFormRequests();
  const controller = new AbortController();
  const epoch = state.formRequestEpoch;
  state.formController = controller;
  button.disabled = true;
  return { controller, epoch, button };
}

function formRequestIsCurrent(request) {
  return Boolean(
    request
    && !request.controller.signal.aborted
    && request.controller === state.formController
    && request.epoch === state.formRequestEpoch
  );
}

function finishFormRequest(request) {
  if (!formRequestIsCurrent(request)) return;
  state.formController = null;
  request.button.disabled = false;
}

const REASONING_DIALECT_LABELS = {
  none: "不发送（未知反代的安全默认）",
  openai_chat: "OpenAI Chat（顶层 reasoning_effort）",
  openai_responses: "OpenAI Responses（reasoning.effort）",
  openrouter: "OpenRouter（reasoning.effort）",
  deepseek: "DeepSeek（thinking.type，档位映射 high/max）",
  thinking_type: "通用 thinking.type（GLM 等）",
  enable_thinking: "通用 enable_thinking（Qwen 等，仅开关）"
};

function populateReasoningDialects(selected) {
  const transport = ui.apiProtocol.value === "responses" ? "responses" : "chat_completions";
  const allowed = reasoningDialectsForTransport(transport);
  clearElement(ui.reasoningDialect);
  for (const dialect of allowed) {
    const option = document.createElement("option");
    option.value = dialect;
    option.textContent = REASONING_DIALECT_LABELS[dialect] ?? dialect;
    ui.reasoningDialect.append(option);
  }
  ui.reasoningDialect.value = allowed.includes(selected) ? selected : "none";
}

function updateReasoningControls() {
  const mode = ui.reasoningMode.value;
  const transport = ui.apiProtocol.value === "responses" ? "responses" : "chat_completions";
  ui.reasoningDetails.classList.toggle("hidden", mode === "inherit");
  ui.reasoningEffort.disabled = mode !== "manual";

  if (mode === "inherit") {
    ui.reasoningPreview.textContent = "不发送任何思考字段，完全继承接口默认行为。";
    return;
  }
  const reasoning = {
    dialect: ui.reasoningDialect.value,
    mode,
    effort: ui.reasoningEffort.value
  };
  if (reasoning.dialect === "none") {
    ui.reasoningPreview.textContent = "尚未选择思考参数方言：当前不会发送任何思考字段。请按你的接口/反代文档选择方言。";
    return;
  }
  const resolved = applyReasoning({}, transport, reasoning);
  const parts = [];
  if (resolved.emitted.length) parts.push(`将发送：${resolved.emitted.join("，")}`);
  if (resolved.removed.length) parts.push(`将移除：${resolved.removed.join("，")}`);
  parts.push(...resolved.notes);
  ui.reasoningPreview.textContent = parts.join("；") || "本次不会发送思考字段。";
}

function fillSettingsForm() {
  ui.providerPreset.value = state.provider.preset || "custom";
  ui.providerName.value = state.provider.name || "";
  ui.baseUrl.value = state.provider.baseUrl || "";
  ui.apiProtocol.value = state.provider.apiProtocol === "responses"
    ? "responses"
    : "chat_completions";
  {
    const reasoning = normalizeReasoning(state.provider.reasoning);
    ui.reasoningMode.value = reasoning.mode;
    ui.reasoningEffort.value = reasoning.effort;
    populateReasoningDialects(reasoning.dialect);
    updateReasoningControls();
  }
  ui.authHeader.value = state.provider.authHeader || "Authorization";
  ui.authPrefix.value = state.provider.authPrefix ?? "Bearer";
  ui.keyStorage.value = state.provider.keyStorage || "local";
  ui.extraHeaders.value = Object.keys(state.provider.extraHeaders ?? {}).length
    ? JSON.stringify(state.provider.extraHeaders, null, 2)
    : "";
  ui.modelTranslate.value = state.provider.modelTranslate || "";
  ui.backTranslationMode.value = currentBackTranslationMode();
  ui.modelBackTranslate.value = state.provider.modelBackTranslate || "";
  updateBackSettingsVisibility();
  ui.debounceMs.value = state.settings.debounceMs;
  ui.longTextThreshold.value = state.settings.longTextThreshold;
  ui.requestTimeoutMs.value = state.settings.requestTimeoutMs;
  ui.backTranslateDelayMs.value = state.settings.backTranslateDelayMs;
  ui.streamPreview.checked = Boolean(state.settings.streamPreview);
  ui.strictReviewGate.checked = Boolean(state.settings.strictReviewGate);
  ui.allowFocusWrite.checked = Boolean(state.settings.allowFocusWrite);
  ui.protectedTerms.value = (state.settings.protectedTerms ?? []).join("\n");
  ui.apiKey.value = "";
  ui.providerTestResult.textContent = "";
  const providerSnapshot = clone(state.provider);
  const providerEpoch = state.providerEpoch;
  void getActiveSecret(providerSnapshot).then((secret) => {
    if (!ui.settingsDialog.open || ui.apiKey.value || providerEpoch !== state.providerEpoch) return;
    try {
      if (!formProviderMatchesStoredSecret(providerFromForm())) return;
    } catch {
      return;
    }
    ui.apiKey.placeholder = maskSecret(secret) || "粘贴 API Key";
  }).catch(() => undefined);
}

function openSettings() {
  // A re-entrant call while the dialog is already open (e.g. a debounce-fired
  // translateNow hitting a missing-config path) must not reset the form the
  // user is editing, abort their in-flight detect/test request, or throw
  // InvalidStateError from showModal().
  if (ui.settingsDialog.open) return;
  invalidateFormRequests();
  state.externalConfigurationChanged = false;
  fillSettingsForm();
  ui.settingsDialog.showModal();
}

function parseExtraHeadersInput() {
  const text = ui.extraHeaders.value.trim();
  if (!text) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("额外请求头必须是合法 JSON 对象");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("额外请求头必须是 JSON 对象");
  }
  return sanitizeExtraHeaders(value, ui.authHeader.value);
}

function providerFromForm() {
  const baseUrl = normalizeBaseUrl(ui.baseUrl.value);
  const apiProtocol = ui.apiProtocol.value === "responses"
    ? "responses"
    : "chat_completions";
  const reasoning = normalizeReasoning({
    dialect: ui.reasoningDialect.value,
    mode: ui.reasoningMode.value,
    effort: ui.reasoningEffort.value
  });
  if (reasoning.mode !== "inherit" && reasoning.dialect === "none") {
    throw new Error("思考策略需要选择“思考参数方言”，或将策略改回“继承接口默认”");
  }
  if (!reasoningDialectsForTransport(apiProtocol).includes(reasoning.dialect)) {
    throw new Error("所选思考参数方言与当前接口协议不匹配");
  }
  const modelTranslate = ui.modelTranslate.value.trim();
  const modelBackTranslate = ui.modelBackTranslate.value.trim() || modelTranslate;
  const authHeader = ui.authHeader.value.trim() || "Authorization";
  const authPrefix = ui.authPrefix.value.trim();
  if ([...modelTranslate].length > 240 || [...modelBackTranslate].length > 240) {
    throw new Error("模型 ID 过长，请检查配置");
  }
  if (authHeader.length > 128 || authPrefix.length > 128) {
    throw new Error("鉴权 Header 或 Key 前缀过长");
  }
  // Learned capabilities are endpoint-behavior: the same gateway may accept
  // response_format on /chat/completions and reject text.format on
  // /responses, so the protocol is part of the capability identity.
  const signature = `${baseUrl}\n${modelTranslate}\n${apiProtocol}`;
  let capabilities = clone(DEFAULT_PROVIDER.capabilities);
  // Carry over only what is actually persisted for this exact target. Reading
  // state.provider.capabilities here would leak runtime-learned degradations
  // (applyCapabilityPatch keeps them in-memory by design) into any ordinary
  // settings save; only an explicit connection test may persist new learning,
  // via the formCapabilities override below.
  if (signature === state.persistedCapabilitySignature && state.persistedCapabilities) {
    capabilities = clone(state.persistedCapabilities);
  }
  if (signature === state.formCapabilitySignature && state.formCapabilities) {
    capabilities = clone(state.formCapabilities);
  }

  const provider = {
    ...state.provider,
    preset: ui.providerPreset.value,
    name: ui.providerName.value.trim() || "Provider",
    baseUrl,
    apiProtocol,
    reasoning,
    keyStorage: ui.keyStorage.value,
    authHeader,
    authPrefix,
    modelTranslate,
    modelBackTranslate,
    extraHeaders: parseExtraHeadersInput(),
    capabilities
  };
  // Validate the authentication header before saving or making a request. A
  // custom header must never be allowed to replace Content-Type or Accept.
  buildHeaders(provider, "validation-key");
  return provider;
}

function settingsFromForm() {
  return {
    ...state.settings,
    automationMode: ui.automationMode.value === "manual" || ui.automationMode.value === "auto_translate"
      ? ui.automationMode.value
      : "auto_sync",
    autoSync: ui.automationMode.value !== "manual",
    backTranslationMode: normalizeBackTranslationMode(ui.backTranslationMode.value),
    debounceMs: clampInteger(ui.debounceMs.value, 200, 2000, DEFAULT_SETTINGS.debounceMs),
    longTextThreshold: clampInteger(ui.longTextThreshold.value, 500, 10000, DEFAULT_SETTINGS.longTextThreshold),
    requestTimeoutMs: clampInteger(ui.requestTimeoutMs.value, 5000, 120000, DEFAULT_SETTINGS.requestTimeoutMs),
    backTranslateDelayMs: clampInteger(ui.backTranslateDelayMs.value, 300, 5000, DEFAULT_SETTINGS.backTranslateDelayMs),
    streamPreview: ui.streamPreview.checked,
    strictReviewGate: ui.strictReviewGate.checked,
    allowFocusWrite: ui.allowFocusWrite.checked,
    protectedTerms: ui.protectedTerms.value
      .split(/\r?\n/)
      .map((term) => [...term.trim()].slice(0, 200).join(""))
      .filter(Boolean)
      .slice(0, 200)
  };
}

function formProviderMatchesStoredSecret(provider) {
  try {
    return providerCredentialBinding(state.provider) === providerCredentialBinding(provider);
  } catch {
    return false;
  }
}

function hasFormSecretCandidate(provider) {
  return Boolean(ui.apiKey.value.trim()) || formProviderMatchesStoredSecret(provider);
}

async function resolveFormSecret(provider) {
  const entered = ui.apiKey.value.trim();
  if (entered) return entered;
  return formProviderMatchesStoredSecret(provider)
    ? getSecretForProvider(state.provider)
    : "";
}

async function saveSettingsFromForm(event) {
  event.preventDefault();
  let newlyGrantedPattern = null;
  try {
    const provider = providerFromForm();
    const settings = settingsFromForm();
    if (
      state.externalConfigurationChanged
      && !confirm("另一个 Edge 窗口已修改 Provider 或翻译设置。继续保存会覆盖那边的配置，是否继续？")
    ) return;
    if (!hasFormSecretCandidate(provider)) {
      throw new Error("新 Provider 需要单独填写 API Key，插件不会跨域复用旧 Key");
    }
    invalidateFormRequests();
    invalidateRuntimeContext();
    // permissions.request() is invoked before any storage/network await so it
    // remains directly attributable to this explicit user click.
    const nextPattern = permissionPatternForBaseUrl(provider.baseUrl);
    const permissionPreviouslyGranted = chrome.permissions.contains({ origins: [nextPattern] })
      .catch(() => false);
    const permissionRequest = ensureProviderPermission(provider.baseUrl);
    const [hadPermission, permissionGranted] = await Promise.all([
      permissionPreviouslyGranted,
      permissionRequest
    ]);
    if (!permissionGranted) throw new Error("未授予 Provider 域名访问权限");
    if (!hadPermission) newlyGrantedPattern = nextPattern;
    const secret = await resolveFormSecret(provider);
    if (!secret) throw new Error("无法读取 API Key，请重新填写");
    // The stored Base URL may predate current validation rules (storage.js
    // documents this) and fail to normalize. That must not brick saving the
    // corrected URL from the form — it only means there is no valid previous
    // origin pattern to revoke.
    let previousPattern = null;
    try {
      previousPattern = permissionPatternForBaseUrl(state.provider.baseUrl);
    } catch {
      previousPattern = null;
    }
    const credentialId = randomId("credential");
    const providerToSave = { ...provider, credentialId };
    markExpectedConfigurationWrite(settings, providerToSave);
    const savedConfiguration = await persistConfiguration(
      settings,
      providerToSave,
      secret,
      credentialId
    );
    newlyGrantedPattern = null;
    if (previousPattern && previousPattern !== nextPattern) {
      await chrome.permissions.remove({ origins: [previousPattern] }).catch(() => false);
    }
    state.settings = savedConfiguration.settings;
    state.provider = savedConfiguration.provider;
    rememberPersistedCapabilities(savedConfiguration.provider);
    state.externalConfigurationChanged = false;
    // Keep the expected-write descriptor alive briefly. Chrome may deliver
    // storage.onChanged after the save promise resolves. It is signature- and
    // credential-specific, so unrelated external changes are still detected.
    updateProviderSummary();
    updateDraftUI();
    ui.settingsDialog.close();
    setStatus("设置已保存", "ready");
  } catch (error) {
    clearExpectedConfigurationWrite();
    if (newlyGrantedPattern) {
      await chrome.permissions.remove({ origins: [newlyGrantedPattern] }).catch(() => false);
    }
    ui.providerTestResult.textContent = error.message || "保存失败";
  }
}

function renderModelList() {
  clearElement(ui.modelList);
  const models = filterLikelyTextModels(state.detectedModels, ui.showAllModels.checked);
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    ui.modelList.append(option);
  }
  ui.providerTestResult.textContent = models.length
    ? `已检测 ${models.length} 个可显示模型；也可手工输入 ID`
    : "没有可显示模型，可直接手工输入模型 ID";
}

async function detectModelsFromForm() {
  const request = beginFormRequest(ui.detectModelsButton);
  ui.providerTestResult.textContent = "正在请求 /models…";
  try {
    const provider = providerFromForm();
    if (!hasFormSecretCandidate(provider)) throw new Error("请先填写 API Key");
    const granted = await ensureProviderPermission(provider.baseUrl);
    if (!formRequestIsCurrent(request)) return;
    if (!granted) throw new Error("未授予 Provider 域名权限");
    const secret = await resolveFormSecret(provider);
    if (!formRequestIsCurrent(request)) return;
    if (!secret) throw new Error("无法读取 API Key，请重新填写");
    const models = await listModels({
      config: { ...provider, timeoutMs: Number(ui.requestTimeoutMs.value) || 20000 },
      apiKey: secret,
      signal: request.controller.signal
    });
    if (!formRequestIsCurrent(request)) return;
    state.detectedModels = models;
    renderModelList();
    const filtered = filterLikelyTextModels(state.detectedModels, ui.showAllModels.checked);
    if (!ui.modelTranslate.value && filtered[0]) ui.modelTranslate.value = filtered[0];
    if (
      normalizeBackTranslationMode(ui.backTranslationMode.value) === BACK_TRANSLATION_MODES.INDEPENDENT
      && !ui.modelBackTranslate.value
      && ui.modelTranslate.value
    ) ui.modelBackTranslate.value = ui.modelTranslate.value;
  } catch (error) {
    if (error?.name !== "AbortError" && formRequestIsCurrent(request)) {
      ui.providerTestResult.textContent = providerFormErrorMessage(error) || error.message;
    }
  } finally {
    finishFormRequest(request);
  }
}

// After a failed explicit connection test, run at most two cheap follow-up
// probes to pinpoint WHERE the failure lives: the SSE route, the /v1/responses
// route, or the whole gateway. Never runs during automatic translation.
async function runProviderFailureProbes(error, context, request) {
  if (!context || !(error instanceof ProviderError)) return "";
  const status = Number(error.status);
  if (!(status >= 500 || status === 404 || status === 405)) return "";
  const probe = async (overrides = {}) => {
    try {
      await testTranslationConnection({
        config: { ...context.requestConfig, ...(overrides.config ?? {}) },
        apiKey: context.secret,
        model: context.model,
        backTranslationMode: BACK_TRANSLATION_MODES.OFF,
        streaming: Boolean(overrides.streaming),
        signal: request.controller.signal
      });
      return { ok: true };
    } catch (probeError) {
      if (probeError?.name === "AbortError") throw probeError;
      return { ok: false, error: probeError };
    }
  };
  try {
    ui.providerTestResult.textContent = "测试失败，正在定位原因（最多 2 次小请求）…";
    // ① Streamed request failed → same protocol, buffered.
    if (error.streamedRequest) {
      const buffered = await probe({ streaming: false });
      if (!formRequestIsCurrent(request)) return "";
      if (buffered.ok) {
        // Persist through the existing capability mechanism so 保存 makes the
        // live path degrade to buffered automatically.
        context.provider.capabilities = { ...context.provider.capabilities, streaming: false };
        state.formCapabilitySignature = `${context.provider.baseUrl}\n${context.provider.modelTranslate}\n${normalizedApiProtocol(context.provider)}`;
        state.formCapabilities = clone(context.provider.capabilities);
        return "同协议缓冲请求正常，仅流式(SSE)失败——已把此 Provider 标记为不支持流式，点“保存”后翻译会自动改走缓冲";
      }
    }
    // ② /v1/responses failed → same gateway, chat/completions.
    if (normalizedApiProtocol(context.requestConfig) === "responses") {
      const chat = await probe({ config: { apiProtocol: "chat_completions" }, streaming: false });
      if (!formRequestIsCurrent(request)) return "";
      if (chat.ok) {
        return `同网关 chat/completions 正常，仅 /v1/responses 失败（HTTP ${status}${
          error.remoteMessage ? `，网关消息：${error.remoteMessage}` : ""
        }）——请检查网关的 responses 路由/模型通道映射，或暂时切回 Chat Completions`;
      }
      const chatDetail = chat.error instanceof ProviderError
        ? `${chat.error.code}${Number.isFinite(chat.error.status) ? ` HTTP ${chat.error.status}` : ""}`
        : "失败";
      return `chat/completions 同样失败（${chatDetail}）——网关或网络整体异常，与接口协议无关`;
    }
  } catch (probeError) {
    if (probeError?.name !== "AbortError") {
      addDiagnostic(`失败定位探测中断：${String(probeError?.message || "probe_error").slice(0, 120)}`);
    }
    return "";
  }
  return "";
}

async function testProviderFromForm() {
  const request = beginFormRequest(ui.testProviderButton);
  ui.providerTestResult.textContent = "正在做真实翻译测试…";
  let probeContext = null;
  try {
    const provider = providerFromForm();
    if (!hasFormSecretCandidate(provider)) throw new Error("请先填写 API Key");
    if (!provider.modelTranslate) throw new Error("请填写主翻译模型 ID");
    const granted = await ensureProviderPermission(provider.baseUrl);
    if (!formRequestIsCurrent(request)) return;
    if (!granted) throw new Error("未授予 Provider 域名权限");
    const secret = await resolveFormSecret(provider);
    if (!formRequestIsCurrent(request)) return;
    if (!secret) throw new Error("无法读取 API Key，请重新填写");
    const started = performance.now();
    const backMode = normalizeBackTranslationMode(ui.backTranslationMode.value);
    const requestConfig = {
      ...provider,
      timeoutMs: Number(ui.requestTimeoutMs.value) || 20000
    };
    // Mirror the live transport: with 流式预览 on, real translations stream,
    // so the test must stream too or a broken SSE route passes the test and
    // then fails every real request.
    const mirrorStreaming = ui.streamPreview.checked && provider.capabilities?.streaming !== false;
    probeContext = {
      requestConfig,
      secret,
      model: provider.modelTranslate,
      provider,
      transportLabel: mirrorStreaming ? "流式" : "缓冲"
    };
    const result = await testTranslationConnection({
      config: requestConfig,
      apiKey: secret,
      model: provider.modelTranslate,
      backTranslationMode: backMode,
      streaming: mirrorStreaming,
      signal: request.controller.signal
    });
    if (!formRequestIsCurrent(request)) return;

    let capabilityPatch = { ...(result.capabilityPatch ?? {}) };
    let backPreviewText = result.backTranslation || "";
    if (backMode === BACK_TRANSLATION_MODES.INDEPENDENT) {
      const independentResult = await backTranslate({
        english: result.english,
        sourceForWarnings: "请只检查这段代码，不要重写整体结构。",
        config: {
          ...requestConfig,
          capabilities: {
            ...(requestConfig.capabilities ?? {}),
            ...capabilityPatch
          }
        },
        apiKey: secret,
        model: provider.modelBackTranslate || provider.modelTranslate,
        signal: request.controller.signal
      });
      if (!formRequestIsCurrent(request)) return;
      capabilityPatch = { ...capabilityPatch, ...(independentResult.capabilityPatch ?? {}) };
      backPreviewText = independentResult.chinese;
    }

    provider.capabilities = { ...provider.capabilities, ...capabilityPatch };
    state.formCapabilitySignature = `${provider.baseUrl}\n${provider.modelTranslate}\n${normalizedApiProtocol(provider)}`;
    state.formCapabilities = clone(provider.capabilities);
    const backPreview = backPreviewText
      ? ` / 回译：${backPreviewText.slice(0, 42)}`
      : "";
    const reasoningNote = Number.isFinite(result.reasoningTokens)
      ? ` · reasoning=${result.reasoningTokens}`
      : "";
    ui.providerTestResult.textContent = `通过 · ${Math.round(performance.now() - started)} ms · ${probeContext.transportLabel}${reasoningNote} · ${result.english.slice(0, 70)}${backPreview}`;
  } catch (error) {
    if (error?.name !== "AbortError" && formRequestIsCurrent(request)) {
      const baseMessage = providerFormErrorMessage(error) || error.message;
      ui.providerTestResult.textContent = baseMessage;
      const verdict = await runProviderFailureProbes(error, probeContext, request);
      if (!formRequestIsCurrent(request)) return;
      if (verdict) ui.providerTestResult.textContent = `${baseMessage} ｜ 诊断：${verdict}`;
    }
  } finally {
    finishFormRequest(request);
  }
}

function renderHistory() {
  clearElement(ui.historyList);
  if (state.history.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "当前会话还没有已发送草稿";
    ui.historyList.append(empty);
    return;
  }

  for (const item of state.history) {
    const card = document.createElement("article");
    card.className = `history-item${item.uncertain ? " history-item-warning" : ""}`;
    const meta = document.createElement("div");
    meta.className = "history-meta";
    const backKindLabel = backTranslationKindLabel(item.backTranslationKind);
    meta.textContent = `${item.uncertain ? "⚠ 一致性未确认 · " : ""}${timestampLabel(item.timestamp)} · ${item.providerName || "Provider"} · ${item.model || "模型"}${backKindLabel ? ` · ${backKindLabel}` : ""}`;
    const source = document.createElement("p");
    source.textContent = item.source || "（无中文原稿）";
    const note = document.createElement("p");
    note.className = "muted compact";
    note.textContent = item.note || "";
    note.classList.toggle("hidden", !item.note);
    const actions = document.createElement("div");
    actions.className = "button-row";
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "primary-button";
    restore.textContent = "恢复";
    restore.addEventListener("click", () => {
      abortInFlight();
      state.sourceRevision += 1;
      state.draft = normalizeDraft({
        ...createEmptyDraft(),
        source: item.source,
        english: item.english,
        backTranslation: item.backTranslation,
        backTranslationKind: item.backTranslationKind || (item.backTranslation ? "independent" : ""),
        sourceRevision: state.sourceRevision,
        englishSourceRevision: null,
        providerName: item.providerName,
        model: item.model
      });
      pauseAutomation("system");
      state.translatePhase = "idle";
      state.backPhase = state.draft.backTranslation
        ? "ready"
        : currentBackTranslationMode() === BACK_TRANSLATION_MODES.OFF
          ? "off"
          : "idle";
      state.targetPhase = state.target.pluginOwned ? "stale-uncleared" : "stale";
      schedulePersist();
      updateDraftUI({ preserveSourceSelection: false });
      setStatus("历史草稿已恢复；确认无误可直接编辑继续（输入即恢复自动流程）", "paused");
      ui.historyDialog.close();
      ui.sourceText.focus({ preventScroll: true });
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost-button";
    remove.textContent = "删除";
    remove.addEventListener("click", () => {
      state.history = state.history.filter((entry) => entry.id !== item.id);
      observeBackgroundTask(persistHistorySnapshot(state.history), "草稿历史");
      renderHistory();
    });
    actions.append(restore, remove);
    card.append(meta, source, note, actions);
    ui.historyList.append(card);
  }
}

function appendDefinition(term, value) {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = String(value);
  ui.diagnosticSummary.append(dt, dd);
}

function renderDiagnostics() {
  clearElement(ui.diagnosticSummary);
  appendDefinition("标签页", state.target.bound ? state.target.tabId : "未绑定");
  appendDefinition("前台状态", state.target.active ? "前台" : "非前台");
  appendDefinition("输入框", state.target.composerReady ? "已定位" : "未定位");
  appendDefinition("Writer Session", state.target.writerSession || "无");
  appendDefinition("Target Epoch", state.target.targetEpoch);
  appendDefinition("当前策略", state.target.strategy || "尚未写入");
  appendDefinition("富文本需聚焦", state.target.requiresFocusWrite ? "是" : "否");
  appendDefinition("插件拥有目标", state.target.pluginOwned ? "是" : "否");

  clearElement(ui.diagnosticLog);
  for (const entry of state.diagnostics.slice(0, 20)) {
    const item = document.createElement("li");
    item.textContent = `${timestampLabel(entry.timestamp)} · ${entry.message}`;
    ui.diagnosticLog.append(item);
  }
}

async function refreshDiagnostics() {
  const result = await requestWriter("REQUEST_WRITER_STATE", {});
  if (!result.ok) addDiagnostic(`状态刷新失败：${result.code || "unknown"}`);
  else {
    updateTargetFromWriterState({ writerSession: result.writerSession, state: result.state });
    addDiagnostic("已刷新 Claude 输入框状态");
  }
}

async function startManualBind() {
  const resultPromise = requestWriter("START_MANUAL_BIND", {}, 30000);
  setStatus("请切到 Claude 页面并点击真实输入框", "binding");
  const result = await resultPromise;

  if (result.ok && result.state?.composerReady) {
    updateTargetFromWriterState({
      writerSession: result.writerSession,
      state: result.state
    });
    setStatus("手动绑定完成并已稳定定位", "ready");
    addDiagnostic("用户手动选择的 Claude 输入节点在页面重渲染后仍存在，并保持可编辑属性");
    updateTargetUI();
    renderDiagnostics();
    return;
  }

  const refreshed = await requestWriter("REQUEST_WRITER_STATE", {});
  if (refreshed.ok) {
    updateTargetFromWriterState({
      writerSession: refreshed.writerSession,
      state: refreshed.state
    });
  }

  const code = result.code || "manual_bind_not_verified";
  setStatus(`手动绑定失败：${code}`, "error");
  addDiagnostic(`手动绑定未通过验证：${code}`);
  updateTargetUI();
  renderDiagnostics();
}

async function diagnosticWrite() {
  if (!state.target.bound || !state.target.active) {
    setStatus("请先绑定并切到目标 Claude 标签页", "error");
    return;
  }
  if (state.target.currentText && !state.target.pluginOwned) {
    if (!confirm("Claude 输入框已有人工内容。诊断写入会覆盖它，是否继续？")) return;
  }
  const text = `ZH2EN diagnostic — ${new Date().toISOString()} — visible text must equal sent text.`;
  const previousPanelFocus = capturePanelFocus();
  const result = await requestWriter("WRITE_TARGET", {
    text,
    expectedWriterSession: state.target.writerSession,
    expectedTargetEpoch: state.target.targetEpoch,
    force: true,
    allowFocus: state.settings.allowFocusWrite
  }, 9000);
  restorePanelFocus(previousPanelFocus, result.focusUsed);
  if (result.ok) {
    state.target.targetEpoch = result.targetEpoch;
    state.target.writerSession = result.writerSession;
    state.target.pluginOwned = true;
    state.target.strategy = result.strategy;
    state.target.currentText = result.readback;
    state.diagnosticActive = true;
    state.diagnosticText = text;
    // The composer no longer holds the draft's English (nor the user's manual
    // content after the confirmed overwrite above). Leaving targetPhase on
    // "synced" would keep a green 已同步 badge for text that is gone, and a
    // surviving manual banner would let 作为核对基线 adopt this diagnostic
    // sentence as if it were the user's English.
    state.targetPhase = "stale-uncleared";
    hideManualBanner();
    addDiagnostic(`诊断写入成功：${result.strategy}${result.focusUsed ? "（聚焦）" : "（无焦点）"}`);
    setStatus("诊断短句已写入；不会自动发送", "ready");
    updateDraftUI();
  } else {
    addDiagnostic(`诊断写入失败：${result.code || "unknown"}`);
    setStatus("诊断写入失败，请查看诊断记录", "error");
  }
  updateTargetUI();
  renderDiagnostics();
}

async function diagnosticClear() {
  const previousPanelFocus = capturePanelFocus();
  const result = await requestWriter("CLEAR_TARGET_IF_OWNED", {
    expectedWriterSession: state.target.writerSession,
    expectedTargetEpoch: state.target.targetEpoch,
    allowFocus: Boolean(state.settings.allowFocusWrite)
  });
  restorePanelFocus(previousPanelFocus, result.focusUsed);
  if (result.ok) {
    state.target.targetEpoch = result.targetEpoch;
    state.target.pluginOwned = false;
    state.target.currentText = "";
    state.diagnosticActive = false;
    state.diagnosticText = "";
    // The composer is empty now; a lingering "synced"/"stale-uncleared" phase
    // would misdescribe it (green badge or a stale-text banner with no text).
    state.targetPhase = "empty";
    addDiagnostic(`插件拥有的目标文字已清除${result.focusUsed ? "（短暂使用焦点）" : ""}`);
    setStatus("目标输入框已清除", "ready");
    updateDraftUI();
  } else {
    addDiagnostic(`清除失败：${result.code || "unknown"}`);
    setStatus(
      result.code === "focus_write_disabled"
        ? "当前富文本框需要聚焦清除；可在完成诊断后启用聚焦写入"
        : "只会清除插件最后写入且未被修改的文字",
      "error"
    );
  }
  updateTargetUI();
}

async function keepManualVersion() {
  // Downgrade the review pause to a system pause: the user has made their
  // choice, so the next Chinese edit resumes automation without a 恢复 click
  // (and only a NEW translation may overwrite the kept text).
  pauseAutomation("system");
  state.targetPhase = "manual";
  hideManualBanner();
  setStatus("已保留 Claude 中的人工英文；继续输入新内容将自动恢复同步", "paused");
  updateDraftUI();
}

async function useManualAsBaseline() {
  abortInFlight();
  const revisionAtClick = state.sourceRevision;
  const expectedTargetContext = targetContextSnapshot();
  const textResult = await requestWriter("GET_TARGET_TEXT", {
    expectedWriterSession: expectedTargetContext.writerSession,
    expectedTargetEpoch: expectedTargetContext.targetEpoch
  });
  if (
    !textResult.ok
    || revisionAtClick !== state.sourceRevision
    || !targetContextMatches(expectedTargetContext, state.target)
  ) {
    setStatus("无法读取 Claude 当前输入框", "error");
    return;
  }
  const baselineResult = await requestWriter("SET_BASELINE", {
    expectedWriterSession: expectedTargetContext.writerSession,
    expectedTargetEpoch: textResult.targetEpoch
  });
  if (
    !baselineResult.ok
    || revisionAtClick !== state.sourceRevision
    || !targetContextMatches(expectedTargetContext, state.target)
  ) {
    setStatus("无法建立人工基线", "error");
    return;
  }
  state.target.targetEpoch = baselineResult.targetEpoch;
  state.target.pluginOwned = false;
  state.target.currentText = textResult.text;
  state.draft.english = textResult.text;
  state.draft.englishSourceRevision = state.sourceRevision;
  state.draft.backTranslation = "";
  const backMode = normalizeBackTranslationMode(state.settings.backTranslationMode);
  state.draft.backTranslationKind = backMode === BACK_TRANSLATION_MODES.OFF
    ? BACK_TRANSLATION_MODES.OFF
    : "manual_independent";
  state.backPhase = backMode === BACK_TRANSLATION_MODES.OFF ? "off" : "idle";
  state.targetPhase = "manual";
  pauseAutomation("system");
  hideManualBanner();
  schedulePersist();
  updateDraftUI();
  setStatus(
    backMode === BACK_TRANSLATION_MODES.OFF
      ? "人工英文已作为基线；回译已关闭（继续输入即恢复自动流程）"
      : "人工英文已作为核对基线；不会被自动覆盖（继续输入即恢复自动流程）",
    "paused"
  );
  if (textResult.text && backMode !== BACK_TRANSLATION_MODES.OFF) {
    scheduleBackTranslation(state.sourceRevision, textResult.text, providerContextSnapshot(), {
      kind: "manual_independent",
      useDelay: false
    });
  }
}

function bindEvents() {
  chrome.storage.onChanged?.addListener?.(handleStorageChanges);
  ui.sourceText.addEventListener("compositionstart", () => {
    state.composing = true;
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
  });
  ui.sourceText.addEventListener("compositionend", () => {
    state.composing = false;
    handleSourceChange();
    scheduleTranslation();
  });
  ui.sourceText.addEventListener("input", () => {
    handleSourceChange();
  });
  ui.sourceText.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && event.ctrlKey) {
      event.preventDefault();
      resumeSystemPause("Ctrl+Enter 显式触发");
      void translateNow({ forceSync: true, forceOverwrite: false, reason: "shortcut" });
    } else if (event.key === "Escape") {
      event.preventDefault();
      // One-way by design: a panic keypress may only reduce automation. A
      // second Esc must never re-arm auto translate/sync — resuming requires
      // the explicit 恢复 button.
      if (state.paused) {
        // Escalate any softer pause to a user pause: pressing Esc while a
        // self-healing system pause is active means "stay stopped".
        state.pauseKind = "user";
        setStatus("已处于暂停状态；恢复请点击“恢复”按钮", "paused");
        return;
      }
      pauseAutomation("user");
      abortInFlight();
      setStatus("自动翻译与同步已暂停（Esc 仅暂停，恢复请点按钮）", "paused");
      updateDraftUI();
    }
  });

  ui.bindButton.addEventListener("click", () => void bindCurrentTab());
  ui.translateButton.addEventListener("click", () => {
    resumeSystemPause("点击翻译并同步");
    void translateNow({ forceSync: true, reason: "button" });
  });
  ui.pauseButton.addEventListener("click", () => {
    if (state.paused) resumeAutomation();
    else pauseAutomation("user");
    if (state.paused) abortInFlight();
    else scheduleTranslation();
    setStatus(state.paused ? "自动翻译与同步已暂停" : "自动翻译与同步已恢复", state.paused ? "paused" : "idle");
    updateDraftUI();
  });
  ui.clearDraftButton.addEventListener("click", () => {
    observeBackgroundTask(clearCurrentDraft(), "清空草稿");
  });
  ui.automationMode.addEventListener("change", () => {
    const mode = ["manual", "auto_translate", "auto_sync"].includes(ui.automationMode.value)
      ? ui.automationMode.value
      : "auto_sync";
    state.settings.automationMode = mode;
    state.settings.autoSync = mode !== "manual";
    observeBackgroundTask(persistSettings(state.settings), "设置");
    if (mode === "manual") abortInFlight();
    else {
      resumeSystemPause("切换自动化模式");
      scheduleTranslation();
    }
    setStatus(
      mode === "manual"
        ? "手动模式：不自动请求模型，点“翻译并同步”触发"
        : mode === "auto_translate"
          ? "自动翻译：停顿后请求模型，但不写入 Claude；点“同步到 Claude”写入"
          : "自动翻译并同步：停顿后请求模型并写入 Claude 输入框",
      "idle"
    );
  });
  ui.syncButton.addEventListener("click", async () => {
    resumeSystemPause("点击同步到 Claude");
    const force = state.targetPhase === "manual" || (state.target.currentText && !state.target.pluginOwned);
    if (force && !confirm("这会覆盖 Claude 输入框中的人工内容，是否继续？")) return;
    await syncEnglish({ forceOverwrite: force, revision: state.sourceRevision });
  });
  ui.copyEnglishButton.addEventListener("click", () => void copyEnglish());
  ui.clearTargetButton.addEventListener("click", () => void clearTargetExplicit());

  ui.keepManualButton.addEventListener("click", () => void keepManualVersion());
  ui.regenerateButton.addEventListener("click", () => {
    if (!confirm("将用最新中文重新翻译，并覆盖你在 Claude 输入框中的人工修改。是否继续？")) return;
    resumeAutomation();
    hideManualBanner();
    void translateNow({ forceSync: true, forceOverwrite: true, reason: "manual_reclaim" });
  });
  ui.baselineButton.addEventListener("click", () => void useManualAsBaseline());

  ui.settingsButton.addEventListener("click", openSettings);
  ui.historyButton.addEventListener("click", () => {
    renderHistory();
    ui.historyDialog.showModal();
  });
  ui.diagnosticsButton.addEventListener("click", () => {
    renderDiagnostics();
    ui.diagnosticsDialog.showModal();
  });
  for (const button of document.querySelectorAll(".close-dialog")) {
    button.addEventListener("click", () => {
      if (button.closest("dialog") === ui.settingsDialog) invalidateFormRequests();
      button.closest("dialog")?.close();
    });
  }

  ui.settingsForm.addEventListener("input", () => {
    if (state.formController) invalidateFormRequests();
  });
  ui.settingsDialog.addEventListener("close", invalidateFormRequests);
  ui.settingsDialog.addEventListener("cancel", invalidateFormRequests);

  ui.providerPreset.addEventListener("change", () => {
    const values = presetValues(ui.providerPreset.value);
    ui.providerName.value = values.name;
    ui.baseUrl.value = values.baseUrl;
    ui.apiKey.value = "";
    ui.apiKey.placeholder = "请为该 Provider 粘贴独立 API Key";
    state.formCapabilitySignature = null;
    state.formCapabilities = null;
  });
  ui.apiProtocol.addEventListener("change", () => {
    populateReasoningDialects(ui.reasoningDialect.value);
    updateReasoningControls();
  });
  ui.reasoningMode.addEventListener("change", updateReasoningControls);
  ui.reasoningDialect.addEventListener("change", updateReasoningControls);
  ui.reasoningEffort.addEventListener("change", updateReasoningControls);
  ui.backTranslationMode.addEventListener("change", () => {
    updateBackSettingsVisibility();
    if (
      normalizeBackTranslationMode(ui.backTranslationMode.value) === BACK_TRANSLATION_MODES.INDEPENDENT
      && !ui.modelBackTranslate.value
      && ui.modelTranslate.value
    ) ui.modelBackTranslate.value = ui.modelTranslate.value;
  });
  ui.showAllModels.addEventListener("change", renderModelList);
  ui.detectModelsButton.addEventListener("click", () => void detectModelsFromForm());
  ui.testProviderButton.addEventListener("click", () => void testProviderFromForm());
  ui.settingsForm.addEventListener("submit", (event) => void saveSettingsFromForm(event));
  ui.clearKeyButton.addEventListener("click", async () => {
    if (!confirm("清除本地与会话中保存的所有 API Key？")) return;
    invalidateFormRequests();
    invalidateRuntimeContext();
    markExpectedSecretClear();
    try {
      await clearStoredSecrets();
      ui.apiKey.value = "";
      ui.apiKey.placeholder = "粘贴 API Key";
      ui.providerTestResult.textContent = "所有已保存 Key 已清除";
    } catch (error) {
      clearExpectedConfigurationWrite();
      ui.providerTestResult.textContent = `清除 Key 失败：${error?.message || "存储不可用"}`;
      setStatus("清除 API Key 失败，请检查 Edge 扩展存储", "error");
    }
  });

  ui.refreshDiagnosticButton.addEventListener("click", () => void refreshDiagnostics());
  ui.manualBindButton.addEventListener("click", () => void startManualBind());
  ui.diagnosticWriteButton.addEventListener("click", () => void diagnosticWrite());
  ui.diagnosticClearButton.addEventListener("click", () => void diagnosticClear());

  window.addEventListener("pagehide", () => {
    state.closing = true;
    if (state.panelReconnectTimer) clearTimeout(state.panelReconnectTimer);
    if (state.bindRetryTimer) clearTimeout(state.bindRetryTimer);
    if (state.persistTimer) clearTimeout(state.persistTimer);
    if (state.cooldownTimer) clearInterval(state.cooldownTimer);
    state.panelReconnectTimer = null;
    state.bindRetryTimer = null;
    state.persistTimer = null;
    state.cooldownTimer = null;
    invalidateFormRequests();
    abortInFlight();
    if (state.externalStorageReloadTimer) clearTimeout(state.externalStorageReloadTimer);
    state.externalStorageReloadTimer = null;
    chrome.storage.onChanged?.removeListener?.(handleStorageChanges);
    void persistDraftSnapshot(state.draft).catch(() => undefined);
    try {
      state.panelPort?.disconnect();
    } catch {
      // Ignore close-time disconnect errors.
    }
  });
}

async function initialize() {
  await hardenStorageAccess();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.draftScope = Number.isInteger(tab?.windowId)
    ? `window-${tab.windowId}`
    : "window-default";
  const [{ settings, provider }, draftState] = await Promise.all([
    loadSettings(),
    loadDraftState(state.draftScope)
  ]);
  state.settings = {
    ...settings,
    backTranslationMode: normalizeBackTranslationMode(settings.backTranslationMode)
  };
  state.provider = provider;
  rememberPersistedCapabilities(provider);
  state.draft = normalizeDraft(draftState.activeDraft);
  state.history = draftState.history;
  state.diagnostics = draftState.diagnostics;
  state.sourceRevision = state.draft.sourceRevision;
  state.targetPhase = state.draft.lastSyncedEnglish ? "stale" : "unbound";

  bindEvents();
  connectPanelPort();
  updateProviderSummary();
  updateTargetUI();
  updateDraftUI({ preserveSourceSelection: false });
  renderHistory();
  renderDiagnostics();
  setStatus(state.draft.source ? "已恢复未发送草稿" : "准备就绪", "idle");

  if (tab?.id && isClaudeUrl(tab.url ?? "")) {
    state.target.tabId = tab.id;
    state.target.windowId = tab.windowId;
    state.target.active = true;
    state.panelPort?.postMessage({ type: "PANEL_HELLO", windowId: tab.windowId });
    postBindRequest(tab.id);
  }
}

void initialize().catch((error) => {
  try {
    setStatus(`安全初始化失败：${error?.message || "unknown"}`, "error");
    ui.sourceText.disabled = true;
    ui.translateButton.disabled = true;
    ui.syncButton.disabled = true;
    ui.settingsButton.disabled = true;
  } catch {
    // No trusted storage means the extension must remain inert.
  }
});
