const MAX_PLACEHOLDERS = 1_000;
const MAX_PROTECTED_TERMS = 500;

function randomPrefix(sourceText = "") {
  const source = String(sourceText ?? "");
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    const prefix = `ZH2EN_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    if (!source.includes(prefix)) return prefix;
  }
  throw new Error("无法生成安全的受保护内容占位符，请稍后重试");
}

function overlapsAny(range, accepted) {
  return accepted.some((item) => range.start < item.end && range.end > item.start);
}

function acceptRange(range, accepted) {
  if (overlapsAny(range, accepted)) return false;
  accepted.push(range);
  if (accepted.length > MAX_PLACEHOLDERS) {
    throw new Error(`受保护片段超过 ${MAX_PLACEHOLDERS} 个，请减少重复保护词或拆分文本`);
  }
  return true;
}

function collectRegexRanges(text, regex, kind, accepted) {
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const value = match[0];
    if (!value) {
      regex.lastIndex += 1;
      continue;
    }
    acceptRange({ start: match.index, end: match.index + value.length, value, kind }, accepted);
  }
}

// Markdown fences may be longer than three characters, and the closing run
// must be at least as long as the opener. A fixed three-character matcher
// would close a four-backtick fence at an inner triple-backtick sequence and
// expose the rest of the code block to translation.
function collectFencedCodeRanges(text, accepted) {
  const opener = /(`{3,}|~{3,})/g;
  let match;
  while ((match = opener.exec(text)) !== null) {
    const fence = match[1];
    const start = match.index;
    const closer = new RegExp(`\\${fence[0]}{${fence.length},}`, "g");
    closer.lastIndex = start + fence.length;
    const closerMatch = closer.exec(text);
    const end = closerMatch ? closerMatch.index + closerMatch[0].length : text.length;
    acceptRange({ start, end, value: text.slice(start, end), kind: "fenced_code" }, accepted);
    opener.lastIndex = end;
  }
}

// CommonMark inline code spans open and close with backtick runs of equal
// length, allowing shorter runs inside (``a`b``). Spans stay single-line here
// on purpose: a stray backtick must not swallow prose across lines.
function collectInlineCodeRanges(text, accepted) {
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    let openLength = 0;
    while (text[index + openLength] === "`") openLength += 1;
    let cursor = index + openLength;
    let closeStart = -1;
    while (cursor < text.length && text[cursor] !== "\n") {
      if (text[cursor] === "`") {
        let runLength = 0;
        while (text[cursor + runLength] === "`") runLength += 1;
        if (runLength === openLength) {
          closeStart = cursor;
          break;
        }
        cursor += runLength;
      } else {
        cursor += 1;
      }
    }
    if (closeStart > index + openLength) {
      acceptRange({
        start: index,
        end: closeStart + openLength,
        value: text.slice(index, closeStart + openLength),
        kind: "inline_code"
      }, accepted);
      index = closeStart + openLength;
    } else {
      index += openLength;
    }
  }
}

function collectTermRanges(text, terms, accepted) {
  // Trim, drop empties and deduplicate BEFORE applying the cap: junk in the
  // first 500 raw entries must not evict valid terms further down the list.
  const normalizedTerms = [...new Set((terms ?? [])
    .map((term) => String(term ?? "").trim())
    .filter(Boolean))]
    .slice(0, MAX_PROTECTED_TERMS)
    .sort((a, b) => b.length - a.length);

  for (const term of normalizedTerms) {
    let start = 0;
    while (start < text.length) {
      const index = text.indexOf(term, start);
      if (index < 0) break;
      acceptRange({ start: index, end: index + term.length, value: term, kind: "term" }, accepted);
      // Advance by one code unit: for term "aba" in "ababa" the occurrence at
      // index 2 must also be considered (overlap rejection handles conflicts).
      start = index + 1;
    }
  }
}

export function protectText(source, protectedTerms = []) {
  const text = String(source ?? "");
  const accepted = [];
  // Priority is encoded by collection order: broader structural ranges must
  // be accepted before lower-priority ranges nested inside them. In particular,
  // a literal token-looking example inside a code block must not prevent the
  // entire code block from being protected.
  collectFencedCodeRanges(text, accepted);
  collectInlineCodeRanges(text, accepted);
  collectRegexRanges(text, /\bhttps?:\/\/[^\s<>"'）)，。！？、；：]+/gi, "url", accepted);
  collectRegexRanges(text, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "email", accepted);
  collectRegexRanges(text, /\b[A-Za-z]:\\(?:[^\\\s<>:"|?*，。！？、；：]+\\)*[^\\\s<>:"|?*，。！？、；：]*/g, "windows_path", accepted);
  collectRegexRanges(text, /(?:^|(?<=[\s"'(=\[：（,，:;；]))(?:~\/|\$[A-Za-z_][A-Za-z0-9_]*\/|\.{0,2}\/|\/)[^\s"'<>）)\]，。！？、；：]+/gm, "unix_path", accepted);
  // Preserve literal examples of our token syntax when they are not already
  // covered by a larger protected structure such as code or a URL.
  collectRegexRanges(text, /⟦ZH2EN_[A-F0-9]+_P\d+⟧/g, "placeholder_literal", accepted);
  collectTermRanges(text, protectedTerms, accepted);

  const ordered = accepted.sort((a, b) => a.start - b.start);
  const prefix = randomPrefix(text);
  const placeholders = ordered.map((range, index) => ({
    ...range,
    token: `⟦${prefix}_P${index}⟧`
  }));

  let protectedText = text;
  for (const item of [...placeholders].sort((a, b) => b.start - a.start)) {
    protectedText = `${protectedText.slice(0, item.start)}${item.token}${protectedText.slice(item.end)}`;
  }

  return { protectedText, placeholders, prefix };
}

export function validatePlaceholderIntegrity(translatedText, placeholders, prefix) {
  const output = String(translatedText ?? "");
  const expectedTokens = placeholders.map((item) => item.token);
  const expectedSet = new Set(expectedTokens);
  const errors = [];
  const warnings = [];

  // Only the random namespace created for this request is reserved. Literal
  // text that resembles an old/unrelated plugin token is ordinary user data
  // and must not trigger a false hard failure.
  const escapedPrefix = String(prefix ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokenRegex = escapedPrefix
    ? new RegExp(`⟦${escapedPrefix}_P\\d+⟧`, "g")
    : new RegExp("a^", "g");
  const actualTokens = output.match(tokenRegex) ?? [];
  const counts = new Map();
  for (const token of actualTokens) counts.set(token, (counts.get(token) ?? 0) + 1);

  for (const token of expectedTokens) {
    const count = counts.get(token) ?? 0;
    if (count === 0) errors.push(`受保护内容缺失：${token}`);
    else if (count > 1) errors.push(`受保护内容重复：${token}`);
  }

  for (const token of counts.keys()) {
    if (!expectedSet.has(token)) errors.push(`模型新增了未知占位符：${token}`);
  }

  const actualOrder = actualTokens.filter((token) => expectedSet.has(token));
  if (
    errors.length === 0
    && actualOrder.length === expectedTokens.length
    && actualOrder.some((token, index) => token !== expectedTokens[index])
  ) {
    warnings.push("受保护内容在英译中改变了位置，请核对语序");
  }

  return { errors, warnings };
}

export function restorePlaceholders(translatedText, placeholders) {
  let output = String(translatedText ?? "");
  for (const item of placeholders) {
    output = output.split(item.token).join(item.value);
  }
  return output;
}
