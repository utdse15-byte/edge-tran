const BLOCKED_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "cookie2",
  "host",
  "origin",
  "referer",
  "content-length",
  "connection",
  "proxy-authorization",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "user-agent"
]);

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const DANGEROUS_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
// Secondary credentials must live in the auth-header slot (cleared by 清除
// Key), never in plain extraHeaders storage. Match the common shapes:
// X-Access-Key, X-Subscription-Key, X-Auth, X-Signature, X-Credential…
// while leaving routing names (X-Project, X-Api-Version, X-Request-Id) alone.
const SECRET_LIKE_HEADER_PATTERN = /(?:api[-_]?key|access[-_]?key|token|secret|credential|signature|passwd|password|bearer|session[-_]?(?:id|key)|(?:^|[-_])key(?:[-_]|$)|(?:^|[-_])auth(?:[-_]|$)|(?:^|[-_])sign(?:[-_]|$))/i;
const RESERVED_PAYLOAD_HEADERS = new Set([
  "accept",
  "content-type",
  "content-encoding",
  "content-length",
  "transfer-encoding"
]);

function isBlockedHeaderName(name) {
  const lower = String(name ?? "").toLowerCase();
  return (
    BLOCKED_HEADER_NAMES.has(lower)
    || lower.startsWith("sec-")
    || lower.startsWith("proxy-")
  );
}

const MAX_CHAT_RESPONSE_BYTES = 524_288;
const MAX_MODEL_RESPONSE_BYTES = 1_048_576;
const MAX_ASSISTANT_TEXT_CHARS = 120_000;
const MAX_MODEL_COUNT = 5_000;
const MAX_MODEL_ID_CHARS = 240;
const MAX_BASE_URL_CHARS = 2_048;
const MAX_MESSAGE_COUNT = 20;
const MAX_MESSAGE_CONTENT_CHARS = 250_000;

const NON_TEXT_MODEL_PATTERN = /(embed|embedding|whisper|tts|speech|dall|image|audio|moderation|realtime|transcri|vision-only)/i;

function safeContentTypeValue(value) {
  const text = String(value ?? "").trim().toLowerCase();
  const mime = text.match(/^[a-z0-9!#$&^_.+*-]+\/[a-z0-9!#$&^_.+*-]+/)?.[0] || "";
  const allowedMime = /^(?:application\/(?:json|problem\+json|x-ndjson|jsonl|xhtml\+xml|octet-stream)|text\/(?:json|html|plain|event-stream))$/;
  if (!allowedMime.test(mime)) return mime ? "other" : "";

  const charset = text.match(/(?:^|;)\s*charset\s*=\s*["']?([a-z0-9._-]{1,40})/i)?.[1] || "";
  const allowedCharset = /^(?:utf-?8|us-ascii|iso-8859-1|windows-1252|gbk|gb2312|gb18030|big5|shift_jis)$/i;
  return charset && allowedCharset.test(charset)
    ? `${mime}; charset=${charset}`
    : mime;
}

function safeRequestIdValue(value) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_.:/-]{1,180}$/.test(text)) return "";
  if (/^(?:sk|xai|bearer|token|secret|api[-_]?key)[_.:/-]/i.test(text)) {
    return "";
  }

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const knownPrefix = /^(?:req|request|trace|corr|correlation|ray)[_.:/-][A-Za-z0-9_.:/-]{4,160}$/i;
  const opaqueToken = text.length >= 12
    && /[0-9]/.test(text)
    && /[A-Za-z]/.test(text);
  return uuid.test(text) || knownPrefix.test(text) || opaqueToken ? text : "";
}

const SAFE_ROUTE_HINTS = new Set([
  "missing_api_prefix_likely"
]);

export class ProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = options.status ?? null;
    this.code = options.code ?? "provider_error";
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.isTimeout = Boolean(options.isTimeout);
    this.unsupportedFields = Array.isArray(options.unsupportedFields)
      ? [...new Set(options.unsupportedFields)]
      : [];
    this.compatibilityHint = Boolean(options.compatibilityHint);

    // Safe protocol metadata only. Never retain Authorization, request bodies,
    // prompts, API keys, or the complete remote response.
    this.contentType = safeContentTypeValue(options.contentType);
    this.responseChars = Number.isFinite(options.responseChars)
      ? options.responseChars
      : null;
    this.responseBytes = Number.isFinite(options.responseBytes)
      ? options.responseBytes
      : null;
    this.requestId = safeRequestIdValue(options.requestId);
    this.responseKind = typeof options.responseKind === "string"
      ? options.responseKind.slice(0, 80)
      : "";
    this.redirected = Boolean(options.redirected);
    this.endpoint = typeof options.endpoint === "string"
      ? options.endpoint.slice(0, 240)
      : "";
    this.remoteCode = typeof options.remoteCode === "string"
      && /^[A-Za-z0-9_.:-]{1,80}$/.test(options.remoteCode)
      ? options.remoteCode
      : "";
    this.responseKeys = Array.isArray(options.responseKeys)
      ? options.responseKeys
          .filter((key) => typeof key === "string")
          .slice(0, 16)
      : [];
    this.routeHint = SAFE_ROUTE_HINTS.has(options.routeHint)
      ? options.routeHint
      : "";
  }
}

