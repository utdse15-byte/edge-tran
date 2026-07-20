import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHeaders,
  chatCompletion,
  endpointUrl,
  filterLikelyTextModels,
  listModels,
  normalizeBaseUrl,
  permissionPatternForBaseUrl,
  readLimitedText,
  sanitizeExtraHeaders
} from "../lib/provider.js";
import {
  protectText,
  restorePlaceholders,
  validatePlaceholderIntegrity
} from "../lib/placeholders.js";
import {
  buildBackTranslationWarnings,
  buildSoftWarnings,
  parseChineseNumeralRun,
  parseTranslationJson,
  validateBackTranslationText,
  validateEnglishTranslationText,
  validateTranslationPayload
} from "../lib/validation.js";
import {
  backTranslate,
  buildPreviewDisplayText,
  createEnglishStreamExtractor,
  translateDraft
} from "../lib/translator.js";
import {
  getSecretForProvider,
  loadDraftState,
  normalizeStoredDiagnostics,
  normalizeStoredDraft,
  normalizeStoredHistory,
  normalizeStoredProvider,
  normalizeStoredSettings,
  providerCredentialBinding,
  saveActiveDraft,
  saveBehaviorSettings,
  saveConfiguration,
  scopedSessionKey
} from "../lib/storage.js";
import {
  BACK_TRANSLATION_MODES,
  STORAGE_KEYS,
  isCurrentDraftSend,
  isEnglishRevisionCurrent,
  normalizeText,
  targetContextMatches
} from "../lib/shared.js";

