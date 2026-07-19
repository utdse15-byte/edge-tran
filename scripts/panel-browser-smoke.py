#!/usr/bin/env python3
"""Minimal browser smoke test for panel.html with a mocked extension API."""

from pathlib import Path
import re
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

CHROME_MOCK = r"""
(() => {
  const local = new Map();
  const session = new Map();
  const makeArea = (map) => ({
    async setAccessLevel() {},
    async get(keys) {
      const requested = keys == null ? [...map.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((key) => map.has(key)).map((key) => [key, structuredClone(map.get(key))]));
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) map.set(key, structuredClone(value));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key);
    }
  });

  const portMessageListeners = [];
  const portDisconnectListeners = [];
  const port = {
    onMessage: { addListener(fn) { portMessageListeners.push(fn); } },
    onDisconnect: { addListener(fn) { portDisconnectListeners.push(fn); } },
    postMessage(message) {
      const emit = (payload) => queueMicrotask(() => portMessageListeners.forEach((fn) => fn(structuredClone(payload))));
      if (message.type === 'PANEL_HELLO') emit({ type: 'PANEL_READY' });
      if (message.type === 'BIND_TAB') emit({
        type: 'BIND_RESULT', ok: true, tabId: message.tabId, windowId: 1,
        active: true, writerSession: 'writer_smoke', targetEpoch: 0,
        composerReady: true, currentText: '', pluginOwned: false,
        strategy: null, requiresFocusWrite: true
      });
      if (message.type === 'REQUEST_WRITER_STATE') emit({
        type: 'REQUEST_WRITER_STATE_RESULT', requestId: message.requestId, ok: true,
        tabId: 1, writerSession: 'writer_smoke', targetEpoch: 0,
        state: { composerReady: true, currentText: '', targetEpoch: 0, pluginOwned: false, requiresFocusWrite: true }
      });
    },
    disconnect() { portDisconnectListeners.forEach((fn) => fn()); }
  };

  window.__chromeState = { local, session, portMessageListeners };
  window.chrome = {
    runtime: { id: 'panel-smoke', connect() { return port; } },
    storage: { local: makeArea(local), session: makeArea(session) },
    tabs: {
      async query() { return [{ id: 1, windowId: 1, active: true, url: 'https://claude.ai/new' }]; }
    },
    permissions: {
      async contains() { return false; },
      async request() { return true; },
      async remove() { return true; }
    }
  };
})();
"""


def build_test_bundle() -> str:
    # The production extension uses native ES modules. For this isolated smoke
    # test we concatenate the already syntax-checked modules so Chromium can run
    # the panel from an about:blank document without network navigation.
    order = [
        "lib/shared.js",
        "lib/storage.js",
        "lib/provider.js",
        "lib/placeholders.js",
        "lib/validation.js",
        "lib/translator.js",
        "panel.js",
    ]
    chunks = []
    for relative in order:
        source = (ROOT / relative).read_text(encoding="utf-8")
        source = re.sub(
            r'^import\s*\{[\s\S]*?\}\s*from\s*"[^"]+";\s*',
            "",
            source,
            flags=re.M,
        )
        source = re.sub(
            r'\bexport\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)',
            "",
            source,
        )
        chunks.append(f"// {relative}\n{source}")
    return "\n".join(chunks)


html = (ROOT / "panel.html").read_text(encoding="utf-8")
css = (ROOT / "panel.css").read_text(encoding="utf-8")
html = re.sub(r'<link rel="stylesheet" href="panel\.css">', f"<style>{css}</style>", html)
html = re.sub(r'\s*<script type="module" src="panel\.js"></script>\s*', "", html)
TEST_BUNDLE = build_test_bundle()

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        executable_path="/usr/bin/chromium",
        args=["--no-sandbox"],
    )
    page = browser.new_page(viewport={"width": 520, "height": 900})
    page_errors = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.set_content(html)
    page.evaluate(CHROME_MOCK)
    page.add_script_tag(content=TEST_BUNDLE)
    page.wait_for_function("document.querySelector('#targetLabel')?.textContent === '已绑定当前 Claude 标签页'")

    assert not page.locator("#sourceText").is_disabled()
    assert page.locator("#targetLabel").inner_text() == "已绑定当前 Claude 标签页"
    assert page.locator("#providerSummary").inner_text() == "OpenAI · 未选模型 · 单次双译"

    page.locator("#settingsButton").click()
    assert page.locator("#settingsDialog").evaluate("(element) => element.open") is True
    assert page.locator("#baseUrl").input_value() == "https://api.openai.com/v1"
    assert page.locator("#backTranslationMode").input_value() == "same_request"
    assert not page.locator("#independentBackSettings").is_visible()
    page.locator("#settingsDialog .close-dialog").first.click()

    page.locator("#sourceText").fill("你好，保留 👨‍👩‍👧‍👦")
    page.wait_for_timeout(250)
    assert page.locator("#sourceCount").inner_text() == "13"
    assert page.locator("#statusBar").inner_text() == "等待翻译…"
    assert page_errors == [], page_errors

    browser.close()

print("Panel browser smoke: PASS")