export function normalizeBaseUrl(rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (!raw) throw new Error("请填写 Base URL");
  if (raw.length > MAX_BASE_URL_CHARS) throw new Error("Base URL 异常过长");

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Base URL 必须包含协议，例如 https://api.example.com/v1");
  }

  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(isLocalhost && url.protocol === "http:")) {
    throw new Error("远程 Provider 只允许 HTTPS；本地仅允许 localhost 或 127.0.0.1 的 HTTP");
  }
  if (url.username || url.password) {
    throw new Error("Base URL 不能包含用户名或密码");
  }
  // An empty query ("...?") or fragment ("...#") makes url.search/url.hash
  // report "" while the serializer keeps the separator, producing endpoints
  // like "/v1?/chat/completions" that can never work.
  if (url.search || url.hash || raw.includes("?") || raw.includes("#")) {
    throw new Error("Base URL 不能包含查询参数或 #fragment");
  }
  // Compare against the FQDN form as well: "claude.ai." (trailing root-label
  // dot) resolves to the same host but would bypass an exact-string check.
  const comparableHostname = url.hostname.replace(/\.+$/, "");
  if (comparableHostname === "claude.ai" || comparableHostname.endsWith(".claude.ai")) {
    throw new Error("Claude 站点不能作为翻译 Provider；插件不会调用 Claude 内部接口");
  }

  let pathname = url.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/(models|chat\/completions|responses)$/i, "");
  url.pathname = pathname || "";
  return url.toString().replace(/\/$/, "");
}

export function endpointUrl(baseUrl, endpoint) {
  const normalized = normalizeBaseUrl(baseUrl);
  return `${normalized}/${String(endpoint).replace(/^\/+/, "")}`;
}

export function permissionPatternForBaseUrl(baseUrl) {
  const url = new URL(normalizeBaseUrl(baseUrl));
  return `${url.protocol}//${url.host}/*`;
}

export async function ensureProviderPermission(baseUrl) {
  const pattern = permissionPatternForBaseUrl(baseUrl);
  // This function is only called from an explicit settings/test button click.
  // Calling request() directly keeps the permission operation inside that
  // user gesture; already-granted origins resolve without another prompt.
  return chrome.permissions.request({ origins: [pattern] });
}

export function sanitizeExtraHeaders(value, authHeader = "Authorization") {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const sanitized = {};
  const seenNames = new Set();
  const authLower = String(authHeader || "Authorization").toLowerCase();

  for (const [name, headerValue] of Object.entries(input).slice(0, 50)) {
    const normalizedName = String(name).trim();
    const lower = normalizedName.toLowerCase();
    if (
      !normalizedName
      || !HEADER_NAME_PATTERN.test(normalizedName)
      || isBlockedHeaderName(lower)
      || DANGEROUS_OBJECT_KEYS.has(lower)
      || RESERVED_PAYLOAD_HEADERS.has(lower)
      || lower === authLower
      // Extra headers are persisted with ordinary Provider settings. Refuse
      // likely credentials here so "清除 Key" cannot leave a second secret
      // behind. Configure one credential through authHeader instead.
      || SECRET_LIKE_HEADER_PATTERN.test(lower)
      || seenNames.has(lower)
    ) continue;
    if (typeof headerValue !== "string" && typeof headerValue !== "number") continue;
    const normalizedValue = String(headerValue);
    // fetch() requires ByteString header values (code points <= 0xFF); a
    // non-Latin-1 value would pass save-time checks and then fail every
    // request as a misdiagnosed "network error".
    if (/[\u0000-\u001f\u007f]|[^\u0020-\u00ff]/u.test(normalizedValue) || normalizedValue.length > 2048) continue;
    seenNames.add(lower);
    sanitized[normalizedName] = normalizedValue;
  }
  return sanitized;
}

export function buildHeaders(config, apiKey) {
  const authHeader = String(config.authHeader || "Authorization").trim() || "Authorization";
  const authLower = authHeader.toLowerCase();
  if (
    !HEADER_NAME_PATTERN.test(authHeader)
    || authHeader.length > 128
    || DANGEROUS_OBJECT_KEYS.has(authLower)
    || RESERVED_PAYLOAD_HEADERS.has(authLower)
    || (isBlockedHeaderName(authHeader) && authLower !== "authorization")
  ) {
    throw new Error("鉴权 Header 名称无效，或使用了内容类型、Cookie、Host、Sec-* 等受保护请求头");
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...sanitizeExtraHeaders(config.extraHeaders, authHeader)
  };

  const key = String(apiKey ?? "").trim();
  if (key.length > 8192) throw new Error("API Key 长度异常，请检查是否粘贴了错误内容");
  if (key) {
    const prefix = String(config.authPrefix ?? "Bearer").trim();
    if (prefix.length > 128) throw new Error("鉴权前缀过长");
    const authValue = prefix ? `${prefix} ${key}` : key;
    if (/[\u0000-\u001f\u007f]|[^\u0020-\u00ff]/u.test(authValue)) {
      throw new Error("API Key 或鉴权前缀包含控制字符，或包含无法用于 HTTP 请求头的非 Latin-1 字符");
    }
    headers[authHeader] = authValue;
  }
  return headers;
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function createRequestSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, timeoutMs);

  const onAbort = () => {
    controller.abort(externalSignal.reason ?? new DOMException("Aborted", "AbortError"));
  };
  if (externalSignal) {
    if (externalSignal.aborted) onAbort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    wasTimedOut: () => timedOut,
    cleanup() {
      clearTimeout(timeout);
      externalSignal?.removeEventListener?.("abort", onAbort);
    }
  };
}