test("normalizes provider URLs and endpoints", () => {
  assert.equal(normalizeBaseUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1");
  assert.equal(normalizeBaseUrl("https://example.com/openai/v1/models"), "https://example.com/openai/v1");
  assert.equal(endpointUrl("https://api.x.ai/v1", "chat/completions"), "https://api.x.ai/v1/chat/completions");
  assert.equal(permissionPatternForBaseUrl("https://api.x.ai/v1"), "https://api.x.ai/*");
  assert.throws(() => normalizeBaseUrl("http://remote.example/v1"));
  assert.throws(() => normalizeBaseUrl("https://claude.ai/api/v1"));
  assert.equal(normalizeBaseUrl("http://localhost:11434/v1"), "http://localhost:11434/v1");
  assert.throws(() => normalizeBaseUrl(`https://example.com/${"a".repeat(2100)}`), /过长/);
});

test("filters model list without blocking manual use", () => {
  const models = ["gpt-5-mini", "text-embedding-3-small", "grok-fast", "audio-preview"];
  assert.deepEqual(filterLikelyTextModels(models), ["gpt-5-mini", "grok-fast"]);
  assert.deepEqual(filterLikelyTextModels(models, true), models);
});

test("removes unsafe and payload-controlling headers", () => {
  assert.deepEqual(
    sanitizeExtraHeaders({
      Cookie: "secret",
      Host: "bad",
      "Sec-Fetch-Site": "cross-site",
      "Bad Header": "invalid",
      "X-Newline": "a\nb",
      "Content-Type": "text/plain",
      Accept: "text/html",
      "X-Backup-Token": "must-not-be-persisted",
      "X-API-Key": "must-use-auth-header-instead",
      "X-Project": "demo",
      "x-project": "must-not-duplicate",
      Authorization: "other"
    }),
    { "X-Project": "demo" }
  );
  assert.throws(
    () => buildHeaders({ authHeader: "Content-Type", authPrefix: "Bearer" }, "secret"),
    /鉴权 Header/
  );
  assert.equal(
    buildHeaders({ authHeader: "X-API-Key", authPrefix: "" }, "secret")["X-API-Key"],
    "secret"
  );
  assert.throws(
    () => buildHeaders({ authHeader: "__proto__", authPrefix: "" }, "secret"),
    /鉴权 Header/
  );
});

test("protects and restores code, URL, email, path and protected terms", () => {
  const source = "请保留 Claude、`x += 1`、https://example.com/a、me@example.com 和 C:\\tmp\\a.txt。";
  const result = protectText(source, ["Claude"]);
  assert.notEqual(result.protectedText, source);
  assert.ok(result.placeholders.length >= 5);

  const translated = `Please keep ${result.placeholders.map((item) => item.token).join(" and ")}.`;
  const integrity = validatePlaceholderIntegrity(translated, result.placeholders, result.prefix);
  assert.deepEqual(integrity.errors, []);
  const restored = restorePlaceholders(translated, result.placeholders);
  for (const item of result.placeholders) assert.ok(restored.includes(item.value));
});

test("protects an unclosed fenced code block through end of draft", () => {
  const source = "请检查：\n```js\nconst value = 1;\n不要改变量名";
  const result = protectText(source, []);
  assert.equal(result.placeholders.length, 1);
  assert.equal(result.placeholders[0].kind, "fenced_code");
  assert.equal(result.placeholders[0].value, "```js\nconst value = 1;\n不要改变量名");
  assert.equal(restorePlaceholders(result.protectedText, result.placeholders), source);
});

test("placeholder protection is collision-resistant and bounded", () => {
  const result = protectText("保留 `value`", []);
  assert.match(result.prefix, /^ZH2EN_[A-F0-9]{24}$/);

  const withUnrelatedLiteral = `${result.placeholders[0].token} ⟦ZH2EN_AAAAAAAAAAAAAAAAAAAAAAAA_P9⟧`;
  assert.deepEqual(
    validatePlaceholderIntegrity(withUnrelatedLiteral, result.placeholders, result.prefix).errors,
    [],
    "an unrelated token-like literal belongs to user data, not this request namespace"
  );
  const withCurrentNamespaceUnknown = `${result.placeholders[0].token} ⟦${result.prefix}_P9⟧`;
  const integrity = validatePlaceholderIntegrity(
    withCurrentNamespaceUnknown,
    result.placeholders,
    result.prefix
  );
  assert.ok(integrity.errors.some((item) => item.includes("未知占位符")));

  assert.throws(
    () => protectText("甲".repeat(1001), ["甲"]),
    /受保护片段超过 1000 个/
  );
});

test("placeholder integrity rejects missing and duplicate tokens", () => {
  const result = protectText("`a` 和 `b`", []);
  const duplicate = `${result.placeholders[0].token} ${result.placeholders[0].token}`;
  const integrity = validatePlaceholderIntegrity(duplicate, result.placeholders, result.prefix);
  assert.ok(integrity.errors.some((item) => item.includes("重复")));
  assert.ok(integrity.errors.some((item) => item.includes("缺失")));
});

test("parses fenced JSON output", () => {
  const payload = parseTranslationJson('```json\n{"english":"Hello","corrections":[],"ambiguous":[]}\n```');
  assert.equal(payload.english, "Hello");
});

test("parses the first valid balanced JSON object without greedily joining objects", () => {
  const payload = parseTranslationJson(
    'gateway note {"broken":} more text {"english":"Hello","back_translation":"你好","corrections":[],"ambiguous":[]} trailing'
  );
  assert.equal(payload.english, "Hello");
  assert.equal(payload.back_translation, "你好");
});

test("skips valid gateway metadata JSON before the translation object", () => {
  const payload = parseTranslationJson(
    '{"request_id":"req_123"}\n{"english":"Hello","back_translation":"你好","corrections":[],"ambiguous":[]}'
  );
  assert.equal(payload.english, "Hello");
  assert.equal(payload.back_translation, "你好");
});

test("bounds malformed JSON candidate scanning and fails closed", () => {
  const malformedPrefix = "{".repeat(80);
  assert.throws(
    () => parseTranslationJson(`${malformedPrefix}{"english":"must not be reached"}`),
    /没有返回可解析的 JSON/
  );
});

test("accepts a narrowly scoped obvious typo and rejects technical corrections", () => {
  const accepted = validateTranslationPayload({
    english: "Delete this function.",
    corrections: [{ original: "删出", interpreted_as: "删除", reason: "明显同音输入错误" }],
    ambiguous: []
  }, "请删出这个函数");
  assert.deepEqual(accepted.errors, []);
  assert.equal(accepted.corrections.length, 1);

  const rejected = validateTranslationPayload({
    english: "Use GPT-5.",
    corrections: [{ original: "GPT-4", interpreted_as: "GPT-5", reason: "升级" }],
    ambiguous: []
  }, "使用 GPT-4");
  assert.ok(rejected.errors.length > 0);
});

test("rejects typo claims that alter negation, modality or broad phrases", () => {
  for (const [source, original, interpreted_as] of [
    ["不要删除", "不要", "要"],
    ["这可能失败", "可能", "一定"],
    ["请删除这个函数", "删除这个函数", "保留这个函数"]
  ]) {
    const result = validateTranslationPayload({
      english: "test",
      corrections: [{ original, interpreted_as, reason: "model claim" }],
      ambiguous: []
    }, source);
    assert.ok(result.errors.some((item) => item.includes("笔误")), `${original} should be rejected`);
  }
});

test("adds soft warnings without rejecting numbers", () => {
  const warnings = buildSoftWarnings("版本 12，成功率 95%", "Version 13, success rate 90%.");
  assert.ok(warnings.some((item) => item.includes("数字")));
  assert.equal(
    buildSoftWarnings("版本 12。", "Version 12.").some((item) => item.includes("数字")),
    false,
    "sentence punctuation must not become part of a number token"
  );
  assert.equal(
    buildSoftWarnings("成功率 50％", "Success rate 50%.").some((item) => item.includes("数字")),
    false,
    "full-width and ASCII percent signs should be equivalent"
  );
});

test("adds self-back-translation warnings without rejecting the translation", () => {
  const warnings = buildBackTranslationWarnings(
    "版本 12，成功率 95%",
    "Version 12, success rate 95%.",
    "版本 13，成功率 90%。"
  );
  assert.ok(warnings.some((item) => item.includes("数字")));
  assert.ok(buildBackTranslationWarnings(
    "请检查这段代码，不要改整体结构。",
    "Please review this code without changing its overall structure.",
    "Back-translation: please review this code."
  ).some((item) => item.includes("说明性前缀")));
  assert.ok(buildBackTranslationWarnings(
    "请检查这段代码，不要改整体结构。",
    "Please review this code without changing its overall structure.",
    "回译如下：请检查这段代码。"
  ).some((item) => item.includes("说明性前缀")));
});

test("requires real English output and Chinese back-translation even for short Chinese drafts", () => {
  const echoed = validateEnglishTranslationText("你好", "你好", []);
  assert.ok(echoed.errors.some((item) => item.includes("没有形成英文")));
  assert.ok(
    validateEnglishTranslationText("你好", "123", []).errors.some((item) => item.includes("没有形成英文")),
    "digits alone are not English unless the Chinese source is numeric"
  );
  assert.deepEqual(validateEnglishTranslationText("一千五", "1,500", []).errors, []);

  const shortBack = validateBackTranslationText("你好", "Hello.", "Hello.");
  assert.ok(shortBack.errors.some((item) => item.includes("没有中文")));
  assert.deepEqual(validateBackTranslationText("你好", "Hello.", "你好。 ").errors, []);
});

test("rejects a non-Chinese back-translation and warns when same-request output copies the source", () => {
  const invalid = validateBackTranslationText(
    "请检查这段代码，不要改整体结构。",
    "Please review this code without changing its overall structure.",
    "Please review this code."
  );
  assert.ok(invalid.errors.some((item) => item.includes("没有中文")));

  const shortInvalid = validateBackTranslationText("你好", "Hello", "Hello");
  assert.ok(shortInvalid.errors.some((item) => item.includes("没有中文")));

  const copied = validateBackTranslationText(
    "请检查这段代码，不要改变整体结构。",
    "Please review this code without changing its overall structure.",
    "请检查这段代码，不要改变整体结构。"
  );
  assert.ok(copied.warnings.some((item) => item.includes("完全相同")));
});

test("normalizes editor text without collapsing meaningful blank lines or Unicode joiners", () => {
  assert.equal(normalizeText("a\r\n\r\n\r\nb\u00a0 \n"), "a\n\n\nb");
  assert.equal(normalizeText("a\u200bb"), "ab");
  assert.equal(normalizeText("👨‍👩‍👧‍👦"), "👨‍👩‍👧‍👦");
  assert.equal(normalizeText("می\u200cخواهم"), "می\u200cخواهم");
});

test("only clears a draft after sending its current English version", () => {
  assert.equal(isCurrentDraftSend({
    sentText: "Current English",
    draftEnglish: "Current English",
    englishSourceRevision: 7,
    sourceRevision: 7,
    targetPhase: "synced"
  }), true);

  assert.equal(isCurrentDraftSend({
    sentText: "Old English",
    draftEnglish: "Old English",
    englishSourceRevision: 6,
    sourceRevision: 7,
    targetPhase: "synced"
  }), false);

  assert.equal(isCurrentDraftSend({
    sentText: "Manually refined English",
    draftEnglish: "Original translation",
    manualTargetText: "Manually refined English",
    englishSourceRevision: 7,
    sourceRevision: 7,
    targetPhase: "manual"
  }), true);
});

test("blocks a translation result when the bound Claude target changes", () => {
  assert.equal(targetContextMatches(
    { tabId: 11, writerSession: "writer_a", targetEpoch: 4 },
    { tabId: 11, writerSession: "writer_a", targetEpoch: 4 }
  ), true);
  assert.equal(targetContextMatches(
    { tabId: 11, writerSession: "writer_a" },
    { tabId: 12, writerSession: "writer_a" }
  ), false);
  assert.equal(targetContextMatches(
    { tabId: 11, writerSession: "writer_a" },
    { tabId: 11, writerSession: "writer_b" }
  ), false);
  assert.equal(targetContextMatches(
    { tabId: 11, writerSession: "writer_a", targetEpoch: 4 },
    { tabId: 11, writerSession: "writer_a", targetEpoch: 5 }
  ), false);
  assert.equal(isEnglishRevisionCurrent({
    requestedRevision: 8,
    currentSourceRevision: 8,
    englishSourceRevision: 8
  }), true);
  assert.equal(isEnglishRevisionCurrent({
    requestedRevision: 8,
    currentSourceRevision: 9,
    englishSourceRevision: 8
  }), false);
});

test("enforces a byte limit while reading provider responses", async () => {
  const withinLimit = new Response("你好", {
    headers: { "Content-Type": "text/plain" }
  });
  assert.equal(await readLimitedText(withinLimit, 6), "你好");

  const oversized = new Response("1234567", {
    headers: { "Content-Type": "text/plain" }
  });
  await assert.rejects(
    readLimitedText(oversized, 6),
    (error) => error?.code === "response_too_large"
  );
});

test("classifies successful non-Chat-Completions responses without leaking bodies", async () => {
  const originalFetch = globalThis.fetch;
  const baseConfig = {
    baseUrl: "https://gateway.example",
    timeoutMs: 1000,
    capabilities: { jsonMode: false, temperature: false }
  };
  const secret = "sk-DO-NOT-LEAK-123";
  const prompt = "TOP-SECRET-PROMPT";

  async function capture(responseFactory) {
    let requestOptions = null;
    globalThis.fetch = async (_url, options) => {
      requestOptions = options;
      return responseFactory();
    };
    let caught;
    try {
      await chatCompletion({
        config: baseConfig,
        apiKey: secret,
        model: "fixture-model",
        messages: [{ role: "user", content: prompt }]
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, "expected ProviderError");
    const serialized = `${JSON.stringify(caught)}\n${caught.stack || ""}`;
    assert.doesNotMatch(serialized, /sk-DO-NOT-LEAK-123|TOP-SECRET-PROMPT/);
    assert.equal(requestOptions?.redirect, "error");
    return caught;
  }

  try {
    const html = "<!doctype html><html><title>website home</title></html>";
    const htmlError = await capture(() => new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Request-ID": "req-html-200"
      }
    }));
    assert.equal(htmlError.code, "html_response");
    assert.equal(htmlError.status, 200);
    assert.equal(htmlError.contentType, "text/html; charset=utf-8");
    assert.equal(htmlError.responseChars, html.length);
    assert.equal(htmlError.responseKind, "html");
    assert.equal(htmlError.endpoint, "https://gateway.example/chat/completions");
    assert.equal(htmlError.routeHint, "missing_api_prefix_likely");
    assert.equal(htmlError.requestId, "req-html-200");
    assert.doesNotMatch(JSON.stringify(htmlError), /website home/);

    const maliciousRequestId = await capture(() => new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=TOP-SECRET-PROMPT",
        "X-Request-ID": prompt
      }
    }));
    assert.equal(maliciousRequestId.code, "html_response");
    assert.equal(maliciousRequestId.contentType, "text/html");
    assert.equal(maliciousRequestId.requestId, "");

    const cases = [
      ["empty_body", () => new Response("", {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })],
      ["non_json_response", () => new Response("plain gateway response", {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      })],
      ["logical_api_error", () => new Response(JSON.stringify({
        error: { code: "invalid_model", message: `${prompt} ${secret}` }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })],
      ["responses_api_response", () => new Response(JSON.stringify({
        object: "response",
        output: [{ content: [{ type: "output_text", text: "hello" }] }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })],
      ["unsupported_response_schema", () => new Response(JSON.stringify({
        data: { text: "hello" }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })],
      ["empty_choices", () => new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })],
      ["empty_assistant_content", () => new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "" } }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })]
    ];

    for (const [expectedCode, responseFactory] of cases) {
      const error = await capture(responseFactory);
      assert.equal(error.code, expectedCode);
    }

    // A remote JSON object must not be able to spoof the reader's private
    // classification channel and inject its own error message.
    globalThis.fetch = async () => new Response(JSON.stringify({
      __edgeTranProtocolError: {
        code: "html_response",
        message: `${prompt} ${secret}`
      },
      choices: [{ finish_reason: "stop", message: { content: "translated" } }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
    const result = await chatCompletion({
      config: baseConfig,
      apiKey: secret,
      model: "fixture-model",
      messages: [{ role: "user", content: prompt }]
    });
    assert.equal(result.text, "translated");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects oversized or malformed provider requests before fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch should not be called");
  };

  const config = {
    baseUrl: "https://provider.example/v1",
    timeoutMs: 1000,
    capabilities: { jsonMode: false, temperature: false }
  };
  try {
    await assert.rejects(
      chatCompletion({
        config,
        apiKey: "test-key",
        model: "m".repeat(241),
        messages: [{ role: "user", content: "test" }]
      }),
      (error) => error?.code === "model_invalid"
    );
    await assert.rejects(
      chatCompletion({
        config,
        apiKey: "test-key",
        model: "model",
        messages: [{ role: "user", content: "x".repeat(250001) }]
      }),
      (error) => error?.code === "payload_too_large"
    );
    await assert.rejects(
      chatCompletion({
        config,
        apiKey: "test-key",
        model: "model",
        messages: [{ role: "user", content: { text: "not supported" } }]
      }),
      (error) => error?.code === "payload_invalid"
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back once when a compatible gateway rejects JSON mode or temperature", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let callCount = 0;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    callCount += 1;
    if (callCount === 1) {
      return new Response(JSON.stringify({ error: { code: "unsupported_parameter" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      model: "custom-model",
      choices: [{ finish_reason: "stop", message: { content: "{\"english\":\"Hello\",\"corrections\":[],\"ambiguous\":[]}" } }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await chatCompletion({
      config: {
        baseUrl: "https://provider.example/v1",
        timeoutMs: 1000,
        capabilities: { jsonMode: null, temperature: null }
      },
      apiKey: "test-key",
      model: "custom-model",
      messages: [{ role: "user", content: "test" }],
      preferJson: true
    });
    assert.equal(callCount, 2);
    assert.deepEqual(requests[0].response_format, { type: "json_object" });
    assert.equal(requests[0].temperature, 0);
    assert.equal("response_format" in requests[1], false);
    assert.equal("temperature" in requests[1], false);
    assert.deepEqual(result.capabilityPatch, { jsonMode: false, temperature: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("removes unsupported JSON mode and temperature in two bounded compatibility steps", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        error: {
          code: "unsupported_parameter",
          param: "response_format",
          message: "response_format is not supported"
        }
      }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    if (requests.length === 2) {
      return new Response(JSON.stringify({
        error: {
          code: "unsupported_parameter",
          param: "temperature",
          message: "temperature is not supported"
        }
      }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      model: "custom-model",
      choices: [{
        finish_reason: "stop",
        message: { content: '{"english":"Hello","corrections":[],"ambiguous":[]}' }
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const result = await chatCompletion({
      config: {
        baseUrl: "https://provider.example/v1",
        timeoutMs: 1000,
        capabilities: { jsonMode: null, temperature: null }
      },
      apiKey: "test-key",
      model: "custom-model",
      messages: [{ role: "user", content: "test" }],
      preferJson: true
    });
    assert.equal(requests.length, 3);
    assert.ok(requests[0].response_format);
    assert.equal(requests[0].temperature, 0);
    assert.equal("response_format" in requests[1], false);
    assert.equal(requests[1].temperature, 0);
    assert.equal("response_format" in requests[2], false);
    assert.equal("temperature" in requests[2], false);
    assert.deepEqual(result.capabilityPatch, { jsonMode: false, temperature: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("same-request mode returns English and back-translation in one provider call", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const protectedSource = body.messages.at(-1).content;
    const token = protectedSource.match(/⟦ZH2EN_[A-F0-9]{24}_P0⟧/u)?.[0];
    assert.ok(token, "protected token should be sent to the model");
    return new Response(JSON.stringify({
      model: "custom-model",
      choices: [{
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            english: `Keep ${token} unchanged.`,
            back_translation: `保持 ${token} 不变。`,
            corrections: [],
            ambiguous: []
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await translateDraft({
      source: "请保持 `value` 不变。",
      config: {
        baseUrl: "https://provider.example/v1",
        timeoutMs: 1000,
        capabilities: { jsonMode: true, temperature: false }
      },
      apiKey: "test-key",
      model: "custom-model"
    });
    assert.equal(requests.length, 1);
    assert.equal(result.backTranslationMode, BACK_TRANSLATION_MODES.SAME_REQUEST);
    assert.match(result.english, /`value`/);
    assert.match(result.backTranslation, /`value`/);
    assert.match(requests[0].messages[0].content, /back_translation/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("same-request mode repairs a missing back-translation once", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const content = requests.length === 1
      ? JSON.stringify({ english: "Hello.", corrections: [], ambiguous: [] })
      : JSON.stringify({
          english: "Hello.",
          back_translation: "你好。",
          corrections: [],
          ambiguous: []
        });
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const result = await translateDraft({
      source: "你好。",
      config: {
        baseUrl: "https://provider.example/v1",
        timeoutMs: 1000,
        capabilities: { jsonMode: true, temperature: false }
      },
      apiKey: "test-key",
      model: "custom-model"
    });
    assert.equal(requests.length, 2);
    assert.equal(result.backTranslation, "你好。");
    assert.match(requests[1].messages[0].content, /back_translation.*为空/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("independent mode keeps the primary translation response English-only", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify({ english: "Hello.", corrections: [], ambiguous: [] }) }
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const result = await translateDraft({
      source: "你好。",
      config: {
        baseUrl: "https://provider.example/v1",
        timeoutMs: 1000,
        capabilities: { jsonMode: true, temperature: false }
      },
      apiKey: "test-key",
      model: "custom-model",
      backTranslationMode: BACK_TRANSLATION_MODES.INDEPENDENT
    });
    assert.equal(result.backTranslation, "");
    assert.equal(result.backTranslationMode, BACK_TRANSLATION_MODES.INDEPENDENT);
    assert.doesNotMatch(requestBody.messages[0].content, /"back_translation"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("backtranslation sends only the English draft as user content", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "请检查这段代码。" } }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await backTranslate({
      english: "Please review this code.",
      config: {
        baseUrl: "https://provider.example/v1",
        timeoutMs: 1000,
        capabilities: { jsonMode: false, temperature: false }
      },
      apiKey: "test-key",
      model: "custom-model"
    });
    assert.equal(result.chinese, "请检查这段代码。");
    assert.equal(requestBody.messages.at(-1).role, "user");
    assert.equal(requestBody.messages.at(-1).content, "Please review this code.");
    assert.equal(requestBody.messages.some((message) => message.content.includes("原始中文草稿")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("rejects tool-call completions even when finish_reason is stop", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      finish_reason: "stop",
      message: {
        content: "{\"english\":\"unsafe\"}",
        tool_calls: [{ id: "call_1", type: "function" }]
      }
    }]
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });

  try {
    await assert.rejects(
      chatCompletion({
        config: {
          baseUrl: "https://provider.example/v1",
          timeoutMs: 1000,
          capabilities: { jsonMode: false, temperature: false }
        },
        apiKey: "test-key",
        model: "custom-model",
        messages: [{ role: "user", content: "test" }]
      }),
      (error) => error?.code === "incomplete_response"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries literally when the model proposes an unsafe correction", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let call = 0;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    call += 1;
    const content = call === 1
      ? JSON.stringify({
          english: "Do delete it.",
          back_translation: "把它删除。",
          corrections: [{ original: "不要", interpreted_as: "要", reason: "wrong" }],
          ambiguous: []
        })
      : JSON.stringify({
          english: "Do not delete it.",
          back_translation: "不要删除它。",
          corrections: [],
          ambiguous: []
        });
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content } }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await translateDraft({
      source: "不要删除它",
      config: {
        baseUrl: "https://provider.example/v1",
        timeoutMs: 1000,
        capabilities: { jsonMode: true, temperature: false }
      },
      apiKey: "test-key",
      model: "custom-model"
    });
    assert.equal(call, 2);
    assert.equal(result.english, "Do not delete it.");
    assert.match(requests[1].messages[0].content, /do not correct or reinterpret any source text/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("enforces a user's literal-retranslation choice locally", async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    const content = call === 1
      ? JSON.stringify({
          english: "Delete this function.",
          back_translation: "删除这个函数。",
          corrections: [{ original: "删出", interpreted_as: "删除", reason: "typo" }],
          ambiguous: []
        })
      : JSON.stringify({
          english: "Remove-out this function literally.",
          back_translation: "按字面移出这个函数。",
          corrections: [],
          ambiguous: []
        });
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content } }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await translateDraft({
      source: "请删出这个函数",
      config: {
        baseUrl: "https://provider.example/v1",
        timeoutMs: 1000,
        capabilities: { jsonMode: true, temperature: false }
      },
      apiKey: "test-key",
      model: "custom-model",
      literalFragments: ["删出"]
    });
    assert.equal(call, 2);
    assert.equal(result.corrections.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rolls back staged secrets when configuration storage fails", async () => {
  const originalChrome = globalThis.chrome;
  const local = new Map([[STORAGE_KEYS.LOCAL_SECRET, "old-local"]]);
  const session = new Map([[STORAGE_KEYS.SESSION_SECRET, "old-session"]]);
  let failSettingsWrite = true;

  const makeArea = (map, isLocal = false) => ({
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((key) => map.has(key)).map((key) => [key, map.get(key)]));
    },
    async set(values) {
      if (isLocal && failSettingsWrite && Object.hasOwn(values, STORAGE_KEYS.SETTINGS)) {
        failSettingsWrite = false;
        throw new Error("simulated settings failure");
      }
      for (const [key, value] of Object.entries(values)) map.set(key, value);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key);
    }
  });

  globalThis.chrome = {
    storage: {
      local: makeArea(local, true),
      session: makeArea(session)
    }
  };

  try {
    await assert.rejects(
      saveConfiguration({ autoSync: true }, { keyStorage: "local" }, "new-secret"),
      /simulated settings failure/
    );
    assert.equal(local.get(STORAGE_KEYS.LOCAL_SECRET), "old-local");
    assert.equal(session.get(STORAGE_KEYS.SESSION_SECRET), "old-session");
    await assert.rejects(
      saveConfiguration({ autoSync: true }, { keyStorage: "local" }, "k".repeat(8_193)),
      /API Key 异常过长/
    );
    assert.equal(local.get(STORAGE_KEYS.LOCAL_SECRET), "old-local");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("binds a saved API key to the exact Provider generation and request destination", async () => {
  const originalChrome = globalThis.chrome;
  const local = new Map();
  const session = new Map();
  const makeArea = (map) => ({
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requested.filter((key) => map.has(key)).map((key) => [key, map.get(key)])
      );
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) map.set(key, value);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key);
    }
  });
  globalThis.chrome = {
    storage: {
      local: makeArea(local),
      session: makeArea(session)
    }
  };

  try {
    const legacyProvider = {
      preset: "custom",
      name: "Gateway A",
      baseUrl: "https://gateway-a.example/v1",
      keyStorage: "local",
      authHeader: "Authorization",
      authPrefix: "Bearer",
      extraHeaders: { "X-Project": "alpha" }
    };
    local.set(STORAGE_KEYS.PROVIDER, legacyProvider);
    local.set(STORAGE_KEYS.LOCAL_SECRET, "legacy-key-for-a");
    assert.equal(await getSecretForProvider(legacyProvider), "legacy-key-for-a");

    const first = await saveConfiguration(
      { autoSync: true },
      {
        ...legacyProvider,
        credentialId: "credential-a"
      },
      "key-for-a"
    );
    assert.equal(await getSecretForProvider(first.provider), "key-for-a");
    assert.equal(
      await getSecretForProvider(legacyProvider),
      "",
      "a legacy panel must not read a newly rotated key for the same endpoint"
    );

    const sameCredentialWrongDestination = {
      ...first.provider,
      baseUrl: "https://gateway-b.example/v1"
    };
    assert.notEqual(
      providerCredentialBinding(first.provider),
      providerCredentialBinding(sameCredentialWrongDestination)
    );
    assert.equal(await getSecretForProvider(sameCredentialWrongDestination), "");

    const sameDestinationWrongRouteHeader = {
      ...first.provider,
      extraHeaders: { "x-project": "beta" }
    };
    assert.equal(await getSecretForProvider(sameDestinationWrongRouteHeader), "");

    const sameGenerationWrongStorageArea = {
      ...first.provider,
      keyStorage: "session"
    };
    assert.equal(await getSecretForProvider(sameGenerationWrongStorageArea), "");

    const second = await saveConfiguration(
      { autoSync: true },
      {
        preset: "custom",
        name: "Gateway B",
        baseUrl: "https://gateway-b.example/v1",
        keyStorage: "local",
        authHeader: "Authorization",
        authPrefix: "Bearer",
        credentialId: "credential-b"
      },
      "key-for-b"
    );
    assert.equal(await getSecretForProvider(first.provider), "");
    assert.equal(await getSecretForProvider(second.provider), "key-for-b");
  } finally {
    globalThis.chrome = originalChrome;
  }
});


test("window-scoped session drafts stay isolated and legacy state migrates once", async () => {
  const originalChrome = globalThis.chrome;
  const session = new Map();
  const area = {
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((key) => session.has(key)).map((key) => [key, session.get(key)]));
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) session.set(key, value);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) session.delete(key);
    }
  };
  globalThis.chrome = { storage: { session: area } };

  try {
    await saveActiveDraft({ source: "窗口一" }, "window-1");
    await saveActiveDraft({ source: "窗口二" }, "window-2");
    assert.equal((await loadDraftState("window-1")).activeDraft.source, "窗口一");
    assert.equal((await loadDraftState("window-2")).activeDraft.source, "窗口二");
    assert.notEqual(
      scopedSessionKey(STORAGE_KEYS.ACTIVE_DRAFT, "window-1"),
      scopedSessionKey(STORAGE_KEYS.ACTIVE_DRAFT, "window-2")
    );

    session.clear();
    session.set(STORAGE_KEYS.ACTIVE_DRAFT, { source: "旧版草稿" });
    session.set(STORAGE_KEYS.HISTORY, [{ source: "旧历史" }]);
    const migrated = await loadDraftState("window-3");
    assert.equal(migrated.activeDraft.source, "旧版草稿");
    assert.equal(migrated.history[0].source, "旧历史");
    assert.equal(session.has(STORAGE_KEYS.ACTIVE_DRAFT), false);
    assert.equal(
      session.get(scopedSessionKey(STORAGE_KEYS.ACTIVE_DRAFT, "window-3")).source,
      "旧版草稿"
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("behavior-only settings saves never rewrite a Provider snapshot", async () => {
  const originalChrome = globalThis.chrome;
  const storedProvider = {
    name: "Provider from another window",
    baseUrl: "https://current.example/v1",
    credentialId: "credential-current"
  };
  const local = new Map([[STORAGE_KEYS.PROVIDER, structuredClone(storedProvider)]]);
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested.filter((key) => local.has(key)).map((key) => [key, local.get(key)]));
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) local.set(key, structuredClone(value));
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) local.delete(key);
        }
      }
    }
  };
  try {
    await saveBehaviorSettings({ autoSync: false, debounceMs: 900 });
    assert.deepEqual(local.get(STORAGE_KEYS.PROVIDER), storedProvider);
    assert.equal(local.get(STORAGE_KEYS.SETTINGS).autoSync, false);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("configuration save rolls back settings and both secrets when stale-secret removal fails", async () => {
  const originalChrome = globalThis.chrome;
  const oldSettings = { autoSync: false, backTranslationMode: "independent" };
  const oldProvider = { keyStorage: "local", name: "Old provider" };
  const local = new Map([
    [STORAGE_KEYS.LOCAL_SECRET, "old-local"],
    [STORAGE_KEYS.SETTINGS, oldSettings],
    [STORAGE_KEYS.PROVIDER, oldProvider]
  ]);
  const session = new Map([[STORAGE_KEYS.SESSION_SECRET, "old-session"]]);
  let failStaleRemoval = true;

  const makeArea = (map, isLocal = false) => ({
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((key) => map.has(key)).map((key) => [key, map.get(key)]));
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) map.set(key, value);
    },
    async remove(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      if (isLocal && failStaleRemoval && requested.includes(STORAGE_KEYS.LOCAL_SECRET)) {
        failStaleRemoval = false;
        throw new Error("simulated stale-secret removal failure");
      }
      for (const key of requested) map.delete(key);
    }
  });

  globalThis.chrome = {
    storage: {
      local: makeArea(local, true),
      session: makeArea(session)
    }
  };

  try {
    await assert.rejects(
      saveConfiguration(
        { autoSync: true, backTranslationMode: "same_request" },
        { keyStorage: "session", name: "New provider" },
        "new-session-secret"
      ),
      /simulated stale-secret removal failure/
    );
    assert.equal(local.get(STORAGE_KEYS.LOCAL_SECRET), "old-local");
    assert.equal(session.get(STORAGE_KEYS.SESSION_SECRET), "old-session");
    assert.deepEqual(local.get(STORAGE_KEYS.SETTINGS), oldSettings);
    assert.deepEqual(local.get(STORAGE_KEYS.PROVIDER), oldProvider);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("normalizes malformed stored settings and provider data before runtime use", () => {
  const settings = normalizeStoredSettings({
    autoSync: "yes",
    debounceMs: -100,
    sentenceEndDelayMs: 999999,
    backTranslationMode: "unknown",
    requestTimeoutMs: "not-a-number",
    protectedTerms: "Claude"
  });
  assert.equal(settings.autoSync, true);
  assert.equal(settings.debounceMs, 200);
  assert.equal(settings.sentenceEndDelayMs, 1000);
  assert.equal(settings.backTranslationMode, BACK_TRANSLATION_MODES.SAME_REQUEST);
  assert.equal(settings.requestTimeoutMs, 20000);
  assert.deepEqual(settings.protectedTerms, []);

  const provider = normalizeStoredProvider({
    preset: "invalid",
    name: 123,
    keyStorage: "cloud",
    modelTranslate: "m".repeat(400),
    extraHeaders: ["bad"],
    capabilities: { jsonMode: "yes", temperature: false }
  });
  assert.equal(provider.preset, "openai");
  assert.equal(provider.name, "OpenAI");
  assert.equal(provider.keyStorage, "local");
  assert.equal([...provider.modelTranslate].length, 240);
  assert.deepEqual(provider.extraHeaders, {});
  assert.deepEqual(provider.capabilities, { jsonMode: null, temperature: false, streaming: null });

  const providerWithDangerousKeys = normalizeStoredProvider({
    authHeader: "Content-Type",
    authPrefix: "Bearer\nInjected",
    extraHeaders: JSON.parse('{"__proto__":"bad","constructor":"bad","prototype":"bad","Cookie":"secret","Content-Type":"text/plain","Authorization":"other","X-Backup-Token":"secret","X-Project":"demo"}')
  });
  assert.equal(providerWithDangerousKeys.authHeader, "Authorization");
  assert.equal(providerWithDangerousKeys.authPrefix, "Bearer");
  assert.deepEqual(providerWithDangerousKeys.extraHeaders, { "X-Project": "demo" });
});

test("independent back-translation retries once when the first output is not Chinese", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const content = calls === 1 ? "This is still English." : "这是中文回译。";
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await backTranslate({
      english: "This is the English translation.",
      sourceForWarnings: "这是用于测试的中文原稿。",
      config: {
        baseUrl: "https://provider.example/v1",
        timeoutMs: 1000,
        capabilities: { jsonMode: false, temperature: false }
      },
      apiKey: "test-key",
      model: "custom-model"
    });
    assert.equal(calls, 2);
    assert.equal(result.chinese, "这是中文回译。");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preserves JSON mode when only temperature is rejected", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        error: { code: "unsupported_parameter", param: "temperature", message: "temperature is not supported" }
      }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: '{"english":"Hello"}' } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await chatCompletion({
      config: {
        baseUrl: "https://provider.example/v1",
        timeoutMs: 1000,
        capabilities: { jsonMode: null, temperature: null }
      },
      apiKey: "test-key",
      model: "custom-model",
      messages: [{ role: "user", content: "test" }],
      preferJson: true
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].response_format, { type: "json_object" });
    assert.equal("temperature" in requests[1], false);
    assert.deepEqual(result.capabilityPatch, { jsonMode: true, temperature: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not retry arbitrary invalid requests and rejects refusal content even when text exists", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: "model_not_found" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    await assert.rejects(
      chatCompletion({
        config: {
          baseUrl: "https://provider.example/v1",
          timeoutMs: 1000,
          capabilities: { jsonMode: null, temperature: null }
        },
        apiKey: "test-key",
        model: "missing-model",
        messages: [{ role: "user", content: "test" }],
        preferJson: true
      }),
      (error) => error?.code === "model_not_found"
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      finish_reason: "stop",
      message: { content: "apparently usable text", refusal: "cannot comply" }
    }]
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(
      chatCompletion({
        config: {
          baseUrl: "https://provider.example/v1",
          timeoutMs: 1000,
          capabilities: { jsonMode: false, temperature: false }
        },
        apiKey: "test-key",
        model: "custom-model",
        messages: [{ role: "user", content: "test" }]
      }),
      (error) => error?.code === "model_refusal"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("protects user text that already looks like a plugin placeholder", () => {
  const source = "请原样显示 ⟦ZH2EN_ABCD_P0⟧，不要解释。";
  const protection = protectText(source, []);
  assert.equal(protection.placeholders.length, 1);
  assert.equal(protection.placeholders[0].kind, "placeholder_literal");
  const output = `Show ${protection.placeholders[0].token} exactly, without explanation.`;
  assert.deepEqual(
    validatePlaceholderIntegrity(output, protection.placeholders, protection.prefix).errors,
    []
  );
  assert.match(restorePlaceholders(output, protection.placeholders), /⟦ZH2EN_ABCD_P0⟧/u);
});

test("protects the whole code block when it contains a literal plugin-looking token", () => {
  const source = "```js\nconst token = '⟦ZH2EN_ABCD_P0⟧';\nconsole.log(token);\n```";
  const protectedResult = protectText(source);

  assert.equal(protectedResult.placeholders.length, 1);
  assert.equal(protectedResult.placeholders[0].kind, "fenced_code");
  assert.equal(protectedResult.placeholders[0].value, source);
  assert.equal(restorePlaceholders(protectedResult.protectedText, protectedResult.placeholders), source);
});

test("rejects ambiguous, duplicate, or overlapping typo claims", () => {
  const repeatedSource = validateTranslationPayload({
    english: "Delete A, then delete B.",
    corrections: [{ original: "删出", interpreted_as: "删除", reason: "claim" }],
    ambiguous: []
  }, "请删出甲，再删出乙");
  assert.ok(repeatedSource.errors.some((item) => item.includes("笔误")));

  const overlappingOccurrence = validateTranslationPayload({
    english: "Ha-ha.",
    corrections: [{ original: "哈哈", interpreted_as: "呵呵", reason: "claim" }],
    ambiguous: []
  }, "哈哈哈");
  assert.ok(overlappingOccurrence.errors.some((item) => item.includes("笔误")));

  const duplicateClaims = validateTranslationPayload({
    english: "Delete it.",
    corrections: [
      { original: "删出", interpreted_as: "删除", reason: "first" },
      { original: "删出", interpreted_as: "删除", reason: "duplicate" }
    ],
    ambiguous: []
  }, "请删出它");
  assert.ok(duplicateClaims.errors.some((item) => item.includes("笔误")));

  const overlappingClaims = validateTranslationPayload({
    english: "Delete it.",
    corrections: [
      { original: "删出", interpreted_as: "删除", reason: "first" },
      { original: "出", interpreted_as: "除", reason: "overlap" }
    ],
    ambiguous: []
  }, "请删出它");
  assert.ok(overlappingClaims.errors.some((item) => item.includes("笔误")));
});

test("does not create false numeric warnings from random placeholder digits", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    const protectedSource = requestBody.messages.at(-1).content;
    const token = protectedSource.match(/⟦ZH2EN_[A-F0-9]{24}_P0⟧/u)?.[0];
    assert.ok(token);
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            english: `Visit ${token} and keep version 3.`,
            back_translation: `请访问 ${token} 并保留版本 3。`,
            corrections: [],
            ambiguous: []
          })
        }
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const result = await translateDraft({
      source: "请访问 https://example.com/v2 并保留版本 3。",
      config: {
        baseUrl: "https://provider.example/v1",
        timeoutMs: 1000,
        capabilities: { jsonMode: true, temperature: false }
      },
      apiKey: "test-key",
      model: "custom-model"
    });
    assert.equal(result.english, "Visit https://example.com/v2 and keep version 3.");
    assert.equal(
      result.warnings.some((item) => item.includes("数字")),
      false
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validates same-request Chinese only after protected content is restored", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const token = body.messages.at(-1).content.match(/⟦ZH2EN_[A-F0-9]{24}_P0⟧/u)?.[0];
    assert.ok(token);
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            english: token,
            back_translation: token,
            corrections: [],
            ambiguous: []
          })
        }
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const source = "```text\n这是受保护的中文内容\n```";
    const result = await translateDraft({
      source,
      config: {
        baseUrl: "https://provider.example/v1",
        timeoutMs: 1000,
        capabilities: { jsonMode: true, temperature: false }
      },
      apiKey: "test-key",
      model: "custom-model"
    });
    assert.equal(result.english, source);
    assert.equal(result.backTranslation, source);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("independent back-translation protects URLs and code without sending source Chinese", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    const protectedEnglish = requestBody.messages.at(-1).content;
    const tokens = protectedEnglish.match(/⟦ZH2EN_[A-F0-9]{24}_P\d+⟧/gu) ?? [];
    assert.equal(tokens.length, 2);
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: { content: `请使用 ${tokens[0]} 并保持 ${tokens[1]} 不变。` }
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const result = await backTranslate({
      english: "Use https://example.com/v2 and keep `alpha()` unchanged.",
      sourceForWarnings: "请使用链接并保持代码不变。",
      config: {
        baseUrl: "https://provider.example/v1",
        timeoutMs: 1000,
        capabilities: { jsonMode: false, temperature: false }
      },
      apiKey: "test-key",
      model: "custom-model"
    });
    assert.equal(
      result.chinese,
      "请使用 https://example.com/v2 并保持 `alpha()` 不变。"
    );
    assert.doesNotMatch(requestBody.messages.at(-1).content, /请使用链接/u);
    assert.doesNotMatch(requestBody.messages.at(-1).content, /https:\/\/example\.com\/v2/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects structured refusal and non-text response parts", async () => {
  const originalFetch = globalThis.fetch;
  const config = {
    baseUrl: "https://provider.example/v1",
    timeoutMs: 1000,
    capabilities: { jsonMode: false, temperature: false }
  };
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: {
          content: [
            { type: "refusal", refusal: "cannot comply" },
            { type: "text", text: "apparently usable text" }
          ]
        }
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    await assert.rejects(
      chatCompletion({
        config,
        apiKey: "test-key",
        model: "custom-model",
        messages: [{ role: "user", content: "test" }]
      }),
      (error) => error?.code === "model_refusal"
    );

    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: {
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
            { type: "text", text: "apparently usable text" }
          ]
        }
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    await assert.rejects(
      chatCompletion({
        config,
        apiKey: "test-key",
        model: "custom-model",
        messages: [{ role: "user", content: "test" }]
      }),
      (error) => error?.code === "incomplete_response"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("distinguishes a missing model returned as HTTP 404 from a missing endpoint", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { code: "model_not_found", message: "The model 'missing-model' does not exist" }
    }), { status: 404, headers: { "Content-Type": "application/json" } });
    await assert.rejects(
      chatCompletion({
        config: {
          baseUrl: "https://provider.example/v1",
          timeoutMs: 1000,
          capabilities: { jsonMode: false, temperature: false }
        },
        apiKey: "test-key",
        model: "missing-model",
        messages: [{ role: "user", content: "test" }]
      }),
      (error) => error?.code === "model_not_found"
    );

    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { code: "not_found", message: "Requested model is unknown and not available" }
    }), { status: 404, headers: { "Content-Type": "application/json" } });
    await assert.rejects(
      chatCompletion({
        config: {
          baseUrl: "https://provider.example/v1",
          timeoutMs: 1000,
          capabilities: { jsonMode: false, temperature: false }
        },
        apiKey: "test-key",
        model: "missing-model",
        messages: [{ role: "user", content: "test" }]
      }),
      (error) => error?.code === "model_not_found"
    );

    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { code: "not_found", message: "Route not found" }
    }), { status: 404, headers: { "Content-Type": "application/json" } });
    await assert.rejects(
      chatCompletion({
        config: {
          baseUrl: "https://provider.example/v1",
          timeoutMs: 1000,
          capabilities: { jsonMode: false, temperature: false }
        },
        apiKey: "test-key",
        model: "custom-model",
        messages: [{ role: "user", content: "test" }]
      }),
      (error) => error?.code === "endpoint_not_found"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounds and sanitizes persisted draft, history, and diagnostics state", () => {
  const draft = normalizeStoredDraft({
    id: 42,
    source: "源".repeat(260_000),
    english: "e".repeat(110_000),
    backTranslation: "回".repeat(110_000),
    corrections: null,
    ambiguities: "bad",
    warnings: ["warning", "warning", 123],
    sourceRevision: -10,
    englishSourceRevision: "bad",
    createdAt: Infinity
  });
  assert.equal(draft.id, "");
  assert.equal([...draft.source].length, 250_000);
  assert.equal(draft.english.length, 100_000);
  assert.equal([...draft.backTranslation].length, 100_000);
  assert.deepEqual(draft.corrections, []);
  assert.deepEqual(draft.ambiguities, []);
  assert.deepEqual(draft.warnings, ["warning"]);
  assert.equal(draft.sourceRevision, 0);
  assert.equal(draft.englishSourceRevision, null);
  assert.ok(Number.isFinite(draft.createdAt));

  const history = normalizeStoredHistory(Array.from({ length: 30 }, (_, index) => ({
    id: `item-${index}`,
    source: "源".repeat(50_000),
    english: "e".repeat(100_000),
    backTranslation: "回".repeat(100_000),
    note: "n".repeat(800)
  })));
  const totalChars = history.reduce(
    (sum, item) => sum + item.source.length + item.english.length + item.backTranslation.length + item.note.length,
    0
  );
  assert.ok(history.length > 0 && history.length <= 20);
  assert.ok(totalChars <= 1_500_000);

  const diagnostics = normalizeStoredDiagnostics(Array.from({ length: 100 }, (_, index) => ({
    timestamp: index % 2 === 0 ? Date.now() : "bad",
    message: index === 0 ? "x".repeat(300) : `message-${index}`
  })));
  assert.equal(diagnostics.length, 80);
  assert.equal(diagnostics[0].message.length, 240);
  assert.ok(diagnostics.every((item) => Number.isFinite(item.timestamp)));
});

test("rejects Base URLs carrying an empty query or fragment separator", () => {
  // "https://x/v1?" reports url.search === "" but serializes back with the
  // bare "?", which would push the endpoint path into the query string.
  assert.throws(() => normalizeBaseUrl("https://api.example.com/v1?"), /查询参数/);
  assert.throws(() => normalizeBaseUrl("https://api.example.com/v1#"), /查询参数/);
  assert.throws(() => normalizeBaseUrl("https://api.example.com/v1?x=1"), /查询参数/);
});

test("rejects header values, prefixes and keys that fetch cannot serialize", () => {
  assert.deepEqual(
    sanitizeExtraHeaders({ "X-Route": "中文路由", "X-Ok": "café" }),
    { "X-Ok": "café" }
  );
  assert.throws(
    () => buildHeaders({ authHeader: "Authorization", authPrefix: "令牌" }, "secret"),
    /Latin-1/
  );
  assert.throws(
    () => buildHeaders({ authHeader: "Authorization", authPrefix: "Bearer" }, "秘密"),
    /Latin-1/
  );
});

test("classifies an oversized error body by HTTP status instead of body size", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("x".repeat(140_000), {
    status: 429,
    headers: { "Retry-After": "7" }
  });
  try {
    await assert.rejects(
      chatCompletion({
        config: {
          baseUrl: "https://provider.example/v1",
          timeoutMs: 1000,
          capabilities: { jsonMode: false, temperature: false }
        },
        apiKey: "test-key",
        model: "model",
        messages: [{ role: "user", content: "hello" }]
      }),
      (error) => error?.code === "rate_limited" && error?.retryAfterMs === 7000
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider credential binding orders headers by code units, not locale", () => {
  const binding = providerCredentialBinding({
    baseUrl: "https://api.example.com/v1",
    extraHeaders: { X_A: "3", "X-B": "1", "X-A": "2" }
  });
  const parsed = JSON.parse(binding);
  // "-" (0x2D) sorts before "_" (0x5F) in code units; ICU collation would
  // interleave them and could change across browser/locale updates.
  assert.deepEqual(parsed.extraHeaders.map(([name]) => name), ["x-a", "x-b", "x_a"]);
});

test("rejects typo claims that alter Chinese numerals or ordinals", () => {
  // Chinese numerals are plain Han codepoints: without a dedicated class they
  // pass the short-Han shape check, and the ASCII-only number warning never
  // fires either — a claimed slip could silently change a quantity.
  for (const [source, original, interpreted_as] of [
    ["把超时设成三十秒", "三十", "五十"],
    ["取第三个结果", "第三", "第五"],
    ["加两个节点", "两个", "三个"],
    ["预留一半容量", "一半", "大半"]
  ]) {
    const result = validateTranslationPayload({
      english: "test",
      corrections: [{ original, interpreted_as, reason: "model claim" }],
      ambiguous: []
    }, source);
    assert.ok(
      result.errors.some((item) => item.includes("笔误")),
      `${original}→${interpreted_as} should be rejected`
    );
    assert.equal(result.corrections.length, 0);
  }

  // A numeral-free obvious typo stays accepted.
  const accepted = validateTranslationPayload({
    english: "Please help me review the code.",
    corrections: [{ original: "帮嘛", interpreted_as: "帮忙", reason: "错字" }],
    ambiguous: []
  }, "请帮嘛检查代码");
  assert.deepEqual(accepted.errors, []);
  assert.equal(accepted.corrections.length, 1);
});

test("flags answer-style phrasing including the Sure opener", () => {
  // The old pattern put a \b after "sure[,!]"; a boundary after punctuation
  // requires a following word character, so "Sure, ..." never matched.
  assert.ok(buildSoftWarnings("检查代码", "Sure, I can review the code.")
    .some((item) => item.includes("回答式")));
  assert.ok(buildSoftWarnings("检查代码", "Sure! Here is what I found.")
    .some((item) => item.includes("回答式")));
  assert.ok(buildSoftWarnings("检查代码", "Here's the review of the code.")
    .some((item) => item.includes("回答式")));
  // "ensure," and a plain translated "sure" must not false-positive.
  assert.equal(
    buildSoftWarnings("确保设置生效", "Make sure the setting takes effect. To ensure, check twice.")
      .some((item) => item.includes("回答式")),
    false
  );
});

test("rejects claude.ai as provider host in trailing-dot FQDN form", () => {
  // "claude.ai." (root-label dot) resolves to the same host but bypassed the
  // exact-string ban, aiming provider requests at the Claude site.
  assert.throws(() => normalizeBaseUrl("https://claude.ai./v1"), /Claude 站点/);
  assert.throws(() => normalizeBaseUrl("https://api.claude.ai./v1"), /Claude 站点/);
  // A trailing dot on an unrelated provider host stays allowed.
  assert.equal(normalizeBaseUrl("https://api.openai.com./v1"), "https://api.openai.com./v1");
});

test("responses protocol posts to /responses and parses typed output", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      object: "response",
      status: "completed",
      model: "gpt-responses",
      output: [
        { type: "reasoning", summary: [] },
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "{\"english\":\"Hel" },
            { type: "output_text", text: "lo\",\"corrections\":[],\"ambiguous\":[]}" }
          ]
        }
      ]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const result = await chatCompletion({
      config: {
        baseUrl: "https://provider.example/v1",
        apiProtocol: "responses",
        timeoutMs: 1000,
        capabilities: { jsonMode: null, temperature: null }
      },
      apiKey: "test-key",
      model: "gpt-responses",
      messages: [
        { role: "system", content: "Translate only." },
        { role: "user", content: "你好" }
      ],
      preferJson: true
    });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].url.endsWith("/v1/responses"), requests[0].url);
    const body = requests[0].body;
    assert.equal(body.instructions, "Translate only.");
    assert.deepEqual(body.input, [
      { role: "user", content: [{ type: "input_text", text: "你好" }] }
    ]);
    assert.deepEqual(body.text, { format: { type: "json_object" } });
    assert.equal(body.temperature, 0);
    assert.equal(body.store, false);
    assert.equal("messages" in body, false);
    assert.equal("response_format" in body, false);
    assert.equal(result.text, "{\"english\":\"Hello\",\"corrections\":[],\"ambiguous\":[]}");
    assert.equal(result.rawModel, "gpt-responses");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("responses protocol degrades text.format like response_format and keeps temperature", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        error: { message: "Unsupported parameter: 'text.format' is not supported with this model.", param: "text.format" }
      }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      object: "response",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "{\"english\":\"Hi\"}" }]
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const result = await chatCompletion({
      config: {
        baseUrl: "https://provider.example/v1",
        apiProtocol: "responses",
        timeoutMs: 1000,
        capabilities: { jsonMode: null, temperature: null }
      },
      apiKey: "test-key",
      model: "m",
      messages: [{ role: "user", content: "你好" }],
      preferJson: true
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].text, { format: { type: "json_object" } });
    assert.equal("text" in requests[1], false);
    assert.equal(requests[1].temperature, 0, "temperature must survive a text.format-only rejection");
    assert.deepEqual(result.capabilityPatch, { jsonMode: false, temperature: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("responses protocol rejects refusals, truncation, tool calls and protocol mismatches", async () => {
  const originalFetch = globalThis.fetch;
  const config = {
    baseUrl: "https://provider.example/v1",
    apiProtocol: "responses",
    timeoutMs: 1000,
    capabilities: { jsonMode: false, temperature: false }
  };
  const attempt = () => chatCompletion({
    config,
    apiKey: "k",
    model: "m",
    messages: [{ role: "user", content: "你好" }],
    preferJson: false
  });
  const respond = (payload) => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });

  try {
    globalThis.fetch = async () => respond({
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }]
    });
    await assert.rejects(attempt, (error) => error?.code === "model_refusal");

    globalThis.fetch = async () => respond({
      object: "response",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] }]
    });
    await assert.rejects(attempt, (error) => error?.code === "output_truncated");

    globalThis.fetch = async () => respond({
      object: "response",
      status: "completed",
      output: [{ type: "function_call", name: "translate", arguments: "{}" }]
    });
    await assert.rejects(attempt, (error) => error?.code === "incomplete_response");

    globalThis.fetch = async () => respond({
      model: "m",
      choices: [{ finish_reason: "stop", message: { content: "hello" } }]
    });
    await assert.rejects(attempt, (error) => error?.code === "chat_completions_response");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizes the stored api protocol and strips a pasted /responses suffix", () => {
  assert.equal(normalizeStoredProvider({ apiProtocol: "responses" }).apiProtocol, "responses");
  assert.equal(normalizeStoredProvider({ apiProtocol: "RESPONSES" }).apiProtocol, "chat_completions");
  assert.equal(normalizeStoredProvider({}).apiProtocol, "chat_completions");
  assert.equal(
    normalizeBaseUrl("https://api.openai.com/v1/responses"),
    "https://api.openai.com/v1"
  );
});

