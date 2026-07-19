import {
  DEFAULT_PROVIDER,
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  clampInteger,
  clone,
  normalizeBackTranslationMode,
  randomId
} from "./shared.js";
import { normalizeBaseUrl } from "./provider.js";

const MAX_STORED_PROTECTED_TERMS = 200;
const MAX_STORED_HEADER_COUNT = 50;
const MAX_STORED_SECRET_CHARS = 8_192;
const MAX_STORED_SOURCE_CHARS = 250_000;
const MAX_STORED_TRANSLATION_CHARS = 100_000;
const MAX_STORED_HISTORY_ITEMS = 20;
const MAX_STORED_HISTORY_CHARS = 1_500_000;
const MAX_STORED_DIAGNOSTICS = 80;
const SECRET_RECORD_VERSION = 1;
const BACK_TRANSLATION_KINDS = new Set([
  "",
  "same_request",
  "independent",
  "manual_independent",
  "off"
]);

const STORED_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const STORED_DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const STORED_RESERVED_HEADERS = new Set([
  "accept",
  "authorization",
  "content-type",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "cookie",
  "cookie2",
  "host",
  "origin",
  "referer",
  "connection",
  "proxy-authorization",
  "user-agent"
]);
const STORED_SECRET_HEADER_PATTERN = /(?:api[-_]?key|token|secret)/i;

function unsafeStoredHeaderName(name, { allowCredentialName = false } = {}) {
  const lower = String(name ?? "").toLowerCase();
  return (
    !STORED_HEADER_NAME_PATTERN.test(String(name ?? ""))
    || STORED_DANGEROUS_KEYS.has(lower)
    || STORED_RESERVED_HEADERS.has(lower)
    || lower.startsWith("sec-")
    || lower.startsWith("proxy-")
    || (!allowCredentialName && STORED_SECRET_HEADER_PATTERN.test(lower))
  );
}

function normalizeStoredAuthHeader(value) {
  const name = boundedString(value, DEFAULT_PROVIDER.authHeader, 120).trim()
    || DEFAULT_PROVIDER.authHeader;
  const lower = name.toLowerCase();
  if (lower === "authorization") return "Authorization";
  return unsafeStoredHeaderName(name, { allowCredentialName: true })
    ? DEFAULT_PROVIDER.authHeader
    : name;
}

function normalizeStoredAuthPrefix(value) {
  const prefix = boundedString(value, DEFAULT_PROVIDER.authPrefix, 200).trim();
  return /[\u0000-\u001f\u007f]/u.test(prefix) ? DEFAULT_PROVIDER.authPrefix : prefix;
}

function boundedString(value, fallback = "", maxLength = 2_048) {
  const string = typeof value === "string" ? value : fallback;
  return [...String(string ?? "")].slice(0, maxLength).join("");
}

function normalizedBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function boundedNonNegativeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function boundedTimestamp(value, fallback = Date.now()) {
  return Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000
    ? value
    : fallback;
}

function normalizeBackTranslationKind(value) {
  const kind = boundedString(value, "", 40);
  return BACK_TRANSLATION_KINDS.has(kind) ? kind : "";
}

function normalizeStoredCorrections(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item) => ({
    original: boundedString(item?.original, "", 24).trim(),
    interpreted_as: boundedString(item?.interpreted_as, "", 24).trim(),
    reason: boundedString(item?.reason, "", 240).trim()
  })).filter((item) => item.original && item.interpreted_as);
}

function normalizeStoredAmbiguities(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).map((item) => ({
    fragment: boundedString(item?.fragment, "", 160).trim(),
    reading_used: boundedString(item?.reading_used, "", 240).trim(),
    alternatives: Array.isArray(item?.alternatives)
      ? item.alternatives.slice(0, 4)
          .map((entry) => boundedString(entry, "", 180).trim())
          .filter(Boolean)
      : []
  })).filter((item) => item.fragment);
}

function normalizeStoredWarnings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 32)
    .map((item) => boundedString(item, "", 400).trim())
    .filter(Boolean))];
}

function normalizedSecret(value) {
  const secret = typeof value === "string" ? value.trim() : "";
  if ([...secret].length > MAX_STORED_SECRET_CHARS) {
    throw new Error("API Key 异常过长，未保存");
  }
  return secret;
}

function normalizeStoredHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  const seenNames = new Set();
  for (const [rawName, rawValue] of Object.entries(value).slice(0, MAX_STORED_HEADER_COUNT)) {
    const name = boundedString(rawName, "", 120).trim();
    const lower = name.toLowerCase();
    const headerValue = boundedString(rawValue, "", 2_000).trim();
    if (
      !name
      || !headerValue
      || unsafeStoredHeaderName(name)
      || seenNames.has(lower)
      || /[\u0000-\u001f\u007f]/u.test(headerValue)
    ) continue;
    seenNames.add(lower);
    result[name] = headerValue;
  }
  return result;
}

export function normalizeStoredSettings(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    ...clone(DEFAULT_SETTINGS),
    autoSync: normalizedBoolean(raw.autoSync, DEFAULT_SETTINGS.autoSync),
    debounceMs: clampInteger(raw.debounceMs, 200, 2_000, DEFAULT_SETTINGS.debounceMs),
    sentenceEndDelayMs: clampInteger(
      raw.sentenceEndDelayMs,
      40,
      1_000,
      DEFAULT_SETTINGS.sentenceEndDelayMs
    ),
    backTranslationMode: normalizeBackTranslationMode(raw.backTranslationMode),
    backTranslateDelayMs: clampInteger(
      raw.backTranslateDelayMs,
      300,
      5_000,
      DEFAULT_SETTINGS.backTranslateDelayMs
    ),
    longTextThreshold: clampInteger(
      raw.longTextThreshold,
      500,
      10_000,
      DEFAULT_SETTINGS.longTextThreshold
    ),
    requestTimeoutMs: clampInteger(
      raw.requestTimeoutMs,
      5_000,
      120_000,
      DEFAULT_SETTINGS.requestTimeoutMs
    ),
    writeIdleGuardMs: clampInteger(
      raw.writeIdleGuardMs,
      100,
      3_000,
      DEFAULT_SETTINGS.writeIdleGuardMs
    ),
    allowFocusWrite: normalizedBoolean(raw.allowFocusWrite, DEFAULT_SETTINGS.allowFocusWrite),
    clearStaleTarget: normalizedBoolean(raw.clearStaleTarget, DEFAULT_SETTINGS.clearStaleTarget),
    protectedTerms: Array.isArray(raw.protectedTerms)
      ? [...new Set(raw.protectedTerms
          .slice(0, MAX_STORED_PROTECTED_TERMS)
          .map((term) => boundedString(term, "", 200).trim())
          .filter(Boolean))]
      : []
  };
}

export function normalizeStoredProvider(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rawCapabilities = raw.capabilities && typeof raw.capabilities === "object"
    && !Array.isArray(raw.capabilities)
    ? raw.capabilities
    : {};
  const capabilityValue = (name) => (
    typeof rawCapabilities[name] === "boolean" ? rawCapabilities[name] : null
  );
  const preset = ["openai", "xai", "custom"].includes(raw.preset)
    ? raw.preset
    : DEFAULT_PROVIDER.preset;
  return {
    ...clone(DEFAULT_PROVIDER),
    preset,
    name: boundedString(raw.name, DEFAULT_PROVIDER.name, 80).trim() || DEFAULT_PROVIDER.name,
    baseUrl: boundedString(raw.baseUrl, DEFAULT_PROVIDER.baseUrl, 2_048).trim()
      || DEFAULT_PROVIDER.baseUrl,
    keyStorage: raw.keyStorage === "session" ? "session" : "local",
    authHeader: normalizeStoredAuthHeader(raw.authHeader),
    authPrefix: normalizeStoredAuthPrefix(raw.authPrefix),
    modelTranslate: boundedString(raw.modelTranslate, "", 240).trim(),
    modelBackTranslate: boundedString(raw.modelBackTranslate, "", 240).trim(),
    extraHeaders: normalizeStoredHeaders(raw.extraHeaders),
    credentialId: boundedString(raw.credentialId, "", 160).trim(),
    capabilities: {
      jsonMode: capabilityValue("jsonMode"),
      temperature: capabilityValue("temperature")
    }
  };
}

