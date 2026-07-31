// Tests for the Gemini Live bridge (scripts/gemini-live-bridge.mjs).
//
// The Live session is injected, so these run over real HTTP against the real
// bridge logic without opening a WebSocket to Google or spending any of the
// token budget. The concurrency and hang-up cases below are the ones that
// actually bit: an earlier version reserved `busy` inside ask() rather than at
// acquisition, so two parallel requests both passed the availability check and
// the second closed the socket the first was still streaming on.

import assert from "node:assert/strict";
import test from "node:test";

import { createLiveBridge, DEFAULT_MODEL } from "../scripts/gemini-live-bridge.mjs";

// A scriptable stand-in for a Live session.
function fakeConnector(options = {}) {
  const {
    setupDelayMs = 0,
    turnDelayMs = 5,
    reply = (text) => `EN(${text})`,
    failSetup = false,
    failTurn = false,
    emptyReply = false,
    chunks = 1
  } = options;
  const created = [];

  const connect = ({ model, systemInstruction }) => {
    const session = {
      open: false,
      busy: false,
      turns: 0,
      lastUsedAt: Date.now(),
      model,
      systemInstruction,
      closed: false,
      askCalls: 0,
      concurrentAsks: 0,
      maxConcurrentAsks: 0
    };
    created.push(session);
    session.ready = new Promise((resolve, reject) => {
      setTimeout(() => {
        if (failSetup) return reject(new Error("setup refused"));
        session.open = true;
        resolve(session);
      }, setupDelayMs);
    });
    session.ask = async (text, onDelta) => {
      session.askCalls += 1;
      session.concurrentAsks += 1;
      session.maxConcurrentAsks = Math.max(session.maxConcurrentAsks, session.concurrentAsks);
      try {
        await new Promise((resolve) => setTimeout(resolve, turnDelayMs));
        if (session.closed) throw new Error("live socket closed (1006)");
        if (failTurn) throw new Error("live turn failed");
        const answer = emptyReply ? "" : reply(text);
        for (const piece of splitInto(answer, chunks)) onDelta?.(piece);
        return { text: answer, usage: { promptTokenCount: 100, totalTokenCount: 120 } };
      } finally {
        session.concurrentAsks -= 1;
      }
    };
    session.close = () => { session.closed = true; session.open = false; };
    return session;
  };

  return { connect, created };
}

function splitInto(text, count) {
  if (count <= 1 || !text) return [text];
  const size = Math.ceil(text.length / count);
  const out = [];
  for (let index = 0; index < text.length; index += size) out.push(text.slice(index, index + size));
  return out;
}

async function withBridge(options, run) {
  const { connectorOptions = {}, ...bridgeOptions } = options;
  const connector = fakeConnector(connectorOptions);
  const bridge = createLiveBridge({ apiKey: "test-key", connect: connector.connect, ...bridgeOptions });
  const port = await bridge.listen(0);
  try {
    return await run({ bridge, connector, base: `http://127.0.0.1:${port}/v1` });
  } finally {
    await bridge.close();
  }
}

function chatBody(text, extra = {}) {
  return JSON.stringify({
    model: DEFAULT_MODEL,
    messages: [
      { role: "system", content: "translate" },
      { role: "user", content: text }
    ],
    ...extra
  });
}

async function post(base, body, init = {}) {
  return fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    ...init
  });
}

test("a buffered translation round-trips through the bridge", async () => {
  await withBridge({}, async ({ base }) => {
    const response = await post(base, chatBody("你好"));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.choices[0].message.content, "EN(你好)");
    assert.equal(payload.choices[0].finish_reason, "stop");
    assert.equal(payload.usage.total_tokens, 120);
  });
});

test("concurrent requests never share or close each other's session", async () => {
  // The regression this file exists for. With reuseTurns=1 every request needs
  // its own session; the old code closed a busy one out from under its owner.
  await withBridge({ connectorOptions: { turnDelayMs: 40 } }, async ({ base, connector, bridge }) => {
    const drafts = ["一", "二", "三", "四", "五", "六", "七", "八"];
    const responses = await Promise.all(drafts.map((draft) => post(base, chatBody(draft))));
    const payloads = await Promise.all(responses.map((response) => response.json()));

    for (const [index, payload] of payloads.entries()) {
      assert.equal(responses[index].status, 200, JSON.stringify(payload));
      assert.equal(payload.choices[0].message.content, `EN(${drafts[index]})`);
    }
    // Every session took exactly one turn, and none ever had two in flight.
    for (const session of connector.created) {
      assert.ok(session.askCalls <= 1, `a session served ${session.askCalls} turns`);
      assert.equal(session.maxConcurrentAsks, 1);
    }
    assert.equal(bridge.stats().sessions, 0, "every session should be released");
  });
});