test("rejects polarity flips and alternate-numeral corrections", () => {
  for (const [source, original, interpreted_as] of [
    ["确认是这个文件", "是", "否"],
    ["把开状态记录下来", "开", "关"],
    ["数量偏多一些", "偏多", "偏少"],
    ["用壹份副本", "壹", "贰"],
    ["共廿件", "廿", "卅"]
  ]) {
    const result = validateTranslationPayload({
      english: "test",
      corrections: [{ original, interpreted_as, reason: "model claim" }],
      ambiguous: []
    }, source);
    assert.ok(result.errors.some((item) => item.includes("笔误")), `${original}→${interpreted_as} should be rejected`);
  }
});

test("treats mostly-untranslated Chinese as a hard failure", () => {
  const echo = validateEnglishTranslationText("你好世界", "你好世界 a", []);
  assert.ok(echo.errors.some((item) => item.includes("复述")), echo);
  const partial = validateEnglishTranslationText("请检查 API 状态", "请检查 API", []);
  assert.ok(partial.errors.length > 0, partial);
  const clean = validateEnglishTranslationText("请检查代码", "Please review the code.", []);
  assert.deepEqual(clean.errors, []);
});

test("parses Chinese numerals and warns when translated values diverge", () => {
  assert.equal(parseChineseNumeralRun("三十"), 30);
  assert.equal(parseChineseNumeralRun("一千二百"), 1200);
  assert.equal(parseChineseNumeralRun("五万"), 50000);
  assert.equal(parseChineseNumeralRun("十三"), 13);
  assert.equal(parseChineseNumeralRun("第三"), null);
  const mismatch = buildSoftWarnings("部署三十台服务器", "Deploy fifty servers.");
  assert.ok(mismatch.some((item) => item.includes("中文数字")), mismatch);
  const match = buildSoftWarnings("部署三十台服务器", "Deploy 30 servers.");
  assert.equal(match.some((item) => item.includes("中文数字")), false, match);
  const ordinaryWords = buildSoftWarnings("我们一起把一样的一定做完", "Let us finish the same thing together.");
  assert.equal(ordinaryWords.some((item) => item.includes("中文数字")), false, ordinaryWords);
});