export function providerCredentialBinding(value) {
  const provider = normalizeStoredProvider(value);
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(provider.baseUrl);
  } catch {
    // Stored data may predate validation. Keep the comparison deterministic
    // and fail closed at request time if the URL itself is unusable.
    baseUrl = boundedString(provider.baseUrl, "", 2_048).trim().replace(/\/+$/, "");
  }
  const extraHeaders = Object.entries(provider.extraHeaders)
    .map(([name, headerValue]) => [name.toLowerCase(), headerValue])
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify({
    version: 1,
    baseUrl,
    authHeader: String(provider.authHeader || "Authorization").toLowerCase(),
    authPrefix: provider.authPrefix ?? "Bearer",
    extraHeaders
  });
}

function createSecretRecord(secret, provider) {
  const value = normalizedSecret(secret);
  if (!value) return null;
  const normalizedProvider = normalizeStoredProvider(provider);
  if (!normalizedProvider.credentialId) {
    throw new Error("Provider 凭据版本缺失，未保存 API Key");
  }
  return {
    version: SECRET_RECORD_VERSION,
    value,
    credentialId: normalizedProvider.credentialId,
    providerBinding: providerCredentialBinding(normalizedProvider),
    updatedAt: Date.now()
  };
}

function normalizeSecretRecord(rawValue) {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) return null;
  if (rawValue.version !== SECRET_RECORD_VERSION) return null;
  let value;
  try {
    value = normalizedSecret(rawValue.value);
  } catch {
    return null;
  }
  const credentialId = boundedString(rawValue.credentialId, "", 160).trim();
  const providerBinding = boundedString(rawValue.providerBinding, "", 120_000);
  if (!value || !credentialId || !providerBinding) return null;
  return {
    version: SECRET_RECORD_VERSION,
    value,
    credentialId,
    providerBinding,
    updatedAt: boundedTimestamp(rawValue.updatedAt, 0)
  };
}

export function secretRecordMetadata(rawValue) {
  const record = normalizeSecretRecord(rawValue);
  return record
    ? {
        credentialId: record.credentialId,
        providerBinding: record.providerBinding,
        updatedAt: record.updatedAt
      }
    : null;
}

export function normalizeStoredDraft(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const sourceRevision = boundedNonNegativeInteger(raw.sourceRevision, 0);
  const englishSourceRevision = boundedNonNegativeInteger(raw.englishSourceRevision, -1);
  const createdAt = boundedTimestamp(raw.createdAt, Date.now());
  const updatedAt = boundedTimestamp(raw.updatedAt, createdAt);
  return {
    id: boundedString(raw.id, "", 120).trim(),
    source: boundedString(raw.source, "", MAX_STORED_SOURCE_CHARS),
    english: boundedString(raw.english, "", MAX_STORED_TRANSLATION_CHARS),
    backTranslation: boundedString(raw.backTranslation, "", MAX_STORED_TRANSLATION_CHARS),
    backTranslationKind: normalizeBackTranslationKind(raw.backTranslationKind),
    corrections: normalizeStoredCorrections(raw.corrections),
    ambiguities: normalizeStoredAmbiguities(raw.ambiguities),
    warnings: normalizeStoredWarnings(raw.warnings),
    sourceRevision,
    englishSourceRevision: englishSourceRevision >= 0 ? englishSourceRevision : null,
    createdAt,
    updatedAt,
    lastSyncedAt: raw.lastSyncedAt == null ? null : boundedTimestamp(raw.lastSyncedAt, null),
    lastSyncedEnglish: boundedString(raw.lastSyncedEnglish, "", MAX_STORED_TRANSLATION_CHARS),
    providerName: boundedString(raw.providerName, "", 120).trim(),
    model: boundedString(raw.model, "", 240).trim()
  };
}