test("a session is reused up to reuseTurns and then retired", async () => {
  await withBridge({ reuseTurns: 3 }, async ({ base, connector }) => {
    for (const draft of ["a", "b", "c", "d"]) {
      const response = await post(base, chatBody(draft));
      assert.equal(response.status, 200);
    }
    const turnCounts = connector.created.map((session) => session.askCalls);
    assert.equal(turnCounts.reduce((sum, value) => sum + value, 0), 4);
    assert.ok(Math.max(...turnCounts) <= 3, `a session exceeded reuseTurns: ${turnCounts}`);
    assert.equal(connector.created.length, 2, `expected 2 sessions, saw ${turnCounts}`);
  });
});

test("a fresh session per request is the default", async () => {
  await withBridge({}, async ({ base, connector }) => {
    for (const draft of ["a", "b", "c"]) await post(base, chatBody(draft));
    assert.equal(connector.created.length, 3);
    assert.ok(connector.created.every((session) => session.askCalls === 1));
  });
});

test("streaming emits deltas and a terminating [DONE]", async () => {
  await withBridge({ connectorOptions: { chunks: 4 } }, async ({ base }) => {
    const response = await post(base, chatBody("你好", { stream: true }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
    const body = await response.text();
    assert.ok(body.includes("data: [DONE]"), body);
    const deltas = [...body.matchAll(/"content":"([^"]*)"/g)].map((match) => match[1]).join("");
    assert.equal(deltas, "EN(你好)");
    assert.ok(body.includes('"finish_reason":"stop"'));
  });
});

test("a client that hangs up mid-turn releases and discards its session", async () => {
  await withBridge({ connectorOptions: { turnDelayMs: 300 } }, async ({ base, connector, bridge }) => {
    const controller = new AbortController();
    const pending = post(base, chatBody("放弃"), { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    await assert.rejects(pending);
    // Give the server a moment to observe the close and run its cleanup.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(bridge.stats().busy, 0, "a hung-up request left its session reserved");
    assert.equal(bridge.stats().sessions, 0, "an abandoned session was never disposed");
    assert.ok(connector.created.every((session) => session.closed));
  });
});

test("a setup failure is a 502 and leaks no session", async () => {
  await withBridge({ connectorOptions: { failSetup: true } }, async ({ base, bridge }) => {
    const response = await post(base, chatBody("你好"));
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error.code, "live_bridge_error");
    assert.match(payload.error.message, /setup refused/);
    assert.equal(bridge.stats().sessions, 0);
  });
});

test("a failed turn is a 502 and the session is discarded, not reused", async () => {
  await withBridge({ reuseTurns: 5, connectorOptions: { failTurn: true } }, async ({ base, connector, bridge }) => {
    const response = await post(base, chatBody("你好"));
    assert.equal(response.status, 502);
    assert.equal(bridge.stats().sessions, 0);
    assert.ok(connector.created.every((session) => session.closed));
  });
});

test("an empty transcription is reported rather than passed off as a translation", async () => {
  await withBridge({ connectorOptions: { emptyReply: true } }, async ({ base }) => {
    const response = await post(base, chatBody("你好"));
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error.code, "empty_transcription");
  });
});

test("routing, method and payload guards", async () => {
  await withBridge({}, async ({ base }) => {
    const models = await fetch(`${base}/models`);
    assert.equal(models.status, 200);
    const list = await models.json();
    assert.equal(list.data[0].id, DEFAULT_MODEL);

    assert.equal((await fetch(`${base}/responses`, { method: "POST", body: "{}" })).status, 404);
    assert.equal((await fetch(`${base}/chat/completions`)).status, 405);

    const badJson = await post(base, "not json");
    assert.equal(badJson.status, 400);

    const noUser = await post(base, JSON.stringify({
      model: DEFAULT_MODEL, messages: [{ role: "system", content: "only system" }]
    }));
    assert.equal(noUser.status, 400);
  });
});

test("different system prompts do not share a session pool", async () => {
  await withBridge({ reuseTurns: 5 }, async ({ base, connector }) => {
    await post(base, JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [{ role: "system", content: "prompt A" }, { role: "user", content: "x" }]
    }));
    await post(base, JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [{ role: "system", content: "prompt B" }, { role: "user", content: "y" }]
    }));
    assert.equal(connector.created.length, 2);
    assert.deepEqual(
      connector.created.map((session) => session.systemInstruction).sort(),
      ["prompt A", "prompt B"]
    );
  });
});

test("an oversized request body is refused", async () => {
  await withBridge({}, async ({ base }) => {
    const response = await post(base, chatBody("x".repeat(1_200_000)));
    assert.equal(response.status, 413);
    const payload = await response.json();
    assert.equal(payload.error.code, "payload_too_large");
    assert.match(payload.error.message, /too large/);
  });
});
