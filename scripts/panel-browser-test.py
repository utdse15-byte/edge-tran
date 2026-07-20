#!/usr/bin/env python3
"""Browser-level state-machine checks for panel.js with mocked extension APIs."""
from __future__ import annotations

import os
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CHROMIUM = os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium")

MOCK_EXTENSION = r"""
(() => {
  const local = new Map();
  const session = new Map();
  const initialSettings = {
    autoSync: true,
    debounceMs: 200,
    sentenceEndDelayMs: 40,
    backTranslationMode: 'same_request',
    backTranslateDelayMs: 300,
    longTextThreshold: 2000,
    requestTimeoutMs: 5000,
    writeIdleGuardMs: 80,
    allowFocusWrite: false,
    protectedTerms: []
  };
  const initialProvider = {
    preset: 'custom',
    name: 'Mock Provider',
    baseUrl: 'https://provider.example/v1',
    keyStorage: 'local',
    authHeader: 'Authorization',
    authPrefix: 'Bearer',
    modelTranslate: 'mock-translate',
    modelBackTranslate: 'mock-back',
    extraHeaders: {},
    capabilities: { jsonMode: true, temperature: false }
  };
  local.set('zh2en.settings.v1', initialSettings);
  local.set('zh2en.provider.v1', initialProvider);
  local.set('zh2en.secret.local.v1', 'mock-key');

  const storageChangeListeners = [];
  function sameStoredValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  function emitStorageChanges(changes, areaName) {
    if (!Object.keys(changes).length) return;
    queueMicrotask(() => {
      for (const listener of [...storageChangeListeners]) {
        listener(structuredClone(changes), areaName);
      }
    });
  }
  function makeStorageArea(map, areaName) {
    return {
      async setAccessLevel() {},
      async get(keys) {
        const requested = keys == null
          ? [...map.keys()]
          : Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(requested.filter(key => map.has(key)).map(key => [key, structuredClone(map.get(key))]));
      },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          const oldValue = map.has(key) ? structuredClone(map.get(key)) : undefined;
          const newValue = structuredClone(value);
          map.set(key, newValue);
          if (!sameStoredValue(oldValue, newValue)) changes[key] = { oldValue, newValue };
        }
        emitStorageChanges(changes, areaName);
      },
      async remove(keys) {
        const changes = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (!map.has(key)) continue;
          changes[key] = { oldValue: structuredClone(map.get(key)) };
          map.delete(key);
        }
        emitStorageChanges(changes, areaName);
      }
    };
  }
  const localArea = makeStorageArea(local, 'local');
  const sessionArea = makeStorageArea(session, 'session');

  const panelMessageListeners = [];
  const disconnectListeners = [];
  const writer = {
    tabId: 42,
    session: 'writer-mock-1',
    epoch: 0,
    text: '',
    pluginOwned: false,
    nextWriteMode: 'normal',
    nextClearMode: 'normal',
    writes: [],
    clears: [],
    forcedClears: []
  };

  function emit(message) {
    for (const listener of [...panelMessageListeners]) listener(structuredClone(message));
  }

  function writerState(reason = 'mock') {
    return {
      type: 'WRITER_STATE',
      tabId: writer.tabId,
      writerSession: writer.session,
      reason,
      state: {
        composerReady: true,
        currentText: writer.text,
        targetEpoch: writer.epoch,
        pluginOwned: writer.pluginOwned,
        strategy: 'mock-native'
      }
    };
  }

  const port = {
    onMessage: { addListener(listener) { panelMessageListeners.push(listener); } },
    onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
    disconnect() { for (const listener of [...disconnectListeners]) listener(); },
    postMessage(message) {
      const respond = response => queueMicrotask(() => emit({ ...response, tabId: writer.tabId }));
      if (message.type === 'PANEL_HELLO') {
        respond({ type: 'PANEL_READY' });
        return;
      }
      if (message.type === 'BIND_TAB') {
        respond({
          type: 'BIND_RESULT', ok: true, tabId: writer.tabId, windowId: 9,
          bindRequestId: message.bindRequestId,
          active: true, lease: 'lease-mock', writerSession: writer.session,
          targetEpoch: writer.epoch, composerReady: true, currentText: writer.text,
          pluginOwned: writer.pluginOwned, strategy: 'mock-native'
        });
        return;
      }
      if (message.type === 'WRITE_TARGET') {
        writer.writes.push(structuredClone(message));
        if (Date.now() > message.deadline) {
          respond({
            type: 'WRITE_TARGET_RESULT', requestId: message.requestId, ok: false,
            code: 'command_expired', writerSession: writer.session, targetEpoch: writer.epoch
          });
          return;
        }
        if (message.expectedWriterSession !== writer.session || message.expectedTargetEpoch !== writer.epoch) {
          respond({
            type: 'WRITE_TARGET_RESULT', requestId: message.requestId, ok: false,
            code: 'target_epoch_changed', writerSession: writer.session, targetEpoch: writer.epoch
          });
          return;
        }
        if (writer.nextWriteMode === 'manual') {
          writer.nextWriteMode = 'normal';
          writer.epoch += 1;
          writer.text = 'human edit';
          writer.pluginOwned = false;
          queueMicrotask(() => emit({
            type: 'TARGET_MANUAL_EDIT', tabId: writer.tabId,
            writerSession: writer.session, targetEpoch: writer.epoch, text: writer.text
          }));
          respond({
            type: 'WRITE_TARGET_RESULT', requestId: message.requestId, ok: false,
            code: 'manual_edit', writerSession: writer.session, targetEpoch: writer.epoch
          });
          return;
        }
        writer.text = String(message.text || '');
        writer.pluginOwned = true;
        writer.epoch += 1;
        respond({
          type: 'WRITE_TARGET_RESULT', requestId: message.requestId, ok: true,
          writerSession: writer.session, targetEpoch: writer.epoch,
          readback: writer.text, strategy: 'mock-native', focusUsed: false
        });
        queueMicrotask(() => emit(writerState('plugin_write')));
        return;
      }
      if (message.type === 'CLEAR_TARGET_FORCE') {
        writer.forcedClears.push(structuredClone(message));
        if (message.expectedWriterSession !== writer.session || message.expectedTargetEpoch !== writer.epoch) {
          respond({
            type: 'CLEAR_TARGET_FORCE_RESULT', requestId: message.requestId, ok: false,
            code: 'target_epoch_changed', writerSession: writer.session, targetEpoch: writer.epoch
          });
          return;
        }
        writer.text = '';
        writer.pluginOwned = false;
        writer.epoch += 1;
        respond({
          type: 'CLEAR_TARGET_FORCE_RESULT', requestId: message.requestId, ok: true,
          writerSession: writer.session, targetEpoch: writer.epoch,
          strategy: 'mock-native', focusUsed: false
        });
        queueMicrotask(() => emit(writerState('user_forced_clear')));
        return;
      }
      if (message.type === 'CLEAR_TARGET_IF_OWNED') {
        writer.clears.push(structuredClone(message));
        if (message.expectedWriterSession !== writer.session || message.expectedTargetEpoch !== writer.epoch) {
          respond({
            type: 'CLEAR_TARGET_IF_OWNED_RESULT', requestId: message.requestId, ok: false,
            code: 'target_epoch_changed', writerSession: writer.session, targetEpoch: writer.epoch
          });
          return;
        }
        if (!writer.pluginOwned) {
          respond({
            type: 'CLEAR_TARGET_IF_OWNED_RESULT', requestId: message.requestId, ok: false,
            code: 'not_plugin_owned', writerSession: writer.session, targetEpoch: writer.epoch
          });
          return;
        }
        if (writer.nextClearMode === 'manual') {
          writer.nextClearMode = 'normal';
          writer.text = 'human edit during clear';
          writer.pluginOwned = false;
          writer.epoch += 1;
          queueMicrotask(() => emit({
            type: 'TARGET_WRITE_RECOVERY_FAILED', tabId: writer.tabId,
            writerSession: writer.session, targetEpoch: writer.epoch, text: writer.text
          }));
          respond({
            type: 'CLEAR_TARGET_IF_OWNED_RESULT', requestId: message.requestId, ok: false,
            code: 'clear_failed_not_restored', writerSession: writer.session,
            targetEpoch: writer.epoch, focusUsed: false
          });
          return;
        }
        writer.text = '';
        writer.pluginOwned = false;
        writer.epoch += 1;
        respond({
          type: 'CLEAR_TARGET_IF_OWNED_RESULT', requestId: message.requestId, ok: true,
          writerSession: writer.session, targetEpoch: writer.epoch,
          strategy: 'mock-native', focusUsed: false
        });
        queueMicrotask(() => emit(writerState('stale_target_cleared')));
        return;
      }
      if (message.type === 'GET_TARGET_TEXT') {
        respond({
          type: 'GET_TARGET_TEXT_RESULT', requestId: message.requestId, ok: true,
          writerSession: writer.session, targetEpoch: writer.epoch,
          text: writer.text, pluginOwned: writer.pluginOwned
        });
        return;
      }
      if (message.type === 'SET_BASELINE') {
        respond({
          type: 'SET_BASELINE_RESULT', requestId: message.requestId, ok: true,
          writerSession: writer.session, targetEpoch: writer.epoch, text: writer.text
        });
        return;
      }
      if (message.type === 'REQUEST_WRITER_STATE') {
        queueMicrotask(() => emit(writerState('requested')));
        respond({
          type: 'REQUEST_WRITER_STATE_RESULT', requestId: message.requestId, ok: true,
          writerSession: writer.session, targetEpoch: writer.epoch,
          state: writerState().state
        });
      }
    }
  };

  window.__mock = {
    local, session, writer, emit,
    async externalSet(areaName, values) {
      return (areaName === 'session' ? sessionArea : localArea).set(values);
    }
  };
  window.confirm = () => true;
  window.chrome = {
    runtime: { id: 'mock-extension', connect() { return port; } },
    storage: {
      local: localArea,
      session: sessionArea,
      onChanged: {
        addListener(listener) { storageChangeListeners.push(listener); },
        removeListener(listener) {
          const index = storageChangeListeners.indexOf(listener);
          if (index >= 0) storageChangeListeners.splice(index, 1);
        }
      }
    },
    permissions: {
      async contains() { return true; },
      async request() { return true; },
      async remove() { return true; }
    },
    tabs: {
      async query() { return [{ id: 42, windowId: 9, active: true, url: 'https://claude.ai/chat/mock' }]; }
    }
  };

  let translationCall = 0;
  window.__mock.translationCalls = 0;
  window.__mock.backCalls = 0;
  window.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    const messages = body.messages || [];
    const system = String(messages[0]?.content || '');
    const user = String(messages.at(-1)?.content || '');
    if (/^Translate the English message into natural Simplified Chinese/i.test(system)) {
      window.__mock.backCalls += 1;
      return new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: `完整中文回译内容：${user}` } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    translationCall += 1;
    window.__mock.translationCalls = translationCall;
    // Keep the second translation in flight long enough for stale cleanup.
    if (translationCall === 2) await new Promise(resolve => setTimeout(resolve, 650));
    const english = user.includes('第三版')
      ? 'Third version.'
      : user.includes('第二版')
        ? 'Second version.'
        : 'First version.';
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: JSON.stringify({ english, back_translation: `回译：${english}`, corrections: [], ambiguous: [] }) }
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
})();
"""