export async function readLimitedText(response, maxBytes) {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ProviderError("Provider 响应体异常过大", {
      status: response.status,
      code: "response_too_large"
    });
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new ProviderError("Provider 响应体异常过大", {
        status: response.status,
        code: "response_too_large"
      });
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel("response_too_large");
        } catch {
          // Preserve the deterministic size error even if stream cancellation fails.
        }
        throw new ProviderError("Provider 响应体异常过大", {
          status: response.status,
          code: "response_too_large"
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function safeResponseRequestId(response) {
  for (const name of [
    "x-request-id",
    "request-id",
    "x-correlation-id",
    "trace-id",
    "cf-ray"
  ]) {
    const value = safeRequestIdValue(response.headers.get(name));
    if (value) return value;
  }
  return "";
}

function looksSensitivePathSegment(segment) {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Keep the encoded form for conservative checks.
  }
  if (decoded === "") return false;
  if (/^(?:sk|xai|bearer|token|secret|api[-_]?key)[_.:-]/i.test(decoded)) {
    return true;
  }
  // Diagnostics only need the route family, so default to redaction: keep a
  // segment only when it is a well-known route word, a version tag, or a
  // short plain word without digit noise. Short proxy path credentials
  // ("/key/AbC123xy/…") would otherwise survive the old ≥24-char heuristic.
  const commonRoute = /^(?:chat|completions|responses|models|openai|azure|deployments|compatible|gateway|proxy|serve|inference|llm|engines|api|beta|stable|v\d+)$/i;
  if (commonRoute.test(decoded)) return false;
  if (/^[A-Za-z]{1,16}$/.test(decoded)) return false;
  return true;
}

function safeEndpointPath(response, fallbackUrl = "") {
  const rawUrl = response?.url || fallbackUrl;
  try {
    const url = new URL(rawUrl);
    const safePath = url.pathname
      .split("/")
      .map((segment) => looksSensitivePathSegment(segment)
        ? "[redacted]"
        : segment.slice(0, 80))
      .join("/");
    return `${url.origin}${safePath}`.slice(0, 240);
  } catch {
    return "";
  }
}

const SAFE_RESPONSE_KEY_NAMES = new Set([
  "id", "object", "created", "model", "choices", "usage", "error",
  "data", "output", "output_text", "status", "type", "message",
  "detail", "code", "request_id"
]);

function safeResponseKeys(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const keys = Object.keys(payload);
  const safeKeys = keys.filter((key) => SAFE_RESPONSE_KEY_NAMES.has(key)).slice(0, 15);
  const otherCount = keys.length - safeKeys.length;
  if (otherCount > 0 && safeKeys.length < 16) safeKeys.push(`other:${otherCount}`);
  return safeKeys;
}

function safeRemoteErrorCode(value) {
  if (typeof value !== "string" || value.length > 80) return "";
  if (!/^[A-Za-z0-9_.:-]+$/.test(value)) return "";
  if (/^(?:sk|xai|bearer|token|secret|api[-_]?key)[_.:-]/i.test(value)) {
    return "";
  }
  if (value.length >= 24 && !/(?:error|invalid|missing|unknown|unsupported|model|rate|quota|auth|permission|limit|not[_-]?found|denied|forbidden)/i.test(value)) {
    return "";
  }
  return value;
}

function inferRouteHint(response, fallbackUrl, responseKind) {
  if (responseKind !== "html") return "";
  const rawUrl = response?.url || fallbackUrl;
  try {
    const pathname = new URL(rawUrl).pathname.replace(/\/+$/, "") || "/";
    // Receiving a website page at the bare compatibility route usually means
    // the configured Base URL is the site origin rather than its API prefix.
    // This is a diagnostic hint only; never guess another URL or auto-retry.
    if (/^\/(?:chat\/completions|responses|models)$/i.test(pathname)) {
      return "missing_api_prefix_likely";
    }
  } catch {
    // Ignore malformed diagnostic URLs; normalizeBaseUrl validates requests.
  }
  return "";
}

function responseMetadata(response, text, responseKind, fallbackUrl = "", extra = {}) {
  return {
    status: response.status,
    contentType: safeContentTypeValue(response.headers.get("content-type")),
    responseChars: text.length,
    responseBytes: new TextEncoder().encode(text).byteLength,
    requestId: safeResponseRequestId(response),
    responseKind,
    redirected: Boolean(response.redirected),
    endpoint: safeEndpointPath(response, fallbackUrl),
    routeHint: inferRouteHint(response, fallbackUrl, responseKind),
    ...extra
  };
}

async function readResponsePayload(
  response,
  successMaxBytes = MAX_CHAT_RESPONSE_BYTES,
  fallbackUrl = ""
) {
  const text = await readLimitedText(
    response,
    response.ok ? successMaxBytes : 131_072
  );
  const normalizedText = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  if (!normalizedText) {
    return {
      kind: "empty",
      payload: null,
      metadata: responseMetadata(response, normalizedText, "empty", fallbackUrl),
      errorCode: "empty_body",
      errorMessage: "Provider 返回成功状态，但响应体为空"
    };
  }

  try {
    return {
      kind: "json",
      payload: JSON.parse(normalizedText),
      metadata: responseMetadata(response, normalizedText, "json", fallbackUrl),
      errorCode: "",
      errorMessage: ""
    };
  } catch {
    const contentType = String(response.headers.get("content-type") || "");
    const looksLikeHtml = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType)
      || /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(normalizedText);
    return {
      kind: looksLikeHtml ? "html" : "non_json",
      payload: null,
      metadata: responseMetadata(
        response,
        normalizedText,
        looksLikeHtml ? "html" : "non_json",
        fallbackUrl
      ),
      errorCode: looksLikeHtml ? "html_response" : "non_json_response",
      errorMessage: looksLikeHtml
        ? "Provider 返回了 HTML 网页，而不是 Chat Completions JSON"
        : "Provider 返回了非 JSON 内容"
    };
  }
}