function normalizeStoredHistoryItem(value, index = 0) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const timestamp = boundedTimestamp(raw.timestamp, Date.now());
  return {
    id: boundedString(raw.id, `history_legacy_${timestamp}_${index}`, 160).trim()
      || `history_legacy_${timestamp}_${index}`,
    timestamp,
    source: boundedString(raw.source, "", MAX_STORED_SOURCE_CHARS),
    english: boundedString(raw.english, "", MAX_STORED_TRANSLATION_CHARS),
    backTranslation: boundedString(raw.backTranslation, "", MAX_STORED_TRANSLATION_CHARS),
    backTranslationKind: normalizeBackTranslationKind(raw.backTranslationKind),
    providerName: boundedString(raw.providerName, "", 120).trim(),
    model: boundedString(raw.model, "", 240).trim(),
    note: boundedString(raw.note, "", 800).trim(),
    uncertain: normalizedBoolean(raw.uncertain, false)
  };
}

export function normalizeStoredHistory(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  let totalChars = 0;
  for (const [index, entry] of value.slice(0, MAX_STORED_HISTORY_ITEMS).entries()) {
    const item = normalizeStoredHistoryItem(entry, index);
    const itemChars = item.source.length + item.english.length + item.backTranslation.length + item.note.length;
    if (result.length > 0 && totalChars + itemChars > MAX_STORED_HISTORY_CHARS) break;
    totalChars += itemChars;
    result.push(item);
  }
  return result;
}

export function normalizeStoredDiagnostics(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_STORED_DIAGNOSTICS).map((item) => ({
    timestamp: boundedTimestamp(item?.timestamp, Date.now()),
    message: boundedString(item?.message, "", 240).trim()
  })).filter((item) => item.message);
}

export async function hardenStorageAccess() {
  const localSetter = chrome.storage?.local?.setAccessLevel;
  const sessionSetter = chrome.storage?.session?.setAccessLevel;
  if (typeof localSetter !== "function" || typeof sessionSetter !== "function") {
    throw new Error("当前 Edge 版本不支持安全的扩展存储访问级别");
  }
  // Fail closed: do not continue to settings or secret storage when either
  // storage area cannot be restricted away from content scripts.
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  ]);
}

export async function loadSettings() {
  const values = await chrome.storage.local.get([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.PROVIDER
  ]);
  return {
    settings: normalizeStoredSettings(values[STORAGE_KEYS.SETTINGS]),
    provider: normalizeStoredProvider(values[STORAGE_KEYS.PROVIDER])
  };
}

async function saveSettings(settings, provider) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: normalizeStoredSettings(settings),
    [STORAGE_KEYS.PROVIDER]: normalizeStoredProvider(provider)
  });
}

export async function saveBehaviorSettings(settings) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: normalizeStoredSettings(settings)
  });
}

async function snapshotSecrets() {
  const [localValues, sessionValues] = await Promise.all([
    chrome.storage.local.get(STORAGE_KEYS.LOCAL_SECRET),
    chrome.storage.session.get(STORAGE_KEYS.SESSION_SECRET)
  ]);
  return {
    local: localValues[STORAGE_KEYS.LOCAL_SECRET] ?? "",
    session: sessionValues[STORAGE_KEYS.SESSION_SECRET] ?? ""
  };
}

async function writeSecretOnly(storageMode, secret, provider) {
  const record = createSecretRecord(secret, provider);
  const area = storageMode === "session" ? chrome.storage.session : chrome.storage.local;
  const key = storageMode === "session" ? STORAGE_KEYS.SESSION_SECRET : STORAGE_KEYS.LOCAL_SECRET;
  if (record) await area.set({ [key]: record });
  else await area.remove(key);
}

async function restoreSecretSnapshot(snapshot) {
  await Promise.all([
    snapshot.local
      ? chrome.storage.local.set({ [STORAGE_KEYS.LOCAL_SECRET]: snapshot.local })
      : chrome.storage.local.remove(STORAGE_KEYS.LOCAL_SECRET),
    snapshot.session
      ? chrome.storage.session.set({ [STORAGE_KEYS.SESSION_SECRET]: snapshot.session })
      : chrome.storage.session.remove(STORAGE_KEYS.SESSION_SECRET)
  ]);
}

async function snapshotConfiguration() {
  const values = await chrome.storage.local.get([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.PROVIDER
  ]);
  return {
    hasSettings: Object.hasOwn(values, STORAGE_KEYS.SETTINGS),
    hasProvider: Object.hasOwn(values, STORAGE_KEYS.PROVIDER),
    settings: values[STORAGE_KEYS.SETTINGS],
    provider: values[STORAGE_KEYS.PROVIDER]
  };
}