def build_test_bundle() -> str:
    """Concatenate the production ES modules for an isolated about:blank test."""
    order = [
        "lib/shared.js",
        "lib/reasoning.js",
        "lib/storage.js",
        "lib/provider.js",
        "lib/placeholders.js",
        "lib/validation.js",
        "lib/translator.js",
        "panel.js",
    ]
    chunks: list[str] = []
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


def build_panel_html() -> str:
    html = (ROOT / "panel.html").read_text(encoding="utf-8")
    css = (ROOT / "panel.css").read_text(encoding="utf-8")
    html = re.sub(r'<link rel="stylesheet" href="panel\.css">', f"<style>{css}</style>", html)
    return re.sub(r'\s*<script type="module" src="panel\.js"></script>\s*', "", html)


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=CHROMIUM,
            args=["--no-sandbox"],
        )
        page = browser.new_page(viewport={"width": 430, "height": 900})
        page.set_default_timeout(10000)
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on(
            "console",
            lambda message: errors.append(f"console:{message.text}") if message.type == "error" else None,
        )
        page.set_content(build_panel_html())
        page.evaluate(MOCK_EXTENSION)
        page.add_script_tag(content=build_test_bundle())
        page.wait_for_function("document.querySelector('#statusBar').textContent !== ''", timeout=10000)
        page.wait_for_timeout(120)
        assert not page.locator("#sourceText").is_disabled(), errors
        assert "Claude" in page.locator("#targetLabel").inner_text()

        page.locator("#sourceText").fill("第一版")
        page.locator("#translateButton").click()
        page.wait_for_function("document.querySelector('#englishText').value === 'First version.'", timeout=10000)
        page.wait_for_function("window.__mock.writer.text === 'First version.'", timeout=10000)
        page.wait_for_function("document.querySelector('#backText').value === '回译：First version.'", timeout=10000)
        page.wait_for_timeout(320)
        assert page.evaluate("window.__mock.translationCalls") == 1, "manual trigger must cancel pending debounce"
        assert page.evaluate("window.__mock.backCalls") == 0
        assert "已同步" in page.locator("#statusBar").inner_text()
        assert page.evaluate("window.__mock.writer.epoch") == 1

        # v0.2.12: editing the Chinese must NOT auto-delete the old English —
        # the new translation simply replaces the plugin-owned text in place.
        page.locator("#sourceText").fill("第二版。")
        page.wait_for_function("document.querySelector('#englishText').value === 'Second version.'", timeout=10000)
        page.wait_for_function("window.__mock.writer.text === 'Second version.'", timeout=10000)
        assert page.evaluate("window.__mock.writer.clears.length") == 0, \
            "no automatic clear may ever run"
        writes = page.evaluate("window.__mock.writer.writes")
        assert writes[-1]["expectedTargetEpoch"] == 1, writes
        assert page.evaluate("window.__mock.writer.epoch") == 2
        assert "已同步" in page.locator("#statusBar").inner_text()
        assert page.evaluate("window.__mock.backCalls") == 0

        # Switch to the optional independent mode. Its real connection test must
        # exercise both the primary and the separately selected back model.
        page.locator("#settingsButton").click()
        page.locator("#apiKey").fill("new-mock-key")
        page.locator("#backTranslationMode").select_option("independent")
        assert page.locator("#independentBackSettings").is_visible()
        page.locator("#modelBackTranslate").fill("mock-back")
        page.locator("#testProviderButton").click()
        page.wait_for_function("document.querySelector('#providerTestResult').textContent.includes('通过')", timeout=10000)
        assert page.evaluate("window.__mock.backCalls") == 1
        assert "回译" in page.locator("#providerTestResult").inner_text()
        page.locator("#settingsForm button[type='submit']").click()
        page.wait_for_function("!document.querySelector('#settingsDialog').open", timeout=10000)
        saved_secret = page.evaluate("window.__mock.local.get('zh2en.secret.local.v1')")
        saved_provider = page.evaluate("window.__mock.local.get('zh2en.provider.v1')")
        assert saved_secret["value"] == "new-mock-key"
        assert saved_secret["credentialId"] == saved_provider["credentialId"]
        assert saved_secret["providerBinding"], saved_secret
        page.wait_for_timeout(180)
        assert page.locator("#pauseButton").inner_text() == "暂停", page.locator("#statusBar").inner_text()
        assert "独立回译" in page.locator("#providerSummary").inner_text()

        page.locator("#sourceText").fill("第三版")
        page.locator("#translateButton").click()
        page.wait_for_function("document.querySelector('#englishText').value === 'Third version.'", timeout=10000)
        page.wait_for_function("window.__mock.writer.text === 'Third version.'", timeout=10000)
        page.wait_for_function("document.querySelector('#backText').value === '完整中文回译内容：Third version.'", timeout=10000)
        assert page.evaluate("window.__mock.backCalls") == 2
        assert page.locator("#backBadge").inner_text() == "独立"

        # Regression: event arrives first, then the failed request result. The
        # later response must not erase the stronger manual-edit safety state.
        page.evaluate("window.__mock.writer.nextWriteMode = 'manual'")
        page.locator("#syncButton").click()
        page.wait_for_function("!document.querySelector('#manualBanner').classList.contains('hidden')", timeout=10000)
        page.wait_for_timeout(120)
        assert "人工修改" in page.locator("#statusBar").inner_text()
        assert "hidden" not in (page.locator("#manualBanner").get_attribute("class") or "").split()

        # Regression: after the explicit overwrite confirmation, the ordinary
        # sync button must be able to reclaim a manually edited target. The old
        # guard rejected every manual-phase write even when force=true.
        writes_before_reclaim = page.evaluate("window.__mock.writer.writes.length")
        page.locator("#syncButton").click()
        page.wait_for_function("window.__mock.writer.text === 'Third version.'", timeout=10000)
        assert page.evaluate("window.__mock.writer.writes.length") == writes_before_reclaim + 1
        assert page.evaluate("window.__mock.writer.writes.at(-1).force") is True
        assert page.locator("#manualBanner").get_attribute("class") and "hidden" in page.locator("#manualBanner").get_attribute("class").split()
        assert "已同步" in page.locator("#statusBar").inner_text()

        # Re-enter manual mode so the following clear regression verifies that
        # stale controls are removed when the page becomes empty.
        page.evaluate("""
          window.__mock.writer.text = 'second human edit';
          window.__mock.writer.pluginOwned = false;
          window.__mock.writer.epoch += 1;
          window.__mock.emit({
            type: 'TARGET_MANUAL_EDIT', tabId: window.__mock.writer.tabId,
            writerSession: window.__mock.writer.session,
            targetEpoch: window.__mock.writer.epoch, text: window.__mock.writer.text
          });
        """)
        page.wait_for_function("!document.querySelector('#manualBanner').classList.contains('hidden')", timeout=10000)

        # An external clear must remove the stale manual-edit banner rather than
        # leaving controls that refer to text no longer present in Claude.
        page.evaluate("""
          window.__mock.writer.text = '';
          window.__mock.writer.pluginOwned = false;
          window.__mock.writer.epoch += 1;
          window.__mock.emit({
            type: 'TARGET_CLEARED', tabId: window.__mock.writer.tabId,
            writerSession: window.__mock.writer.session,
            targetEpoch: window.__mock.writer.epoch
          });
        """)
        page.wait_for_function("document.querySelector('#manualBanner').classList.contains('hidden')")

        # Resume and put the current English back under plugin ownership, then
        # reproduce a clear transaction that fails after a real page mutation.
        # Clearing the side-panel draft must preserve the stronger manual/pause
        # safety state instead of claiming the Claude target is empty.
        page.locator("#pauseButton").click()
        page.locator("#syncButton").click()
        page.wait_for_function("window.__mock.writer.pluginOwned === true", timeout=10000)
        page.evaluate("window.__mock.writer.nextClearMode = 'manual'")
        page.locator("#clearDraftButton").click()
        page.wait_for_function("document.querySelector('#sourceText').value === ''", timeout=10000)
        page.wait_for_function("!document.querySelector('#manualBanner').classList.contains('hidden')", timeout=10000)
        assert page.evaluate("window.__mock.writer.text") == "human edit during clear"
        assert page.locator("#pauseButton").inner_text() == "恢复"
        assert "仍有内容" in page.locator("#statusBar").inner_text()

        # A save from another Edge window receives a new credential generation.
        # The current panel must invalidate in-flight work and adopt the new
        # configuration rather than combining that external key with a cached
        # Provider snapshot. (The panel is still review-paused here from the
        # manual banner above; adoption must not silently lift that pause.)
        current_provider = page.evaluate("window.__mock.local.get('zh2en.provider.v1')")
        current_secret = page.evaluate("window.__mock.local.get('zh2en.secret.local.v1')")
        external_provider = {
            **current_provider,
            "name": "External Provider",
            "credentialId": "credential_external_window",
        }
        external_secret = {
            **current_secret,
            "value": "external-window-key",
            "credentialId": "credential_external_window",
            "updatedAt": current_secret.get("updatedAt", 0) + 1000,
        }
        page.evaluate(
            "([provider, secret]) => window.__mock.externalSet('local', {"
            "'zh2en.provider.v1': provider, 'zh2en.secret.local.v1': secret})",
            [external_provider, external_secret],
        )
        page.wait_for_function(
            "document.querySelector('#providerSummary').textContent.includes('External Provider')",
            timeout=10000,
        )
        page.wait_for_function(
            "document.querySelector('#statusBar').textContent.includes('另一个窗口')",
            timeout=10000,
        )
        assert page.locator("#pauseButton").inner_text() == "恢复"

        # Exercise the real key-clear path. This catches missing imports or
        # storage regressions that syntax checks cannot detect.
        page.locator("#settingsButton").click()
        page.locator("#clearKeyButton").click()
        page.wait_for_function("!window.__mock.local.has('zh2en.secret.local.v1')", timeout=10000)
        assert not page.evaluate("window.__mock.session.has('zh2en.secret.session.v1')")

        assert errors == [], errors

        # A second isolated panel simulates another Edge window changing the
        # Provider and credential generation. The active panel must adopt the
        # new configuration WITHOUT forcing a manual 恢复 (v0.2.11), and never
        # expose the new key to its stale Provider snapshot.
        cross_page = browser.new_page(viewport={"width": 430, "height": 900})
        cross_errors: list[str] = []
        cross_page.on("pageerror", lambda error: cross_errors.append(str(error)))
        cross_page.on(
            "console",
            lambda message: cross_errors.append(f"console:{message.text}") if message.type == "error" else None,
        )
        cross_page.set_content(build_panel_html())
        cross_page.evaluate(MOCK_EXTENSION)
        cross_page.add_script_tag(content=build_test_bundle())
        cross_page.wait_for_function("document.querySelector('#statusBar').textContent !== ''", timeout=10000)
        cross_page.wait_for_timeout(120)
        cross_page.evaluate("""
          window.__mock.staleProvider = structuredClone(window.__mock.local.get('zh2en.provider.v1'));
          const nextProvider = {
            ...window.__mock.staleProvider,
            name: 'External Provider',
            baseUrl: 'https://other-provider.example/v1',
            credentialId: 'credential_external_1'
          };
          const nextSecret = {
            version: 1,
            value: 'external-key',
            credentialId: nextProvider.credentialId,
            providerBinding: providerCredentialBinding(nextProvider),
            updatedAt: Date.now()
          };
          window.__mock.externalSet('local', {
            'zh2en.provider.v1': nextProvider,
            'zh2en.secret.local.v1': nextSecret
          });
        """)
        cross_page.wait_for_function(
            "document.querySelector('#statusBar').textContent.includes('另一个窗口')",
            timeout=10000,
        )
        # v0.2.11: external configuration is adopted and automation continues —
        # no forced manual 恢复 for a change the user made themselves.
        assert cross_page.locator("#pauseButton").inner_text() == "暂停"
        assert "External Provider" in cross_page.locator("#providerSummary").inner_text()
        assert cross_page.evaluate("getSecretForProvider(window.__mock.staleProvider)") == ""
        assert cross_page.evaluate(
            "getSecretForProvider(window.__mock.local.get('zh2en.provider.v1'))"
        ) == "external-key"
        assert cross_errors == [], cross_errors
        cross_page.close()

        # Stability regressions: (1) an ordinary conversation switch with no
        # plugin-owned content must not force a manual 恢复; (2) an abort while
        # a translation is in flight must re-enable 立即翻译; (3) a recoverable
        # target loss must auto-resume once the automatic re-bind succeeds.
        stability_page = browser.new_page(viewport={"width": 430, "height": 900})
        stability_errors: list[str] = []
        stability_page.on("pageerror", lambda error: stability_errors.append(str(error)))
        stability_page.on(
            "console",
            lambda message: stability_errors.append(f"console:{message.text}") if message.type == "error" else None,
        )
        stability_page.set_content(build_panel_html())
        stability_page.evaluate(MOCK_EXTENSION)
        stability_page.add_script_tag(content=build_test_bundle())
        stability_page.wait_for_function("document.querySelector('#statusBar').textContent !== ''", timeout=10000)
        stability_page.wait_for_timeout(150)

        # (1) Conversation switch before anything was synced: no forced pause.
        # The real writer always follows WRITER_SESSION_CHANGED with a fresh
        # WRITER_STATE from the rebound composer; mirror that here.
        stability_page.evaluate("""
          window.__mock.writer.session = 'writer-mock-2';
          window.__mock.writer.epoch = 0;
          window.__mock.emit({
            type: 'WRITER_SESSION_CHANGED', tabId: window.__mock.writer.tabId,
            writerSession: 'writer-mock-2', targetEpoch: 0
          });
          window.__mock.emit({
            type: 'WRITER_STATE', tabId: window.__mock.writer.tabId,
            writerSession: window.__mock.writer.session, reason: 'navigation_rebound',
            state: {
              composerReady: true, currentText: window.__mock.writer.text,
              targetEpoch: window.__mock.writer.epoch,
              pluginOwned: window.__mock.writer.pluginOwned, strategy: 'mock-native'
            }
          });
        """)
        stability_page.wait_for_timeout(150)
        assert stability_page.locator("#pauseButton").inner_text() == "暂停", \
            stability_page.locator("#statusBar").inner_text()

        # (2) Slow down translations, pause mid-flight, and confirm the button
        # comes back immediately instead of staying disabled forever.
        stability_page.evaluate("""
          const originalFetch = window.fetch;
          window.fetch = async (...args) => {
            await new Promise(resolve => setTimeout(resolve, 700));
            return originalFetch(...args);
          };
        """)
        stability_page.locator("#sourceText").fill("第一版")
        stability_page.locator("#translateButton").click()
        stability_page.wait_for_function(
            "document.querySelector('#translateButton').disabled === true", timeout=10000
        )
        stability_page.locator("#sourceText").press("Escape")
        stability_page.wait_for_function(
            "document.querySelector('#translateButton').disabled === false", timeout=10000
        )
        assert stability_page.locator("#pauseButton").inner_text() == "恢复"
        # Esc is one-way now: a second press must NOT resume automation.
        stability_page.locator("#sourceText").press("Escape")
        assert stability_page.locator("#pauseButton").inner_text() == "恢复", \
            "Esc must never re-arm automation"
        # Resume via the explicit button: the aborted draft has no current
        # English, so this schedules a fresh translation that completes+syncs.
        stability_page.locator("#pauseButton").click()
        stability_page.wait_for_function(
            "document.querySelector('#englishText').value === 'First version.'", timeout=10000
        )
        stability_page.wait_for_function("window.__mock.writer.text === 'First version.'", timeout=10000)

        # (3) Recoverable writer loss: pause, automatic re-bind, auto-resume.
        stability_page.evaluate("""
          window.__mock.emit({
            type: 'TARGET_UNAVAILABLE', tabId: window.__mock.writer.tabId,
            recoverable: true, message: 'Claude 页面连接已断开，正在等待自动恢复'
          });
        """)
        stability_page.wait_for_function(
            "document.querySelector('#pauseButton').textContent === '暂停'", timeout=10000
        )
        assert "已绑定" in stability_page.locator("#statusBar").inner_text() \
            or "输入框" in stability_page.locator("#statusBar").inner_text(), \
            stability_page.locator("#statusBar").inner_text()

        # Speed regressions: a normalized-equivalent edit (trailing space) must
        # not re-bill a translation, and returning to an already-translated
        # draft must replay from the session cache instead of the Provider.
        calls_before = stability_page.evaluate("window.__mock.translationCalls")
        stability_page.locator("#sourceText").fill("第一版 ")
        stability_page.wait_for_timeout(700)
        assert stability_page.evaluate("window.__mock.translationCalls") == calls_before, \
            "trailing-whitespace edit must not trigger a paid re-translation"
        assert stability_page.evaluate("document.querySelector('#englishText').value") == "First version."

        stability_page.locator("#sourceText").fill("第二版。")
        stability_page.wait_for_function(
            f"window.__mock.translationCalls === {calls_before + 1}", timeout=10000
        )
        stability_page.wait_for_function(
            "document.querySelector('#englishText').value === 'Second version.'", timeout=10000
        )
        stability_page.locator("#sourceText").fill("第一版")
        stability_page.wait_for_function(
            "document.querySelector('#englishText').value === 'First version.'", timeout=10000
        )
        assert stability_page.evaluate("window.__mock.translationCalls") == calls_before + 1, \
            "returning to a cached draft must replay without a Provider request"

        # v0.2.11 pause overhaul: (4) a system pause (external clear) self-heals
        # when the user keeps typing — no 恢复 click required.
        stability_page.evaluate("""
          window.__mock.writer.text = '';
          window.__mock.writer.pluginOwned = false;
          window.__mock.writer.epoch += 1;
          window.__mock.emit({
            type: 'TARGET_CLEARED', tabId: window.__mock.writer.tabId,
            writerSession: window.__mock.writer.session,
            targetEpoch: window.__mock.writer.epoch
          });
        """)
        stability_page.wait_for_function(
            "document.querySelector('#pauseButton').textContent === '恢复'", timeout=10000
        )
        stability_page.locator("#sourceText").fill("第三版。")
        stability_page.wait_for_function(
            "document.querySelector('#pauseButton').textContent === '暂停'", timeout=10000
        )
        stability_page.wait_for_function(
            "document.querySelector('#englishText').value === 'Third version.'", timeout=10000
        )
        stability_page.wait_for_function(
            "window.__mock.writer.text === 'Third version.'", timeout=10000
        )

        # (5) An explicit Esc pause is a user decision: typing must NOT lift it
        # and no auto-translation may fire while it holds.
        stability_page.locator("#sourceText").press("Escape")
        assert stability_page.locator("#pauseButton").inner_text() == "恢复"
        calls_esc = stability_page.evaluate("window.__mock.translationCalls")
        stability_page.locator("#sourceText").fill("第四版。")
        stability_page.wait_for_timeout(700)
        assert stability_page.locator("#pauseButton").inner_text() == "恢复", \
            "typing must not lift a user (Esc) pause"
        assert stability_page.evaluate("window.__mock.translationCalls") == calls_esc, \
            "no auto-translation while user-paused"

        # v0.2.12 zero-delete: (6) foreign text in the composer is adopted
        # QUIETLY (no banner, no pause), nothing is ever auto-deleted, and the
        # explicit 清空输入框 button is the only path that removes it.
        stability_page.locator("#pauseButton").click()
        stability_page.wait_for_function(
            "window.__mock.writer.text === 'First version.'", timeout=10000
        )
        stability_page.evaluate("""
          window.__mock.writer.text = 'my own notes';
          window.__mock.writer.pluginOwned = false;
          window.__mock.writer.epoch += 1;
          window.__mock.emit({
            type: 'WRITER_STATE', tabId: window.__mock.writer.tabId,
            writerSession: window.__mock.writer.session, reason: 'reconcile',
            state: {
              composerReady: true, currentText: window.__mock.writer.text,
              targetEpoch: window.__mock.writer.epoch,
              pluginOwned: false, strategy: 'mock-native'
            }
          });
        """)
        stability_page.wait_for_function(
            "document.querySelector('#statusBar').textContent.includes('已有内容')", timeout=10000
        )
        assert "hidden" in (stability_page.locator("#manualBanner").get_attribute("class") or "").split(), \
            "pre-existing user content must not raise the conflict banner"
        assert stability_page.locator("#pauseButton").inner_text() == "暂停", \
            "pre-existing user content must not pause automation"

        stability_page.locator("#sourceText").fill("第三版。")
        stability_page.wait_for_function(
            "document.querySelector('#statusBar').textContent.includes('未写入')", timeout=10000
        )
        assert stability_page.evaluate("window.__mock.writer.text") == "my own notes", \
            "auto-sync must never delete user content"
        assert stability_page.evaluate("window.__mock.writer.forcedClears.length") == 0

        stability_page.locator("#clearTargetButton").click()
        stability_page.wait_for_function("window.__mock.writer.text === ''", timeout=10000)
        assert stability_page.evaluate("window.__mock.writer.forcedClears.length") == 1
        stability_page.wait_for_function(
            "document.querySelector('#statusBar').textContent.includes('清空')", timeout=10000
        )
        stability_page.locator("#syncButton").click()
        stability_page.wait_for_function(
            "window.__mock.writer.text === 'Third version.'", timeout=10000
        )

        assert stability_errors == [], stability_errors
        stability_page.close()

        browser.close()
    print("panel browser state-machine test: PASS")


if __name__ == "__main__":
    main()
