#!/usr/bin/env node
// A real, dependency-free OpenAI-compatible gateway used to exercise the
// extension over an actual socket instead of a stubbed `fetch`. The unit
// suites hand-build `Response` objects, so they never cover HTTP framing:
// chunked transfer, SSE events split across TCP packets, multi-byte UTF-8
// split mid-character, Content-Encoding, redirects, stalled sockets, or a
// server observing the client cancel a stream.
//
// Two ways to use it:
//   * as a library — `startMockProvider()` from tests (see tests/e2e-*.test.js);
//   * as a CLI — `node scripts/mock-provider.mjs --port 8787`, then point the
//     extension's Base URL at `http://127.0.0.1:8787/v1` and drive the real
//     panel by hand. Every scenario below is reachable as its own Base URL:
//     `http://127.0.0.1:8787/<scenario>/v1`.
//
// The "model" is a deterministic dictionary translator. It is not good at
// Chinese, but it is faithful to the response contract the extension asks
// for, which is what the transport and validation layers are being tested on.

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

// ---------------------------------------------------------------------------
// The fake model
// ---------------------------------------------------------------------------

// [source, english, back-translation]. `back` is deliberately a paraphrase of
// `source` rather than a copy: a real model's back-translation is derived from
// its own English, and an exact echo of the draft trips a soft warning.
const LEXICON = [
  ["请帮我", "please help me", "请协助我"],
  ["请先", "first, please", "请首先"],
  ["请", "please", "麻烦"],
  ["帮我", "help me", "协助我"],
  ["检查", "review", "检视"],
  ["这段代码", "this snippet", "这段程序"],
  ["这个函数", "this function", "此函数"],
  ["代码", "code", "程序代码"],
  ["函数", "function", "方法"],
  ["不要", "do not", "别"],
  ["重写", "rewrite", "改写"],
  ["整体结构", "the overall structure", "总体架构"],
  ["结构", "structure", "架构"],
  ["我觉得", "I think", "我认为"],
  ["我想", "I want to", "我打算"],
  ["我需要", "I need", "我要"],
  ["性能", "performance", "效能"],
  ["问题", "issue", "毛病"],
  ["可能", "may", "或许"],
  ["应该", "should", "理应"],
  ["必须", "must", "务必"],
  ["尽量", "as far as possible", "尽可能"],
  ["直接", "directly", "径直"],
  ["测试", "test", "检验"],
  ["失败", "failed", "未通过"],
  ["成功", "succeeded", "通过了"],
  ["超时", "timed out", "逾时"],
  ["重试", "retry", "再试"],
  ["报错", "throws an error", "抛出错误"],
  ["错误", "error", "差错"],
  ["日志", "logs", "记录"],
  ["接口", "the API", "该接口"],
  ["返回", "returns", "回传"],
  ["为空", "is empty", "是空的"],
  ["超过", "exceeds", "超出"],
  ["字符", "characters", "字元"],
  ["部署", "deploy", "上线"],
  ["回滚", "roll back", "撤回"],
  ["修复", "fix", "修正"],
  ["有点", "a bit", "稍微"],
  ["很", "very", "十分"],
  ["慢", "slow", "缓慢"],
  ["快", "fast", "迅速"],
  ["谢谢", "thanks", "感谢"],
  ["你好", "hello", "您好"],
  ["帮忙", "help", "帮个忙"],
  ["看一下", "take a look at", "查看一下"],
  ["确认", "confirm", "核实"],
  ["一下", "", ""],
  ["的", "", ""],
  ["了", "", ""],
  ["和", "and", "以及"],
  ["或者", "or", "或是"],
  ["但是", "but", "不过"],
  ["因为", "because", "由于"],
  ["所以", "so", "因此"],
  ["然后", "then", "接着"],
  ["现在", "now", "目前"],
  ["版本", "version", "版次"],
  ["用户", "the user", "使用者"],
  ["文件", "the file", "档案"],
  ["路径", "path", "路线"],
  ["三十", "thirty", "三十"],
  ["五十", "fifty", "五十"],
  ["两次", "twice", "两回"],
  ["一次", "once", "一回"],
  ["个", "", ""],
  ["秒", "seconds", "秒钟"],
  ["分钟", "minutes", "分"]
];

const PUNCTUATION = new Map(Object.entries({
  "，": ", ", "。": ". ", "、": ", ", "；": "; ", "：": ": ",
  "？": "? ", "！": "! ", "（": " (", "）": ") ", "“": '"', "”": '"',
  "《": "\"", "》": "\"", "…": "..."
}));

const REVERSE_PUNCTUATION = new Map(Object.entries({
  ",": "，", ".": "。", ";": "；", ":": "：", "?": "？", "!": "！"
}));

const PLACEHOLDER_PATTERN = /⟦[A-Z0-9_]+_P\d+⟧/;
const HAN_PATTERN = /[㐀-鿿]/u;

function splitOnPlaceholders(text) {
  const parts = [];
  const regex = new RegExp(PLACEHOLDER_PATTERN.source, "g");
  let cursor = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > cursor) parts.push({ token: false, value: text.slice(cursor, match.index) });
    parts.push({ token: true, value: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ token: false, value: text.slice(cursor) });
  return parts;
}

// Greedy longest-match over LEXICON. Latin runs, digits and whitespace pass
// through untouched so numbers and identifiers survive, which is what the
// number-consistency checks in lib/validation.js compare.
function translateChineseRun(run, column) {
  let out = "";
  let index = 0;
  while (index < run.length) {
    const char = run[index];
    if (PUNCTUATION.has(char)) {
      out += PUNCTUATION.get(char);
      index += 1;
      continue;
    }
    if (!HAN_PATTERN.test(char)) {
      out += char;
      index += 1;
      continue;
    }
    let matched = null;
    for (const entry of LEXICON) {
      if (run.startsWith(entry[0], index)) {
        matched = entry;
        break;
      }
    }
    if (matched) {
      const piece = matched[column];
      if (piece) out += `${piece} `;
      index += matched[0].length;
      continue;
    }
    // Unknown Han: emit a Latin stand-in so the output still reads as English.
    let end = index;
    while (end < run.length && HAN_PATTERN.test(run[end])) end += 1;
    out += column === 1 ? "(untranslated term) " : `${run.slice(index, end)} `;
    index = end;
  }
  return out;
}