test("rejects token-level back-translations and bidi control characters", () => {
  const tiny = validateBackTranslationText(
    "请检查这段代码的整体结构是否合理",
    "Please review the structure.",
    "x中"
  );
  assert.ok(tiny.errors.some((item) => item.includes("比例过低")), tiny);
  const bidi = validateTranslationPayload({
    english: "Delete ‮report.txt‬ now.",
    corrections: [],
    ambiguous: []
  }, "现在删除文件");
  assert.ok(bidi.errors.some((item) => item.includes("控制字符")), bidi);
});

test("over-limit correction lists fail and over-limit ambiguities warn", () => {
  const overflow = validateTranslationPayload({
    english: "test",
    corrections: Array.from({ length: 9 }, (_, index) => ({
      original: `错字${index}`, interpreted_as: `正字${index}`, reason: "claim"
    })),
    ambiguous: []
  }, "一段没有这些片段的原稿");
  assert.ok(overflow.errors.some((item) => item.includes("笔误")), overflow);
  const manyAmbiguities = validateTranslationPayload({
    english: "A perfectly ordinary translation.",
    corrections: [],
    ambiguous: Array.from({ length: 7 }, (_, index) => ({
      fragment: "原稿", reading_used: `读法${index}`, alternatives: []
    }))
  }, "原稿");
  assert.ok(manyAmbiguities.warnings.some((item) => item.includes("显示上限")), manyAmbiguities);
});

