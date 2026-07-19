import { hardenStorageAccess } from "./lib/storage.js";
import { isClaudeUrl, randomId } from "./lib/shared.js";

const writers = new Map();
const panels = new Set();

function post(port, message) {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

async function initializeExtension() {
  await hardenStorageAccess();
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    // Edge/Chrome versions without this behavior can still open from the sidebar menu.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void initializeExtension();
});
chrome.runtime.onStartup.addListener(() => {
  void initializeExtension();
});
void initializeExtension();

function panelForWriter(writer) {
  return writer?.ownerPanel && panels.has(writer.ownerPanel) ? writer.ownerPanel : null;
}

function notifyWriterOwner(writer, message) {
  const panel = panelForWriter(writer);
  if (panel) post(panel.port, message);
}

function detachPanel(panel, reason = "panel_detached") {
  if (!panel.boundTabId) return;
  const writer = writers.get(panel.boundTabId);
  if (writer?.ownerPanel === panel) {
    post(writer.port, {
      type: "DETACH",
      lease: panel.lease,
      reason
    });
    writer.ownerPanel = null;
    writer.lease = null;
  }
  panel.boundTabId = null;
  panel.lease = null;
}

function bindingIsCurrent(panel, generation, bindRequestId, tabId) {
  return Boolean(
    panels.has(panel)
    && panel.bindGeneration === generation
    && panel.bindRequestId === bindRequestId
    && panel.desiredTabId === tabId
  );
}

async function bindPanelToTab(
  panel,
  tabId,
  {
    generation = panel.bindGeneration,
    bindRequestId = panel.bindRequestId
  } = {}
) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    if (!bindingIsCurrent(panel, generation, bindRequestId, tabId)) return;
    post(panel.port, {
      type: "BIND_RESULT",
      ok: false,
      bindRequestId,
      tabId,
      code: "tab_unavailable",
      message: "目标标签页不可用"
    });
    return;
  }

  // chrome.tabs.get() is asynchronous. The user may have selected another
  // Claude tab while it was pending; stale bind completions must never detach
  // or overwrite the newer target.
  if (!bindingIsCurrent(panel, generation, bindRequestId, tabId)) return;

  if (!isClaudeUrl(tab.url ?? "")) {
    post(panel.port, {
      type: "BIND_RESULT",
      ok: false,
      bindRequestId,
      tabId,
      code: "not_claude",
      message: "当前标签页不是 claude.ai"
    });
    return;
  }

  // Stop observing the old Claude tab as soon as the user chooses a different
  // target, even when the new tab's content script has not connected yet.
  if (panel.boundTabId && panel.boundTabId !== tabId) detachPanel(panel, "rebind_pending");

  const writer = writers.get(tabId);
  if (!writer) {
    // Remember the desired target so a content-script reconnect can recover
    // the binding immediately instead of relying only on panel retry timers.
    panel.boundTabId = tabId;
    panel.windowId = tab.windowId;
    panel.lease = null;
    post(panel.port, {
      type: "BIND_RESULT",
      ok: false,
      bindRequestId,
      tabId,
      code: "writer_not_ready",
      message: "Claude 页面写入脚本尚未就绪，请刷新该标签页后重试"
    });
    return;
  }

  if (writer.ownerPanel && writer.ownerPanel !== panel) {
    const previousPanel = writer.ownerPanel;
    previousPanel.bindGeneration += 1;
    previousPanel.bindRequestId = null;
    previousPanel.desiredTabId = null;
    post(previousPanel.port, {
      type: "TARGET_TAKEN",
      tabId,
      message: "该 Claude 标签页已绑定到另一个侧栏实例"
    });
    previousPanel.boundTabId = null;
    previousPanel.lease = null;
    post(writer.port, { type: "DETACH", lease: writer.lease, reason: "lease_replaced" });
  }

  const lease = randomId("lease");
  panel.boundTabId = tabId;
  panel.lease = lease;
  panel.windowId = tab.windowId;
  writer.ownerPanel = panel;
  writer.lease = lease;

  post(writer.port, { type: "ATTACH", lease });
  post(panel.port, {
    type: "BIND_RESULT",
    ok: true,
    bindRequestId,
    tabId,
    windowId: tab.windowId,
    active: tab.active,
    lease,
    writerSession: writer.writerSession ?? null,
    targetEpoch: writer.lastState?.targetEpoch ?? 0,
    composerReady: Boolean(writer.lastState?.composerReady),
    currentText: writer.lastState?.currentText ?? "",
    pluginOwned: Boolean(writer.lastState?.pluginOwned),
    strategy: writer.lastState?.strategy ?? null,
    requiresFocusWrite: Boolean(writer.lastState?.requiresFocusWrite)
  });
}

