// End-to-end tests against a real HTTP gateway (scripts/mock-provider.mjs).
//
// The other suites replace `globalThis.fetch` with hand-built Response
// objects, which cannot exercise HTTP framing: chunked transfer, SSE events
// split across TCP packets, multi-byte UTF-8 cut mid-character, gzip,
// redirects, stalled sockets, or the server observing a cancelled stream.
// Everything here runs over a socket through the real fetch stack.

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startMockProvider } from "../scripts/mock-provider.mjs";
import {
  backTranslate,
  translateDraft,
  testTranslationConnection,
  TranslationValidationError
} from "../lib/translator.js";
import {
  filterLikelyTextModels,
  listModels,
  ProviderError
} from "../lib/provider.js";
import { BACK_TRANSLATION_MODES } from "../lib/shared.js";

const SOURCE = "请帮我检查这段代码的性能问题，不要重写整体结构。";
const KEY = "sk-mock-abcdefghijklmnopqrstuvwxyz";
const MODEL = "gpt-4o-mini";

let mock;

before(async () => {
  mock = await startMockProvider({ port: 0 });
});

after(async () => {
  await mock.close();
});

beforeEach(() => {
  mock.reset();
});

function config(scenario, extra = {}) {
  return {
    baseUrl: mock.baseUrl(scenario),
    apiProtocol: "chat_completions",
    authHeader: "Authorization",
    authPrefix: "Bearer",
    extraHeaders: {},
    capabilities: { jsonMode: null, temperature: null, streaming: null },
    timeoutMs: 5000,
    reasoning: { dialect: "none", mode: "inherit", effort: "low" },
    ...extra
  };
}

function translate(scenario, options = {}) {
  const { configExtra, ...rest } = options;
  return translateDraft({
    source: SOURCE,
    config: config(scenario, configExtra),
    apiKey: KEY,
    model: MODEL,
    ...rest
  });
}

async function expectFailure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: "expected the call to fail, but it resolved" });
}

async function expectProviderError(promise, expected = {}) {
  const error = await expectFailure(promise);
  assert.ok(
    error instanceof ProviderError,
    `expected ProviderError, got ${error.name}: ${error.message}`
  );
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(error[field], value, `${field}: ${error[field]} !== ${value} (${error.message})`);
  }
  return error;
}

async function expectValidationError(promise) {
  const error = await expectFailure(promise);
  assert.ok(
    error instanceof TranslationValidationError,
    `expected TranslationValidationError, got ${error.name}: ${error.message}`
  );
  return error;
}

