import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const sharedText = await readFile(path.join(root, "lib/shared.js"), "utf8");
const sharedVersion = sharedText.match(/EXTENSION_VERSION\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
if (manifest.version !== packageJson.version || manifest.version !== sharedVersion) {
  throw new Error(`Version mismatch: manifest=${manifest.version}, package=${packageJson.version}, shared=${sharedVersion}`);
}
const requiredFiles = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...(manifest.content_scripts ?? []).flatMap((item) => item.js ?? []),
  ...Object.values(manifest.icons ?? {})
].filter(Boolean);

for (const file of requiredFiles) await stat(path.join(root, file));

const forbiddenPermissions = ["debugger", "cookies", "history", "webRequest", "proxy", "clipboardRead", "tabs"];
const actualPermissions = new Set(manifest.permissions ?? []);
for (const permission of forbiddenPermissions) {
  if (actualPermissions.has(permission)) throw new Error(`Forbidden permission present: ${permission}`);
}

const allowedRequiredOrigins = new Set(["https://claude.ai/*"]);
for (const origin of manifest.host_permissions ?? []) {
  if (!allowedRequiredOrigins.has(origin)) throw new Error(`Unexpected required host permission: ${origin}`);
}
const allowedOptionalOrigins = new Set([
  "https://*/*",
  "http://localhost/*",
  "http://127.0.0.1/*"
]);
for (const origin of manifest.optional_host_permissions ?? []) {
  if (!allowedOptionalOrigins.has(origin)) throw new Error(`Unexpected optional host permission: ${origin}`);
}

const extensionCsp = manifest.content_security_policy?.extension_pages ?? "";
if (!extensionCsp.includes("script-src 'self'")) {
  throw new Error("Extension page CSP must restrict scripts to self");
}
if (/unsafe-eval|unsafe-inline/i.test(extensionCsp)) throw new Error("Unsafe extension CSP directive present");

const sourceFiles = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (/\.(js|mjs|html)$/.test(entry.name)) sourceFiles.push(full);
  }
}
await walk(root);

