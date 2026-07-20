// Reasoning compatibility layer, v1.
//
// Translates the user's unified thinking policy into the concrete request
// fields each OpenAI-compatible dialect expects. Design rules (from the
// 2026-07-20 compatibility study, trimmed to this extension's needs):
//
//   - inherit ≠ off ≠ minimal: omitting the field, explicitly disabling and
//     requesting the lowest tier are three different server behaviors.
//   - The dialect is independent of the transport protocol: a proxy can speak
//     /chat/completions while expecting DeepSeek- or Qwen-style fields.
//   - Unknown proxy → send nothing (dialect "none" is the default).
//   - Exactly one control source per request: every known alias is stripped
//     before the selected dialect writes its own fields, which makes the
//     "no reasoning + reasoning_effort together", "off ⇒ no effort/budget"
//     and "inherit ⇒ no fields" invariants true by construction.
//   - No silent degradation: reasoning fields never join the compatibility
//     retry loop; a server that rejects them surfaces a visible error.
//   - No paid probing, no capability registry, no reasoning-content storage.

export const REASONING_MODES = Object.freeze(["inherit", "off", "manual"]);

export const REASONING_EFFORTS = Object.freeze([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

export const REASONING_DIALECTS = Object.freeze([
  "none",
  "openai_chat",
  "openai_responses",
  "openrouter",
  "deepseek",
  "thinking_type",
  "enable_thinking"
]);

export const DEFAULT_REASONING = Object.freeze({
  dialect: "none",
  mode: "inherit",
  effort: "low"
});

// Request-body paths any dialect may own. They are always cleared first so a
// dialect switch can never leave a stale alias from the previous dialect.
const KNOWN_REASONING_KEYS = ["reasoning", "reasoning_effort", "thinking", "enable_thinking", "thinking_budget"];

export function normalizeReasoning(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    dialect: REASONING_DIALECTS.includes(raw.dialect) ? raw.dialect : DEFAULT_REASONING.dialect,
    mode: REASONING_MODES.includes(raw.mode) ? raw.mode : DEFAULT_REASONING.mode,
    effort: REASONING_EFFORTS.includes(raw.effort) ? raw.effort : DEFAULT_REASONING.effort
  };
}

export function reasoningDialectsForTransport(transport) {
  return transport === "responses"
    ? ["none", "openai_responses"]
    : ["none", "openai_chat", "openrouter", "deepseek", "thinking_type", "enable_thinking"];
}

// DeepSeek documents that low tiers map upward and xhigh maps to max; the
// mapping is part of the dialect, not a per-model guess.
const DEEPSEEK_EFFORT_MAP = Object.freeze({
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max"
});

function stripKnownReasoningFields(body) {
  for (const key of KNOWN_REASONING_KEYS) delete body[key];
  if (body.output_config && typeof body.output_config === "object") {
    delete body.output_config.effort;
    if (Object.keys(body.output_config).length === 0) delete body.output_config;
  }
}

// Pure: returns a description of what was emitted alongside the mutated copy.
// `body` is treated as freshly built by the caller (chatAttempt) — it is
// still cloned defensively so snapshots and tests stay order-independent.
export function applyReasoning(body, transport, reasoningValue) {
  const reasoning = normalizeReasoning(reasoningValue);
  const output = JSON.parse(JSON.stringify(body ?? {}));
  const emitted = [];
  const removed = [];
  const notes = [];

  stripKnownReasoningFields(output);

  if (reasoning.mode === "inherit" || reasoning.dialect === "none") {
    if (reasoning.mode !== "inherit" && reasoning.dialect === "none") {
      notes.push("思考方言为“不发送”，off/manual 策略未生效");
    }
    return { body: output, emitted, removed, notes, effectiveEffort: null };
  }

  if (!reasoningDialectsForTransport(transport).includes(reasoning.dialect)) {
    notes.push(`方言 ${reasoning.dialect} 不适用于当前接口协议，本次未发送思考字段`);
    return { body: output, emitted, removed, notes, effectiveEffort: null };
  }

  const off = reasoning.mode === "off";
  let effectiveEffort = off ? null : reasoning.effort;

  switch (reasoning.dialect) {
    case "openai_chat": {
      // "none" is the documented off encoding for current OpenAI chat models;
      // models that reject it fail visibly instead of pretending to be off.
      output.reasoning_effort = off ? "none" : reasoning.effort;
      emitted.push(`reasoning_effort=${output.reasoning_effort}`);
      break;
    }
    case "openai_responses":
    case "openrouter": {
      // Canonical nested form only — never both aliases (they may conflict).
      output.reasoning = { effort: off ? "none" : reasoning.effort };
      emitted.push(`reasoning.effort=${output.reasoning.effort}`);
      break;
    }
    case "deepseek": {
      if (off) {
        output.thinking = { type: "disabled" };
        emitted.push("thinking.type=disabled");
      } else {
        effectiveEffort = DEEPSEEK_EFFORT_MAP[reasoning.effort];
        output.thinking = { type: "enabled" };
        output.reasoning_effort = effectiveEffort;
        emitted.push("thinking.type=enabled", `reasoning_effort=${effectiveEffort}`);
        if (effectiveEffort !== reasoning.effort) {
          notes.push(`档位 ${reasoning.effort} 按 DeepSeek 方言映射为 ${effectiveEffort}`);
        }
        // DeepSeek documents that sampling parameters are not applied in
        // thinking mode; sending them invites gateway-specific surprises.
        for (const key of ["temperature", "top_p", "presence_penalty", "frequency_penalty"]) {
          if (key in output) {
            delete output[key];
            removed.push(key);
          }
        }
      }
      break;
    }
    case "thinking_type": {
      output.thinking = { type: off ? "disabled" : "enabled" };
      emitted.push(`thinking.type=${output.thinking.type}`);
      if (!off) {
        output.reasoning_effort = reasoning.effort;
        emitted.push(`reasoning_effort=${reasoning.effort}`);
      }
      break;
    }
    case "enable_thinking": {
      output.enable_thinking = !off;
      emitted.push(`enable_thinking=${output.enable_thinking}`);
      if (!off) {
        // This dialect has no standardized effort field; the switch is the
        // whole contract. Saying so beats silently pretending tiers applied.
        effectiveEffort = null;
        notes.push("enable_thinking 方言只有开关，无档位字段；effort 设置不适用");
      }
      break;
    }
    default:
      break;
  }

  return { body: output, emitted, removed, notes, effectiveEffort };
}

// Params/paths whose rejection means the server refused a reasoning field.
// Such errors must surface verbatim — a silent removal would betray an
// explicit user choice (strict-manual semantics).
const REASONING_PARAM_PATTERN = /^(?:reasoning|reasoning[._]effort|reasoning\.mode|thinking|thinking\.type|enable_thinking|thinking_budget|output_config\.effort)$/i;

export function isReasoningParamName(value) {
  return REASONING_PARAM_PATTERN.test(String(value ?? "").trim());
}