function tidy(text) {
  return text
    .replace(/\s+([,.;:?!])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

// English → Chinese for the independent back-translation request, which
// receives only English and must answer with plain Chinese text.
function reverseTranslate(text) {
  const reverse = LEXICON
    .filter((entry) => entry[1] && entry[2])
    .map((entry) => [entry[1], entry[2]])
    .sort((a, b) => b[0].length - a[0].length);
  let out = "";
  let index = 0;
  const lower = text.toLowerCase();
  while (index < text.length) {
    let matched = null;
    for (const [english, chinese] of reverse) {
      if (lower.startsWith(english.toLowerCase(), index)) {
        matched = [english, chinese];
        break;
      }
    }
    if (matched) {
      out += matched[1];
      index += matched[0].length;
      continue;
    }
    const char = text[index];
    if (REVERSE_PUNCTUATION.has(char)) out += REVERSE_PUNCTUATION.get(char);
    else if (char === " " ) out += "";
    else out += char;
    index += 1;
  }
  return out.trim() || "内容";
}

function fakeTranslate(protectedSource) {
  const parts = splitOnPlaceholders(protectedSource);
  let english = "";
  let back = "";
  for (const part of parts) {
    if (part.token) {
      english += ` ${part.value} `;
      back += ` ${part.value} `;
      continue;
    }
    english += translateChineseRun(part.value, 1);
    back += translateChineseRun(part.value, 2);
  }
  return { english: tidy(english), back: tidy(back) };
}

// Which of the three response shapes the extension is asking for, read off the
// system prompt the way a real model would.
function requestKind(messages) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  if (/Output only the Chinese translation/.test(system)) return "plain_chinese";
  if (/"back_translation"/.test(system)) return "json_with_back";
  return "json_english_only";
}

function userContent(messages) {
  const user = messages.filter((m) => m.role !== "system");
  return user.length > 0 ? String(user[user.length - 1].content ?? "") : "";
}

function modelReply(messages, overrides = {}) {
  const kind = requestKind(messages);
  const source = userContent(messages);
  if (kind === "plain_chinese") {
    return overrides.plainChinese ?? reverseTranslate(source);
  }
  const { english, back } = fakeTranslate(source);
  const payload = { english: overrides.english ?? english };
  if (kind === "json_with_back") payload.back_translation = overrides.back ?? back;
  payload.corrections = overrides.corrections ?? [];
  payload.ambiguous = overrides.ambiguous ?? [];
  if (overrides.mutate) overrides.mutate(payload, { source, messages });
  return JSON.stringify(payload);
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const MODEL_LIST = [
  "gpt-4o-mini", "gpt-4o", "o4-mini", "grok-3-mini",
  "deepseek-chat", "text-embedding-3-small", "whisper-1", "dall-e-3"
];

// An extension page has host permissions and needs no CORS, but a page-level
// browser test (and anyone poking the API from a devtools console) does. The
// headers are attached to every response so both work against one server.
const CORS_HEADERS = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
  "Access-Control-Max-Age": "600"
});

function json(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.byteLength),
    "x-request-id": "req_mock_0123456789ab",
    ...CORS_HEADERS,
    ...extraHeaders
  });
  res.end(body);
}

function chatEnvelope(text, { model = "mock-model", usage = null, finishReason = "stop" } = {}) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: 1700000000,
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: finishReason
    }],
    usage: usage ?? { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 }
  };
}

function responsesEnvelope(text, { model = "mock-model", reasoningItem = false } = {}) {
  const output = [];
  if (reasoningItem) output.push({ type: "reasoning", id: "rs_1", summary: [] });
  output.push({
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }]
  });
  return {
    id: "resp_mock",
    object: "response",
    created_at: 1700000000,
    status: "completed",
    model,
    output,
    usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160 }
  };
}

function sseHead(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "x-request-id": "req_mock_stream_0123",
    ...CORS_HEADERS
  });
}

function chatDeltaEvent(delta, extra = {}) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: null, ...extra }]
  };
}

// Cuts text into `count` roughly equal pieces, splitting on code points so a
// chunk never ends inside a surrogate pair (the byte-level splitting tests do
// that deliberately, at the Buffer level).
function sliceText(text, count) {
  const points = [...text];
  const size = Math.max(1, Math.ceil(points.length / count));
  const out = [];
  for (let index = 0; index < points.length; index += size) {
    out.push(points.slice(index, index + size).join(""));
  }
  return out;
}

async function streamChat(res, text, { chunks = 12, delayMs = 0, done = true, finishReason = "stop" } = {}) {
  sseHead(res);
  res.write(`data: ${JSON.stringify(chatDeltaEvent({ role: "assistant", content: "" }))}\n\n`);
  for (const piece of sliceText(text, chunks)) {
    if (delayMs) await sleep(delayMs);
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(chatDeltaEvent({ content: piece }))}\n\n`);
  }
  res.write(`data: ${JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    model: "mock-model",
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
  })}\n\n`);
  if (done) res.write("data: [DONE]\n\n");
  res.end();
}

async function streamResponses(res, text, { chunks = 12, delayMs = 0, done = true } = {}) {
  sseHead(res);
  res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_mock", status: "in_progress" } })}\n\n`);
  for (const piece of sliceText(text, chunks)) {
    if (delayMs) await sleep(delayMs);
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: piece })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ type: "response.completed", response: responsesEnvelope(text) })}\n\n`);
  if (done) res.write("data: [DONE]\n\n");
  res.end();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const NGINX_502 = `<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx/1.24.0</center>\r\n</body>\r\n</html>\r\n`;
const LOGIN_PAGE = `<!DOCTYPE html>\n<html lang="en"><head><title>Sign in</title></head>\n<body><form action="/login"><input name="password"></form></body></html>\n`;

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
//
// Each handler receives { req, res, endpoint, body, streamRequested, state,
// protocol }. `state` is a per-scenario object that survives across requests
// so sequences (429 → 200, degrade → degrade → 200) can be expressed, and is
// cleared by handle.reset().

const scenarios = new Map();

function scenario(name, handler) {
  scenarios.set(name, handler);
}

function modelListPayload() {
  return { object: "list", data: MODEL_LIST.map((id) => ({ id, object: "model", owned_by: "mock" })) };
}

function replyText(ctx, text, options = {}) {
  const { res, protocol, streamRequested } = ctx;
  // A scenario that reaches its success path serves /models normally, so every
  // failure scenario applies to /models too without extra wiring.
  if (ctx.endpoint === "models") return json(res, 200, modelListPayload());
  if (streamRequested) {
    return protocol === "responses"
      ? streamResponses(res, text, options)
      : streamChat(res, text, options);
  }
  return json(res, 200, protocol === "responses"
    ? responsesEnvelope(text, options)
    : chatEnvelope(text, options));
}

function ok(ctx, overrides = {}, options = {}) {
  return replyText(ctx, modelReply(ctx.body.messages ?? ctx.inputMessages, overrides), options);
}

// -- happy paths ------------------------------------------------------------

scenario("ok", (ctx) => ok(ctx));

scenario("slow_chunks", (ctx) => ok(ctx, {}, { chunks: 8, delayMs: 25 }));

scenario("one_byte_stream", async (ctx) => {
  // Byte-at-a-time SSE: every event boundary, every multi-byte character and
  // every JSON escape is guaranteed to straddle a chunk boundary.
  const text = modelReply(ctx.body.messages);
  const { res } = ctx;
  sseHead(res);
  const payload = Buffer.from(
    `data: ${JSON.stringify(chatDeltaEvent({ role: "assistant", content: "" }))}\n\n`
    + sliceText(text, 6).map((piece) => `data: ${JSON.stringify(chatDeltaEvent({ content: piece }))}\n\n`).join("")
    + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`
    + "data: [DONE]\n\n",
    "utf8"
  );
  for (const byte of payload) {
    if (res.writableEnded) return;
    res.write(Buffer.from([byte]));
    await sleep(0);
  }
  res.end();
});