function classifyHttpError(response, payload) {
  const status = response.status;
  const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
  const remoteCode = payload?.error?.code || payload?.code || null;
  const safeCode = safeRemoteErrorCode(remoteCode) || null;
  const remoteParam = typeof payload?.error?.param === "string"
    ? payload.error.param.slice(0, 120).toLowerCase()
    : "";
  const remoteMessage = typeof payload?.error?.message === "string"
    ? payload.error.message.slice(0, 800).toLowerCase()
    : "";
  const unsupportedFields = [];
  // The Responses API expresses JSON mode as `text.format`; gateways name the
  // rejected parameter in several shapes. Both protocols map onto the same
  // internal capability field so degradation stays a single mechanism.
  const degradableFields = [
    {
      // The bare param "text" is deliberately absent: an unrelated 400 whose
      // param happens to be "text" must not trigger a paid retry without
      // structured output. Gateways rejecting Responses JSON mode name the
      // parameter "text.format" (or describe it in the message).
      field: "response_format",
      params: ["response_format", "text.format", "text.format.type"],
      messageHints: ["response_format", "text.format"]
    },
    { field: "temperature", params: ["temperature"], messageHints: ["temperature"] },
    // Exact param match only: "stream" inside an unrelated error message
    // (e.g. "upstream error") must not trigger a paid non-streaming retry.
    { field: "stream", params: ["stream", "stream_options"], messageHints: [] }
  ];
  for (const { field, params, messageHints } of degradableFields) {
    if (
      params.includes(remoteParam)
      || (
        messageHints.some((hint) => remoteMessage.includes(hint))
        && /(unsupported|not supported|unknown|unrecognized|extra|not allowed|invalid parameter)/i.test(remoteMessage)
      )
    ) unsupportedFields.push(field);
  }
  const compatibilityHint = unsupportedFields.length > 0
    || ["unsupported_parameter", "unknown_parameter", "extra_forbidden"].includes(
      String(safeCode ?? "").toLowerCase()
    );
  const normalizedRemoteCode = String(safeCode ?? "").toLowerCase();
  const modelFailure = (
    normalizedRemoteCode.includes("model")
    && /(not[_ -]?found|missing|unavailable|access|permission|does[_ -]?not[_ -]?exist)/i.test(normalizedRemoteCode)
  ) || (
    /\bmodel\b/i.test(remoteMessage)
    && /(not found|does not exist|unknown|unavailable|no access|not have access|permission)/i.test(remoteMessage)
  );

  if (status === 401 || status === 403) {
    return new ProviderError("鉴权失败，请检查 API Key、模型权限或账户状态", {
      status,
      code: "unauthorized"
    });
  }
  if (status === 404 && modelFailure) {
    return new ProviderError("模型不存在、不可用，或当前 API Key 无权访问", {
      status,
      code: "model_not_found"
    });
  }
  if (status === 404 || status === 405) {
    return new ProviderError("端点不存在，请检查 Base URL 与所选接口协议的路径", {
      status,
      code: "endpoint_not_found"
    });
  }
  if (status === 413) {
    return new ProviderError("请求文本超过 Provider 限制", {
      status,
      code: "payload_too_large"
    });
  }
  if (status === 429) {
    return new ProviderError("Provider 正在限流", {
      status,
      code: "rate_limited",
      retryAfterMs
    });
  }
  if (status === 400 || status === 422) {
    return new ProviderError("请求参数或模型协议不兼容", {
      status,
      code: safeCode || "incompatible_request",
      unsupportedFields,
      compatibilityHint
    });
  }
  if (status >= 500) {
    return new ProviderError("Provider 暂时不可用", {
      status,
      code: "provider_unavailable"
    });
  }
  return new ProviderError(`Provider 请求失败（HTTP ${status}）`, {
    status,
    code: safeCode || "http_error"
  });
}

async function processBufferedJsonResponse(response, successMaxBytes, requestUrl) {
  let result;
  try {
    result = await readResponsePayload(
      response,
      successMaxBytes,
      requestUrl
    );
  } catch (error) {
    // An oversized error body must not mask the real HTTP classification.
    if (!response.ok) throw classifyHttpError(response, {});
    throw error;
  }

  const payload = result.kind === "json" ? result.payload : {};
  if (!response.ok) throw classifyHttpError(response, payload);

  if (result.kind !== "json") {
    throw new ProviderError(result.errorMessage, {
      ...result.metadata,
      code: result.errorCode
    });
  }

  if (
    payload
    && typeof payload === "object"
    && !Array.isArray(payload)
    && payload.error
  ) {
    const remoteCode = safeRemoteErrorCode(payload.error?.code);
    throw new ProviderError("Provider 以 HTTP 200 返回了逻辑错误", {
      ...result.metadata,
      code: "logical_api_error",
      responseKind: "json_error",
      responseKeys: safeResponseKeys(payload),
      remoteCode
    });
  }

  return { response, payload, metadata: result.metadata };
}

