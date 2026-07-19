const MAX_TRANSLATION_CHARS = 100_000;
const MAX_CORRECTION_FRAGMENT_CODEPOINTS = 4;
const CRITICAL_MEANING_PATTERN = /(?:不|没|未|无|非|别|勿|禁止|必须|务必|只能|不得|不能|不要|无需|应该|应当|可能|也许|可以|请)/u;
const DISALLOWED_TEXT_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const MAX_JSON_CANDIDATE_SCANS = 32;

function stripJsonFence(text) {
  return String(text ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function balancedJsonObjectAt(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { text: text.slice(start, index + 1), end: index };
      if (depth < 0) return null;
    }
  }
  return null;
}

export function parseTranslationJson(text) {
  const stripped = stripJsonFence(text);
  try {
    return JSON.parse(stripped);
  } catch {
    // Some compatible gateways prepend a short explanation despite the prompt.
    // Parse the first balanced JSON object that is itself valid rather than the
    // unsafe/greedy "first { through last }" strategy.
    let firstValidObject = null;
    let scans = 0;
    for (
      let start = stripped.indexOf("{");
      start >= 0 && scans < MAX_JSON_CANDIDATE_SCANS;
    ) {
      scans += 1;
      const candidate = balancedJsonObjectAt(stripped, start);
      if (!candidate) {
        start = stripped.indexOf("{", start + 1);
        continue;
      }
      try {
        const parsed = JSON.parse(candidate.text);
        // Compatible gateways sometimes prepend a valid metadata object before
        // the actual translation. Prefer the object that matches this parser's
        // contract instead of accepting unrelated JSON and forcing a retry.
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.english === "string") {
          return parsed;
        }
        if (firstValidObject === null) firstValidObject = parsed;
        // A valid JSON object cannot contain a second top-level response object;
        // skip its nested braces instead of rescanning them one by one.
        start = stripped.indexOf("{", candidate.end + 1);
      } catch {
        start = stripped.indexOf("{", start + 1);
      }
    }
    if (firstValidObject !== null) return firstValidObject;
    throw new Error("模型没有返回可解析的 JSON");
  }
}

function levenshtein(leftValue, rightValue) {
  const left = [...String(leftValue ?? "")];
  const right = [...String(rightValue ?? "")];
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array(right.length + 1).fill(0);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j];
  }
  return previous[right.length];
}

function changedCoreSize(leftValue, rightValue) {
  const left = [...String(leftValue ?? "")];
  const right = [...String(rightValue ?? "")];
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) suffix += 1;
  return Math.max(left.length - prefix - suffix, right.length - prefix - suffix);
}

function containsProtectedShape(value) {
  return /[A-Za-z0-9]|https?:\/\/|@|[\\/]|⟦/.test(String(value ?? ""));
}

function isShortHanFragment(value) {
  const points = [...String(value ?? "")];
  return (
    points.length > 0
    && points.length <= MAX_CORRECTION_FRAGMENT_CODEPOINTS
    && points.every((point) => /[\u3400-\u9fff]/u.test(point))
  );
}

function sourceOccurrences(source, fragment) {
  const indexes = [];
  if (!fragment) return indexes;
  let start = 0;
  while (start <= source.length) {
    const index = source.indexOf(fragment, start);
    if (index < 0) break;
    indexes.push(index);
    if (indexes.length > 2) break;
    // Advance by one code unit so overlapping occurrences are also counted.
    // For example, “哈哈” appears twice in “哈哈哈”; treating it as unique
    // would let the model silently choose which occurrence it claims to fix.
    start = index + 1;
  }
  return indexes;
}

function normalizeCorrections(value, source) {
  if (!Array.isArray(value)) return { corrections: [], rejected: [] };
  const corrections = [];
  const rejected = [];
  const acceptedRanges = [];
  const seenOriginals = new Set();

  for (const item of value.slice(0, 8)) {
    const original = String(item?.original ?? "").trim();
    const interpretedAs = String(item?.interpreted_as ?? "").trim();
    const reason = String(item?.reason ?? "").trim().slice(0, 240);
    const shapeValid =
      isShortHanFragment(original)
      && isShortHanFragment(interpretedAs)
      && !containsProtectedShape(original)
      && !containsProtectedShape(interpretedAs)
      && !CRITICAL_MEANING_PATTERN.test(original)
      && !CRITICAL_MEANING_PATTERN.test(interpretedAs);

    const occurrences = shapeValid ? sourceOccurrences(source, original) : [];
    const start = occurrences.length === 1 ? occurrences[0] : -1;
    const end = start >= 0 ? start + original.length : -1;
    const overlapsAccepted = start >= 0 && acceptedRanges.some(
      (range) => start < range.end && end > range.start
    );

    let valid = false;
    if (
      shapeValid
      && occurrences.length === 1
      && !seenOriginals.has(original)
      && !overlapsAccepted
      && original !== interpretedAs
    ) {
      const distance = levenshtein(original, interpretedAs);
      valid = distance >= 1 && distance <= 2 && changedCoreSize(original, interpretedAs) <= 2;
    }

    if (valid && corrections.length < 2) {
      corrections.push({ original, interpreted_as: interpretedAs, reason });
      acceptedRanges.push({ start, end });
      seenOriginals.add(original);
    } else {
      rejected.push({
        original: original.slice(0, 24),
        interpreted_as: interpretedAs.slice(0, 24)
      });
    }
  }
  return { corrections, rejected };
}