scenario("split_utf8_stream", async (ctx) => {
  // Splits the SSE body at a byte offset that lands inside a multi-byte
  // character, which only a streaming TextDecoder survives.
  const text = modelReply(ctx.body.messages);
  const { res } = ctx;
  sseHead(res);
  const events = [
    `data: ${JSON.stringify(chatDeltaEvent({ role: "assistant", content: "" }))}\n\n`,
    ...sliceText(text, 4).map((piece) => `data: ${JSON.stringify(chatDeltaEvent({ content: piece }))}\n\n`),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ];
  const buffer = Buffer.from(events.join(""), "utf8");
  // Find a byte in the middle that is a UTF-8 continuation byte (0b10xxxxxx)
  // and cut there.
  let cut = Math.floor(buffer.byteLength / 2);
  while (cut < buffer.byteLength - 1 && (buffer[cut] & 0xc0) !== 0x80) cut += 1;
  res.write(buffer.subarray(0, cut));
  await sleep(10);
  res.write(buffer.subarray(cut));
  res.end();
});

scenario("crlf_stream", async (ctx) => {
  // CRLF line endings, `:` comment keep-alives, `data:` with no space, and a
  // single event carrying two data lines — all legal SSE, all seen in the wild.
  const text = modelReply(ctx.body.messages);
  const { res } = ctx;
  sseHead(res);
  res.write(": ping\r\n\r\n");
  res.write(`data:${JSON.stringify(chatDeltaEvent({ role: "assistant", content: "" }))}\r\n\r\n`);
  const pieces = sliceText(text, 4);
  for (const piece of pieces) {
    res.write(": keep-alive\r\n\r\n");
    res.write(`event: chunk\r\ndata:${JSON.stringify(chatDeltaEvent({ content: piece }))}\r\n\r\n`);
    await sleep(2);
  }
  res.write(`data:${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\r\n\r\n`);
  res.write("data:[DONE]\r\n\r\n");
  res.write(": trailing noise after DONE\r\n\r\n");
  res.end();
});

scenario("multiline_data_stream", async (ctx) => {
  // Pretty-printed JSON in the event payload: relays that marshal with
  // indentation emit one `data:` line per JSON line, and the spec requires the
  // client to rejoin them with \n before parsing.
  const text = modelReply(ctx.body.messages);
  const { res } = ctx;
  sseHead(res);
  const pretty = JSON.stringify(chatDeltaEvent({ role: "assistant", content: text }), null, 2);
  res.write(`${pretty.split("\n").map((line) => `data: ${line}`).join("\n")}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});

scenario("sse_dropped_event", async (ctx) => {
  // One malformed event in the middle of an otherwise healthy stream. The
  // stream still terminates with finish_reason: stop, so nothing downstream
  // knows a delta went missing.
  const text = modelReply(ctx.body.messages);
  const { res } = ctx;
  sseHead(res);
  const pieces = sliceText(text, 6);
  res.write(`data: ${JSON.stringify(chatDeltaEvent({ role: "assistant", content: "" }))}\n\n`);
  for (const [index, piece] of pieces.entries()) {
    if (index === 3) {
      res.write(`data: {"choices":[{"delta":{"content":"${piece}"\n\n`); // truncated JSON
      continue;
    }
    res.write(`data: ${JSON.stringify(chatDeltaEvent({ content: piece }))}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});

scenario("sse_done_whitespace", async (ctx) => {
  // The terminator with trailing whitespace, plus a huge error-body sibling
  // below: both are shapes seen from real relays.
  const text = modelReply(ctx.body.messages);
  const { res } = ctx;
  sseHead(res);
  for (const piece of sliceText(text, 4)) {
    res.write(`data: ${JSON.stringify(chatDeltaEvent({ content: piece }))}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE] \r\n\r\n");
  res.end();
});

scenario("huge_error_body", (ctx) => {
  // A 500 whose body is far past the error-body read cap. The HTTP status must
  // still drive the classification instead of an oversize-body error.
  const body = Buffer.from(`<html><body>${"e".repeat(200_000)}</body></html>`, "utf8");
  ctx.res.writeHead(500, {
    "Content-Type": "text/html",
    "Content-Length": String(body.byteLength)
  });
  ctx.res.end(body);
});

scenario("sse_refusal", (ctx) => {
  sseHead(ctx.res);
  ctx.res.write(`data: ${JSON.stringify(chatDeltaEvent({ role: "assistant", refusal: "I can't help with that." }))}\n\n`);
  ctx.res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
  ctx.res.write("data: [DONE]\n\n");
  ctx.res.end();
});

scenario("sse_usage_final", async (ctx) => {
  // OpenAI's documented streamed-usage shape: a final chunk with an empty
  // choices array carrying the usage block.
  const text = modelReply(ctx.body.messages);
  const { res } = ctx;
  sseHead(res);
  res.write(`data: ${JSON.stringify(chatDeltaEvent({ role: "assistant", content: "" }))}\n\n`);
  for (const piece of sliceText(text, 4)) {
    res.write(`data: ${JSON.stringify(chatDeltaEvent({ content: piece }))}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write(`data: ${JSON.stringify({
    id: "chatcmpl-mock", object: "chat.completion.chunk", model: "mock-model", choices: [],
    usage: { prompt_tokens: 111, completion_tokens: 22, total_tokens: 133, completion_tokens_details: { reasoning_tokens: 7 } }
  })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});

scenario("sse_array_content", async (ctx) => {
  // Relays fronting non-OpenAI models often stream content as typed parts
  // rather than a bare string. The buffered path accepts this shape.
  const text = modelReply(ctx.body.messages);
  const { res } = ctx;
  if (!ctx.streamRequested) {
    return json(res, 200, {
      id: "chatcmpl-mock", object: "chat.completion", model: "mock-model",
      choices: [{
        index: 0,
        message: { role: "assistant", content: [{ type: "text", text }] },
        finish_reason: "stop"
      }]
    });
  }
  sseHead(res);
  for (const piece of sliceText(text, 4)) {
    res.write(`data: ${JSON.stringify(chatDeltaEvent({ content: [{ type: "text", text: piece }] }))}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});

scenario("sse_content_type_json_body", (ctx) => {
  // Mislabelled: SSE content type, ordinary JSON body.
  const body = Buffer.from(JSON.stringify(chatEnvelope(modelReply(ctx.body.messages))), "utf8");
  ctx.res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Content-Length": String(body.byteLength)
  });
  ctx.res.end(body);
});

scenario("sse_body_on_buffered", (ctx) => {
  // The mirror image: a buffered request answered with an SSE body.
  const text = modelReply(ctx.body.messages);
  const body = Buffer.from(
    `data: ${JSON.stringify(chatDeltaEvent({ role: "assistant", content: text }))}\n\ndata: [DONE]\n\n`,
    "utf8"
  );
  ctx.res.writeHead(200, { "Content-Type": "text/event-stream", "Content-Length": String(body.byteLength) });
  ctx.res.end(body);
});

scenario("worst_case", (ctx) => {
  // Degrades one field per request and then never returns parseable JSON:
  // used to measure how many paid requests a single draft can cost.
  ctx.state.count = (ctx.state.count ?? 0) + 1;
  if (ctx.body.response_format || ctx.body.text?.format) {
    return rejectParam(ctx.res, "response_format", "Unsupported parameter: response_format");
  }
  if ("temperature" in ctx.body) {
    return rejectParam(ctx.res, "temperature", "Unsupported parameter: temperature");
  }
  if (ctx.body.stream === true) {
    return rejectParam(ctx.res, "stream", "Unsupported parameter: stream");
  }
  return replyText(ctx, "sorry, I cannot output JSON");
});

scenario("many_models", (ctx) => {
  if (ctx.endpoint === "models") {
    return json(ctx.res, 200, {
      object: "list",
      data: [
        ...Array.from({ length: 6000 }, (_, index) => ({ id: `model-${index}`, object: "model" })),
        { id: "gpt-4o-mini", object: "model" },
        { id: "gpt-4o-mini", object: "model" },
        { id: "x".repeat(300), object: "model" },
        { id: "", object: "model" },
        null,
        { object: "model" }
      ]
    });
  }
  return ok(ctx);
});

// Fields a conformant OpenAI-compatible gateway is expected to understand.
// Anything else in the body is rejected the way strict relays and Azure-style
// deployments do ("Unrecognized request argument supplied: …").
const KNOWN_CHAT_FIELDS = new Set([
  "model", "messages", "stream", "stream_options", "response_format", "temperature",
  "top_p", "max_tokens", "max_completion_tokens", "n", "stop", "presence_penalty",
  "frequency_penalty", "seed", "user", "logprobs", "tools", "tool_choice"
]);
const KNOWN_RESPONSES_FIELDS = new Set([
  "model", "input", "instructions", "stream", "store", "text", "temperature",
  "top_p", "max_output_tokens", "metadata", "tools", "tool_choice", "include",
  "previous_response_id", "truncation", "user"
]);

scenario("strict_schema", (ctx) => {
  const known = ctx.protocol === "responses" ? KNOWN_RESPONSES_FIELDS : KNOWN_CHAT_FIELDS;
  const unknown = Object.keys(ctx.rawBody ? JSON.parse(ctx.rawBody) : {}).filter(
    (key) => !known.has(key)
  );
  if (unknown.length > 0) {
    return json(ctx.res, 400, {
      error: {
        message: `Unrecognized request argument supplied: ${unknown.join(", ")}`,
        type: "invalid_request_error",
        param: unknown[0],
        code: "unknown_parameter"
      }
    });
  }
  return ok(ctx);
});

scenario("strict_accept", (ctx) => {
  // A gateway that performs real content negotiation. A streaming request that
  // advertises only `Accept: application/json` is refused with 406.
  const accept = String(ctx.req.headers.accept ?? "");
  if (ctx.streamRequested && !/text\/event-stream|\*\/\*/.test(accept)) {
    return json(ctx.res, 406, {
      error: { message: "Not Acceptable: streaming requires Accept: text/event-stream", code: "not_acceptable" }
    });
  }
  return ok(ctx);
});

scenario("no_done_stream", (ctx) => ok(ctx, {}, { done: false }));

scenario("ignores_stream", (ctx) => {
  // Gateway accepts `stream: true` and answers with buffered JSON anyway.
  json(ctx.res, 200, chatEnvelope(modelReply(ctx.body.messages)));
});

scenario("gzip", (ctx) => {
  const body = gzipSync(Buffer.from(JSON.stringify(chatEnvelope(modelReply(ctx.body.messages))), "utf8"));
  ctx.res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Encoding": "gzip",
    "Content-Length": String(body.byteLength)
  });
  ctx.res.end(body);
});

scenario("bom", (ctx) => {
  const body = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify(chatEnvelope(modelReply(ctx.body.messages))), "utf8")
  ]);
  ctx.res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(body.byteLength) });
  ctx.res.end(body);
});