function classifyTransportError(error, requestSignal) {
  if (error instanceof ProviderError) return error;
  if (requestSignal.wasTimedOut()) {
    return new ProviderError("Provider 请求超时", {
      code: "timeout",
      isTimeout: true
    });
  }
  if (error?.name === "AbortError") return error;
  return new ProviderError("无法连接 Provider，请检查网络、权限与 Base URL", {
    code: "network_error"
  });
}

async function requestJson(
  url,
  options,
  timeoutMs,
  externalSignal,
  successMaxBytes = MAX_CHAT_RESPONSE_BYTES
) {
  const requestSignal = createRequestSignal(externalSignal, timeoutMs);
  const requestUrl = String(url ?? "");

  try {
    const response = await fetch(url, {
      ...options,
      signal: requestSignal.signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
    return await processBufferedJsonResponse(response, successMaxBytes, requestUrl);
  } catch (error) {
    throw classifyTransportError(error, requestSignal);
  } finally {
    requestSignal.cleanup();
  }
}

// Streams a chat/responses request over SSE, forwarding assistant-text deltas
// to onTextDelta as they arrive. The assembled result is returned in the SAME
// payload shapes the buffered path produces, so every downstream validation
// rule applies unchanged to streamed responses. A gateway that ignores
// `stream: true` and answers with plain JSON falls back transparently.
async function requestStreamedJson(
  url,
  options,
  timeoutMs,
  externalSignal,
  { protocol = "chat_completions", onTextDelta = null, successMaxBytes = MAX_CHAT_RESPONSE_BYTES } = {}
) {
  const requestSignal = createRequestSignal(externalSignal, timeoutMs);
  const requestUrl = String(url ?? "");

  try {
    const response = await fetch(url, {
      ...options,
      signal: requestSignal.signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });

    const contentType = String(response.headers.get("content-type") || "");
    if (!response.ok || !/text\/event-stream/i.test(contentType) || !response.body) {
      const buffered = await processBufferedJsonResponse(response, successMaxBytes, requestUrl);
      return { ...buffered, streamed: false };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sseBytes = 0;
    let deltaCount = 0;
    let sawDone = false;
    let chatText = "";
    let chatRole;
    let chatFinishReason = null;
    let chatRefusal = "";
    let sawToolCalls = false;
    let chatModel = null;
    let responsesFinal = null;

    const baseMetadata = () => ({
      ...responseMetadata(response, "", "json", requestUrl),
      responseChars: chatText.length || null,
      responseBytes: sseBytes
    });

    const handleDataText = (dataText) => {
      if (dataText === "[DONE]") {
        sawDone = true;
        return;
      }
      let event;
      try {
        event = JSON.parse(dataText);
      } catch {
        return; // Ignore comments/keep-alives that are not JSON.
      }
      if (protocol === "responses") {
        const type = String(event?.type ?? "");
        if (type === "response.output_text.delta" && typeof event.delta === "string") {
          deltaCount += 1;
          chatText += event.delta;
          onTextDelta?.(event.delta);
        } else if (
          ["response.completed", "response.failed", "response.incomplete"].includes(type)
          && event.response && typeof event.response === "object"
        ) {
          responsesFinal = event.response;
        } else if (type === "error") {
          throw new ProviderError("Provider 流式响应报告错误", {
            ...baseMetadata(),
            code: "logical_api_error",
            remoteCode: safeRemoteErrorCode(event?.code)
          });
        }
        return;
      }
      if (event?.error) {
        throw new ProviderError("Provider 以流式响应返回了逻辑错误", {
          ...baseMetadata(),
          code: "logical_api_error",
          remoteCode: safeRemoteErrorCode(event.error?.code)
        });
      }
      const choice = Array.isArray(event?.choices) ? event.choices[0] : null;
      if (typeof event?.model === "string") chatModel = event.model;
      if (!choice || typeof choice !== "object") return;
      if (typeof choice.finish_reason === "string" && choice.finish_reason) {
        chatFinishReason = choice.finish_reason;
      }
      const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};
      if (typeof delta.role === "string") chatRole = delta.role;
      if (typeof delta.content === "string" && delta.content) {
        deltaCount += 1;
        chatText += delta.content;
        onTextDelta?.(delta.content);
      }
      if (typeof delta.refusal === "string") chatRefusal += delta.refusal;
      if (delta.tool_calls || delta.function_call) sawToolCalls = true;
    };

    while (!sawDone) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBytes += value.byteLength;
      if (sseBytes > successMaxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The transport is being abandoned either way.
        }
        throw new ProviderError("Provider 流式响应超过安全上限，已终止", {
          ...baseMetadata(),
          code: "response_too_large"
        });
      }
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const rawEvent of events) {
        const dataText = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (dataText) handleDataText(dataText);
        if (sawDone) break;
      }
    }
    buffer += decoder.decode();
    if (!sawDone && buffer.trim()) {
      for (const rawEvent of buffer.split(/\r?\n\r?\n/)) {
        const dataText = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (dataText) handleDataText(dataText);
      }
    }

    if (protocol === "responses") {
      if (responsesFinal) {
        return { response, payload: responsesFinal, metadata: baseMetadata(), streamed: true };
      }
      throw new ProviderError(
        deltaCount > 0 ? "流式响应未收到完成事件" : "Provider 流式响应为空",
        {
          ...baseMetadata(),
          code: deltaCount > 0 ? "incomplete_response" : "empty_response"
        }
      );
    }

    if (deltaCount === 0 && !chatFinishReason) {
      throw new ProviderError("Provider 流式响应为空", {
        ...baseMetadata(),
        code: "empty_response"
      });
    }
    const message = { role: chatRole ?? "assistant", content: chatText };
    if (chatRefusal.trim()) message.refusal = chatRefusal;
    if (sawToolCalls) message.tool_calls = [{ type: "function" }];
    return {
      response,
      payload: {
        object: "chat.completion",
        model: chatModel,
        choices: [{ finish_reason: chatFinishReason, message }]
      },
      metadata: baseMetadata(),
      streamed: true
    };
  } catch (error) {
    throw classifyTransportError(error, requestSignal);
  } finally {
    requestSignal.cleanup();
  }
}