for (const file of sourceFiles) {
  const text = await readFile(file, "utf8");
  if (/\.(?:innerHTML|outerHTML)\s*=/.test(text)) throw new Error(`HTML assignment found: ${file}`);
  if (/\binsertAdjacentHTML\s*\(/.test(text)) throw new Error(`insertAdjacentHTML found: ${file}`);
  if (/\bdocument\.write\s*\(/.test(text)) throw new Error(`document.write found: ${file}`);
  if (/\beval\s*\(/.test(text)) throw new Error(`eval found: ${file}`);
  if (/\bnew\s+Function\s*\(/.test(text)) throw new Error(`Function constructor found: ${file}`);
  if (/https?:\/\/[^\s"']+\.js\b/.test(text)) throw new Error(`remote script reference found: ${file}`);
}

const writerText = await readFile(path.join(root, "writer.js"), "utf8");
if (/chrome\.storage/.test(writerText)) throw new Error("Content script must not access extension storage");
if (/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/.test(writerText)) {
  throw new Error("Content script must not make network requests");
}
if (/document\.cookie|\blocalStorage\b|\bsessionStorage\b/.test(writerText)) {
  throw new Error("Content script must not read page/browser storage");
}
for (const forbidden of ["replaceContentEditableDom", "dom-mutation-input", "ClipboardEvent(\"paste\")"]) {
  if (writerText.includes(forbidden)) throw new Error(`Unsafe contenteditable fallback found: ${forbidden}`);
}
for (const required of [
  "mutationQueue = Promise.resolve()",
  "composerObserver = new MutationObserver",
  "focus_write_disabled",
  "TARGET_WRITE_RECOVERY_FAILED",
  "activeMutation",
  "validateExpectedState",
  "history.pushState() does not emit popstate",
  "insertLineBreak"
]) {
  if (!writerText.includes(required)) throw new Error(`Writer safety invariant missing: ${required}`);
}

const storageText = await readFile(path.join(root, "lib/storage.js"), "utf8");
if (!storageText.includes("MAX_STORED_SOURCE_CHARS = 250_000")) {
  throw new Error("Oversized active drafts must be preserved beyond the 50k translation ceiling");
}
if (!storageText.includes('accessLevel: "TRUSTED_CONTEXTS"')) {
  throw new Error("Storage access hardening is missing");
}
for (const required of [
  "export async function saveConfiguration(",
  "credentialId = randomId(\"credential\")",
  "credentialId: boundedString(credentialId",
  "providerCredentialBinding",
  "getSecretForProvider",
  "requestedProvider.keyStorage !== currentProvider.keyStorage",
  "record.credentialId !== currentProvider.credentialId",
  "record.providerBinding === currentBinding",
  "restoreConfigurationSnapshot",
  "scopedSessionKey",
  "loadDraftState(scope",
  "unsafeStoredHeaderName",
  "normalizeStoredAuthHeader"
]) {
  if (!storageText.includes(required)) throw new Error(`Storage safety invariant missing: ${required}`);
}
if (/export\s+async\s+function\s+getSecret\s*\(/.test(storageText)) {
  throw new Error("Unbound secret reads must not be exported");
}
if (/export\s+async\s+function\s+setSecret\s*\(/.test(storageText)) {
  throw new Error("Unbound secret writes must not be exported");
}

const swText = await readFile(path.join(root, "sw.js"), "utf8");
const registerWriterStart = swText.indexOf("function registerWriter");
const writerPublish = swText.indexOf("writers.set(tabId, writer)", registerWriterStart);
const oldDisconnect = swText.indexOf("previous.port.disconnect()", registerWriterStart);
if (registerWriterStart < 0 || writerPublish < 0 || oldDisconnect < 0 || writerPublish > oldDisconnect) {
  throw new Error("Writer replacement must be published before disconnecting the stale port");
}
if (!swText.includes("Number.isFinite(message.deadline)") || !swText.includes("recoverable: true")) {
  throw new Error("Service-worker command expiry/reconnect guard is missing");
}

const providerText = await readFile(path.join(root, "lib/provider.js"), "utf8");
for (const required of [
  "MAX_BASE_URL_CHARS",
  "MAX_MESSAGE_CONTENT_CHARS",
  "MAX_ASSISTANT_TEXT_CHARS",
  "SECRET_LIKE_HEADER_PATTERN",
  "message?.tool_calls"
]) {
  if (!providerText.includes(required)) throw new Error(`Provider safety invariant missing: ${required}`);
}

const placeholderText = await readFile(path.join(root, "lib/placeholders.js"), "utf8");
for (const required of ["MAX_PLACEHOLDERS", "new Uint8Array(12)", "模型新增了未知占位符"]) {
  if (!placeholderText.includes(required)) throw new Error(`Placeholder safety invariant missing: ${required}`);
}

const panelHtmlText = await readFile(path.join(root, "panel.html"), "utf8");
if (!panelHtmlText.includes('id="sourceText"') || !panelHtmlText.includes('maxlength="250000"')) {
  throw new Error("Source editor persistence ceiling is not enforced in the UI");
}

const panelText = await readFile(path.join(root, "panel.js"), "utf8");
const panelIds = [...panelHtmlText.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicatePanelIds = panelIds.filter((id, index) => panelIds.indexOf(id) !== index);
if (duplicatePanelIds.length > 0) {
  throw new Error(`Duplicate panel IDs: ${[...new Set(duplicatePanelIds)].join(", ")}`);
}
const panelIdSet = new Set(panelIds);
for (const match of panelText.matchAll(/\$\("#([^"]+)"\)/g)) {
  if (!panelIdSet.has(match[1])) throw new Error(`Panel JavaScript references missing element: #${match[1]}`);
}
for (const required of [
  "operationEpoch",
  "invalidateRuntimeContext",
  "providerContextSnapshot",
  "persistConfiguration",
  "getSecretForProvider",
  "providerCredentialBinding",
  "chrome.storage.onChanged",
  "externalConfigurationChanged",
  "saveBehaviorSettings",
  "backTranslationMode",
  "A manual/Ctrl+Enter trigger supersedes the already-scheduled debounce",
  "observeBackgroundTask(archiveAndReset",
  "observeBackgroundTask(archiveUncertainSend"
]) {
  if (!panelText.includes(required)) throw new Error(`Panel stale-work invariant missing: ${required}`);
}
if (/\bgetSecret\s*\(/.test(panelText)) {
  throw new Error("Panel must not use unbound secret reads");
}


const translatorText = await readFile(path.join(root, "lib/translator.js"), "utf8");
for (const required of [
  "BACK_TRANSLATION_MODES.SAME_REQUEST",
  '"back_translation"',
  "validatePlaceholderIntegrity(\n          validated.backTranslation"
]) {
  if (!translatorText.includes(required)) throw new Error(`Single-request dual-translation invariant missing: ${required}`);
}

const validationText = await readFile(path.join(root, "lib/validation.js"), "utf8");
for (const required of [
  "buildBackTranslationWarnings",
  "requireBackTranslation",
  "firstValidObject",
  "MAX_JSON_CANDIDATE_SCANS"
]) {
  if (!validationText.includes(required)) throw new Error(`Translation validation invariant missing: ${required}`);
}

console.log(`Audit OK: v${manifest.version}, ${requiredFiles.length} manifest resources, ${sourceFiles.length} source files`);