scenario("no_content_type", (ctx) => {
  const body = Buffer.from(JSON.stringify(chatEnvelope(modelReply(ctx.body.messages))), "utf8");
  ctx.res.writeHead(200, { "Content-Length": String(body.byteLength) });
  ctx.res.end(body);
});

scenario("gbk", (ctx) => {
  // Chinese relays occasionally serve GB18030-encoded JSON while declaring it.
  // fetch() always decodes as UTF-8, so the Chinese arrives mojibake.
  const payload = JSON.stringify(chatEnvelope(modelReply(ctx.body.messages)));
  const bytes = [];
  for (const char of payload) {
    const code = char.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else bytes.push(0x81 + (code % 0x30), 0x40 + (code % 0x3f)); // plausible 2-byte GBK
  }
  const body = Buffer.from(bytes);
  ctx.res.writeHead(200, {
    "Content-Type": "application/json; charset=gbk",
    "Content-Length": String(body.byteLength)
  });
  ctx.res.end(body);
});

scenario("reasoning_usage", (ctx) => {
  const text = modelReply(ctx.body.messages);
  json(ctx.res, 200, ctx.protocol === "responses"
    ? { ...responsesEnvelope(text, { reasoningItem: true }), usage: { input_tokens: 100, output_tokens: 80, output_tokens_details: { reasoning_tokens: 55 } } }
    : { ...chatEnvelope(text), usage: { prompt_tokens: 100, completion_tokens: 80, completion_tokens_details: { reasoning_tokens: 55 } } });
});

scenario("fenced_json", (ctx) => replyText(ctx, `\`\`\`json\n${modelReply(ctx.body.messages)}\n\`\`\``));

scenario("prose_then_json", (ctx) => replyText(
  ctx,
  `Sure! Here is the translation you asked for:\n\n${modelReply(ctx.body.messages)}\n\nLet me know if you need changes.`
));

scenario("metadata_object_first", (ctx) => replyText(
  ctx,
  `{"trace_id":"abc","cached":false}\n${modelReply(ctx.body.messages)}`
));

scenario("corrections", (ctx) => ok(ctx, {
  corrections: [{ original: "代码", interpreted_as: "code", reason: "typo" }]
}));

scenario("valid_correction", (ctx) => ok(ctx, {
  // 结构 → 结果 : two Han characters, edit distance 1, no numerals, no
  // polarity flip — the only class of correction local rules accept.
  corrections: [{ original: "结构", interpreted_as: "结果", reason: "likely input slip" }]
}));

scenario("ambiguous", (ctx) => ok(ctx, {
  ambiguous: [{ fragment: "性能", reading_used: "performance", alternatives: ["throughput", "efficiency"] }]
}));

// -- HTTP-level failures ----------------------------------------------------

scenario("unauthorized", (ctx) => json(ctx.res, 401, {
  error: { message: "Incorrect API key provided: sk-mock-**********ey. Check your key.", type: "invalid_request_error", code: "invalid_api_key" }
}));

scenario("forbidden_echoes_key", (ctx) => json(ctx.res, 403, {
  error: { message: `Key ${ctx.req.headers.authorization ?? ""} is not permitted for this model`, code: "permission_denied" }
}));

scenario("rate_limited", (ctx) => json(ctx.res, 429, {
  error: { message: "Rate limit reached for gpt-4o-mini in organization org-x on tokens per min", code: "rate_limit_exceeded" }
}, { "Retry-After": "3" }));