export async function listModels({ config, apiKey, signal }) {
  const { payload } = await requestJson(
    endpointUrl(config.baseUrl, "models"),
    {
      method: "GET",
      headers: buildHeaders(config, apiKey)
    },
    config.timeoutMs ?? 20000,
    signal,
    MAX_MODEL_RESPONSE_BYTES
  );

  // A 200 response that is not a model-list envelope (login page JSON, proxy
  // metadata, another endpoint's payload) must be reported as a schema error,
  // not rendered as an innocuous "no models" result.
  if (!Array.isArray(payload?.data) && !Array.isArray(payload?.models)) {
    throw new ProviderError("/models 响应不是模型列表结构，请核对 Base URL 与网关配置", {
      code: "unsupported_response_schema",
      status: 200,
      responseKind: "json",
      responseKeys: safeResponseKeys(payload)
    });
  }
  const rawModels = Array.isArray(payload?.data)
    ? payload.data
    : payload.models;

  const ids = rawModels
    .slice(0, MAX_MODEL_COUNT)
    .map((item) => (typeof item === "string" ? item : item?.id || item?.name))
    .filter((id) => typeof id === "string" && id.trim())
    .map((id) => id.trim())
    .filter((id) => id.length <= MAX_MODEL_ID_CHARS);

  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export function filterLikelyTextModels(models, showAll = false) {
  const list = Array.isArray(models) ? models : [];
  return showAll ? list : list.filter((id) => !NON_TEXT_MODEL_PATTERN.test(id));
}

function hasStructuredRefusal(message) {
  if (!message || typeof message !== "object") return false;
  const refusal = message.refusal;
  if (typeof refusal === "string" && refusal.trim()) return true;
  if (Array.isArray(refusal) && refusal.length > 0) return true;
  if (refusal && typeof refusal === "object") return true;
  return Array.isArray(message.content) && message.content.some((part) => (
    part && typeof part === "object" && (
      part.type === "refusal"
      || (typeof part.refusal === "string" && part.refusal.trim())
    )
  ));
}

function hasUnsupportedContentParts(message) {
  const content = message?.content;
  if (content === null || content === undefined || typeof content === "string") return false;
  if (!Array.isArray(content)) return true;
  return content.some((part) => {
    if (typeof part === "string") return false;
    if (!part || typeof part !== "object") return true;
    if (part.type && !["text", "output_text"].includes(part.type)) return true;
    return typeof part.text !== "string" && typeof part.content !== "string";
  });
}

function extractAssistantText(payload) {
  const message = payload?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .join("");
  }
  // Deliberately no fallback to choices[0].text: that is the legacy
  // Completions schema. Accepting it here would silently mix protocols and
  // mask a wrong endpoint; such a response now fails as empty content.
  return "";
}

export function normalizedApiProtocol(config) {
  return config?.apiProtocol === "responses" ? "responses" : "chat_completions";
}

function buildResponsesRequestBody(model, messages, jsonMode, temperature) {
  // system → instructions; the remaining conversation becomes typed input
  // items. `store: false` opts out of provider-side response retention.
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const input = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: [{ type: "input_text", text: message.content }]
    }));
  const body = { model, input, stream: false, store: false };
  if (instructions) body.instructions = instructions;
  if (jsonMode) body.text = { format: { type: "json_object" } };
  if (temperature) body.temperature = 0;
  return body;
}