async function isBoundTabActive(panel) {
  if (!panel.boundTabId || !Number.isInteger(panel.windowId)) return false;
  try {
    const [[activeTab], targetWindow] = await Promise.all([
      chrome.tabs.query({ active: true, windowId: panel.windowId }),
      typeof chrome.windows?.get === "function"
        ? chrome.windows.get(panel.windowId)
        : Promise.resolve(null)
    ]);
    // “Active tab” is window-local. In a background Edge window it is still
    // marked active, so require the containing window to be focused as well.
    // A late Provider response must never mutate a conversation the user is no
    // longer looking at; the English preview remains available for a later sync.
    return activeTab?.id === panel.boundTabId && targetWindow?.focused !== false;
  } catch {
    return false;
  }
}

const WRITER_COMMANDS = new Set([
  "WRITE_TARGET",
  "CLEAR_TARGET_IF_OWNED",
  "GET_TARGET_TEXT",
  "SET_BASELINE",
  "START_MANUAL_BIND",
  "REQUEST_WRITER_STATE"
]);

async function handlePanelMessage(panel, message) {
  switch (message?.type) {
    case "PANEL_HELLO": {
      panel.windowId = Number.isInteger(message.windowId) ? message.windowId : null;
      post(panel.port, { type: "PANEL_READY" });
      break;
    }
    case "BIND_TAB": {
      if (Number.isInteger(message.tabId)) {
        panel.bindGeneration += 1;
        panel.bindRequestId = typeof message.bindRequestId === "string" && message.bindRequestId
          ? message.bindRequestId
          : randomId("bind");
        panel.desiredTabId = message.tabId;
        await bindPanelToTab(panel, message.tabId, {
          generation: panel.bindGeneration,
          bindRequestId: panel.bindRequestId
        });
      }
      break;
    }
    case "UNBIND": {
      panel.bindGeneration += 1;
      panel.bindRequestId = null;
      panel.desiredTabId = null;
      detachPanel(panel, "user_unbind");
      post(panel.port, { type: "UNBOUND" });
      break;
    }
    default: {
      if (!WRITER_COMMANDS.has(message?.type)) return;
      const writer = panel.boundTabId ? writers.get(panel.boundTabId) : null;
      if (!writer || writer.ownerPanel !== panel || writer.lease !== panel.lease) {
        post(panel.port, {
          type: `${message.type}_RESULT`,
          requestId: message.requestId,
          ok: false,
          code: "target_unavailable",
          message: "目标 Claude 标签页未连接"
        });
        return;
      }

      if (Number.isFinite(message.deadline) && Date.now() > message.deadline) {
        post(panel.port, {
          type: `${message.type}_RESULT`,
          requestId: message.requestId,
          ok: false,
          code: "command_expired",
          message: "Claude 写入命令已过期，未执行",
          tabId: panel.boundTabId,
          writerSession: writer.writerSession,
          targetEpoch: writer.lastState?.targetEpoch ?? null
        });
        return;
      }

      if (Number.isInteger(message.expectedTabId) && message.expectedTabId !== panel.boundTabId) {
        post(panel.port, {
          type: `${message.type}_RESULT`,
          requestId: message.requestId,
          ok: false,
          code: "target_changed",
          message: "翻译期间绑定的 Claude 标签页已变化"
        });
        return;
      }

      if (
        message.expectedWriterSession
        && writer.writerSession
        && message.expectedWriterSession !== writer.writerSession
      ) {
        post(panel.port, {
          type: `${message.type}_RESULT`,
          requestId: message.requestId,
          ok: false,
          code: "writer_session_changed",
          message: "翻译期间 Claude 页面会话已变化"
        });
        return;
      }

      if (message.type !== "REQUEST_WRITER_STATE") {
        const active = await isBoundTabActive(panel);
        if (!active) {
          post(panel.port, {
            type: `${message.type}_RESULT`,
            requestId: message.requestId,
            ok: false,
            code: "target_inactive",
            message: "已绑定的 Claude 标签页当前不在前台"
          });
          return;
        }
      }

      post(writer.port, {
        ...message,
        lease: panel.lease
      });
    }
  }
}

