#!/usr/bin/env python3
"""Browser-level safety checks for writer.js.

Requires Python Playwright and a Chromium executable. This script is intended
for release verification; it never opens claude.ai or uses a real account.
"""
from __future__ import annotations

import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WRITER_JS = (ROOT / "writer.js").read_text(encoding="utf-8")
CHROMIUM = os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium")


def setup(page, kind: str = "contenteditable") -> dict:
    if kind == "contenteditable":
        editor = (
            '<div id="editor" contenteditable="true" role="textbox" '
            'aria-label="Message Claude" style="width:700px;height:120px;border:1px solid"></div>'
        )
    elif kind == "plaintext":
        editor = (
            '<div id="editor" contenteditable="plaintext-only" role="textbox" '
            'aria-label="Message Claude" style="width:700px;height:120px;border:1px solid"></div>'
        )
    else:
        editor = (
            '<textarea id="editor" aria-label="Message Claude" '
            'style="width:700px;height:120px"></textarea>'
        )
    page.set_content(
        "<!doctype html><body>"
        '<div role="textbox" aria-label="Message decoy" '
        'style="width:700px;height:60px;border:1px solid">do not touch</div>'
        '<div style="height:430px"></div>'
        f'<form onsubmit="return false">{editor}'
        '<button id="send" type="button" aria-label="Send message">Send</button></form>'
        "</body>"
    )
    page.evaluate(
        """() => {
          const messages = [];
          const messageListeners = [];
          const disconnectListeners = [];
          const port = {
            postMessage(message) { messages.push(structuredClone(message)); },
            onMessage: { addListener(listener) { messageListeners.push(listener); } },
            onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
            disconnect() { for (const listener of disconnectListeners) listener(); }
          };
          window.__writerHarness = { messages, messageListeners, disconnectListeners };
          window.chrome = { runtime: { id: 'test-extension', connect() { return port; } } };
        }"""
    )
    page.add_script_tag(content=WRITER_JS)
    page.wait_for_timeout(40)
    hello = page.evaluate(
        "window.__writerHarness.messages.find(message => message.type === 'WRITER_HELLO')"
    )
    assert hello, hello
    page.evaluate(
        "message => window.__writerHarness.messageListeners[0](message)",
        {"type": "ATTACH", "lease": "lease-1"},
    )
    page.wait_for_timeout(40)
    attached_state = page.evaluate(
        "window.__writerHarness.messages.findLast(message => message.type === 'WRITER_STATE')"
    )
    assert attached_state and attached_state["state"]["composerReady"], attached_state
    return hello