async function restoreConfigurationSnapshot(snapshot) {
  const values = {};
  const removals = [];
  if (snapshot.hasSettings) values[STORAGE_KEYS.SETTINGS] = snapshot.settings;
  else removals.push(STORAGE_KEYS.SETTINGS);
  if (snapshot.hasProvider) values[STORAGE_KEYS.PROVIDER] = snapshot.provider;
  else removals.push(STORAGE_KEYS.PROVIDER);
  if (Object.keys(values).length > 0) await chrome.storage.local.set(values);
  if (removals.length > 0) await chrome.storage.local.remove(removals);
}

export async function saveConfiguration(
  settings,
  provider,
  secret,
  credentialId = randomId("credential")
) {
  const normalizedSettings = normalizeStoredSettings(settings);
  // Every explicit Provider/Key save gets a fresh credential generation. The
  // panel pre-generates it so storage.onChanged echoes can be recognized;
  // direct callers receive a new generation automatically.
  const normalizedProvider = normalizeStoredProvider({
    ...provider,
    credentialId: boundedString(credentialId, "", 160).trim() || randomId("credential")
  });
  const normalizedApiKey = normalizedSecret(secret);
  const [secretSnapshot, configurationSnapshot] = await Promise.all([
    snapshotSecrets(),
    snapshotConfiguration()
  ]);
  const staleArea = normalizedProvider.keyStorage === "session" ? chrome.storage.local : chrome.storage.session;
  const staleKey = normalizedProvider.keyStorage === "session"
    ? STORAGE_KEYS.LOCAL_SECRET
    : STORAGE_KEYS.SESSION_SECRET;

  try {
    // Treat the selected storage mode and removal of the stale copy as one
    // transaction. Never report "session only" while a persistent copy remains.
    await writeSecretOnly(normalizedProvider.keyStorage, normalizedApiKey, normalizedProvider);
    await staleArea.remove(staleKey);
    await saveSettings(normalizedSettings, normalizedProvider);
    return {
      settings: normalizedSettings,
      provider: normalizedProvider
    };
  } catch (error) {
    await Promise.allSettled([
      restoreSecretSnapshot(secretSnapshot),
      restoreConfigurationSnapshot(configurationSnapshot)
    ]);
    throw error;
  }
}

export async function getSecretForProvider(provider) {
  const requestedProvider = normalizeStoredProvider(provider);
  const storageMode = requestedProvider.keyStorage;
  const key = storageMode === "session" ? STORAGE_KEYS.SESSION_SECRET : STORAGE_KEYS.LOCAL_SECRET;
  let storedProviderValue;
  let rawSecret;
  if (storageMode === "session") {
    const [localValues, sessionValues] = await Promise.all([
      chrome.storage.local.get(STORAGE_KEYS.PROVIDER),
      chrome.storage.session.get(key)
    ]);
    storedProviderValue = localValues[STORAGE_KEYS.PROVIDER];
    rawSecret = sessionValues[key];
  } else {
    const values = await chrome.storage.local.get([STORAGE_KEYS.PROVIDER, key]);
    storedProviderValue = values[STORAGE_KEYS.PROVIDER];
    rawSecret = values[key];
  }

  const currentProvider = normalizeStoredProvider(storedProviderValue);
  const requestedBinding = providerCredentialBinding(requestedProvider);
  const currentBinding = providerCredentialBinding(currentProvider);
  if (requestedBinding !== currentBinding) return "";
  if (requestedProvider.keyStorage !== currentProvider.keyStorage) return "";
  // A missing generation is also a mismatch when the other side has one. This
  // prevents a stale v0.2.1 window from reading a freshly rotated v0.2.2 key.
  if (requestedProvider.credentialId !== currentProvider.credentialId) return "";

  const record = normalizeSecretRecord(rawSecret);
  if (record) {
    if (!currentProvider.credentialId) return "";
    if (record.credentialId !== currentProvider.credentialId) return "";
    if (requestedProvider.credentialId && record.credentialId !== requestedProvider.credentialId) return "";
    return record.providerBinding === currentBinding ? record.value : "";
  }

  // v0.2.1 and older stored a bare string. It is accepted only while both the
  // requested and currently persisted Provider are still legacy records. Any
  // explicit v0.2.2 save rotates to the bound envelope above.
  if (
    typeof rawSecret === "string"
    && !requestedProvider.credentialId
    && !currentProvider.credentialId
  ) {
    try {
      return normalizedSecret(rawSecret);
    } catch {
      return "";
    }
  }
  return "";
}