test("responses parsing accepts only completed assistant output", async () => {
  const originalFetch = globalThis.fetch;
  const config = {
    baseUrl: "https://provider.example/v1",
    apiProtocol: "responses",
    timeoutMs: 1000,
    capabilities: { jsonMode: false, temperature: false }
  };
  const attempt = () => chatCompletion({
    config, apiKey: "k", model: "m",
    messages: [{ role: "user", content: "你好" }],
    preferJson: false
  });
  const respond = (payload) => new Response(JSON.stringify(payload), {
    status: 200, headers: { "Content-Type": "application/json" }
  });
  const goodMessage = { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] };

  try {
    globalThis.fetch = async () => respond({ object: "response", status: "in_progress", output: [goodMessage] });
    await assert.rejects(attempt, (error) => error?.code === "incomplete_response");

    globalThis.fetch = async () => respond({ object: "response", status: "completed", output: [{ ...goodMessage, status: "in_progress" }] });
    await assert.rejects(attempt, (error) => error?.code === "incomplete_response");

    globalThis.fetch = async () => respond({ object: "response", status: "completed", output: [{ ...goodMessage, role: "user" }] });
    await assert.rejects(attempt, (error) => error?.code === "incomplete_response");

    globalThis.fetch = async () => respond({ object: "not-a-response", output: [goodMessage] });
    await assert.rejects(attempt, (error) => error?.code === "unsupported_response_schema");

    globalThis.fetch = async () => respond({ object: "response", status: "completed", output: [goodMessage] });
    const result = await attempt();
    assert.equal(result.text, "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat parsing allowlists finish reasons and drops the legacy text fallback", async () => {
  const originalFetch = globalThis.fetch;
  const config = {
    baseUrl: "https://provider.example/v1",
    timeoutMs: 1000,
    capabilities: { jsonMode: false, temperature: false }
  };
  const attempt = () => chatCompletion({
    config, apiKey: "k", model: "m",
    messages: [{ role: "user", content: "你好" }],
    preferJson: false
  });
  const respond = (payload) => new Response(JSON.stringify(payload), {
    status: 200, headers: { "Content-Type": "application/json" }
  });

  try {
    globalThis.fetch = async () => respond({
      choices: [{ finish_reason: "mystery_reason", message: { role: "assistant", content: "hello" } }]
    });
    await assert.rejects(attempt, (error) => error?.code === "incomplete_response");

    globalThis.fetch = async () => respond({
      choices: [{ finish_reason: "stop", message: { role: "user", content: "hello" } }]
    });
    await assert.rejects(attempt, (error) => error?.code === "incomplete_response");

    globalThis.fetch = async () => respond({
      choices: [{ finish_reason: "stop", text: "legacy completions text" }]
    });
    await assert.rejects(attempt, (error) => error?.code === "empty_assistant_content");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model list requires a recognized envelope and unrelated text params do not degrade JSON mode", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ login: "required" }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
    await assert.rejects(
      () => listModels({
        config: { baseUrl: "https://provider.example/v1", timeoutMs: 1000 },
        apiKey: "k"
      }),
      (error) => error?.code === "unsupported_response_schema"
    );

    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "text is invalid here", param: "text" } }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    };
    await assert.rejects(() => chatCompletion({
      config: { baseUrl: "https://provider.example/v1", timeoutMs: 1000, capabilities: { jsonMode: null, temperature: null } },
      apiKey: "k", model: "m",
      messages: [{ role: "user", content: "你好" }],
      preferJson: true
    }));
    assert.equal(calls, 1, "an unrelated param 'text' must not trigger a paid degradation retry");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("secret-like extra headers are stripped while routing headers survive", () => {
  const sanitized = sanitizeExtraHeaders({
    "X-Access-Key": "a", "X-Subscription-Key": "b", "X-Credential": "c",
    "X-Auth": "d", "X-Signature": "e", "X-Session-Id": "f",
    "X-Project": "keepme", "X-Api-Version": "2024", "X-Request-Source": "panel"
  });
  assert.deepEqual(Object.keys(sanitized).sort(), ["X-Api-Version", "X-Project", "X-Request-Source"]);
});

test("variable-length fences, overlapping terms and expanded path forms are protected", () => {
  const fenced = "````\ncode with ``` inside\nstill code\n````\n之后的中文";
  const fencedResult = protectText(fenced, []);
  assert.equal(fencedResult.placeholders[0].value.includes("still code"), true, fencedResult.placeholders);
  assert.equal(fencedResult.protectedText.includes("still code"), false);

  const inline = "运行 ``a`b`` 命令";
  const inlineResult = protectText(inline, []);
  assert.ok(inlineResult.placeholders.some((item) => item.value === "``a`b``"), inlineResult.placeholders);

  const overlapping = protectText("ababa", ["aba"]);
  assert.equal(overlapping.placeholders.length, 1);
  assert.equal(overlapping.placeholders[0].start, 0);

  const paths = protectText("路径：/tmp/file 与 path=/var/log 以及 ~/project/main.js 和 $HOME/bin/tool", []);
  const values = paths.placeholders.map((item) => item.value);
  assert.ok(values.includes("/tmp/file"), values);
  assert.ok(values.includes("/var/log"), values);
  assert.ok(values.includes("~/project/main.js"), values);
  assert.ok(values.includes("$HOME/bin/tool"), values);

  const restored = restorePlaceholders(fencedResult.protectedText, fencedResult.placeholders);
  assert.equal(restored, fenced);
});

test("protected terms deduplicate before the cap is applied", () => {
  const noisy = [
    ...Array.from({ length: 500 }, () => "  重复词  "),
    "尾部真词"
  ];
  const result = protectText("原稿包含 尾部真词 和 重复词", noisy);
  const values = result.placeholders.map((item) => item.value);
  assert.ok(values.includes("尾部真词"), values);
  assert.ok(values.includes("重复词"), values);
});

function sseResponse(frames, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    }
  }), { status, headers: { "Content-Type": "text/event-stream" } });
}