function registerPanel(port) {
  const panel = {
    port,
    windowId: null,
    boundTabId: null,
    desiredTabId: null,
    lease: null,
    bindGeneration: 0,
    bindRequestId: null
  };
  panels.add(panel);

  port.onMessage.addListener((message) => {
    void handlePanelMessage(panel, message);
  });
  port.onDisconnect.addListener(() => {
    detachPanel(panel, "panel_closed");
    panels.delete(panel);
  });
}

function registerWriter(port) {
  const tabId = port.sender?.tab?.id;
  if (!Number.isInteger(tabId)) {
    port.disconnect();
    return;
  }

  const previous = writers.get(tabId);
  const writer = {
    port,
    tabId,
    documentId: port.sender?.documentId ?? null,
    writerSession: null,
    lastState: null,
    ownerPanel: previous?.ownerPanel ?? null,
    lease: previous?.lease ?? null
  };

  // Publish the replacement before disconnecting the stale port. This makes
  // the old onDisconnect handler observe the new writer and prevents it from
  // clearing a lease that has already been transferred to the replacement.
  writers.set(tabId, writer);
  if (previous && previous.port !== port) {
    try {
      previous.port.disconnect();
    } catch {
      // Ignore stale port cleanup failures.
    }
  }
  const waitingPanel = [...panels].find(
    (panel) => panel.boundTabId === tabId && !panel.lease
  ) ?? null;

  port.onMessage.addListener((message) => {
    if (writers.get(tabId)?.port !== port) return;
    if (message?.writerSession) writer.writerSession = message.writerSession;
    if (message?.type === "WRITER_HELLO") {
      writer.writerSession = message.writerSession ?? null;
      writer.lastState = message.state ?? null;
      if (writer.ownerPanel && writer.lease) {
        post(port, { type: "ATTACH", lease: writer.lease });
      } else if (waitingPanel && panels.has(waitingPanel) && waitingPanel.boundTabId === tabId) {
        void bindPanelToTab(waitingPanel, tabId, {
          generation: waitingPanel.bindGeneration,
          bindRequestId: waitingPanel.bindRequestId
        });
      }
    } else if (message?.type === "WRITER_STATE") {
      writer.writerSession = message.writerSession ?? writer.writerSession;
      writer.lastState = message.state ?? writer.lastState;
    }

    notifyWriterOwner(writer, {
      ...message,
      tabId,
      documentId: writer.documentId
    });
  });

  port.onDisconnect.addListener(() => {
    if (writers.get(tabId)?.port !== port) return;
    writers.delete(tabId);
    if (writer.ownerPanel) {
      // Preserve the desired tab binding across a normal page reload or MV3
      // content-script reconnect. A fresh writer will receive a new lease.
      writer.ownerPanel.lease = null;
      post(writer.ownerPanel.port, {
        type: "TARGET_UNAVAILABLE",
        tabId,
        recoverable: true,
        message: "Claude 页面连接已断开，正在等待自动恢复"
      });
    }
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "zh2en-panel") registerPanel(port);
  else if (port.name === "zh2en-writer") registerWriter(port);
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  for (const panel of panels) {
    if (panel.windowId !== windowId) continue;
    post(panel.port, {
      type: "ACTIVE_TAB_CHANGED",
      activeTabId: tabId,
      boundTabId: panel.boundTabId,
      isBoundActive: panel.boundTabId === tabId
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const writer = writers.get(tabId);
  if (writer?.ownerPanel) {
    post(writer.ownerPanel.port, {
      type: "TARGET_UNAVAILABLE",
      tabId,
      message: "已绑定的 Claude 标签页已关闭"
    });
    writer.ownerPanel.boundTabId = null;
    writer.ownerPanel.desiredTabId = null;
    writer.ownerPanel.lease = null;
  }
  writers.delete(tabId);
});