function chatRequests() {
  return mock.requests.filter((entry) => entry.endpoint !== "models");
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test("buffered chat completion produces English and back-translation in one request", async () => {
  const result = await translate("ok");
  assert.match(result.english, /please help me review this snippet/);
  assert.match(result.backTranslation, /[㐀-鿿]/u);
  assert.equal(result.backTranslationMode, BACK_TRANSLATION_MODES.SAME_REQUEST);
  assert.deepEqual(result.warnings, []);
  assert.equal(chatRequests().length, 1);

  const [request] = chatRequests();
  assert.equal(request.body.stream, false);
  assert.deepEqual(request.body.response_format, { type: "json_object" });
  assert.equal(request.body.temperature, 0);
  // The draft must arrive byte-exact: a broken charset round-trip here would
  // silently degrade every translation.
  assert.equal(request.body.messages.at(-1).content, SOURCE);
});

test("streaming preview emits growing prefixes and the final text is the validated response", async () => {
  const previews = [];
  const result = await translate("ok", { onEnglishPreview: (text) => previews.push(text) });

  assert.ok(previews.length > 1, `expected several previews, got ${previews.length}`);
  for (let index = 1; index < previews.length; index += 1) {
    assert.ok(
      previews[index].startsWith(previews[index - 1]),
      `preview ${index} is not an extension of the previous one`
    );
  }
  assert.equal(previews.at(-1), result.english);
  assert.equal(chatRequests()[0].body.stream, true);
});

test("byte-at-a-time SSE still assembles a valid response", async () => {
  const previews = [];
  const result = await translate("one_byte_stream", { onEnglishPreview: (text) => previews.push(text) });
  assert.match(result.english, /please help me review/);
  assert.ok(previews.length > 1);
});

test("SSE split inside a multi-byte character decodes without corruption", async () => {
  const result = await translate("split_utf8_stream", { onEnglishPreview: () => {} });
  assert.match(result.english, /please help me review this snippet/);
  assert.match(result.backTranslation, /[㐀-鿿]/u);
  assert.ok(!result.english.includes("�"), "decoded text contains a replacement character");
  assert.ok(!result.backTranslation.includes("�"));
});

test("CRLF framing, comment keep-alives and data: without a space are accepted", async () => {
  const result = await translate("crlf_stream", { onEnglishPreview: () => {} });
  assert.match(result.english, /please help me review this snippet/);
});

test("an event carrying several data: lines is joined before parsing", async () => {
  const result = await translate("multiline_data_stream", { onEnglishPreview: () => {} });
  assert.match(result.english, /please help me review this snippet/);
});

test("a stream that closes without [DONE] is still assembled", async () => {
  const result = await translate("no_done_stream", { onEnglishPreview: () => {} });
  assert.match(result.english, /please help me review this snippet/);
});

test("a gateway that ignores stream:true falls back to the buffered payload", async () => {
  const previews = [];
  const result = await translate("ignores_stream", { onEnglishPreview: (text) => previews.push(text) });
  assert.match(result.english, /please help me review this snippet/);
  assert.equal(previews.length, 0, "no deltas can be emitted for a buffered answer");
  assert.equal(chatRequests().length, 1, "the fallback must not cost a second request");
});

test("gzip, BOM and missing content-type responses are handled", async () => {
  for (const scenario of ["gzip", "bom", "no_content_type"]) {
    const result = await translate(scenario);
    assert.match(result.english, /please help me review this snippet/, `scenario ${scenario}`);
  }
});

test("Responses protocol works buffered and streamed", async () => {
  const buffered = await translate("ok", { configExtra: { apiProtocol: "responses" } });
  assert.match(buffered.english, /please help me review this snippet/);
  const [request] = chatRequests();
  assert.equal(request.endpoint, "responses");
  assert.equal(request.body.store, false);
  assert.equal(request.body.stream, false);
  assert.ok(request.body.instructions.includes("faithful Chinese-to-English translator"));
  assert.deepEqual(request.body.text, { format: { type: "json_object" } });

  mock.reset();
  const streamed = await translate("ok", {
    configExtra: { apiProtocol: "responses" },
    onEnglishPreview: () => {}
  });
  assert.match(streamed.english, /please help me review this snippet/);
  assert.equal(chatRequests()[0].body.stream, true);
});

test("Responses protocol tolerates a leading reasoning item and reports reasoning tokens", async () => {
  const result = await translate("reasoning_usage", { configExtra: { apiProtocol: "responses" } });
  assert.match(result.english, /please help me review this snippet/);
  assert.equal(result.reasoningTokens, 55);
});

test("chat protocol reports reasoning tokens from completion_tokens_details", async () => {
  const result = await translate("reasoning_usage");
  assert.equal(result.reasoningTokens, 55);
});

test("a streamed request advertises the media type it actually wants", async () => {
  await translate("ok", { onEnglishPreview: () => {} });
  assert.equal(chatRequests()[0].headers.accept, "text/event-stream, application/json");

  mock.reset();
  await translate("ok");
  assert.equal(chatRequests()[0].headers.accept, "application/json");
});

test("a content-negotiating gateway accepts the streamed request", async () => {
  // Answering `stream: true` + `Accept: application/json` with 406 is correct
  // HTTP; the client has to ask for text/event-stream.
  const result = await translate("strict_accept", { onEnglishPreview: () => {} });
  assert.match(result.english, /please help me review this snippet/);
  assert.equal(chatRequests().length, 1);
});

test("streamed responses report usage and reasoning tokens like buffered ones", async () => {
  const result = await translate("sse_usage_final", { onEnglishPreview: () => {} });
  assert.equal(result.usage?.prompt_tokens, 111);
  assert.equal(result.usage?.total_tokens, 133);
  assert.equal(result.reasoningTokens, 7);
});

test("typed content parts stream as well as they buffer", async () => {
  const buffered = await translate("sse_array_content");
  mock.reset();
  const streamed = await translate("sse_array_content", { onEnglishPreview: () => {} });
  assert.match(buffered.english, /please help me review this snippet/);
  assert.equal(streamed.english, buffered.english);
});

test("a JSON body mislabelled as text/event-stream is reused, not re-requested", async () => {
  const result = await translate("sse_content_type_json_body", { onEnglishPreview: () => {} });
  assert.match(result.english, /please help me review this snippet/);
  assert.equal(result.usage?.total_tokens, 160);
  assert.equal(chatRequests().length, 1, "the fallback must not cost a second request");
});

test("a lost stream event is reported as a transport fault, not model misbehaviour", async () => {
  const error = await expectProviderError(
    translate("sse_dropped_event", { onEnglishPreview: () => {} }),
    { code: "stream_event_lost", status: 200 }
  );
  assert.equal(error.droppedEvents, 1);
  assert.ok(
    !/复述|原稿/.test(error.message),
    `a dropped delta must not be blamed on the model: ${error.message}`
  );
  assert.equal(chatRequests().length, 1, "a truncated stream must not silently pay for a repair");
});

test("a gateway refusing response_format, temperature and stream is still reachable", async () => {
  // Three degradable fields need three degradation steps; with only two the
  // streamed configuration could never be satisfied.
  const error = await expectValidationError(translate("worst_case", { onEnglishPreview: () => {} }));
  const bodies = chatRequests().map((entry) => entry.body);
  assert.ok(bodies.length >= 4, `expected the degradation to run out of fields, saw ${bodies.length}`);
  const reached = bodies.find((body) => (
    body.response_format === undefined && !("temperature" in body) && body.stream !== true
  ));
  assert.ok(reached, "no request ever reached the model with all optional fields removed");
  assert.match(error.message, /JSON/);
});

test("the same complaint is never shown to the user twice", async () => {
  const error = await expectValidationError(translate("english_back_translation"));
  assert.equal(error.errors.length, new Set(error.errors).size, error.errors.join(" | "));
  const parts = error.message.split("；");
  assert.equal(parts.length, new Set(parts).size, error.message);
});

test("protected code, URLs, paths and emails survive verbatim", async () => {
  const source = [
    "请看一下 https://example.com/a?b=1 这个链接，",
    "还有 `npm run verify` 和 /etc/hosts 文件，",
    "报错日志发到 dev@example.com。",
    "```js",
    "const a = 1; // 不要翻译这里",
    "```"
  ].join("\n");
  const result = await translateDraft({
    source,
    config: config("ok"),
    apiKey: KEY,
    model: MODEL
  });
  for (const fragment of [
    "https://example.com/a?b=1",
    "`npm run verify`",
    "/etc/hosts",
    "dev@example.com",
    "const a = 1; // 不要翻译这里"
  ]) {
    assert.ok(result.english.includes(fragment), `missing protected fragment: ${fragment}`);
  }
  // The request body must carry placeholders, never the raw protected text.
  const sent = chatRequests()[0].body.messages.at(-1).content;
  assert.ok(!sent.includes("https://example.com/a?b=1"));
  assert.match(sent, /⟦ZH2EN_[0-9A-F]+_P0⟧/);
});

test("independent mode sends a second request that contains no Chinese source", async () => {
  const first = await translate("ok", { backTranslationMode: BACK_TRANSLATION_MODES.INDEPENDENT });
  assert.equal(first.backTranslation, "");
  const second = await backTranslate({
    english: first.english,
    sourceForWarnings: SOURCE,
    config: config("ok"),
    apiKey: KEY,
    model: MODEL
  });
  assert.match(second.chinese, /[㐀-鿿]/u);
  assert.equal(chatRequests().length, 2);

  const backRequest = chatRequests()[1];
  const sentContent = backRequest.body.messages.map((message) => message.content).join("\n");
  assert.ok(
    !/[㐀-鿿]/u.test(sentContent),
    `the back-translation request leaked Chinese: ${sentContent}`
  );
  assert.equal(backRequest.body.response_format, undefined, "plain-text request must not force JSON mode");
});

test("back-translation off mode requests only the English translation", async () => {
  const result = await translate("ok", { backTranslationMode: BACK_TRANSLATION_MODES.OFF });
  assert.equal(result.backTranslation, "");
  assert.equal(chatRequests().length, 1);
  const system = chatRequests()[0].body.messages[0].content;
  assert.ok(!system.includes('"back_translation"'), "off mode must not ask for back_translation");
});

test("model corrections and ambiguities reach the caller", async () => {
  const corrected = await translate("valid_correction");
  assert.equal(corrected.corrections.length, 1);
  assert.deepEqual(
    { ...corrected.corrections[0], reason: undefined },
    { original: "结构", interpreted_as: "结果", reason: undefined }
  );

  mock.reset();
  const ambiguous = await translate("ambiguous");
  assert.equal(ambiguous.ambiguities.length, 1);
  assert.equal(ambiguous.ambiguities[0].fragment, "性能");
  assert.deepEqual(ambiguous.ambiguities[0].alternatives, ["throughput", "efficiency"]);
});

test("markdown fences, prose preambles and a metadata object before the JSON are recovered", async () => {
  for (const scenario of ["fenced_json", "prose_then_json", "metadata_object_first"]) {
    mock.reset();
    const result = await translate(scenario);
    assert.match(result.english, /please help me review this snippet/, `scenario ${scenario}`);
    assert.equal(chatRequests().length, 1, `${scenario} must not need a repair request`);
  }
});

test("connection test mirrors the streaming setting", async () => {
  const streamed = await testTranslationConnection({
    config: config("ok"), apiKey: KEY, model: MODEL, streaming: true
  });
  assert.ok(streamed.english);
  assert.equal(chatRequests()[0].body.stream, true);

  mock.reset();
  await testTranslationConnection({ config: config("ok"), apiKey: KEY, model: MODEL, streaming: false });
  assert.equal(chatRequests()[0].body.stream, false);
});

test("a gateway whose SSE route is broken fails the streaming connection test", async () => {
  await expectProviderError(
    testTranslationConnection({ config: config("relay_stream_502"), apiKey: KEY, model: MODEL, streaming: true }),
    { code: "provider_unavailable", status: 502, streamedRequest: true }
  );
  // The same gateway passes a buffered test — which is exactly why the test
  // has to mirror the live transport.
  mock.reset();
  const buffered = await testTranslationConnection({
    config: config("relay_stream_502"), apiKey: KEY, model: MODEL, streaming: false
  });
  assert.ok(buffered.english);
});

test("a relay that only breaks /v1/responses is reported with its own message", async () => {
  const error = await expectProviderError(
    translate("relay_responses_502", { configExtra: { apiProtocol: "responses" } }),
    { code: "provider_unavailable", status: 502, protocol: "responses" }
  );
  assert.match(error.remoteMessage, /no available channel/);
  assert.equal(error.remoteCode, "channel_unavailable");

  mock.reset();
  const viaChat = await translate("relay_responses_502");
  assert.ok(viaChat.english);
});

// ---------------------------------------------------------------------------
// Credentials and headers
// ---------------------------------------------------------------------------

test("the API key is sent only in the auth header", async () => {
  await translate("ok", {
    configExtra: {
      extraHeaders: {
        "X-Project": "demo",
        "x-project": "duplicate",
        "X-Api-Key": "leak-attempt",
        Cookie: "session=1",
        "Content-Type": "text/plain"
      }
    }
  });
  const [request] = chatRequests();
  assert.equal(request.headers.authorization, `Bearer ${KEY}`);
  assert.equal(request.headers["x-project"], "demo");
  assert.equal(request.headers["x-api-key"], undefined, "secret-shaped extra header must be dropped");
  assert.equal(request.headers.cookie, undefined);
  assert.equal(request.headers["content-type"], "application/json");
  for (const [name, value] of Object.entries(request.headers)) {
    if (name === "authorization") continue;
    assert.ok(!String(value).includes(KEY), `key leaked into header ${name}`);
  }
  assert.ok(!request.rawBody.includes(KEY), "key leaked into the request body");
});

test("custom auth header and empty prefix are honoured", async () => {
  await translate("ok", { configExtra: { authHeader: "X-Goog-Api-Key", authPrefix: "" } });
  const [request] = chatRequests();
  assert.equal(request.headers["x-goog-api-key"], KEY);
  assert.equal(request.headers.authorization, undefined);
});

test("401 stops immediately and never echoes credential material", async () => {
  const error = await expectProviderError(translate("unauthorized"), {
    status: 401, code: "unauthorized"
  });
  assert.equal(error.remoteMessage, "", "auth errors must not carry the remote body");
  assert.ok(!error.message.includes("sk-"));
  assert.equal(chatRequests().length, 1, "auth failure must not be retried");
});

test("a 403 body that echoes the key back cannot re-leak it", async () => {
  const error = await expectProviderError(translate("forbidden_echoes_key"), {
    status: 403, code: "unauthorized"
  });
  assert.ok(!JSON.stringify({ ...error, message: error.message }).includes(KEY));
});

// ---------------------------------------------------------------------------
// HTTP failure classification
// ---------------------------------------------------------------------------

test("429 surfaces the cooldown from Retry-After seconds", async () => {
  const error = await expectProviderError(translate("rate_limited"), {
    status: 429, code: "rate_limited", retryAfterMs: 3000
  });
  assert.match(error.remoteMessage, /Rate limit reached/);
  assert.equal(chatRequests().length, 1, "429 must not trigger a retry storm");
});

test("429 with an HTTP-date Retry-After yields a usable cooldown", async () => {
  const error = await expectProviderError(translate("rate_limited_http_date"), {
    status: 429, code: "rate_limited"
  });
  assert.ok(
    Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 30_000 && error.retryAfterMs <= 45_000,
    `HTTP-date Retry-After was not parsed: ${error.retryAfterMs}`
  );
});

test("quota exhaustion is reported as rate limiting with its remote code", async () => {
  const error = await expectProviderError(translate("quota_exhausted"), { status: 429, code: "rate_limited" });
  assert.equal(error.remoteCode, "insufficient_quota");
});

test("5xx and gateway HTML are classified as provider unavailable", async () => {
  const jsonError = await expectProviderError(translate("server_error"), {
    status: 503, code: "provider_unavailable"
  });
  assert.match(jsonError.remoteMessage, /overloaded/);

  mock.reset();
  const htmlError = await expectProviderError(translate("bad_gateway_html"), {
    status: 502, code: "provider_unavailable"
  });
  assert.equal(htmlError.remoteMessage, "");
  assert.equal(chatRequests().length, 1, "5xx must not be retried inside the provider layer");
});

test("an HTML page at a bare route hints at a missing API prefix", async () => {
  // Base URL is the site origin, so the request lands on /chat/completions with
  // no /v1 in front of it — the most common misconfiguration.
  const site = await startMockProvider({ port: 0, rootScenario: "login_html" });
  try {
    const error = await expectProviderError(
      translateDraft({
        source: SOURCE,
        config: { ...config("ok"), baseUrl: site.origin },
        apiKey: KEY,
        model: MODEL
      }),
      { code: "html_response", status: 200, routeHint: "missing_api_prefix_likely" }
    );
    assert.equal(error.responseKind, "html");
  } finally {
    await site.close();
  }
});

test("an HTML page below /v1 is reported without the prefix hint", async () => {
  const error = await expectProviderError(translate("login_html"), { code: "html_response" });
  assert.equal(error.routeHint, "");
});

test("empty, plain-text and logical-error 200 responses are distinguished", async () => {
  await expectProviderError(translate("empty_body"), { code: "empty_body", status: 200 });
  mock.reset();
  await expectProviderError(translate("plain_text"), { code: "non_json_response", status: 200 });
  mock.reset();
  const logical = await expectProviderError(translate("json_error_200"), {
    code: "logical_api_error", status: 200
  });
  assert.equal(logical.remoteCode, "insufficient_balance");
});

test("model errors and route errors are told apart on 404", async () => {
  await expectProviderError(translate("model_not_found"), { status: 404, code: "model_not_found" });
  mock.reset();
  await expectProviderError(translate("route_not_found"), { status: 404, code: "endpoint_not_found" });
  mock.reset();
  await expectProviderError(translate("method_not_allowed"), { status: 405, code: "endpoint_not_found" });
});

test("413 is reported as an oversized request", async () => {
  await expectProviderError(translate("payload_too_large"), { status: 413, code: "payload_too_large" });
});

test("a redirect is refused rather than followed", async () => {
  await expectProviderError(translate("redirect"), { code: "network_error" });
});

test("a reset socket is a network error, not a silent success", async () => {
  await expectProviderError(translate("socket_reset"), { code: "network_error" });
});

test("a slow gateway times out at the configured budget", async () => {
  const error = await expectProviderError(translate("slow", { configExtra: { timeoutMs: 250 } }), {
    code: "timeout"
  });
  assert.equal(error.isTimeout, true);
});

test("a gateway that sends headers and then stalls times out", async () => {
  await expectProviderError(translate("stall_headers", { configExtra: { timeoutMs: 300 } }), {
    code: "timeout", isTimeout: true
  });
});

test("a stalled stream times out instead of leaving a half-written preview", async () => {
  const previews = [];
  await expectProviderError(
    translate("stall_stream", { configExtra: { timeoutMs: 300 }, onEnglishPreview: (text) => previews.push(text) }),
    { code: "timeout", isTimeout: true }
  );
});

test("a stream cut mid-flight fails instead of yielding the partial text", async () => {
  await expectProviderError(translate("stream_then_reset", { onEnglishPreview: () => {} }), {
    code: "network_error"
  });
});

test("oversized responses are rejected with and without Content-Length", async () => {
  await expectProviderError(translate("huge_response"), { code: "response_too_large" });
  mock.reset();
  await expectProviderError(translate("huge_response_chunked"), { code: "response_too_large" });
});

test("an endless stream is capped and the server sees the client hang up", async () => {
  await expectProviderError(translate("huge_stream", { onEnglishPreview: () => {} }), {
    code: "response_too_large"
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(mock.state("huge_stream").aborted, true, "the stream was never cancelled server-side");
});

// ---------------------------------------------------------------------------
// Capability degradation
// ---------------------------------------------------------------------------

test("a gateway rejecting response_format is retried once without JSON mode", async () => {
  const result = await translate("reject_response_format");
  assert.match(result.english, /please help me review this snippet/);
  assert.equal(chatRequests().length, 2);
  assert.equal(result.capabilityPatch.jsonMode, false);
  assert.equal(result.capabilityPatch.temperature, true);
  assert.equal(chatRequests()[1].body.response_format, undefined);
});

test("a gateway rejecting temperature is retried once without it", async () => {
  const result = await translate("reject_temperature");
  assert.ok(result.english);
  assert.equal(chatRequests().length, 2);
  assert.equal(result.capabilityPatch.temperature, false);
  assert.equal("temperature" in chatRequests()[1].body, false);
});

test("response_format then temperature degrade one field at a time and then succeed", async () => {
  const result = await translate("reject_json_then_temperature");
  assert.ok(result.english);
  assert.equal(chatRequests().length, 3);
  assert.equal(result.capabilityPatch.jsonMode, false);
  assert.equal(result.capabilityPatch.temperature, false);
});

test("a gateway rejecting stream falls back to a buffered request", async () => {
  const previews = [];
  const result = await translate("reject_stream", { onEnglishPreview: (text) => previews.push(text) });
  assert.ok(result.english);
  assert.equal(chatRequests().length, 2);
  assert.equal(chatRequests()[0].body.stream, true);
  assert.equal(chatRequests()[1].body.stream, false);
  assert.equal(result.capabilityPatch.streaming, false);
});

test("an unnamed unsupported_parameter degrades once to the conservative subset", async () => {
  const result = await translate("reject_all_vague", { onEnglishPreview: () => {} });
  assert.ok(result.english);
  assert.equal(chatRequests().length, 2);
  const second = chatRequests()[1].body;
  assert.equal(second.response_format, undefined);
  assert.equal("temperature" in second, false);
  assert.equal(second.stream, false);
});

test("an unrelated 400 mentioning \"upstream\" does not buy a second request", async () => {
  await expectProviderError(translate("reject_upstream_wording", { onEnglishPreview: () => {} }), {
    status: 400
  });
  assert.equal(chatRequests().length, 1, "no paid retry for an unrelated 400");
});

test("an ordinary 400 is never retried", async () => {
  await expectProviderError(translate("plain_400"), { status: 400, code: "incompatible_request" });
  assert.equal(chatRequests().length, 1);
});

test("a refused reasoning field surfaces verbatim and is never silently dropped", async () => {
  const error = await expectProviderError(
    translate("reject_reasoning", {
      configExtra: { reasoning: { dialect: "openai_chat", mode: "manual", effort: "high" } }
    }),
    { status: 400, code: "reasoning_rejected", reasoningRejected: true }
  );
  assert.equal(error.compatibilityHint, false);
  assert.equal(chatRequests().length, 1, "a rejected reasoning field must not be retried");
  assert.equal(chatRequests()[0].body.reasoning_effort, "high");
});

test("the thinking dialect emits its own fields and reports rejection", async () => {
  await expectProviderError(
    translate("reject_thinking", {
      configExtra: { reasoning: { dialect: "thinking_type", mode: "manual", effort: "medium" } }
    }),
    { code: "reasoning_rejected", reasoningRejected: true }
  );
  assert.deepEqual(chatRequests()[0].body.thinking, { type: "enabled" });
});

test("inherit + none dialect sends no thinking fields at all", async () => {
  await translate("ok");
  const body = chatRequests()[0].body;
  for (const field of ["reasoning", "reasoning_effort", "thinking", "enable_thinking"]) {
    assert.equal(field in body, false, `unexpected reasoning field ${field}`);
  }
});

test("a single 500 is surfaced rather than retried by the provider layer", async () => {
  await expectProviderError(translate("flaky_500"), { status: 500, code: "provider_unavailable" });
  assert.equal(chatRequests().length, 1);
});

// ---------------------------------------------------------------------------
// Malformed model output
// ---------------------------------------------------------------------------

test("unparseable JSON is repaired once and then fails", async () => {
  const recovered = await translate("invalid_json_once");
  assert.ok(recovered.english);
  assert.equal(chatRequests().length, 2);
  assert.match(chatRequests()[1].body.messages[0].content, /was not valid JSON/);

  mock.reset();
  const error = await expectValidationError(translate("invalid_json_always"));
  assert.match(error.message, /不可解析的 JSON/);
  assert.equal(chatRequests().length, 2, "at most one repair request");
});

test("an echoed Chinese draft is rejected as a non-translation", async () => {
  const error = await expectValidationError(translate("echo_source"));
  assert.ok(error.errors.some((item) => item.includes("复述")), error.errors.join(" | "));
});

test("English that still carries most of the Chinese draft is a hard failure", async () => {
  await expectValidationError(translate("mostly_untranslated"));
});

test("an English back-translation is rejected", async () => {
  const error = await expectValidationError(translate("english_back_translation"));
  assert.ok(error.errors.some((item) => item.includes("回译")), error.errors.join(" | "));
});

test("blank English and unsafe control characters are rejected", async () => {
  await expectValidationError(translate("empty_english"));
  mock.reset();
  const error = await expectValidationError(translate("control_chars"));
  assert.ok(error.errors.some((item) => item.includes("控制字符")), error.errors.join(" | "));
});

test("a dropped, duplicated or invented placeholder fails after one repair attempt", async () => {
  const source = "请看 https://example.com/x 这个链接，谢谢。";
  for (const scenario of ["drop_placeholder", "duplicate_placeholder", "unknown_placeholder"]) {
    mock.reset();
    const error = await expectValidationError(translateDraft({
      source, config: config(scenario), apiKey: KEY, model: MODEL
    }));
    assert.ok(
      error.errors.some((item) => /受保护内容|占位符/.test(item)),
      `${scenario}: ${error.errors.join(" | ")}`
    );
    assert.equal(chatRequests().length, 2, `${scenario} should try one repair`);
  }
});

test("reordered protected content succeeds with a word-order warning", async () => {
  const source = "请把 https://a.example/1 和 https://b.example/2 都检查一下。";
  const result = await translateDraft({ source, config: config("reordered_placeholders"), apiKey: KEY, model: MODEL });
  assert.ok(result.english.includes("https://a.example/1"));
  assert.ok(
    result.warnings.some((item) => item.includes("改变了位置")),
    result.warnings.join(" | ")
  );
});

test("an out-of-bounds numeral correction forces a literal retranslation", async () => {
  const result = await translateDraft({
    source: "请把上限提到三十。",
    config: config("numeral_correction_once"),
    apiKey: KEY,
    model: MODEL
  });
  assert.deepEqual(result.corrections, [], "the rejected correction must not reach the user");
  assert.match(result.english, /thirty/);
  assert.equal(chatRequests().length, 2);
  assert.match(chatRequests()[1].body.messages[0].content, /do not correct or reinterpret/);
});

test("a polarity flip disguised as a typo is rejected outright", async () => {
  const error = await expectValidationError(translateDraft({
    source: "请开启这个开关。", config: config("polarity_correction_always"), apiKey: KEY, model: MODEL
  }));
  assert.ok(error.message.length > 0);
});

test("an over-long corrections list and a non-array corrections field are rejected", async () => {
  await expectValidationError(translate("too_many_corrections"));
  mock.reset();
  await expectValidationError(translate("corrections_not_array"));
});

test("literal fragments the user pinned cannot be \"corrected\"", async () => {
  const error = await expectValidationError(translateDraft({
    source: "请检查这段代码的结构。",
    config: config("polarity_correction_always"),
    apiKey: KEY,
    model: MODEL,
    literalFragments: ["结构"]
  }));
  assert.ok(error.errors.length > 0);
});

// ---------------------------------------------------------------------------
// Response-shape rejection
// ---------------------------------------------------------------------------

test("chat-protocol shape violations are each classified", async () => {
  const cases = [
    ["empty_choices", "empty_choices"],
    ["finish_length", "output_truncated"],
    ["refusal", "model_refusal"],
    ["tool_calls", "incomplete_response"],
    ["role_user", "incomplete_response"],
    ["unknown_finish_reason", "incomplete_response"],
    ["responses_shape_on_chat", "responses_api_response"]
  ];
  for (const [scenario, code] of cases) {
    mock.reset();
    await expectProviderError(translate(scenario), { code });
  }
});

test("Responses-protocol shape violations are each classified", async () => {
  const cases = [
    ["chat_shape_on_responses", "chat_completions_response"],
    ["responses_incomplete", "output_truncated"],
    ["responses_in_progress", "incomplete_response"],
    ["responses_refusal", "model_refusal"],
    ["responses_function_call", "incomplete_response"]
  ];
  for (const [scenario, code] of cases) {
    mock.reset();
    await expectProviderError(
      translate(scenario, { configExtra: { apiProtocol: "responses" } }),
      { code }
    );
  }
});

test("streamed shape violations match their buffered classification", async () => {
  const cases = [
    ["sse_error_event", "logical_api_error"],
    ["sse_tool_calls", "incomplete_response"],
    ["sse_finish_length", "output_truncated"],
    ["sse_empty", "empty_response"]
  ];
  for (const [scenario, code] of cases) {
    mock.reset();
    await expectProviderError(translate(scenario, { onEnglishPreview: () => {} }), { code });
  }
});

test("a Responses stream without a completion event is not treated as done", async () => {
  await expectProviderError(
    translate("sse_responses_no_completion", {
      configExtra: { apiProtocol: "responses" }, onEnglishPreview: () => {}
    }),
    { code: "incomplete_response" }
  );
});

test("a mis-encoded response never passes as a valid translation", async () => {
  // A gateway declaring charset=gbk while fetch decodes UTF-8 produces
  // mojibake; the only acceptable outcomes are a parse/validation failure.
  const error = await expectFailure(translate("gbk"));
  assert.ok(
    error instanceof ProviderError || error instanceof TranslationValidationError,
    `unexpected error type ${error.name}`
  );
});

test("real-world framing quirks do not break a valid response", async () => {
  // Close-delimited body (no Content-Length), a 200 carrying `error: null`, and
  // a model whose JSON arrives fully \u-escaped one byte at a time.
  for (const scenario of ["http10_close", "error_null"]) {
    mock.reset();
    const result = await translate(scenario);
    assert.match(result.english, /please help me review this snippet/, `scenario ${scenario}`);
  }
  mock.reset();
  const escaped = await translate("escaped_json_stream", { onEnglishPreview: () => {} });
  assert.match(escaped.english, /please help me review this snippet/);
  assert.match(escaped.backTranslation, /[㐀-鿿]/u);
  assert.ok(!escaped.english.includes("\\u"), "escapes were not decoded");
});

test("a 204, a broken Content-Encoding and a long first token are each classified", async () => {
  await expectProviderError(translate("no_content"), { status: 204, code: "empty_body" });
  mock.reset();
  await expectProviderError(translate("bad_gzip"), { code: "network_error" });
  mock.reset();
  const slow = await translate("slow_first_delta", { onEnglishPreview: () => {} });
  assert.ok(slow.english, "a long time-to-first-token inside the budget must succeed");
  mock.reset();
  await expectProviderError(
    translate("slow_first_delta", { configExtra: { timeoutMs: 300 }, onEnglishPreview: () => {} }),
    { code: "timeout", isTimeout: true }
  );
});

test("the [DONE] sentinel is recognised with trailing whitespace", async () => {
  // The dropped-event detector must not mistake "[DONE] " for a lost JSON
  // payload just because it opens with a bracket.
  const result = await translate("sse_done_whitespace", { onEnglishPreview: () => {} });
  assert.match(result.english, /please help me review this snippet/);
});

test("an oversized error body still classifies by HTTP status", async () => {
  await expectProviderError(translate("huge_error_body"), {
    status: 500, code: "provider_unavailable"
  });
});

test("a 200 carrying both usable choices and an error object is refused", async () => {
  await expectProviderError(translate("choices_and_error"), {
    code: "logical_api_error", status: 200
  });
});

test("a Responses payload with only output_text is not accepted", async () => {
  await expectProviderError(
    translate("output_text_only", { configExtra: { apiProtocol: "responses" } }),
    { code: "unsupported_response_schema" }
  );
});

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

test("a huge model list is capped, deduplicated and cleaned", async () => {
  const models = await listModels({ config: config("many_models"), apiKey: KEY });
  assert.equal(models.length, 5000, "the model cap must hold");
  assert.equal(models.length, new Set(models).size, "duplicate ids must collapse");
  assert.ok(!models.some((id) => id.length > 240), "over-long ids must be dropped");
  assert.ok(!models.includes(""), "empty ids must be dropped");
});

test("model listing, filtering and error shapes", async () => {
  const models = await listModels({ config: config("ok"), apiKey: KEY });
  assert.ok(models.includes("gpt-4o-mini"));
  assert.deepEqual(models, [...models].sort((a, b) => a.localeCompare(b)));
  assert.ok(!filterLikelyTextModels(models).some((id) => /embedding|whisper|dall/.test(id)));
  assert.ok(filterLikelyTextModels(models, true).includes("whisper-1"));

  const bare = await listModels({ config: config("models_bare_array"), apiKey: KEY });
  assert.ok(bare.includes("gpt-4o"));

  await expectProviderError(listModels({ config: config("models_missing"), apiKey: KEY }), {
    status: 404, code: "endpoint_not_found"
  });
  await expectProviderError(listModels({ config: config("models_not_a_list"), apiKey: KEY }), {
    code: "unsupported_response_schema"
  });
  await expectProviderError(listModels({ config: config("models_html"), apiKey: KEY }), {
    code: "html_response"
  });
});

test("a model list failure does not block a manually typed model id", async () => {
  await expectProviderError(listModels({ config: config("models_missing"), apiKey: KEY }), { status: 404 });
  const result = await translate("models_missing");
  assert.ok(result.english);
});

// ---------------------------------------------------------------------------
// Malformed-payload sweep
// ---------------------------------------------------------------------------

// Every one of these must fail as a classified error. A raw TypeError would
// reach the side panel as an unhandled error with no actionable message, and
// any response body a gateway can emit must land in a known bucket.
const MALFORMED_PAYLOADS = [
  ["null body", "null"],
  ["bare array", "[]"],
  ["bare string", '"hello"'],
  ["bare number", "42"],
  ["choices null", '{"choices":null}'],
  ["choices [null]", '{"choices":[null]}'],
  ["choices [42]", '{"choices":[42]}'],
  ["choices [{}]", '{"choices":[{}]}'],
  ["message null", '{"choices":[{"message":null,"finish_reason":"stop"}]}'],
  ["message string", '{"choices":[{"message":"hi","finish_reason":"stop"}]}'],
  ["content object", '{"choices":[{"message":{"role":"assistant","content":{"english":"x"}},"finish_reason":"stop"}]}'],
  ["content number", '{"choices":[{"message":{"role":"assistant","content":5},"finish_reason":"stop"}]}'],
  ["content array of numbers", '{"choices":[{"message":{"role":"assistant","content":[1,2]},"finish_reason":"stop"}]}'],
  ["legacy completions text field", '{"choices":[{"text":"{\\"english\\":\\"x\\"}","finish_reason":"stop"}]}'],
  ["finish_reason object", '{"choices":[{"message":{"role":"assistant","content":"{}"},"finish_reason":{"a":1}}]}'],
  ["english as number", '{"choices":[{"message":{"role":"assistant","content":"{\\"english\\":42}"},"finish_reason":"stop"}]}'],
  ["english as object", '{"choices":[{"message":{"role":"assistant","content":"{\\"english\\":{\\"a\\":1}}"},"finish_reason":"stop"}]}'],
  ["corrections as object", '{"choices":[{"message":{"role":"assistant","content":"{\\"english\\":\\"ok text here\\",\\"back_translation\\":\\"中文回译内容够长了\\",\\"corrections\\":{\\"a\\":1}}"},"finish_reason":"stop"}]}'],
  ["unterminated model json", '{"choices":[{"message":{"role":"assistant","content":"{\\"english\\":\\"abc"},"finish_reason":"stop"}]}']
];

test("no malformed response escapes classification", async () => {
  for (const [label, body] of MALFORMED_PAYLOADS) {
    mock.reset();
    // Two identical bodies: a repair retry must hit the same shape, not the
    // scenario's success fallback.
    mock.queueRaw(body);
    mock.queueRaw(body);
    mock.queueRaw(body);
    const error = await expectFailure(translate("raw"));
    assert.ok(
      error instanceof ProviderError || error instanceof TranslationValidationError,
      `${label}: unclassified ${error.name}: ${error.message}`
    );
    assert.ok(String(error.message).trim().length > 0, `${label}: empty message`);
  }
});

test("a response body cannot pollute Object.prototype", async () => {
  mock.reset();
  mock.queueRaw(
    '{"__proto__":{"zh2enPolluted":true},"choices":[{"message":{"role":"assistant",'
    + '"content":"{\\"english\\":\\"please review this snippet\\",'
    + '\\"back_translation\\":\\"请检视这段程序内容\\"}"},"finish_reason":"stop"}]}'
  );
  await translate("raw");
  assert.equal({}.zh2enPolluted, undefined, "prototype was polluted by a response body");
});

// ---------------------------------------------------------------------------
// Cancellation and concurrency
// ---------------------------------------------------------------------------

test("aborting a request rejects with AbortError and nothing is written", async () => {
  const controller = new AbortController();
  const pending = translate("slow", { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const error = await expectFailure(pending);
  assert.equal(error.name, "AbortError");
});

test("aborting mid-stream stops the preview and rejects", async () => {
  const controller = new AbortController();
  const previews = [];
  const pending = translate("slow_chunks", {
    signal: controller.signal,
    onEnglishPreview: (text) => previews.push(text)
  });
  setTimeout(() => controller.abort(), 60);
  const error = await expectFailure(pending);
  assert.equal(error.name, "AbortError");
  const seen = previews.length;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(previews.length, seen, "previews continued after the abort");
});

test("concurrent translations stay independent", async () => {
  const [first, second] = await Promise.all([
    translateDraft({ source: "请检查性能问题。", config: config("ok"), apiKey: KEY, model: MODEL }),
    translateDraft({ source: "请修复部署失败的日志。", config: config("ok"), apiKey: KEY, model: MODEL })
  ]);
  assert.match(first.english, /performance/);
  assert.match(second.english, /deploy/);
  assert.notEqual(first.english, second.english);
});

test("a rate-limited attempt followed by a fresh translation succeeds", async () => {
  await expectProviderError(translate("rate_limited_once"), { status: 429 });
  const result = await translate("rate_limited_once");
  assert.ok(result.english, "the second, user-initiated attempt must go through");
  assert.equal(chatRequests().length, 2);
});