def send(page, message: dict, wait_ms: int = 100) -> dict:
    page.evaluate(
        "message => window.__writerHarness.messageListeners[0](message)", message
    )
    page.wait_for_timeout(wait_ms)
    result = page.evaluate(
        "requestId => window.__writerHarness.messages.findLast(message => message.requestId === requestId)",
        message.get("requestId"),
    )
    assert result, (message, page.evaluate("window.__writerHarness.messages"))
    return result


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=CHROMIUM,
            args=["--no-sandbox"],
        )

        page = browser.new_page(viewport={"width": 1200, "height": 800})
        hello = setup(page, "contenteditable")
        session = hello["writerSession"]

        expired = send(
            page,
            {
                "type": "WRITE_TARGET",
                "requestId": "expired",
                "lease": "lease-1",
                "text": "must not appear",
                "expectedWriterSession": session,
                "expectedTargetEpoch": 0,
                "allowFocus": True,
                "deadline": 1,
            },
        )
        assert expired["code"] == "command_expired", expired
        assert page.locator("#editor").inner_text() == ""
        assert page.locator('[role="textbox"]:not([contenteditable])').inner_text() == "do not touch"

        no_focus = send(
            page,
            {
                "type": "WRITE_TARGET",
                "requestId": "no-focus",
                "lease": "lease-1",
                "text": "a\nb",
                "expectedWriterSession": session,
                "expectedTargetEpoch": 0,
                "allowFocus": False,
            },
        )
        assert not no_focus["ok"] and no_focus["code"] == "focus_write_disabled", no_focus
        assert page.locator("#editor").inner_text() == ""

        written = send(
            page,
            {
                "type": "WRITE_TARGET",
                "requestId": "write-multiline",
                "lease": "lease-1",
                "text": "a\n\nb",
                "expectedWriterSession": session,
                "expectedTargetEpoch": 0,
                "allowFocus": True,
                "deadline": 2**53 - 1,
            },
        )
        assert written["ok"] and written["readback"] == "a\n\nb", written
        assert written["targetEpoch"] == 1

        no_focus_clear = send(
            page,
            {
                "type": "CLEAR_TARGET_IF_OWNED",
                "requestId": "clear-no-focus",
                "lease": "lease-1",
                "expectedWriterSession": session,
                "expectedTargetEpoch": 1,
                "allowFocus": False,
                "deadline": 2**53 - 1,
            },
        )
        assert no_focus_clear["code"] == "focus_write_disabled", no_focus_clear
        assert send(
            page,
            {"type": "REQUEST_WRITER_STATE", "requestId": "state-1", "lease": "lease-1"},
        )["state"]["currentText"] == "a\n\nb"

        cleared = send(
            page,
            {
                "type": "CLEAR_TARGET_IF_OWNED",
                "requestId": "clear-focus",
                "lease": "lease-1",
                "expectedWriterSession": session,
                "expectedTargetEpoch": 1,
                "allowFocus": True,
                "deadline": 2**53 - 1,
            },
        )
        assert cleared["ok"] and cleared["targetEpoch"] == 2, cleared

        plugin_write = send(
            page,
            {
                "type": "WRITE_TARGET",
                "requestId": "manual-base",
                "lease": "lease-1",
                "text": "plugin",
                "expectedWriterSession": session,
                "expectedTargetEpoch": 2,
                "allowFocus": True,
                "deadline": 2**53 - 1,
            },
        )
        page.locator("#editor").click()
        page.keyboard.press("End")
        page.keyboard.type(" user")
        page.wait_for_timeout(100)
        manual = page.evaluate(
            "window.__writerHarness.messages.findLast(message => message.type === 'TARGET_MANUAL_EDIT')"
        )
        assert manual and manual["text"] == "plugin user", manual
        assert manual["targetEpoch"] > plugin_write["targetEpoch"]

        to_send = send(
            page,
            {
                "type": "WRITE_TARGET",
                "requestId": "navigation-send",
                "lease": "lease-1",
                "text": "to send",
                "expectedWriterSession": session,
                "expectedTargetEpoch": manual["targetEpoch"],
                "allowFocus": True,
                "force": True,
                "deadline": 2**53 - 1,
            },
        )
        assert to_send["ok"], to_send
        page.locator("#send").click()
        # Simulate the common SPA sequence: the old composer is removed while
        # the route changes, and a fresh empty composer appears.
        page.evaluate(
            """() => {
              const oldEditor = document.querySelector('#editor');
              const replacement = document.createElement('div');
              replacement.id = 'editor';
              replacement.contentEditable = 'true';
              replacement.setAttribute('role', 'textbox');
              replacement.setAttribute('aria-label', 'Message Claude');
              replacement.style.cssText = oldEditor.style.cssText;
              oldEditor.replaceWith(replacement);
              location.hash = `conversation-${Date.now()}`;
            }"""
        )
        page.wait_for_timeout(220)
        confirmed = page.evaluate(
            "window.__writerHarness.messages.findLast(message => message.type === 'SEND_CONFIRMED')"
        )
        navigation_messages = page.evaluate("window.__writerHarness.messages")
        assert confirmed and confirmed["sentText"] == "to send", navigation_messages
        navigation_clear_events = [
            message for message in navigation_messages
            if message.get("type") in ("SEND_CONFIRMED", "TARGET_CLEARED")
        ]
        assert [message["type"] for message in navigation_clear_events] == ["SEND_CONFIRMED"], (
            "navigation must reconcile one logical clear exactly once",
            navigation_messages,
        )
        page.close()

        # Chromium and some editor frameworks expose plain-text rich editors as
        # contenteditable="plaintext-only". They must be discoverable anywhere a
        # normal contenteditable composer is supported.
        plaintext_page = browser.new_page(viewport={"width": 1200, "height": 800})
        hello = setup(plaintext_page, "plaintext")
        plaintext_result = send(
            plaintext_page,
            {
                "type": "WRITE_TARGET",
                "requestId": "plaintext-write",
                "lease": "lease-1",
                "text": "plain\ntext",
                "expectedWriterSession": hello["writerSession"],
                "expectedTargetEpoch": 0,
                "allowFocus": True,
                "deadline": 2**53 - 1,
            },
        )
        assert plaintext_result["ok"] and plaintext_result["readback"] == "plain\ntext", plaintext_result
        plaintext_page.close()

        # Claude can replace the composer after a send without changing the URL.
        # The trusted intent must survive the node/epoch transition.
        same_url_page = browser.new_page(viewport={"width": 1200, "height": 800})
        hello = setup(same_url_page, "contenteditable")
        session = hello["writerSession"]
        same_url_write = send(
            same_url_page,
            {
                "type": "WRITE_TARGET",
                "requestId": "same-url-write",
                "lease": "lease-1",
                "text": "same URL send",
                "expectedWriterSession": session,
                "expectedTargetEpoch": 0,
                "allowFocus": True,
                "deadline": 2**53 - 1,
            },
        )
        assert same_url_write["ok"], same_url_write
        same_url_page.locator("#send").click()
        same_url_page.evaluate(
            """() => {
              const oldEditor = document.querySelector('#editor');
              const replacement = oldEditor.cloneNode(false);
              oldEditor.replaceWith(replacement);
            }"""
        )
        same_url_page.wait_for_timeout(220)
        same_url_confirmed = same_url_page.evaluate(
            "window.__writerHarness.messages.findLast(message => message.type === 'SEND_CONFIRMED')"
        )
        assert same_url_confirmed and same_url_confirmed["sentText"] == "same URL send", (
            same_url_page.evaluate("window.__writerHarness.messages")
        )
        same_url_page.close()

        # The same replacement without a trusted send must be reported as an
        # external clear, preserving the Chinese draft instead of silently
        # leaving the panel in a false 'synced' state.
        external_clear_page = browser.new_page(viewport={"width": 1200, "height": 800})
        hello = setup(external_clear_page, "contenteditable")
        session = hello["writerSession"]
        external_write = send(
            external_clear_page,
            {
                "type": "WRITE_TARGET",
                "requestId": "external-clear-write",
                "lease": "lease-1",
                "text": "must be reported",
                "expectedWriterSession": session,
                "expectedTargetEpoch": 0,
                "allowFocus": True,
                "deadline": 2**53 - 1,
            },
        )
        assert external_write["ok"], external_write
        external_clear_page.evaluate(
            """() => {
              const oldEditor = document.querySelector('#editor');
              const replacement = oldEditor.cloneNode(false);
              oldEditor.replaceWith(replacement);
            }"""
        )
        external_clear_page.wait_for_timeout(220)
        external_cleared = external_clear_page.evaluate(
            "window.__writerHarness.messages.findLast(message => message.type === 'TARGET_CLEARED')"
        )
        assert external_cleared and external_cleared["previousText"] == "must be reported", (
            external_clear_page.evaluate("window.__writerHarness.messages")
        )
        assert external_clear_page.evaluate(
            "window.__writerHarness.messages.filter(message => message.type === 'SEND_CONFIRMED').length"
        ) == 0
        external_clear_page.close()

        # Atomic rich-editor descendants (attachments, images, mention/file
        # chips) are not represented reliably by plain-text readback. The
        # writer must refuse both replacement and cleanup rather than selecting
        # across and deleting them.
        attachment_page = browser.new_page(viewport={"width": 1200, "height": 800})
        hello = setup(attachment_page, "contenteditable")
        session = hello["writerSession"]
        attachment_page.evaluate(
            """() => {
              const chip = document.createElement('span');
              chip.contentEditable = 'false';
              chip.dataset.attachment = 'true';
              chip.setAttribute('aria-label', 'attachment report.pdf');
              document.querySelector('#editor').append(chip);
            }"""
        )
        attachment_page.wait_for_timeout(80)
        attachment_write = send(
            attachment_page,
            {
                "type": "WRITE_TARGET",
                "requestId": "attachment-write",
                "lease": "lease-1",
                "text": "must not delete attachment",
                "expectedWriterSession": session,
                "expectedTargetEpoch": 0,
                "allowFocus": True,
                "force": True,
                "deadline": 2**53 - 1,
            },
        )
        assert attachment_write["code"] == "protected_content_present", attachment_write
        assert attachment_page.locator("#editor [data-attachment]").count() == 1
        assert attachment_page.locator("#editor").inner_text() == ""
        attachment_page.close()

        attachment_clear_page = browser.new_page(viewport={"width": 1200, "height": 800})
        hello = setup(attachment_clear_page, "contenteditable")
        session = hello["writerSession"]
        owned_write = send(
            attachment_clear_page,
            {
                "type": "WRITE_TARGET",
                "requestId": "owned-before-attachment",
                "lease": "lease-1",
                "text": "plugin text",
                "expectedWriterSession": session,
                "expectedTargetEpoch": 0,
                "allowFocus": True,
                "deadline": 2**53 - 1,
            },
        )
        assert owned_write["ok"], owned_write
        attachment_clear_page.evaluate(
            """() => {
              const chip = document.createElement('span');
              chip.contentEditable = 'false';
              chip.dataset.fileId = 'file-1';
              chip.setAttribute('aria-label', 'attached file');
              document.querySelector('#editor').append(chip);
            }"""
        )
        attachment_clear_page.wait_for_timeout(80)
        protected_clear = send(
            attachment_clear_page,
            {
                "type": "CLEAR_TARGET_IF_OWNED",
                "requestId": "attachment-clear",
                "lease": "lease-1",
                "expectedWriterSession": session,
                "expectedTargetEpoch": owned_write["targetEpoch"],
                "allowFocus": True,
                "deadline": 2**53 - 1,
            },
        )
        assert protected_clear["code"] == "protected_content_present", protected_clear
        assert attachment_clear_page.locator("#editor").inner_text() == "plugin text"
        assert attachment_clear_page.locator("#editor [data-file-id]").count() == 1
        attachment_clear_page.close()

        # An atomic node may appear after the initial safety check while the
        # editor is settling (for example, an attachment upload completing). A
        # rollback must not select-all across and delete that newly added node.
        late_attachment_page = browser.new_page(viewport={"width": 1200, "height": 800})
        hello = setup(late_attachment_page, "contenteditable")
        session = hello["writerSession"]
        late_attachment_page.evaluate(
            """() => {
              const nativeExec = document.execCommand.bind(document);
              window.__execCalls = 0;
              document.execCommand = (...args) => {
                window.__execCalls += 1;
                const result = nativeExec(...args);
                if (window.__execCalls === 1) {
                  queueMicrotask(() => {
                    const editor = document.querySelector('#editor');
                    editor.append(document.createTextNode(' drift'));
                    const chip = document.createElement('span');
                    chip.contentEditable = 'false';
                    chip.dataset.attachment = 'late-file';
                    chip.setAttribute('aria-label', 'attachment appeared during write');
                    editor.append(chip);
                  });
                }
                return result;
              };
            }"""
        )
        late_result = send(
            late_attachment_page,
            {
                "type": "WRITE_TARGET",
                "requestId": "late-attachment-write",
                "lease": "lease-1",
                "text": "new text",
                "expectedWriterSession": session,
                "expectedTargetEpoch": 0,
                "allowFocus": True,
                "deadline": 2**53 - 1,
            },
        )
        assert late_result["code"] == "write_failed_not_restored", late_result
        assert late_attachment_page.evaluate("window.__execCalls") == 1
        assert late_attachment_page.locator("#editor [data-attachment='late-file']").count() == 1
        assert "drift" in late_attachment_page.locator("#editor").inner_text()
        late_attachment_page.close()

        textarea_page = browser.new_page(viewport={"width": 1200, "height": 800})
        hello = setup(textarea_page, "textarea")
        session = hello["writerSession"]
        textarea_write = send(
            textarea_page,
            {
                "type": "WRITE_TARGET",
                "requestId": "textarea-write",
                "lease": "lease-1",
                "text": "x\n\n\ny",
                "expectedWriterSession": session,
                "expectedTargetEpoch": 0,
                "allowFocus": False,
                "deadline": 2**53 - 1,
            },
        )
        assert textarea_write["ok"] and textarea_write["readback"] == "x\n\n\ny", textarea_write
        textarea_page.locator("#editor").click()
        textarea_page.keyboard.type("z")
        textarea_page.wait_for_timeout(80)
        manual = textarea_page.evaluate(
            "window.__writerHarness.messages.findLast(message => message.type === 'TARGET_MANUAL_EDIT')"
        )
        stale = send(
            textarea_page,
            {
                "type": "WRITE_TARGET",
                "requestId": "stale-epoch",
                "lease": "lease-1",
                "text": "bad",
                "expectedWriterSession": session,
                "expectedTargetEpoch": 0,
                "allowFocus": False,
                "force": True,
                "deadline": 2**53 - 1,
            },
        )
        assert manual and not stale["ok"] and stale["code"] == "target_epoch_changed", stale
        assert textarea_page.locator("#editor").input_value() == "x\n\n\nyz"
        textarea_page.close()

        # A command can leave the service worker while the tab is active and
        # arrive after the user switches away. The writer must fail closed in a
        # hidden document rather than mutating a background conversation.
        hidden_page = browser.new_page(viewport={"width": 1200, "height": 800})
        hello = setup(hidden_page, "textarea")
        session = hello["writerSession"]
        hidden_page.evaluate(
            """() => Object.defineProperty(document, 'visibilityState', {
              configurable: true,
              get() { return 'hidden'; }
            })"""
        )
        hidden_write = send(
            hidden_page,
            {
                "type": "WRITE_TARGET",
                "requestId": "hidden-write",
                "lease": "lease-1",
                "text": "must not be written in background",
                "expectedWriterSession": session,
                "expectedTargetEpoch": 0,
                "allowFocus": True,
                "deadline": 2**53 - 1,
            },
        )
        assert not hidden_write["ok"] and hidden_write["code"] == "target_inactive", hidden_write
        assert hidden_page.locator("#editor").input_value() == ""
        hidden_page.close()

        # history.pushState() can switch Claude conversations without firing
        # popstate and without replacing the composer immediately. A command
        # carrying the previous writer session must be rejected synchronously.
        silent_route_page = browser.new_page(viewport={"width": 1200, "height": 800})
        hello = setup(silent_route_page, "textarea")
        old_session = hello["writerSession"]
        silent_route_page.evaluate("history.pushState({}, '', '#silent-conversation')")
        stale_route_write = send(
            silent_route_page,
            {
                "type": "WRITE_TARGET",
                "requestId": "silent-route-write",
                "lease": "lease-1",
                "text": "must stay out of the new conversation",
                "expectedWriterSession": old_session,
                "expectedTargetEpoch": 0,
                "allowFocus": False,
                "deadline": 2**53 - 1,
            },
        )
        assert not stale_route_write["ok"] and stale_route_write["code"] == "writer_session_changed", (
            stale_route_write,
            silent_route_page.evaluate("window.__writerHarness.messages"),
        )
        assert silent_route_page.locator("#editor").input_value() == ""
        silent_route_page.close()

        # Plain Enter may be configured to insert a newline rather than send.
        # Because normalized readback trims a trailing newline, the resulting
        # input event must explicitly cancel the provisional keyboard intent;
        # otherwise a quick manual clear can be misreported as SEND_CONFIRMED.
        newline_page = browser.new_page(viewport={"width": 1200, "height": 800})
        hello = setup(newline_page, "textarea")
        session = hello["writerSession"]
        newline_write = send(
            newline_page,
            {
                "type": "WRITE_TARGET",
                "requestId": "newline-base",
                "lease": "lease-1",
                "text": "line",
                "expectedWriterSession": session,
                "expectedTargetEpoch": 0,
                "allowFocus": False,
                "deadline": 2**53 - 1,
            },
        )
        assert newline_write["ok"], newline_write
        newline_page.locator("#editor").click()
        newline_page.keyboard.press("End")
        newline_page.keyboard.press("Enter")
        assert newline_page.locator("#editor").input_value() == "line\n"
        newline_page.locator("#editor").fill("")
        newline_page.wait_for_timeout(120)
        newline_messages = newline_page.evaluate("window.__writerHarness.messages")
        newline_cleared = next(
            (message for message in reversed(newline_messages) if message.get("type") == "TARGET_CLEARED"),
            None,
        )
        assert newline_cleared and newline_cleared["previousText"] == "line", newline_messages
        assert not any(message.get("type") == "SEND_CONFIRMED" for message in newline_messages), newline_messages
        newline_page.close()

        # v0.2.12: claude.ai's new-chat route centers a strong editor with no
        # hint attributes and no visible send button. It must still be located.
        hero_page = browser.new_page(viewport={"width": 1200, "height": 800})
        hero_page.set_content(
            "<!doctype html><body>"
            '<div style="height:180px"></div>'
            '<div class="ProseMirror" id="editor" contenteditable="true" '
            'style="width:600px;height:80px;border:1px solid;margin:0 auto"></div>'
            '<div style="height:460px"></div>'
            "</body>"
        )
        hero_page.evaluate(
            """() => {
              const messages = [];
              const messageListeners = [];
              const disconnectListeners = [];
              const port = {
                postMessage(message) { messages.push(structuredClone(message)); },
                onMessage: { addListener(listener) { messageListeners.push(listener); } },
                onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
                disconnect() { for (const listener of disconnectListeners) listener(); }
              };
              window.__writerHarness = { messages, messageListeners, disconnectListeners };
              window.chrome = { runtime: { id: 'test-extension', connect() { return port; } } };
            }"""
        )
        hero_page.add_script_tag(content=WRITER_JS)
        hero_page.wait_for_timeout(40)
        hero_page.evaluate(
            "message => window.__writerHarness.messageListeners[0](message)",
            {"type": "ATTACH", "lease": "lease-hero"},
        )
        hero_page.wait_for_timeout(60)
        hero_state = hero_page.evaluate(
            "window.__writerHarness.messages.findLast(message => message.type === 'WRITER_STATE')"
        )
        assert hero_state and hero_state["state"]["composerReady"], \
            ("centered hero composer must be locatable without hints", hero_state)
        hero_session = hero_state["writerSession"]
        hero_epoch = hero_state["state"]["targetEpoch"]

        # v0.2.12 zero-delete contract at the writer level: a non-forced write
        # refuses foreign text; CLEAR_TARGET_IF_OWNED refuses it too; only the
        # explicit CLEAR_TARGET_FORCE removes it — and even that never touches
        # attachments.
        hero_page.evaluate("document.getElementById('editor').textContent = 'user note'")
        hero_page.wait_for_timeout(150)
        # The direct DOM edit is reported as a manual edit and advances the
        # epoch; later commands must CAS against the advanced value.
        hero_epoch = hero_page.evaluate(
            """() => {
              let epoch = 0;
              for (const message of window.__writerHarness.messages) {
                if (Number.isInteger(message.targetEpoch)) epoch = message.targetEpoch;
                else if (Number.isInteger(message.state?.targetEpoch)) epoch = message.state.targetEpoch;
              }
              return epoch;
            }"""
        )
        refused_write = send(
            hero_page,
            {
                "type": "WRITE_TARGET",
                "requestId": "hero-write-refused",
                "lease": "lease-hero",
                "text": "translation",
                "expectedWriterSession": hero_session,
                "expectedTargetEpoch": hero_epoch,
                "allowFocus": True,
                "deadline": 2**53 - 1,
            },
        )
        assert not refused_write["ok"] and refused_write["code"] == "manual_edit", refused_write
        assert hero_page.locator("#editor").inner_text() == "user note"

        refused_clear = send(
            hero_page,
            {
                "type": "CLEAR_TARGET_IF_OWNED",
                "requestId": "hero-clear-refused",
                "lease": "lease-hero",
                "expectedWriterSession": hero_session,
                "expectedTargetEpoch": hero_epoch,
                "allowFocus": True,
                "deadline": 2**53 - 1,
            },
        )
        assert not refused_clear["ok"] and refused_clear["code"] == "not_plugin_owned", refused_clear
        assert hero_page.locator("#editor").inner_text() == "user note"

        forced_clear = send(
            hero_page,
            {
                "type": "CLEAR_TARGET_FORCE",
                "requestId": "hero-clear-forced",
                "lease": "lease-hero",
                "expectedWriterSession": hero_session,
                "expectedTargetEpoch": hero_epoch,
                "allowFocus": True,
                "deadline": 2**53 - 1,
            },
            wait_ms=200,
        )
        assert forced_clear["ok"], forced_clear
        assert hero_page.locator("#editor").inner_text().strip() == ""

        hero_page.evaluate(
            "document.getElementById('editor').innerHTML = "
            "'draft <span data-attachment contenteditable=\"false\">f.png</span>'"
        )
        hero_page.wait_for_timeout(150)
        # The injected attachment markup is itself a manual edit → fresh epoch.
        hero_epoch_after_attachment = hero_page.evaluate(
            """() => {
              let epoch = 0;
              for (const message of window.__writerHarness.messages) {
                if (Number.isInteger(message.targetEpoch)) epoch = message.targetEpoch;
                else if (Number.isInteger(message.state?.targetEpoch)) epoch = message.state.targetEpoch;
              }
              return epoch;
            }"""
        )
        protected_clear = send(
            hero_page,
            {
                "type": "CLEAR_TARGET_FORCE",
                "requestId": "hero-clear-protected",
                "lease": "lease-hero",
                "expectedWriterSession": hero_session,
                "expectedTargetEpoch": hero_epoch_after_attachment,
                "allowFocus": True,
                "deadline": 2**53 - 1,
            },
            wait_ms=200,
        )
        assert not protected_clear["ok"], protected_clear
        assert protected_clear["code"] == "protected_content_present", protected_clear
        assert "draft" in hero_page.locator("#editor").inner_text()
        hero_page.close()

        # Fail-closed counterpart: a centered CodeMirror-style artifact editor
        # (strong textbox semantics, composer-like shape) must NOT be located.
        artifact_page = browser.new_page(viewport={"width": 1200, "height": 800})
        artifact_page.set_content(
            "<!doctype html><body>"
            '<div style="height:180px"></div>'
            '<div class="cm-editor" style="width:600px;margin:0 auto">'
            '<div id="editor" contenteditable="true" role="textbox" aria-multiline="true" '
            'style="width:600px;height:80px;border:1px solid"></div></div>'
            '<div style="height:460px"></div>'
            "</body>"
        )
        artifact_page.evaluate(
            """() => {
              const messages = [];
              const messageListeners = [];
              const disconnectListeners = [];
              const port = {
                postMessage(message) { messages.push(structuredClone(message)); },
                onMessage: { addListener(listener) { messageListeners.push(listener); } },
                onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
                disconnect() { for (const listener of disconnectListeners) listener(); }
              };
              window.__writerHarness = { messages, messageListeners, disconnectListeners };
              window.chrome = { runtime: { id: 'test-extension', connect() { return port; } } };
            }"""
        )
        artifact_page.add_script_tag(content=WRITER_JS)
        artifact_page.wait_for_timeout(40)
        artifact_page.evaluate(
            "message => window.__writerHarness.messageListeners[0](message)",
            {"type": "ATTACH", "lease": "lease-artifact"},
        )
        artifact_page.wait_for_timeout(60)
        artifact_state = artifact_page.evaluate(
            "window.__writerHarness.messages.findLast(message => message.type === 'WRITER_STATE')"
        )
        assert artifact_state and not artifact_state["state"]["composerReady"], \
            ("artifact/code editors must stay unlocatable", artifact_state)
        artifact_page.close()

        browser.close()

    print("writer browser safety test: PASS")


if __name__ == "__main__":
    main()
