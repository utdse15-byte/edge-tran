import test from "node:test";
import assert from "node:assert/strict";

class FakeEvent {
  constructor() {
    this.listeners = [];
  }

  addListener(listener) {
    this.listeners.push(listener);
  }

  emit(...args) {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

class FakePort {
  constructor(name, sender = {}) {
    this.name = name;
    this.sender = sender;
    this.onMessage = new FakeEvent();
    this.onDisconnect = new FakeEvent();
    this.messages = [];
    this.disconnected = false;
  }

  postMessage(message) {
    if (this.disconnected) throw new Error("disconnected");
    this.messages.push(structuredClone(message));
  }

  send(message) {
    this.onMessage.emit(structuredClone(message));
  }

  disconnect() {
    if (this.disconnected) return;
    this.disconnected = true;
    this.onDisconnect.emit();
  }

  last(type) {
    return this.messages.findLast((message) => message.type === type);
  }
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("service worker transfers and recovers writer leases without losing the bound tab", async () => {
  const originalChrome = globalThis.chrome;
  const runtime = {
    onInstalled: new FakeEvent(),
    onStartup: new FakeEvent(),
    onConnect: new FakeEvent()
  };
  const tabs = {
    onActivated: new FakeEvent(),
    onRemoved: new FakeEvent(),
    async get(tabId) {
      return { id: tabId, url: "https://claude.ai/chat/test", windowId: 9, active: true };
    },
    async query() {
      return [{ id: 41, url: "https://claude.ai/chat/test", windowId: 9, active: true }];
    }
  };
  const trustedStorage = {
    async setAccessLevel() {},
    async get() { return {}; },
    async set() {},
    async remove() {}
  };

  globalThis.chrome = {
    runtime,
    tabs,
    sidePanel: { async setPanelBehavior() {} },
    storage: { local: trustedStorage, session: trustedStorage }
  };

  try {
    await import(new URL(`../sw.js?test=${Date.now()}`, import.meta.url));
    await nextTurn();

    const panel = new FakePort("zh2en-panel");
    runtime.onConnect.emit(panel);
    panel.send({ type: "PANEL_HELLO", windowId: 9 });

    const writer1 = new FakePort("zh2en-writer", {
      tab: { id: 41 },
      documentId: "document-1"
    });
    runtime.onConnect.emit(writer1);
    writer1.send({
      type: "WRITER_HELLO",
      writerSession: "writer-1",
      state: { composerReady: true, currentText: "", targetEpoch: 0, pluginOwned: false }
    });

    panel.send({ type: "BIND_TAB", tabId: 41 });
    await nextTurn();
    const firstBind = panel.last("BIND_RESULT");
    assert.equal(firstBind?.ok, true);
    const firstLease = firstBind.lease;
    assert.ok(firstLease);
    assert.equal(writer1.last("ATTACH")?.lease, firstLease);

    const messageCountBeforeReplacement = panel.messages.length;
    const writer2 = new FakePort("zh2en-writer", {
      tab: { id: 41 },
      documentId: "document-2"
    });
    runtime.onConnect.emit(writer2);
    assert.equal(writer1.disconnected, true, "stale writer should be disconnected");
    writer2.send({
      type: "WRITER_HELLO",
      writerSession: "writer-2",
      state: { composerReady: true, currentText: "", targetEpoch: 0, pluginOwned: false }
    });
    await nextTurn();

    assert.equal(writer2.last("ATTACH")?.lease, firstLease, "lease should transfer atomically");
    const replacementMessages = panel.messages.slice(messageCountBeforeReplacement);
    assert.equal(
      replacementMessages.some((message) => message.type === "TARGET_UNAVAILABLE"),
      false,
      "atomic replacement must not transiently unbind the panel"
    );

    writer2.disconnect();
    await nextTurn();
    const unavailable = panel.last("TARGET_UNAVAILABLE");
    assert.equal(unavailable?.recoverable, true);
    assert.equal(unavailable?.tabId, 41);

    const writer3 = new FakePort("zh2en-writer", {
      tab: { id: 41 },
      documentId: "document-3"
    });
    runtime.onConnect.emit(writer3);
    writer3.send({
      type: "WRITER_HELLO",
      writerSession: "writer-3",
      state: { composerReady: true, currentText: "", targetEpoch: 0, pluginOwned: false }
    });
    await nextTurn();
    await nextTurn();

    const recoveredBind = panel.messages.findLast(
      (message) => message.type === "BIND_RESULT" && message.ok && message.writerSession === "writer-3"
    );
    assert.ok(recoveredBind, "fresh writer should automatically recover the desired tab binding");
    assert.equal(writer3.last("ATTACH")?.lease, recoveredBind.lease);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("service worker remembers a not-yet-ready target and rejects expired or stale-session commands", async () => {
  const originalChrome = globalThis.chrome;
  const runtime = {
    onInstalled: new FakeEvent(),
    onStartup: new FakeEvent(),
    onConnect: new FakeEvent()
  };
  const tabRecords = new Map([
    [41, { id: 41, url: "https://claude.ai/chat/one", windowId: 9, active: true }],
    [42, { id: 42, url: "https://claude.ai/chat/two", windowId: 9, active: true }]
  ]);
  let windowFocused = true;
  const tabs = {
    onActivated: new FakeEvent(),
    onRemoved: new FakeEvent(),
    async get(tabId) {
      const tab = tabRecords.get(tabId);
      if (!tab) throw new Error("missing tab");
      return tab;
    },
    async query() {
      return [tabRecords.get(42)];
    }
  };
  const trustedStorage = {
    async setAccessLevel() {},
    async get() { return {}; },
    async set() {},
    async remove() {}
  };

  globalThis.chrome = {
    runtime,
    tabs,
    windows: { async get(windowId) { return { id: windowId, focused: windowFocused }; } },
    sidePanel: { async setPanelBehavior() {} },
    storage: { local: trustedStorage, session: trustedStorage }
  };

  try {
    await import(new URL(`../sw.js?test=${Date.now()}_pending`, import.meta.url));
    await nextTurn();

    const panel = new FakePort("zh2en-panel");
    runtime.onConnect.emit(panel);
    panel.send({ type: "PANEL_HELLO", windowId: 9 });

    const writer1 = new FakePort("zh2en-writer", {
      tab: { id: 41 },
      documentId: "document-1"
    });
    runtime.onConnect.emit(writer1);
    writer1.send({
      type: "WRITER_HELLO",
      writerSession: "writer-1",
      state: { composerReady: true, currentText: "", targetEpoch: 0, pluginOwned: false }
    });
    panel.send({ type: "BIND_TAB", tabId: 41 });
    await nextTurn();
    assert.equal(panel.last("BIND_RESULT")?.tabId, 41);

    panel.send({ type: "BIND_TAB", tabId: 42 });
    await nextTurn();
    assert.equal(writer1.last("DETACH")?.reason, "rebind_pending");
    assert.equal(panel.last("BIND_RESULT")?.code, "writer_not_ready");

    const writer2 = new FakePort("zh2en-writer", {
      tab: { id: 42 },
      documentId: "document-2"
    });
    runtime.onConnect.emit(writer2);
    writer2.send({
      type: "WRITER_HELLO",
      writerSession: "writer-2",
      state: { composerReady: true, currentText: "", targetEpoch: 4, pluginOwned: false }
    });
    await nextTurn();
    await nextTurn();

    const recovered = panel.messages.findLast(
      (message) => message.type === "BIND_RESULT" && message.ok && message.tabId === 42
    );
    assert.ok(recovered, "writer arrival should recover the desired tab without another click");
    assert.equal(writer2.last("ATTACH")?.lease, recovered.lease);

    const writeCount = writer2.messages.filter((message) => message.type === "WRITE_TARGET").length;
    panel.send({
      type: "WRITE_TARGET",
      requestId: "expired-command",
      expectedTabId: 42,
      expectedWriterSession: "writer-2",
      expectedTargetEpoch: 4,
      deadline: Date.now() - 1,
      text: "must not be forwarded"
    });
    await nextTurn();
    assert.equal(panel.last("WRITE_TARGET_RESULT")?.code, "command_expired");
    assert.equal(
      writer2.messages.filter((message) => message.type === "WRITE_TARGET").length,
      writeCount,
      "expired commands must stop at the service worker"
    );

    writer2.send({
      type: "WRITER_SESSION_CHANGED",
      writerSession: "writer-2-next",
      targetEpoch: 5
    });
    await nextTurn();
    panel.send({
      type: "WRITE_TARGET",
      requestId: "stale-session",
      expectedTabId: 42,
      expectedWriterSession: "writer-2",
      expectedTargetEpoch: 4,
      deadline: Date.now() + 1000,
      text: "must not be forwarded"
    });
    await nextTurn();
    const staleSession = panel.messages.findLast(
      (message) => message.type === "WRITE_TARGET_RESULT" && message.requestId === "stale-session"
    );
    assert.equal(staleSession?.code, "writer_session_changed");

    const forwardedBeforeBackgroundWindow = writer2.messages.length;
    windowFocused = false;
    panel.send({
      type: "GET_TARGET_TEXT",
      requestId: "background-window",
      deadline: Date.now() + 1000
    });
    await nextTurn();
    const backgroundWindow = panel.messages.findLast(
      (message) => message.type === "GET_TARGET_TEXT_RESULT" && message.requestId === "background-window"
    );
    assert.equal(backgroundWindow?.code, "target_inactive");
    assert.equal(
      writer2.messages.length,
      forwardedBeforeBackgroundWindow,
      "commands must not reach a Claude tab in an unfocused Edge window"
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("service worker ignores a slow stale bind after a newer tab was selected", async () => {
  const originalChrome = globalThis.chrome;
  const runtime = {
    onInstalled: new FakeEvent(),
    onStartup: new FakeEvent(),
    onConnect: new FakeEvent()
  };
  let resolveSlowTab;
  const slowTab = new Promise((resolve) => { resolveSlowTab = resolve; });
  const tabs = {
    onActivated: new FakeEvent(),
    onRemoved: new FakeEvent(),
    async get(tabId) {
      if (tabId === 41) return slowTab;
      return { id: 42, url: "https://claude.ai/chat/two", windowId: 9, active: true };
    },
    async query() {
      return [{ id: 42, url: "https://claude.ai/chat/two", windowId: 9, active: true }];
    }
  };
  const trustedStorage = {
    async setAccessLevel() {},
    async get() { return {}; },
    async set() {},
    async remove() {}
  };
  globalThis.chrome = {
    runtime,
    tabs,
    sidePanel: { async setPanelBehavior() {} },
    storage: { local: trustedStorage, session: trustedStorage }
  };

  try {
    await import(new URL(`../sw.js?test=${Date.now()}_bind_race`, import.meta.url));
    await nextTurn();

    const panel = new FakePort("zh2en-panel");
    runtime.onConnect.emit(panel);
    panel.send({ type: "PANEL_HELLO", windowId: 9 });

    const writer41 = new FakePort("zh2en-writer", { tab: { id: 41 }, documentId: "doc-41" });
    const writer42 = new FakePort("zh2en-writer", { tab: { id: 42 }, documentId: "doc-42" });
    runtime.onConnect.emit(writer41);
    runtime.onConnect.emit(writer42);
    writer41.send({
      type: "WRITER_HELLO",
      writerSession: "writer-41",
      state: { composerReady: true, currentText: "", targetEpoch: 0, pluginOwned: false }
    });
    writer42.send({
      type: "WRITER_HELLO",
      writerSession: "writer-42",
      state: { composerReady: true, currentText: "", targetEpoch: 0, pluginOwned: false }
    });

    panel.send({ type: "BIND_TAB", tabId: 41, bindRequestId: "bind-old" });
    panel.send({ type: "BIND_TAB", tabId: 42, bindRequestId: "bind-new" });
    await nextTurn();
    await nextTurn();

    const newBind = panel.messages.findLast(
      (message) => message.type === "BIND_RESULT" && message.bindRequestId === "bind-new"
    );
    assert.equal(newBind?.ok, true);
    assert.equal(newBind?.tabId, 42);
    assert.ok(writer42.last("ATTACH")?.lease);

    resolveSlowTab({ id: 41, url: "https://claude.ai/chat/one", windowId: 9, active: true });
    await nextTurn();
    await nextTurn();

    assert.equal(
      panel.messages.some(
        (message) => message.type === "BIND_RESULT" && message.bindRequestId === "bind-old"
      ),
      false,
      "the late old bind must be dropped rather than rebinding the previous conversation"
    );
    assert.equal(writer41.last("ATTACH"), undefined);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
