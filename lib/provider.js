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
const SECRET_LIKE_HEADER_PATTERN = /(?:api[-_]?key|token|secret)/i;
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
  if (url.hostname === "claude.ai" || url.hostname.endsWith(".claude.ai")) {
    throw new Error("Claude 站点不能作为翻译 Provider；插件不会调用 Claude 内部接口");
  }

  let pathname = url.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/(models|chat\/completions)$/i, "");
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

async function readResponsePayload(response, successMaxBytes = MAX_CHAT_RESPONSE_BYTES) {
  const text = await readLimitedText(response, response.ok ? successMaxBytes : 131_072);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text.slice(0, 500) };
  }
}

function classifyHttpError(response, payload) {
  const status = response.status;
  const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
  const remoteCode = payload?.error?.code || payload?.code || null;
  const safeCode = typeof remoteCode === "string" ? remoteCode.slice(0, 80) : null;
  const remoteParam = typeof payload?.error?.param === "string"
    ? payload.error.param.slice(0, 120).toLowerCase()
    : "";
  const remoteMessage = typeof payload?.error?.message === "string"
    ? payload.error.message.slice(0, 800).toLowerCase()
    : "";
  const unsupportedFields = [];
  for (const field of ["response_format", "temperature"]) {
    if (
      remoteParam === field
      || (
        remoteMessage.includes(field)
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
    return new ProviderError("端点不存在，请检查 Base URL 与 Chat Completions 路径", {
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

async function requestJson(url, options, timeoutMs, externalSignal, successMaxBytes = MAX_CHAT_RESPONSE_BYTES) {
  const requestSignal = createRequestSignal(externalSignal, timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: requestSignal.signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
    let payload;
    try {
      payload = await readResponsePayload(response, successMaxBytes);
    } catch (error) {
      // An oversized error body must not mask the real HTTP classification:
      // a 429 behind a proxy error page still needs its Retry-After cooldown
      // and a 401 still needs its "check the API key" message.
      if (!response.ok) throw classifyHttpError(response, {});
      throw error;
    }
    if (!response.ok) throw classifyHttpError(response, payload);
    return { response, payload };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (requestSignal.wasTimedOut()) {
      throw new ProviderError("Provider 请求超时", {
        code: "timeout",
        isTimeout: true
      });
    }
    if (error?.name === "AbortError") throw error;
    throw new ProviderError("无法连接 Provider，请检查网络、权限与 Base URL", {
      code: "network_error"
    });
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

  const rawModels = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];

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
  if (typeof payload?.choices?.[0]?.text === "string") return payload.choices[0].text;
  return "";
}

async function chatAttempt({
  config,
  apiKey,
  model,
  messages,
  jsonMode,
  temperature,
  signal
}) {
  const body = { model, messages, stream: false };
  if (jsonMode) body.response_format = { type: "json_object" };
  if (temperature) body.temperature = 0;

  const { payload } = await requestJson(
    endpointUrl(config.baseUrl, "chat/completions"),
    {
      method: "POST",
      headers: buildHeaders(config, apiKey),
      body: JSON.stringify(body)
    },
    config.timeoutMs ?? 20000,
    signal
  );

  const choice = payload?.choices?.[0];
  const message = choice?.message;
  const finishReason = choice?.finish_reason ?? null;
  if (hasStructuredRefusal(message)) {
    throw new ProviderError("模型拒绝处理这次翻译", { code: "model_refusal" });
  }
  if (finishReason === "length") {
    throw new ProviderError("模型输出被截断", { code: "output_truncated" });
  }
  if (
    ["content_filter", "tool_calls", "function_call"].includes(finishReason)
    || (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0)
    || message?.function_call
    || hasUnsupportedContentParts(message)
  ) {
    throw new ProviderError("模型没有返回完整的纯文本翻译", { code: "incomplete_response" });
  }

  const text = extractAssistantText(payload).trim();
  if (text.length > MAX_ASSISTANT_TEXT_CHARS) {
    throw new ProviderError("模型返回内容异常过长", { code: "response_too_large" });
  }
  if (!text) {
    throw new ProviderError("模型返回了空内容", { code: "empty_response" });
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

  let jsonMode = wantsJson;
  let temperature = wantsTemperature;

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
        signal
      });
      return {
        ...result,
        capabilityPatch: {
          ...(preferJson ? { jsonMode } : {}),
          temperature
        }
      };
    } catch (error) {
      const canCompatibilityRetry =
        attempt < 2
        && error instanceof ProviderError
        && (error.status === 400 || error.status === 422)
        && error.compatibilityHint
        && (jsonMode || temperature);
      if (!canCompatibilityRetry) throw error;

      const beforeJson = jsonMode;
      const beforeTemperature = temperature;
      const rejected = new Set(error.unsupportedFields ?? []);
      if (rejected.size > 0) {
        if (rejected.has("response_format")) jsonMode = false;
        if (rejected.has("temperature")) temperature = false;
      } else {
        // A few gateways only return `unsupported_parameter` without naming
        // the field. Fall back once to the conservative common subset.
        jsonMode = false;
        temperature = false;
      }
      if (jsonMode === beforeJson && temperature === beforeTemperature) throw error;
    }
  }

  throw new ProviderError("模型或网关不兼容当前请求格式", {
    code: "incompatible_request"
  });
}