function extractResponsesText(payload, schemaMeta) {
  const items = Array.isArray(payload?.output) ? payload.output : [];
  let text = "";
  for (const item of items) {
    if (!item || typeof item !== "object") {
      throw new ProviderError("模型没有返回完整的纯文本翻译", {
        ...schemaMeta,
        code: "incomplete_response"
      });
    }
    // o-series models prepend reasoning items; they are metadata, not output.
    if (item.type === "reasoning") continue;
    if (item.type !== "message") {
      // function_call / web_search_call / computer_call / unknown item types
      // cannot be a plain-text translation.
      throw new ProviderError("模型没有返回完整的纯文本翻译", {
        ...schemaMeta,
        code: "incomplete_response"
      });
    }
    // A message item must be a completed assistant message. An in_progress or
    // incomplete item is partial output; a non-assistant role is not model
    // output at all. A missing role/status is tolerated for lenient gateways.
    if (item.role !== undefined && item.role !== "assistant") {
      throw new ProviderError("模型没有返回完整的纯文本翻译", {
        ...schemaMeta,
        code: "incomplete_response"
      });
    }
    if (typeof item.status === "string" && item.status !== "completed") {
      throw new ProviderError("模型响应未完成", {
        ...schemaMeta,
        code: "incomplete_response"
      });
    }
    const parts = Array.isArray(item.content) ? item.content : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") {
        throw new ProviderError("模型没有返回完整的纯文本翻译", {
          ...schemaMeta,
          code: "incomplete_response"
        });
      }
      if (
        part.type === "refusal"
        || (typeof part.refusal === "string" && part.refusal.trim())
      ) {
        throw new ProviderError("模型拒绝处理这次翻译", {
          ...schemaMeta,
          code: "model_refusal"
        });
      }
      if (part.type !== "output_text" || typeof part.text !== "string") {
        throw new ProviderError("模型没有返回完整的纯文本翻译", {
          ...schemaMeta,
          code: "incomplete_response"
        });
      }
      text += part.text;
    }
  }
  return text;
}

function responsesAttemptResult(payload, schemaMeta, model) {
  // The output array is mandatory; a present-but-wrong object marker is a
  // schema violation even when an output array exists. Only an absent object
  // field is tolerated for lenient compatible gateways.
  const objectMarkerOk = payload?.object === undefined || payload?.object === "response";
  if (!objectMarkerOk || !Array.isArray(payload?.output)) {
    const looksLikeChatCompletions = Array.isArray(payload?.choices);
    throw new ProviderError(
      looksLikeChatCompletions
        ? "Provider 返回了 Chat Completions 结构；当前配置要求 Responses API"
        : "Provider 响应不是 OpenAI Responses 结构",
      {
        ...schemaMeta,
        code: looksLikeChatCompletions
          ? "chat_completions_response"
          : "unsupported_response_schema"
      }
    );
  }

  const status = typeof payload?.status === "string" ? payload.status : "";
  if (status === "incomplete") {
    const reason = String(payload?.incomplete_details?.reason ?? "");
    throw new ProviderError(
      reason === "max_output_tokens" ? "模型输出被截断" : "模型响应未完成",
      {
        ...schemaMeta,
        code: reason === "max_output_tokens" ? "output_truncated" : "incomplete_response"
      }
    );
  }
  // This is a synchronous, non-background request with no polling loop, so
  // in_progress can only mean partial output and must not be treated as a
  // final result. Only an explicit completed (or a lenient gateway omitting
  // the field entirely) is success.
  if (status === "in_progress" || status === "queued") {
    throw new ProviderError("Provider 返回了未完成的 Responses 状态", {
      ...schemaMeta,
      code: "incomplete_response"
    });
  }
  if (status && status !== "completed") {
    throw new ProviderError("Provider 报告 Responses 请求失败", {
      ...schemaMeta,
      code: "logical_api_error",
      responseKind: "json_error",
      remoteCode: safeRemoteErrorCode(payload?.error?.code)
    });
  }

  const text = extractResponsesText(payload, schemaMeta).trim();
  if (text.length > MAX_ASSISTANT_TEXT_CHARS) {
    throw new ProviderError("模型返回内容异常过长", {
      ...schemaMeta,
      code: "response_too_large"
    });
  }
  if (!text) {
    throw new ProviderError("assistant 文本字段为空", {
      ...schemaMeta,
      code: "empty_assistant_content"
    });
  }
  return {
    text,
    usage: payload?.usage ?? null,
    rawModel: payload?.model ?? model
  };
}