export async function clearSecrets() {
  await Promise.all([
    chrome.storage.local.remove(STORAGE_KEYS.LOCAL_SECRET),
    chrome.storage.session.remove(STORAGE_KEYS.SESSION_SECRET)
  ]);
}

function normalizeSessionScope(scope) {
  return String(scope ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 80);
}

export function scopedSessionKey(baseKey, scope = "") {
  const normalizedScope = normalizeSessionScope(scope);
  return normalizedScope ? `${baseKey}.${normalizedScope}` : baseKey;
}

function draftStateKeys(scope = "") {
  return {
    activeDraft: scopedSessionKey(STORAGE_KEYS.ACTIVE_DRAFT, scope),
    history: scopedSessionKey(STORAGE_KEYS.HISTORY, scope),
    diagnostics: scopedSessionKey(STORAGE_KEYS.DIAGNOSTICS, scope)
  };
}

export async function loadDraftState(scope = "") {
  const keys = draftStateKeys(scope);
  const scopedKeyList = [keys.activeDraft, keys.history, keys.diagnostics];
  const hasScope = Boolean(normalizeSessionScope(scope));
  const legacyKeyList = [
    STORAGE_KEYS.ACTIVE_DRAFT,
    STORAGE_KEYS.HISTORY,
    STORAGE_KEYS.DIAGNOSTICS
  ];
  const values = await chrome.storage.session.get(
    hasScope ? [...scopedKeyList, ...legacyKeyList] : scopedKeyList
  );

  const scopedHasData = scopedKeyList.some((key) => values[key] !== undefined);
  const legacyHasData = hasScope && legacyKeyList.some((key) => values[key] !== undefined);
  let activeDraft = values[keys.activeDraft] ?? null;
  let history = values[keys.history] ?? [];
  let diagnostics = values[keys.diagnostics] ?? [];

  // Adopt pre-v0.2.0 unscoped session state once so existing users keep their
  // current draft after upgrading. Subsequent windows receive isolated keys.
  if (!scopedHasData && legacyHasData) {
    activeDraft = values[STORAGE_KEYS.ACTIVE_DRAFT] ?? null;
    history = values[STORAGE_KEYS.HISTORY] ?? [];
    diagnostics = values[STORAGE_KEYS.DIAGNOSTICS] ?? [];
    activeDraft = activeDraft == null ? null : normalizeStoredDraft(activeDraft);
    history = normalizeStoredHistory(history);
    diagnostics = normalizeStoredDiagnostics(diagnostics);
    await chrome.storage.session.set({
      [keys.activeDraft]: activeDraft,
      [keys.history]: history,
      [keys.diagnostics]: diagnostics
    });
    await chrome.storage.session.remove(legacyKeyList);
  }

  return {
    activeDraft: activeDraft == null ? null : normalizeStoredDraft(activeDraft),
    history: normalizeStoredHistory(history),
    diagnostics: normalizeStoredDiagnostics(diagnostics)
  };
}

export async function saveActiveDraft(draft, scope = "") {
  const keys = draftStateKeys(scope);
  await chrome.storage.session.set({
    [keys.activeDraft]: draft == null ? null : normalizeStoredDraft(draft)
  });
}

export async function saveHistory(history, scope = "") {
  const keys = draftStateKeys(scope);
  await chrome.storage.session.set({
    [keys.history]: normalizeStoredHistory(history)
  });
}

export async function saveDiagnostics(entries, scope = "") {
  const keys = draftStateKeys(scope);
  await chrome.storage.session.set({
    [keys.diagnostics]: normalizeStoredDiagnostics(entries)
  });
}