scenario("rate_limited_http_date", (ctx) => json(ctx.res, 429, {
  error: { message: "Too many requests", code: "rate_limit_exceeded" }
}, { "Retry-After": new Date(Date.now() + 42_000).toUTCString() }));

scenario("quota_exhausted", (ctx) => json(ctx.res, 429, {
  error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" }
}));

scenario("server_error", (ctx) => json(ctx.res, 503, {
  error: { message: "The engine is currently overloaded, please try again later", code: "overloaded" }
}));

scenario("bad_gateway_html", (ctx) => {
  const body = Buffer.from(NGINX_502, "utf8");
  ctx.res.writeHead(502, { "Content-Type": "text/html", "Content-Length": String(body.byteLength) });
  ctx.res.end(body);
});

scenario("relay_responses_502", (ctx) => {
  // The exact shape 0.2.11 was written for: chat/completions works, the
  // /responses route has no upstream channel behind the relay.
  if (ctx.endpoint === "responses") {
    return json(ctx.res, 502, {
      error: { message: "no available channel for model gpt-4o-mini on route /v1/responses", code: "channel_unavailable" }
    });
  }
  return ok(ctx);
});

scenario("relay_stream_502", (ctx) => {
  // Buffered requests work; the SSE route is broken. Only a test that mirrors
  // the live streaming setting can catch this.
  if (ctx.streamRequested) {
    return json(ctx.res, 502, { error: { message: "streaming not supported by this channel", code: "stream_unavailable" } });
  }
  return ok(ctx);
});

scenario("login_html", (ctx) => {
  const body = Buffer.from(LOGIN_PAGE, "utf8");
  ctx.res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": String(body.byteLength) });
  ctx.res.end(body);
});

scenario("empty_body", (ctx) => {
  ctx.res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "0" });
  ctx.res.end();
});

scenario("plain_text", (ctx) => {
  const body = Buffer.from("OK\n", "utf8");
  ctx.res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": String(body.byteLength) });
  ctx.res.end(body);
});

scenario("json_error_200", (ctx) => json(ctx.res, 200, {
  error: { message: "insufficient balance", code: "insufficient_balance" }
}));

scenario("model_not_found", (ctx) => json(ctx.res, 404, {
  error: { message: "The model `nope-1` does not exist or you do not have access to it.", type: "invalid_request_error", code: "model_not_found" }
}));

scenario("route_not_found", (ctx) => json(ctx.res, 404, {
  error: { message: "Not Found", type: "invalid_request_error" }
}));

scenario("method_not_allowed", (ctx) => json(ctx.res, 405, { error: { message: "Method Not Allowed" } }));

scenario("payload_too_large", (ctx) => json(ctx.res, 413, {
  error: { message: "Request entity too large", code: "request_too_large" }
}));

scenario("redirect", (ctx) => {
  ctx.res.writeHead(302, { Location: "/v1/chat/completions", "Content-Length": "0" });
  ctx.res.end();
});

scenario("slow_once", async (ctx) => {
  // Only the first request is slow. Used to drive the stale-response race: the
  // user edits the draft while request #1 is still in flight, and #1's answer
  // must never reach the composer.
  ctx.state.count = (ctx.state.count ?? 0) + 1;
  if (ctx.state.count === 1) await sleep(1200);
  return ok(ctx);
});

scenario("slow", async (ctx) => {
  await sleep(ctx.query.get("ms") ? Number(ctx.query.get("ms")) : 900);
  return ok(ctx);
});

scenario("stall_headers", (ctx) => {
  // Headers sent, body never arrives: the classic hung gateway.
  ctx.res.writeHead(200, { "Content-Type": "application/json" });
  ctx.res.write("{");
});

scenario("stall_stream", (ctx) => {
  // One delta then silence. A naive client shows a half-written preview
  // forever; the request must die on the timeout instead.
  sseHead(ctx.res);
  ctx.res.write(`data: ${JSON.stringify(chatDeltaEvent({ role: "assistant", content: '{"english":"partial' }))}\n\n`);
});

scenario("socket_reset", (ctx) => {
  ctx.req.socket.destroy();
});

scenario("stream_then_reset", (ctx) => {
  sseHead(ctx.res);
  ctx.res.write(`data: ${JSON.stringify(chatDeltaEvent({ role: "assistant", content: '{"english":"half' }))}\n\n`);
  setTimeout(() => ctx.req.socket.destroy(), 20);
});

scenario("huge_response", (ctx) => {
  const filler = "x".repeat(600_000);
  json(ctx.res, 200, chatEnvelope(JSON.stringify({ english: filler, back_translation: "很长", corrections: [], ambiguous: [] })));
});

scenario("huge_response_chunked", (ctx) => {
  // No Content-Length, so the byte cap has to be enforced while streaming.
  ctx.res.writeHead(200, { "Content-Type": "application/json" });
  ctx.res.write('{"choices":[{"message":{"role":"assistant","content":"');
  for (let index = 0; index < 40; index += 1) ctx.res.write("y".repeat(20_000));
  ctx.res.write('"}}]}');
  ctx.res.end();
});

scenario("huge_stream", (ctx) => {
  // Never stops on its own: the test asserts the client cancels and that the
  // server observes the cancellation (state.aborted).
  sseHead(ctx.res);
  ctx.state.aborted = false;
  ctx.res.on("close", () => { ctx.state.aborted = true; });
  const timer = setInterval(() => {
    if (ctx.res.writableEnded || ctx.res.destroyed) {
      clearInterval(timer);
      return;
    }
    ctx.res.write(`data: ${JSON.stringify(chatDeltaEvent({ content: "z".repeat(4_000) }))}\n\n`);
  }, 1);
  ctx.res.on("close", () => clearInterval(timer));
});

// -- capability degradation -------------------------------------------------

function rejectParam(res, param, message) {
  return json(res, 400, {
    error: { message, type: "invalid_request_error", param, code: "unsupported_parameter" }
  });
}

scenario("reject_response_format", (ctx) => {
  if (ctx.body.response_format || ctx.body.text?.format) {
    return rejectParam(ctx.res, "response_format", "response_format is not supported by this model");
  }
  return ok(ctx);
});

scenario("reject_temperature", (ctx) => {
  if ("temperature" in ctx.body) {
    return rejectParam(ctx.res, "temperature", "temperature is not supported with this model");
  }
  return ok(ctx);
});

scenario("reject_json_then_temperature", (ctx) => {
  if (ctx.body.response_format || ctx.body.text?.format) {
    return rejectParam(ctx.res, "response_format", "Unsupported parameter: response_format");
  }
  if ("temperature" in ctx.body) {
    return rejectParam(ctx.res, "temperature", "Unsupported parameter: temperature");
  }
  return ok(ctx);
});

scenario("reject_stream", (ctx) => {
  if (ctx.body.stream === true) {
    return rejectParam(ctx.res, "stream", "stream is not supported on this deployment");
  }
  return ok(ctx);
});