function normalizeAmbiguities(value, source) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).map((item) => ({
    fragment: String(item?.fragment ?? "").trim().slice(0, 160),
    reading_used: String(item?.reading_used ?? "").trim().slice(0, 240),
    alternatives: Array.isArray(item?.alternatives)
      ? item.alternatives.slice(0, 4).map((entry) => String(entry).trim().slice(0, 180))
      : []
  })).filter((item) => item.fragment && source.includes(item.fragment));
}

function extractAsciiNumbers(text) {
  const matches = String(text ?? "").match(/\d+(?:[,.]\d+)*(?:%|％|‰)?/g) ?? [];
  return matches
    .map((value) => value.replace(/,/g, "").replace(/％/g, "%"))
    .sort();
}

function numberListsMatch(left, right) {
  return extractAsciiNumbers(left).join("|") === extractAsciiNumbers(right).join("|");
}

export function validateEnglishTranslationText(source, protectedEnglish, placeholders = []) {
  const sourceText = String(source ?? "");
  let visibleEnglish = String(protectedEnglish ?? "");
  let visibleSource = sourceText;
  let protectedHan = 0;
  const placeholderList = Array.isArray(placeholders) ? placeholders : [];
  for (const item of placeholderList) {
    const token = String(item?.token ?? "");
    if (token) visibleEnglish = visibleEnglish.split(token).join("");
    protectedHan += (String(item?.value ?? "").match(/[\u3400-\u9fff]/gu) ?? []).length;
  }
  // Remove protected source ranges by position rather than value replacement;
  // repeated protected terms must not accidentally erase unprotected text.
  for (const item of [...placeholderList].sort((a, b) => Number(b?.start ?? 0) - Number(a?.start ?? 0))) {
    const start = Number(item?.start);
    const end = Number(item?.end);
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start) {
      visibleSource = `${visibleSource.slice(0, start)}${visibleSource.slice(end)}`;
    }
  }

  const totalSourceHan = (sourceText.match(/[\u3400-\u9fff]/gu) ?? []).length;
  const sourceHan = Math.max(0, totalSourceHan - protectedHan);
  const outputHan = (visibleEnglish.match(/[\u3400-\u9fff]/gu) ?? []).length;
  const outputLatin = (visibleEnglish.match(/[A-Za-z]/g) ?? []).length;
  const outputDigits = (visibleEnglish.match(/\d/g) ?? []).length;
  const errors = [];
  const warnings = [];

  const compactSource = visibleSource.replace(/[\s\p{P}\p{S}]/gu, "");
  const sourceLooksNumeric = Boolean(compactSource) && /^[零〇○一二两三四五六七八九十百千万亿兆点分之半负正第元块角毛厘成]+$/u.test(compactSource);

  // The model occasionally echoes the Chinese source while still returning a
  // structurally valid JSON object. Require actual English signal whenever
  // there is unprotected Chinese to translate. A digits-only rendering is
  // accepted only when the unprotected source itself is a Chinese number; the
  // old generic exception let “你好” -> “123” pass as a valid translation.
  if (sourceHan > 0 && outputLatin === 0) {
    const validNumericRendering = sourceLooksNumeric && outputHan === 0 && outputDigits > 0;
    if (!validNumericRendering) {
      errors.push("english 没有形成英文内容，模型可能只是复述了中文原稿");
    }
  }
  if (sourceHan >= 4 && outputHan >= Math.max(4, Math.ceil(sourceHan * 0.5)) && outputLatin < outputHan * 2) {
    warnings.push("english 中仍保留了较多未受保护的中文，请核对是否完整翻译");
  }
  return { errors, warnings };
}

export function buildSoftWarnings(source, english) {
  const warnings = [];
  const sourceNumbers = extractAsciiNumbers(source);
  if (sourceNumbers.length > 0 && !numberListsMatch(source, english)) {
    warnings.push("原文与英译中的阿拉伯数字或百分号不完全一致，请核对");
  }

  if (/\b(as an ai|i(?:'|’)d be happy to|sure[,!]|here(?:'|’)s)\b/i.test(english)) {
    warnings.push("译文出现了疑似回答式措辞，请重点核对");
  }

  const sourceLength = [...String(source ?? "")].length;
  const englishLength = [...String(english ?? "")].length;
  if (sourceLength >= 20) {
    const ratio = englishLength / sourceLength;
    if (ratio < 0.35 || ratio > 4.5) warnings.push("译文长度与原文比例异常，请核对是否遗漏或扩写");
  }
  return warnings;
}

