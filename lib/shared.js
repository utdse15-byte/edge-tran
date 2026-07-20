export const EXTENSION_VERSION = "0.2.5";

export const STORAGE_KEYS = Object.freeze({
  SETTINGS: "zh2en.settings.v1",
  PROVIDER: "zh2en.provider.v1",
  LOCAL_SECRET: "zh2en.secret.local.v1",
  SESSION_SECRET: "zh2en.secret.session.v1",
  ACTIVE_DRAFT: "zh2en.activeDraft.v1",
  HISTORY: "zh2en.history.v1",
  DIAGNOSTICS: "zh2en.diagnostics.v1"
});

export const BACK_TRANSLATION_MODES = Object.freeze({
  SAME_REQUEST: "same_request",
  INDEPENDENT: "independent",
  OFF: "off"
});

export const DEFAULT_SETTINGS = Object.freeze({
  autoSync: true,
  debounceMs: 750,
  sentenceEndDelayMs: 160,
  // One model response produces both the English translation and a Chinese
  // self-back-translation. Independent verification remains available as an
  // opt-in mode because it requires a second Provider request.
  backTranslationMode: BACK_TRANSLATION_MODES.SAME_REQUEST,
  backTranslateDelayMs: 950,
  longTextThreshold: 2000,
  requestTimeoutMs: 20000,
  writeIdleGuardMs: 420,
  // Safety-first default: automatic synchronization never moves focus out of
  // the side panel. Users may opt in after completing the page diagnostic.
  allowFocusWrite: false,
  clearStaleTarget: true,
  protectedTerms: []
});

export const DEFAULT_PROVIDER = Object.freeze({
  preset: "openai",
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  keyStorage: "local",
  authHeader: "Authorization",
  authPrefix: "Bearer",
  modelTranslate: "",
  modelBackTranslate: "",
  extraHeaders: {},
  // Rotated whenever Provider/Key configuration is explicitly saved. The
  // same identifier is stored beside the secret so a stale side panel cannot
  // pair a newer Key with an older Provider snapshot.
  credentialId: "",
  capabilities: {
    jsonMode: null,
    temperature: null
  }
});

export function normalizeBackTranslationMode(value) {
  return Object.values(BACK_TRANSLATION_MODES).includes(value)
    ? value
    : BACK_TRANSLATION_MODES.SAME_REQUEST;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function randomId(prefix = "id") {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const body = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${body}`;
}

export function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b\ufeff]/g, "")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

export function isCurrentDraftSend({
  sentText,
  draftEnglish,
  manualTargetText = "",
  englishSourceRevision,
  sourceRevision,
  targetPhase = ""
}) {
  if (englishSourceRevision !== sourceRevision) return false;
  const sent = normalizeText(sentText);
  if (!sent) return false;
  if (sent === normalizeText(draftEnglish)) return true;
  return targetPhase === "manual" && sent === normalizeText(manualTargetText);
}

export function targetContextMatches(expected, current) {
  if (!expected) return true;
  return (
    expected.tabId === current?.tabId
    && expected.writerSession === current?.writerSession
    && (
      !Number.isInteger(expected.targetEpoch)
      || expected.targetEpoch === current?.targetEpoch
    )
  );
}

export function isEnglishRevisionCurrent({
  requestedRevision,
  currentSourceRevision,
  englishSourceRevision
}) {
  return (
    Number.isInteger(requestedRevision)
    && requestedRevision === currentSourceRevision
    && englishSourceRevision === requestedRevision
  );
}

export function isClaudeUrl(url) {
  try {
    return new URL(url).origin === "https://claude.ai";
  } catch {
    return false;
  }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const timer = setTimeout(() => finish(resolve), ms);
    const onAbort = () => {
      clearTimeout(timer);
      finish(reject, signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (!signal) return;
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function timestampLabel(timestamp = Date.now()) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}
