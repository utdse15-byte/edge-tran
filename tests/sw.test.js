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
    onAttached: new FakeEvent(),
    onReplaced: new FakeEvent(),
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
    onAttached: new FakeEvent(),
    onReplaced: new FakeEvent(),
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
    onAttached: new FakeEvent(),
    onReplaced: new FakeEvent(),
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

test("service worker rejects prerendered writers and follows a tab moved between windows", async () => {
  const originalChrome = globalThis.chrome;
  const runtime = {
    onInstalled: new FakeEvent(),
    onStartup: new FakeEvent(),
    onConnect: new FakeEvent()
  };
  const tab41 = { id: 41, url: "https://claude.ai/chat/one", windowId: 9, active: true };
  const tabs = {
    onActivated: new FakeEvent(),
    onRemoved: new FakeEvent(),
    onAttached: new FakeEvent(),
    onReplaced: new FakeEvent(),
    async get(tabId) {
      if (tabId !== 41) throw new Error("missing tab");
      return { ...tab41 };
    },
    async query({ windowId }) {
      return tab41.windowId === windowId ? [{ ...tab41 }] : [];
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
    windows: { async get(windowId) { return { id: windowId, focused: true }; } },
    sidePanel: { async setPanelBehavior() {} },
    storage: { local: trustedStorage, session: trustedStorage }
  };

  try {
    await import(new URL(`../sw.js?test=${Date.now()}_lifecycle`, import.meta.url));
    await nextTurn();

    const panel = new FakePort("zh2en-panel");
    runtime.onConnect.emit(panel);
    panel.send({ type: "PANEL_HELLO", windowId: 9 });

    const writer = new FakePort("zh2en-writer", {
      tab: { id: 41 },
      documentId: "doc-active",
      documentLifecycle: "active"
    });
    runtime.onConnect.emit(writer);
    writer.send({
      type: "WRITER_HELLO",
      writerSession: "writer-1",
      state: { composerReady: true, currentText: "", targetEpoch: 0, pluginOwned: false }
    });
    panel.send({ type: "BIND_TAB", tabId: 41 });
    await nextTurn();
    assert.equal(panel.last("BIND_RESULT")?.ok, true);

    // A prerendered document sharing the tab id must not capture the writer
    // slot or inherit the live page's lease.
    const prerender = new FakePort("zh2en-writer", {
      tab: { id: 41 },
      documentId: "doc-prerender",
      documentLifecycle: "prerender"
    });
    runtime.onConnect.emit(prerender);
    await nextTurn();
    assert.equal(prerender.disconnected, true, "prerendered writers must be rejected");
    assert.equal(writer.disconnected, false, "the live writer must keep its slot");

    panel.send({ type: "GET_TARGET_TEXT", requestId: "before-move", deadline: Date.now() + 1000 });
    await nextTurn();
    assert.equal(writer.last("GET_TARGET_TEXT")?.requestId, "before-move");

    // Dragging the bound tab into another window keeps commands flowing once
    // onAttached updates the tracked window.
    tab41.windowId = 12;
    tabs.onAttached.emit(41, { newWindowId: 12, newPosition: 0 });
    panel.send({ type: "GET_TARGET_TEXT", requestId: "after-move", deadline: Date.now() + 1000 });
    await nextTurn();
    assert.equal(
      writer.last("GET_TARGET_TEXT")?.requestId,
      "after-move",
      "a tab moved between windows must stay writable"
    );

    // Tab replacement clears the binding instead of leaving a dead tab id.
    tabs.onReplaced.emit(51, 41);
    await nextTurn();
    assert.equal(panel.last("TARGET_UNAVAILABLE")?.tabId, 41);
    panel.send({ type: "GET_TARGET_TEXT", requestId: "after-replace", deadline: Date.now() + 1000 });
    await nextTurn();
    const afterReplace = panel.messages.findLast(
      (message) => message.type === "GET_TARGET_TEXT_RESULT" && message.requestId === "after-replace"
    );
    assert.equal(afterReplace?.code, "target_unavailable");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("service worker releases the old lease when a rebind attempt fails", async () => {
  const originalChrome = globalThis.chrome;
  const runtime = {
    onInstalled: new FakeEvent(),
    onStartup: new FakeEvent(),
    onConnect: new FakeEvent()
  };
  const tabs = {
    onActivated: new FakeEvent(),
    onRemoved: new FakeEvent(),
    onAttached: new FakeEvent(),
    onReplaced: new FakeEvent(),
    async get(tabId) {
      if (tabId === 41) {
        return { id: 41, url: "https://claude.ai/chat/test", windowId: 9, active: true };
      }
      if (tabId === 42) {
        return { id: 42, url: "https://example.com/", windowId: 9, active: true };
      }
      throw new Error("no such tab");
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
    await import(new URL(`../sw.js?test=${Date.now()}-bindfail`, import.meta.url));
    await nextTurn();

    const panel = new FakePort("zh2en-panel");
    runtime.onConnect.emit(panel);
    panel.send({ type: "PANEL_HELLO", windowId: 9 });

    const writer41 = new FakePort("zh2en-writer", { tab: { id: 41 }, documentId: "doc-41" });
    runtime.onConnect.emit(writer41);
    writer41.send({
      type: "WRITER_HELLO",
      writerSession: "writer-41",
      state: { composerReady: true, currentText: "old english", targetEpoch: 0, pluginOwned: true }
    });

    panel.send({ type: "BIND_TAB", tabId: 41 });
    await nextTurn();
    assert.equal(panel.last("BIND_RESULT")?.ok, true);

    // Rebinding onto a non-claude.ai tab fails. The panel treats any failure
    // other than writer_not_ready as fully unbound (target.tabId = null), so
    // the old tab's lease and ownership must not survive in the service
    // worker: a retained owner would keep forwarding writer 41's events
    // (e.g. SEND_CONFIRMED → draft archival) past the panel's ghost filter.
    panel.send({ type: "BIND_TAB", tabId: 42 });
    await nextTurn();
    const failedBind = panel.last("BIND_RESULT");
    assert.equal(failedBind?.ok, false);
    assert.equal(failedBind?.code, "not_claude");
    assert.ok(writer41.last("DETACH"), "old writer must be detached on failed rebind");

    const messagesBeforeGhost = panel.messages.length;
    writer41.send({
      type: "SEND_CONFIRMED",
      writerSession: "writer-41",
      targetEpoch: 1,
      sentText: "old english",
      intentKind: "keyboard"
    });
    await nextTurn();
    assert.equal(
      panel.messages.slice(messagesBeforeGhost).some((message) => message.type === "SEND_CONFIRMED"),
      false,
      "events from the detached writer must no longer reach the panel"
    );

    // Writer commands must fail closed instead of routing to the old tab.
    panel.send({ type: "GET_TARGET_TEXT", requestId: "after-fail", deadline: Date.now() + 5000 });
    await nextTurn();
    const commandResult = panel.last("GET_TARGET_TEXT_RESULT");
    assert.equal(commandResult?.ok, false);
    assert.equal(commandResult?.code, "target_unavailable");

    // The tab_unavailable path must release the lease the same way.
    panel.send({ type: "BIND_TAB", tabId: 41 });
    await nextTurn();
    assert.equal(panel.last("BIND_RESULT")?.ok, true);
    const detachCountBefore = writer41.messages.filter((m) => m.type === "DETACH").length;
    panel.send({ type: "BIND_TAB", tabId: 77 });
    await nextTurn();
    assert.equal(panel.last("BIND_RESULT")?.code, "tab_unavailable");
    assert.equal(
      writer41.messages.filter((m) => m.type === "DETACH").length,
      detachCountBefore + 1,
      "tab_unavailable must also detach the previous binding"
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});