scenario("reject_all_vague", (ctx) => {
  ctx.state.count = (ctx.state.count ?? 0) + 1;
  if (ctx.state.count === 1) {
    return json(ctx.res, 400, {
      error: { message: "Unsupported parameter in request body", code: "unsupported_parameter" }
    });
  }
  return ok(ctx);
});

scenario("reject_upstream_wording", (ctx) => {
  // "upstream" contains "stream": a message-substring matcher would degrade to
  // a paid non-streaming retry on an error that has nothing to do with SSE.
  json(ctx.res, 400, { error: { message: "invalid parameter: upstream request malformed", code: "bad_request" } });
});

scenario("reject_reasoning", (ctx) => json(ctx.res, 400, {
  error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model", param: "reasoning_effort", code: "unsupported_parameter" }
}));

scenario("reject_thinking", (ctx) => json(ctx.res, 400, {
  error: { message: "thinking is not supported", param: "thinking.type", code: "invalid_request_error" }
}));

scenario("plain_400", (ctx) => json(ctx.res, 400, {
  error: { message: "messages[0].content must be a string", type: "invalid_request_error", param: "messages" }
}));

scenario("flaky_500", (ctx) => {
  ctx.state.count = (ctx.state.count ?? 0) + 1;
  if (ctx.state.count === 1) return json(ctx.res, 500, { error: { message: "internal error" } });
  return ok(ctx);
});

scenario("rate_limited_once", (ctx) => {
  ctx.state.count = (ctx.state.count ?? 0) + 1;
  if (ctx.state.count === 1) {
    return json(ctx.res, 429, { error: { message: "slow down", code: "rate_limit_exceeded" } }, { "Retry-After": "1" });
  }
  return ok(ctx);
});

// -- malformed model output -------------------------------------------------

scenario("invalid_json_once", (ctx) => {
  ctx.state.count = (ctx.state.count ?? 0) + 1;
  if (ctx.state.count === 1) return replyText(ctx, "english: please review this snippet");
  return ok(ctx);
});

scenario("invalid_json_always", (ctx) => replyText(ctx, "I cannot produce JSON right now."));

scenario("echo_source", (ctx) => ok(ctx, { english: userContent(ctx.body.messages) }));

scenario("mostly_untranslated", (ctx) => {
  const source = userContent(ctx.body.messages);
  return ok(ctx, { english: `note: ${source}` });
});

scenario("english_back_translation", (ctx) => ok(ctx, { back: "This is the back translation in English." }));

scenario("empty_english", (ctx) => ok(ctx, { english: "   " }));

scenario("control_chars", (ctx) => ok(ctx, {
  mutate: (payload) => { payload.english = `please review‮this snippet`; }
}));

scenario("drop_placeholder", (ctx) => ok(ctx, {
  mutate: (payload) => {
    payload.english = payload.english.replace(PLACEHOLDER_PATTERN, "").trim();
  }
}));

scenario("duplicate_placeholder", (ctx) => ok(ctx, {
  mutate: (payload) => {
    const token = payload.english.match(PLACEHOLDER_PATTERN)?.[0];
    if (token) payload.english = `${payload.english} ${token}`;
  }
}));

scenario("unknown_placeholder", (ctx) => ok(ctx, {
  mutate: (payload) => {
    const token = payload.english.match(PLACEHOLDER_PATTERN)?.[0];
    if (token) payload.english = `${payload.english} ${token.replace(/_P(\d+)⟧$/, "_P99⟧")}`;
  }
}));

scenario("reordered_placeholders", (ctx) => ok(ctx, {
  mutate: (payload) => {
    const tokens = payload.english.match(new RegExp(PLACEHOLDER_PATTERN.source, "g")) ?? [];
    if (tokens.length >= 2) {
      let index = 0;
      const reversed = [...tokens].reverse();
      payload.english = payload.english.replace(
        new RegExp(PLACEHOLDER_PATTERN.source, "g"),
        () => reversed[index++]
      );
    }
  }
}));

scenario("numeral_correction_once", (ctx) => {
  ctx.state.count = (ctx.state.count ?? 0) + 1;
  if (ctx.state.count === 1) {
    return ok(ctx, {
      english: "please raise the limit to fifty",
      corrections: [{ original: "三十", interpreted_as: "五十", reason: "assumed a typo" }]
    });
  }
  return ok(ctx, { english: "please raise the limit to thirty", back: "请把上限提到三十" });
});

scenario("polarity_correction_always", (ctx) => ok(ctx, {
  corrections: [{ original: "开启", interpreted_as: "关闭", reason: "assumed a typo" }]
}));

scenario("too_many_corrections", (ctx) => ok(ctx, {
  corrections: Array.from({ length: 9 }, (_, index) => ({
    original: `词${index}`, interpreted_as: `字${index}`, reason: "slip"
  }))
}));

scenario("corrections_not_array", (ctx) => ok(ctx, {
  mutate: (payload) => { payload.corrections = "none"; }
}));

scenario("empty_choices", (ctx) => json(ctx.res, 200, {
  id: "chatcmpl-mock", object: "chat.completion", model: "mock-model", choices: []
}));

scenario("finish_length", (ctx) => json(ctx.res, 200, {
  ...chatEnvelope(modelReply(ctx.body.messages).slice(0, 40), { finishReason: "length" })
}));

scenario("refusal", (ctx) => json(ctx.res, 200, {
  id: "chatcmpl-mock", object: "chat.completion", model: "mock-model",
  choices: [{ index: 0, message: { role: "assistant", content: null, refusal: "I can't help with that." }, finish_reason: "stop" }]
}));

scenario("tool_calls", (ctx) => json(ctx.res, 200, {
  id: "chatcmpl-mock", object: "chat.completion", model: "mock-model",
  choices: [{
    index: 0,
    message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "translate", arguments: "{}" } }] },
    finish_reason: "tool_calls"
  }]
}));

scenario("role_user", (ctx) => json(ctx.res, 200, {
  id: "chatcmpl-mock", object: "chat.completion", model: "mock-model",
  choices: [{ index: 0, message: { role: "user", content: modelReply(ctx.body.messages) }, finish_reason: "stop" }]
}));

scenario("unknown_finish_reason", (ctx) => json(ctx.res, 200, {
  ...chatEnvelope(modelReply(ctx.body.messages), { finishReason: "max_tokens_reached" })
}));

scenario("responses_shape_on_chat", (ctx) => json(ctx.res, 200, responsesEnvelope(modelReply(ctx.body.messages))));

scenario("chat_shape_on_responses", (ctx) => json(ctx.res, 200, chatEnvelope(modelReply(ctx.inputMessages))));

scenario("responses_incomplete", (ctx) => json(ctx.res, 200, {
  ...responsesEnvelope(modelReply(ctx.inputMessages)),
  status: "incomplete",
  incomplete_details: { reason: "max_output_tokens" }
}));

scenario("responses_in_progress", (ctx) => json(ctx.res, 200, {
  ...responsesEnvelope(modelReply(ctx.inputMessages)),
  status: "in_progress"
}));

scenario("responses_refusal", (ctx) => json(ctx.res, 200, {
  id: "resp_mock", object: "response", status: "completed", model: "mock-model",
  output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "no" }] }]
}));