async function chatAttempt({
  config,
  apiKey,
  model,
  messages,
  jsonMode,
  temperature,
  streaming = false,
  onTextDelta = null,
  signal
}) {
  const protocol = normalizedApiProtocol(config);
  let body;
  if (protocol === "responses") {
    body = buildResponsesRequestBody(model, messages, jsonMode, temperature);
  } else {
    body = { model, messages, stream: false };
    if (jsonMode) body.response_format = { type: "json_object" };
    if (temperature) body.temperature = 0;
  }
  if (streaming) body.stream = true;

  const requestOptions = {
    method: "POST",
    headers: buildHeaders(config, apiKey),
    body: JSON.stringify(body)
  };
  const endpoint = endpointUrl(config.baseUrl, protocol === "responses" ? "responses" : "chat/completions");
  const timeoutMs = config.timeoutMs ?? 20000;

  const { payload, metadata } = streaming
    ? await requestStreamedJson(endpoint, requestOptions, timeoutMs, signal, {
        protocol,
        onTextDelta
      })
    : await requestJson(endpoint, requestOptions, timeoutMs, signal);

  const schemaMeta = {
    ...metadata,
    responseKind: "json",
    responseKeys: safeResponseKeys(payload)
  };

  if (protocol === "responses") {
    return responsesAttemptResult(payload, schemaMeta, model);
  }

  if (!Array.isArray(payload?.choices)) {
    const looksLikeResponsesApi = payload?.object === "response"
      || Array.isArray(payload?.output)
      || typeof payload?.output_text === "string";
    throw new ProviderError(
      looksLikeResponsesApi
        ? "Provider 返回了 Responses API 结构；当前配置要求 Chat Completions"
        : "Provider 响应不是 OpenAI Chat Completions 结构",
      {
        ...schemaMeta,
        code: looksLikeResponsesApi
          ? "responses_api_response"
          : "unsupported_response_schema"
      }
    );
  }

  if (payload.choices.length === 0) {
    throw new ProviderError("Provider 返回了空 choices 数组", {
      ...schemaMeta,
      code: "empty_choices"
    });
  }

  const choice = payload.choices[0];
  const message = choice?.message;
  const finishReason = choice?.finish_reason ?? null;

  if (hasStructuredRefusal(message)) {
    throw new ProviderError("模型拒绝处理这次翻译", {
      ...schemaMeta,
      code: "model_refusal"
    });
  }
  if (finishReason === "length") {
    throw new ProviderError("模型输出被截断", {
      ...schemaMeta,
      code: "output_truncated"
    });
  }
  if (
    ["content_filter", "tool_calls", "function_call"].includes(finishReason)
    || (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0)
    || message?.function_call
    || hasUnsupportedContentParts(message)
  ) {
    throw new ProviderError("模型没有返回完整的纯文本翻译", {
      ...schemaMeta,
      code: "incomplete_response"
    });
  }
  // Positive allowlist of successful terminal states. Unknown finish reasons
  // from compatible gateways or future protocol revisions must not be assumed
  // to be complete text; null/missing stays accepted for lenient gateways.
  if (finishReason !== null && !["stop", "end_turn", "eos"].includes(finishReason)) {
    throw new ProviderError("模型没有以已知的完成状态结束输出", {
      ...schemaMeta,
      code: "incomplete_response"
    });
  }
  // A message that declares a non-assistant role is not model output.
  if (message?.role !== undefined && message.role !== "assistant") {
    throw new ProviderError("模型没有返回完整的纯文本翻译", {
      ...schemaMeta,
      code: "incomplete_response"
    });
  }

  const text = extractAssistantText(payload).trim();
  if (text.length > MAX_ASSISTANT_TEXT_CHARS) {
    throw new ProviderError("模型返回内容异常过长", {
      ...schemaMeta,
      code: "response_too_large"
    });
  }
  if (!text) {
    throw new ProviderError("assistant 文本字段为空", {
      ...schemaMeta,
      code: "empty_assistant_content"
    });
  }

  return {
    text,
    usage: payload?.usage ?? null,
    rawModel: payload?.model ?? model
  };
}

export async function chatCompletion({
  config,
  apiKey,
  model,
  messages,
  preferJson = false,
  onTextDelta = null,
  signal
}) {
  const normalizedModel = String(model ?? "").trim();
  if (!normalizedModel) {
    throw new ProviderError("尚未选择模型", { code: "model_missing" });
  }
  if (normalizedModel.length > MAX_MODEL_ID_CHARS) {
    throw new ProviderError("模型 ID 异常过长", { code: "model_invalid" });
  }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGE_COUNT) {
    throw new ProviderError("模型消息结构无效", { code: "payload_invalid" });
  }
  let totalMessageChars = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object" || typeof message.role !== "string" || typeof message.content !== "string") {
      throw new ProviderError("模型消息结构无效", { code: "payload_invalid" });
    }
    totalMessageChars += message.content.length;
    if (totalMessageChars > MAX_MESSAGE_CONTENT_CHARS) {
      throw new ProviderError("请求文本超过插件本地安全上限", { code: "payload_too_large" });
    }
  }

  const wantsJson = preferJson && config.capabilities?.jsonMode !== false;
  const wantsTemperature = config.capabilities?.temperature !== false;
  const wantsStreaming = Boolean(onTextDelta) && config.capabilities?.streaming !== false;

  let jsonMode = wantsJson;
  let temperature = wantsTemperature;
  let streaming = wantsStreaming;

  // Some OpenAI-compatible gateways reject response_format first and only
  // reveal that temperature is unsupported on the next request. Allow at most
  // two narrowly-scoped retries (one per optional field); arbitrary 400/422
  // responses still fail immediately and never enter a retry loop.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await chatAttempt({
        config,
        apiKey,
        model: normalizedModel,
        messages,
        jsonMode,
        temperature,
        streaming,
        onTextDelta: streaming ? onTextDelta : null,
        signal
      });
      return {
        ...result,
        capabilityPatch: {
          ...(preferJson ? { jsonMode } : {}),
          temperature,
          ...(onTextDelta ? { streaming } : {})
        }
      };
    } catch (error) {
      const canCompatibilityRetry =
        attempt < 2
        && error instanceof ProviderError
        && (error.status === 400 || error.status === 422)
        && error.compatibilityHint
        && (jsonMode || temperature || streaming);
      if (!canCompatibilityRetry) throw error;

      const beforeJson = jsonMode;
      const beforeTemperature = temperature;
      const beforeStreaming = streaming;
      const rejected = new Set(error.unsupportedFields ?? []);
      if (rejected.size > 0) {
        if (rejected.has("response_format")) jsonMode = false;
        if (rejected.has("temperature")) temperature = false;
        if (rejected.has("stream")) streaming = false;
      } else {
        // A few gateways only return `unsupported_parameter` without naming
        // the field. Fall back once to the conservative common subset.
        jsonMode = false;
        temperature = false;
        streaming = false;
      }
      if (
        jsonMode === beforeJson
        && temperature === beforeTemperature
        && streaming === beforeStreaming
      ) throw error;
    }
  }

  throw new ProviderError("模型或网关不兼容当前请求格式", {
    code: "incompatible_request"
  });
}