export function buildBackTranslationWarnings(source, english, backTranslation) {
  const warnings = [];
  if (extractAsciiNumbers(english).length > 0 && !numberListsMatch(english, backTranslation)) {
    warnings.push("英译与回译中的阿拉伯数字或百分号不完全一致，请核对");
  }

  const sourceHan = (String(source ?? "").match(/[\u3400-\u9fff]/gu) ?? []).length;
  const backHan = (String(backTranslation ?? "").match(/[\u3400-\u9fff]/gu) ?? []).length;
  if (sourceHan >= 1 && backTranslation && backHan === 0) {
    warnings.push("回译结果几乎没有中文，模型可能没有遵守回译格式");
  }

  const comparableSource = String(source ?? "").replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
  const comparableBack = String(backTranslation ?? "").replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
  if (sourceHan >= 8 && comparableSource.length >= 8 && comparableSource === comparableBack) {
    warnings.push("回译与中文原稿几乎完全相同；同请求模式下模型可能直接复述了原稿，请重点核对英文");
  }

  if (
    /\b(the (?:chinese )?translation is|back[- ]?translation|here is)\b/i.test(backTranslation)
    || /^\s*(?:回译|中文(?:翻译|译文)|翻译如下|回译如下)\s*[:：]/u.test(backTranslation)
  ) {
    warnings.push("回译出现了说明性前缀，请核对模型是否添加了额外内容");
  }

  const sourceLength = [...String(source ?? "")].length;
  const backLength = [...String(backTranslation ?? "")].length;
  if (sourceLength >= 20 && backLength > 0) {
    const ratio = backLength / sourceLength;
    if (ratio < 0.3 || ratio > 3.5) warnings.push("回译长度与中文原稿比例异常，请重点核对");
  }
  return warnings;
}

export function validateBackTranslationText(
  source,
  english,
  backTranslation,
  { requireChinese = true, includeWarnings = true } = {}
) {
  const chinese = typeof backTranslation === "string" ? backTranslation : "";
  const errors = [];
  if (!chinese.trim()) errors.push("模型返回的回译为空");
  if ([...chinese].length > MAX_TRANSLATION_CHARS) errors.push("模型返回的回译异常过长");
  if (DISALLOWED_TEXT_CONTROL_PATTERN.test(chinese)) errors.push("模型返回的回译含有不安全控制字符");
  const sourceHan = (String(source ?? "").match(/[\u3400-\u9fff]/gu) ?? []).length;
  const backHan = (chinese.match(/[\u3400-\u9fff]/gu) ?? []).length;
  if (requireChinese && sourceHan >= 1 && chinese.trim() && backHan === 0) {
    errors.push("回译结果没有中文，模型未遵守回译要求");
  }
  return {
    errors,
    warnings: includeWarnings ? buildBackTranslationWarnings(source, english, chinese) : [],
    chinese
  };
}

export function validateTranslationPayload(
  payload,
  source,
  { requireBackTranslation = false, includeWarnings = true } = {}
) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      errors: ["模型 JSON 顶层必须是对象"],
      english: "",
      backTranslation: "",
      corrections: [],
      rejectedCorrections: [],
      ambiguities: [],
      warnings: []
    };
  }

  const english = typeof payload.english === "string" ? payload.english : "";
  if (!english.trim()) errors.push("模型返回的 english 为空");
  if ([...english].length > MAX_TRANSLATION_CHARS) errors.push("模型返回的 english 异常过长");
  if (DISALLOWED_TEXT_CONTROL_PATTERN.test(english)) errors.push("模型返回的 english 含有不安全控制字符");

  const backTranslation = typeof payload.back_translation === "string"
    ? payload.back_translation
    : "";
  // Placeholder-bearing output is not yet restored here. Structural checks
  // are safe now, but requiring visible Han characters or comparing numbers
  // must wait until translator.js restores protected code/URLs/terms.
  const backValidation = requireBackTranslation
    ? validateBackTranslationText(source, english, backTranslation, {
        requireChinese: false,
        includeWarnings
      })
    : {
        errors: [],
        warnings: includeWarnings && backTranslation
          ? buildBackTranslationWarnings(source, english, backTranslation)
          : []
      };
  errors.push(...backValidation.errors.map((error) => error.replace("模型返回的回译", "模型返回的 back_translation")));
  if (payload.corrections !== undefined && !Array.isArray(payload.corrections)) {
    errors.push("模型返回的 corrections 必须是数组");
  }
  if (payload.ambiguous !== undefined && !Array.isArray(payload.ambiguous)) {
    errors.push("模型返回的 ambiguous 必须是数组");
  }

  const correctionResult = normalizeCorrections(payload.corrections, source);
  if (correctionResult.rejected.length > 0) {
    errors.push("模型报告的笔误超出“仅明显错字”边界");
  }

  const ambiguities = normalizeAmbiguities(payload.ambiguous, source);
  const warnings = includeWarnings ? buildSoftWarnings(source, english) : [];
  if (includeWarnings && backTranslation) warnings.push(...backValidation.warnings);

  return {
    errors,
    english,
    backTranslation,
    corrections: correctionResult.corrections,
    rejectedCorrections: correctionResult.rejected,
    ambiguities,
    warnings: [...new Set(warnings)]
  };
}