scenario("responses_function_call", (ctx) => json(ctx.res, 200, {
  id: "resp_mock", object: "response", status: "completed", model: "mock-model",
  output: [{ type: "function_call", id: "f1", name: "translate", arguments: "{}" }]
}));

scenario("sse_error_event", (ctx) => {
  sseHead(ctx.res);
  ctx.res.write(`data: ${JSON.stringify(chatDeltaEvent({ role: "assistant", content: '{"eng' }))}\n\n`);
  ctx.res.write(`data: ${JSON.stringify({ error: { message: "upstream closed", code: "upstream_error" } })}\n\n`);
  ctx.res.end();
});

scenario("sse_tool_calls", (ctx) => {
  sseHead(ctx.res);
  ctx.res.write(`data: ${JSON.stringify(chatDeltaEvent({ role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function" }] }))}\n\n`);
  ctx.res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
  ctx.res.write("data: [DONE]\n\n");
  ctx.res.end();
});

scenario("sse_finish_length", (ctx) => {
  streamChat(ctx.res, modelReply(ctx.body.messages).slice(0, 60), { chunks: 3, finishReason: "length" });
});

scenario("sse_empty", (ctx) => {
  sseHead(ctx.res);
  ctx.res.write(": keep-alive\n\n");
  ctx.res.end();
});

scenario("sse_responses_no_completion", (ctx) => {
  sseHead(ctx.res);
  ctx.res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: '{"english":"hi' })}\n\n`);
  ctx.res.write("data: [DONE]\n\n");
  ctx.res.end();
});

scenario("http10_close", (ctx) => {
  // HTTP/1.0-style framing: no Content-Length, body delimited by the close.
  const body = JSON.stringify(chatEnvelope(modelReply(ctx.body.messages)));
  ctx.res.socket.write(
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${body}`
  );
  ctx.res.socket.end();
  ctx.res.detachSocket?.(ctx.res.socket);
});

scenario("no_content", (ctx) => {
  ctx.res.writeHead(204, { ...CORS_HEADERS });
  ctx.res.end();
});

scenario("bad_gzip", (ctx) => {
  // Declares gzip, sends plain text: a real proxy misconfiguration.
  const body = Buffer.from(JSON.stringify(chatEnvelope(modelReply(ctx.body.messages))), "utf8");
  ctx.res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Encoding": "gzip",
    "Content-Length": String(body.byteLength)
  });
  ctx.res.end(body);
});

scenario("slow_first_delta", async (ctx) => {
  // Long time-to-first-token, then a fast stream.
  sseHead(ctx.res);
  await sleep(700);
  if (ctx.res.writableEnded) return;
  const text = modelReply(ctx.body.messages);
  ctx.res.write(`data: ${JSON.stringify(chatDeltaEvent({ role: "assistant", content: text }))}\n\n`);
  ctx.res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
  ctx.res.write("data: [DONE]\n\n");
  ctx.res.end();
});