test("streams chat completions over SSE and reassembles the strict payload", async () => {
  const originalFetch = globalThis.fetch;
  const deltas = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.stream, true);
    return sseResponse([
      'data: {"model":"m","choices":[{"delta":{"role":"assistant","content":"{\\"english\\":\\"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo\\"}"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n"
    ]);
  };
  try {
    const result = await chatCompletion({
      config: { baseUrl: "https://provider.example/v1", timeoutMs: 1000, capabilities: { jsonMode: false, temperature: false, streaming: null } },
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "你好" }],
      preferJson: false,
      onTextDelta: (delta) => deltas.push(delta)
    });
    assert.equal(result.text, "{\"english\":\"Hello\"}");
    assert.equal(deltas.join(""), "{\"english\":\"Hello\"}");
    assert.equal(result.capabilityPatch.streaming, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streams responses-protocol SSE and validates the final completed object", async () => {
  const originalFetch = globalThis.fetch;
  const deltas = [];
  const finalResponse = {
    object: "response",
    status: "completed",
    model: "m",
    output: [{
      type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "streamed ok" }]
    }]
  };
  globalThis.fetch = async () => sseResponse([
    'data: {"type":"response.output_text.delta","delta":"streamed "}\n\n',
    'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
    `data: ${JSON.stringify({ type: "response.completed", response: finalResponse })}\n\n`
  ]);
  try {
    const result = await chatCompletion({
      config: { baseUrl: "https://provider.example/v1", apiProtocol: "responses", timeoutMs: 1000, capabilities: { jsonMode: false, temperature: false, streaming: null } },
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "你好" }],
      preferJson: false,
      onTextDelta: (delta) => deltas.push(delta)
    });
    assert.equal(result.text, "streamed ok");
    assert.deepEqual(deltas, ["streamed ", "ok"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back transparently when a gateway ignores stream and degrades when it rejects stream", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // Gateway ignores stream:true and answers with buffered JSON.
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "buffered" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    const deltas = [];
    const buffered = await chatCompletion({
      config: { baseUrl: "https://provider.example/v1", timeoutMs: 1000, capabilities: { jsonMode: false, temperature: false, streaming: null } },
      apiKey: "k", model: "m",
      messages: [{ role: "user", content: "你好" }],
      preferJson: false,
      onTextDelta: (delta) => deltas.push(delta)
    });
    assert.equal(buffered.text, "buffered");
    assert.deepEqual(deltas, []);

    // Gateway rejects the stream parameter → one retry without streaming.
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          error: { message: "Unsupported parameter: stream", param: "stream" }
        }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "no stream" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const degraded = await chatCompletion({
      config: { baseUrl: "https://provider.example/v1", timeoutMs: 1000, capabilities: { jsonMode: null, temperature: null, streaming: null } },
      apiKey: "k", model: "m",
      messages: [{ role: "user", content: "你好" }],
      preferJson: true,
      onTextDelta: () => {}
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].stream, true);
    assert.equal(requests[1].stream, false);
    assert.deepEqual(requests[1].response_format, { type: "json_object" }, "JSON mode must survive a stream-only rejection");
    assert.equal(degraded.capabilityPatch.streaming, false);
    assert.equal(degraded.capabilityPatch.jsonMode, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("english stream extractor decodes escapes across chunk boundaries and hides partial tokens", () => {
  const seen = [];
  const extractor = createEnglishStreamExtractor((english) => seen.push(english));
  extractor.push('{"eng');
  extractor.push('lish": "Line\\');
  extractor.push('nTwo \\u');
  extractor.push('4F60 and \\"quoted\\""');
  extractor.push(', "corrections": []}');
  assert.equal(seen.at(-1), 'Line\nTwo 你 and "quoted"');

  const protection = protectText("运行 `npm test` 后检查", []);
  const token = protection.placeholders[0].token;
  const partial = token.slice(0, token.length - 2);
  assert.equal(
    buildPreviewDisplayText(`Run ${partial}`, protection.placeholders),
    "Run "
  );
  assert.equal(
    buildPreviewDisplayText(`Run ${token} then check`, protection.placeholders),
    "Run `npm test` then check"
  );
});

test("translateDraft streams the english preview while returning fully validated output", async () => {
  const originalFetch = globalThis.fetch;
  const previews = [];
  const payloadText = JSON.stringify({
    english: "Please review the code.",
    back_translation: "请检查这段代码。",
    corrections: [],
    ambiguous: []
  });
  const escaped = JSON.stringify(payloadText).slice(1, -1);
  const half = Math.floor(escaped.length / 2);
  globalThis.fetch = async () => sseResponse([
    `data: {"choices":[{"delta":{"role":"assistant","content":"${escaped.slice(0, half)}"}}]}\n\n`,
    `data: {"choices":[{"delta":{"content":"${escaped.slice(half)}"}}]}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n"
  ]);
  try {
    const result = await translateDraft({
      source: "请检查这段代码。",
      config: { baseUrl: "https://provider.example/v1", timeoutMs: 1000, capabilities: { jsonMode: true, temperature: false, streaming: null } },
      apiKey: "k",
      model: "m",
      onEnglishPreview: (text) => previews.push(text)
    });
    assert.equal(result.english, "Please review the code.");
    assert.ok(previews.length >= 1, previews);
    assert.equal(previews.at(-1), "Please review the code.");
    assert.ok(previews.every((text, index) => index === 0 || text.startsWith(previews[index - 1])));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