scenario("escaped_json_stream", async (ctx) => {
  // Python-style ensure_ascii output: the model's JSON arrives full of \uXXXX
  // escapes, and every escape is guaranteed to straddle a chunk boundary.
  const text = modelReply(ctx.body.messages).replace(
    /[-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
  const { res } = ctx;
  sseHead(res);
  const payload = Buffer.from(
    sliceText(text, 8).map((piece) => `data: ${JSON.stringify(chatDeltaEvent({ content: piece }))}\n\n`).join("")
    + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`
    + "data: [DONE]\n\n",
    "utf8"
  );
  for (const byte of payload) {
    if (res.writableEnded) return;
    res.write(Buffer.from([byte]));
  }
  res.end();
});

scenario("output_text_only", (ctx) => json(ctx.res, 200, {
  id: "resp_mock", object: "response", status: "completed", model: "mock-model",
  output_text: modelReply(ctx.inputMessages)
}));

scenario("error_null", (ctx) => json(ctx.res, 200, {
  ...chatEnvelope(modelReply(ctx.body.messages)), error: null
}));

scenario("choices_and_error", (ctx) => json(ctx.res, 200, {
  ...chatEnvelope(modelReply(ctx.body.messages)),
  error: { message: "partial upstream failure", code: "partial_failure" }
}));

// Serves whatever the test queued with handle.queueRaw(). Used for the
// malformed-payload sweep: every response body must still fail as a classified
// error rather than a raw TypeError reaching the panel.
scenario("raw", (ctx) => {
  const next = ctx.state.queue?.shift();
  if (!next) return json(ctx.res, 200, chatEnvelope(modelReply(ctx.body.messages)));
  const body = Buffer.from(next.body, "utf8");
  ctx.res.writeHead(next.status ?? 200, {
    "Content-Type": next.contentType ?? "application/json",
    "Content-Length": String(body.byteLength),
    ...CORS_HEADERS
  });
  ctx.res.end(body);
});

// -- Google AI Studio OpenAI-compatibility layer ----------------------------
//
// Verified against the real endpoint: every error is wrapped in a one-element
// JSON array, error.code is a number, there is no error.param, the auth
// failure is a 400 rather than a 401, and 429 carries no Retry-After header.

function googleError(res, status, message, extra = {}) {
  const body = Buffer.from(JSON.stringify([{
    error: { code: status, message, status: extra.status ?? "INVALID_ARGUMENT" }
  }]), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=UTF-8",
    "Content-Length": String(body.byteLength),
    ...CORS_HEADERS
  });
  res.end(body);
}

scenario("google_model_not_found", (ctx) => googleError(
  ctx.res, 404,
  "models/gemini-does-not-exist is not found for API version v1main, or is not supported for generateContent. "
  + "Call ModelService.ListModels to see the list of available models and their supported methods.",
  { status: "NOT_FOUND" }
));

scenario("google_quota", (ctx) => googleError(
  ctx.res, 429,
  "You exceeded your current quota, please check your plan and billing details. "
  + "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, "
  + "limit: 5, model: gemini-3.5-flash Please retry in 4.686262257s.",
  { status: "RESOURCE_EXHAUSTED" }
));

scenario("google_bad_key", (ctx) => googleError(ctx.res, 400, "Please pass a valid API key."));

scenario("google_unknown_field", (ctx) => googleError(
  ctx.res, 400, 'Invalid JSON payload received. Unknown name "thinking": Cannot find field.'
));

scenario("google_reject_response_format", (ctx) => {
  // Hypothetical but shaped exactly like the real 400s: the rejected field is
  // named only in the message, inside the array envelope.
  if (ctx.body.response_format) {
    return googleError(ctx.res, 400, 'Invalid JSON payload received. Unknown name "response_format": Cannot find field, this parameter is not supported.');
  }
  return ok(ctx);
});

scenario("google_logical_200", (ctx) => {
  const body = Buffer.from(JSON.stringify([{
    error: { code: 500, message: "Internal error encountered.", status: "INTERNAL" }
  }]), "utf8");
  ctx.res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": String(body.byteLength),
    ...CORS_HEADERS
  });
  ctx.res.end(body);
});

// -- /models variants -------------------------------------------------------

scenario("models_missing", (ctx) => {
  if (ctx.endpoint === "models") return json(ctx.res, 404, { error: { message: "Not Found" } });
  return ok(ctx);
});

scenario("models_not_a_list", (ctx) => {
  if (ctx.endpoint === "models") return json(ctx.res, 200, { object: "list", result: "ok" });
  return ok(ctx);
});

scenario("models_bare_array", (ctx) => {
  if (ctx.endpoint === "models") return json(ctx.res, 200, { models: MODEL_LIST });
  return ok(ctx);
});

scenario("models_html", (ctx) => {
  if (ctx.endpoint === "models") {
    const body = Buffer.from(LOGIN_PAGE, "utf8");
    ctx.res.writeHead(200, { "Content-Type": "text/html", "Content-Length": String(body.byteLength) });
    return ctx.res.end(body);
  }
  return ok(ctx);
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const ENDPOINTS = new Set(["chat/completions", "responses", "models"]);

// `/<scenario>/v1/chat/completions`, `/v1/models`, and the version-less
// `/<scenario>/chat/completions` (used to reproduce a Base URL that is missing
// its `/v1` prefix) all resolve here.
function parseRoute(pathname, rootScenario) {
  const segments = pathname.split("/").filter(Boolean);
  let endpoint = "";
  if (segments.length >= 2 && segments.at(-2) === "chat" && segments.at(-1) === "completions") {
    endpoint = "chat/completions";
    segments.splice(-2);
  } else if (segments.length >= 1 && ["responses", "models"].includes(segments.at(-1))) {
    endpoint = segments.at(-1);
    segments.pop();
  } else {
    return null;
  }
  if (segments.at(-1) && /^v\d+$/.test(segments.at(-1))) segments.pop();
  return { scenarioName: segments.join("/") || rootScenario, endpoint };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// `rootScenario` decides what a Base URL with no scenario segment resolves to,
// which is how a Base URL missing its `/v1` prefix is reproduced.
export function startMockProvider({ port = 0, host = "127.0.0.1", log = false, rootScenario = "ok" } = {}) {
  const requests = [];
  const states = new Map();

  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...CORS_HEADERS, "Content-Length": "0" });
      return res.end();
    }
    const url = new URL(req.url, `http://${host}`);

    // Introspection for out-of-process callers (the browser suite, or a human
    // checking how many paid requests an interaction really cost). Never part
    // of the emulated API surface.
    if (url.pathname === "/__mock/requests") {
      return json(res, 200, {
        count: requests.length,
        requests: requests.map(({ headers, rawBody, ...rest }) => rest)
      });
    }
    if (url.pathname === "/__mock/reset") {
      requests.length = 0;
      states.clear();
      return json(res, 200, { ok: true });
    }

    const route = parseRoute(url.pathname, rootScenario);
    if (!route) {
      return json(res, 404, { error: { message: `unknown route ${url.pathname}` } });
    }
    const { scenarioName, endpoint } = route;
    const rawBody = req.method === "POST" ? await readBody(req) : "";
    let body = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return json(res, 400, { error: { message: "request body is not valid JSON" } });
      }
    }

    const record = {
      scenario: scenarioName,
      endpoint,
      method: req.method,
      path: url.pathname,
      headers: { ...req.headers },
      rawBody,
      body,
      at: Date.now()
    };
    requests.push(record);
    if (log) {
      process.stderr.write(`[mock] ${req.method} ${url.pathname} scenario=${scenarioName} stream=${body.stream === true}\n`);
    }

    if (!ENDPOINTS.has(endpoint)) {
      return json(res, 404, { error: { message: `unknown endpoint /${endpoint}` } });
    }

    const handler = scenarios.get(scenarioName);
    if (!handler) {
      return json(res, 404, { error: { message: `unknown scenario ${scenarioName}` } });
    }

    if (!states.has(scenarioName)) states.set(scenarioName, {});
    const protocol = endpoint === "responses" ? "responses" : "chat_completions";

    // The Responses protocol nests message text one level deeper; expose a
    // chat-shaped view so scenario handlers do not care which protocol ran.
    const inputMessages = protocol === "responses"
      ? [
          ...(body.instructions ? [{ role: "system", content: String(body.instructions) }] : []),
          ...(Array.isArray(body.input) ? body.input.map((item) => ({
            role: item?.role ?? "user",
            content: Array.isArray(item?.content)
              ? item.content.map((part) => part?.text ?? "").join("")
              : String(item?.content ?? "")
          })) : [])
        ]
      : (Array.isArray(body.messages) ? body.messages : []);

    const ctx = {
      req,
      res,
      endpoint,
      protocol,
      body: { ...body, messages: inputMessages },
      inputMessages,
      rawBody,
      streamRequested: body.stream === true,
      state: states.get(scenarioName),
      query: url.searchParams,
      requests
    };

    try {
      await handler(ctx);
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: { message: `mock scenario crashed: ${error.message}` } });
      else res.end();
    }
  });

  server.on("clientError", (_error, socket) => socket.destroy());

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        origin: `http://${host}:${address.port}`,
        baseUrl: (scenarioName = "ok") => `http://${host}:${address.port}/${scenarioName}/v1`,
        requests,
        state: (name) => states.get(name) ?? {},
        // Queue raw response bodies for the "raw" scenario, one per request.
        queueRaw: (body, options = {}) => {
          if (!states.has("raw")) states.set("raw", {});
          const state = states.get("raw");
          state.queue = state.queue ?? [];
          state.queue.push({ body, ...options });
        },
        reset: () => {
          requests.length = 0;
          states.clear();
        },
        scenarioNames: [...scenarios.keys()],
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

// CLI mode: a gateway a human can point the real extension at.
// pathToFileURL, not string concatenation: on Windows process.argv[1] is
// `G:\dir\file.mjs` while import.meta.url is `file:///G:/dir/file.mjs`, so the
// naive comparison is never true and the CLI block silently never runs — the
// process just exits with no output at all.
// argv[1] is absent under `node -e` and in embedders, where pathToFileURL
// would throw on undefined; no argv[1] means we were not invoked as a script.
const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedAsScript) {
  const flag = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
  };
  const port = Number(flag("port", 8787));
  // --root-scenario decides what a Base URL with no scenario segment serves,
  // which is how "the user forgot the /v1 prefix" is reproduced by hand:
  //   npm run mock:provider -- --root-scenario login_html
  // then set the Base URL to the bare origin.
  const rootScenario = flag("root-scenario", "ok");
  if (!scenarios.has(rootScenario)) {
    process.stderr.write(`[mock] unknown --root-scenario ${rootScenario}\n`);
    process.exit(1);
  }
  const handle = await startMockProvider({ port, host: "127.0.0.1", log: true, rootScenario });
  process.stderr.write(`[mock] listening on ${handle.origin}\n`);
  process.stderr.write(`[mock] default Base URL:  ${handle.origin}/v1  (root scenario: ${rootScenario})\n`);
  process.stderr.write(`[mock] request log:       ${handle.origin}/__mock/requests\n`);
  process.stderr.write(`[mock] scenarios (${handle.scenarioNames.length}): use ${handle.origin}/<scenario>/v1\n`);
  process.stderr.write(`[mock] ${handle.scenarioNames.join(", ")}\n`);
}
