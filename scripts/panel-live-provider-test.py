#!/usr/bin/env python3
"""Panel end-to-end against a real local gateway.

The other panel suite replaces window.fetch, so nothing between panel.js and
the socket is ever exercised: no real streaming into the preview, no real
error classification, no real request headers. This one boots
scripts/mock-provider.mjs on a loopback port, points the panel's Base URL at
it, and drives the actual UI — the same thing a human does when they side-load
the extension and aim it at a local gateway.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import socket
import subprocess
import time
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def chromium_path() -> str:
    override = os.environ.get("CHROMIUM_PATH")
    if override:
        return override
    for candidate in (
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        "/opt/pw-browsers/chromium",
    ):
        if Path(candidate).exists():
            return candidate
    return "/usr/bin/chromium"


def load_panel_harness():
    """Reuse the extension/writer mocks from the existing panel suite."""
    spec = importlib.util.spec_from_file_location(
        "panel_browser_test", ROOT / "scripts" / "panel-browser-test.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class Gateway:
    """The mock provider as a child process."""

    def __init__(self) -> None:
        self.port = free_port()
        self.origin = f"http://127.0.0.1:{self.port}"
        self.process: subprocess.Popen | None = None

    def __enter__(self) -> "Gateway":
        self.process = subprocess.Popen(
            [
                "node",
                str(ROOT / "scripts" / "mock-provider.mjs"),
                "--port",
                str(self.port),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.2):
                    return self
            except OSError:
                if self.process.poll() is not None:
                    raise RuntimeError("mock provider exited during start-up")
                time.sleep(0.05)
        raise RuntimeError("mock provider did not start listening")

    def __exit__(self, *_exc) -> None:
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()

    def base_url(self, scenario: str) -> str:
        return f"{self.origin}/{scenario}/v1"

    def request_log(self) -> list[dict]:
        with urlopen(f"{self.origin}/__mock/requests", timeout=5) as response:
            return json.load(response)["requests"]

    def paid_requests(self) -> int:
        """Requests that would have cost money (model calls, not /models)."""
        return len([entry for entry in self.request_log() if entry["endpoint"] != "models"])

    def reset(self) -> None:
        with urlopen(f"{self.origin}/__mock/reset", timeout=5) as response:
            response.read()


def extension_mock(
    harness,
    base_url: str,
    *,
    stream_preview: bool = True,
    automation_mode: str = "manual",
    debounce_ms: int = 200,
) -> str:
    """The shared chrome/writer mock with the fetch stub removed."""
    mock = harness.MOCK_EXTENSION
    marker = "  let translationCall = 0;"
    assert marker in mock, "panel-browser-test.py no longer stubs fetch as expected"
    mock = mock[: mock.index(marker)] + "})();\n"
    mock = mock.replace("baseUrl: 'https://provider.example/v1'", f"baseUrl: '{base_url}'")
    assert base_url in mock, "failed to point the panel at the live gateway"
    # capabilities in the shared mock disable temperature; start from unknown so
    # the real degradation path runs.
    mock = mock.replace(
        "capabilities: { jsonMode: true, temperature: false }",
        "capabilities: { jsonMode: null, temperature: null, streaming: null }",
    )
    settings_patch = (
        "streamPreview: "
        + ("true" if stream_preview else "false")
        + f", automationMode: '{automation_mode}', requestTimeoutMs: 5000,"
        + f" debounceMs: {debounce_ms}, sentenceEndDelayMs: 40,"
    )
    mock = mock.replace("autoSync: true,", "autoSync: true, " + settings_patch, 1)
    return mock


def open_panel(browser, harness, mock: str):
    page = browser.new_page(viewport={"width": 430, "height": 900})
    page.set_default_timeout(15000)
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.set_content(harness.build_panel_html())
    page.add_init_script(mock)
    # set_content does not re-run init scripts, so inject both explicitly.
    page.evaluate(mock)
    page.add_script_tag(content=harness.build_test_bundle())
    page.wait_for_function("!!document.querySelector('#translateButton')")
    page.wait_for_function("window.__mock !== undefined")
    return page, errors


def set_source(page, text: str) -> None:
    page.fill("#sourceText", text)
    page.dispatch_event("#sourceText", "input")


def bind_target(page) -> None:
    page.locator("#bindButton").click()
    page.wait_for_function(
        "document.querySelector('#targetLabel').textContent.includes('已绑定')"
    )


def translate_now(page) -> None:
    page.locator("#translateButton").click()


def status_text(page) -> str:
    return page.evaluate("document.querySelector('#statusBar').textContent")


def notices(page) -> str:
    """Corrections and ambiguities render as .notice-item blocks; warnings as li."""
    return page.evaluate(
        "[...document.querySelectorAll("
        "  '#correctionList .notice-item, #ambiguityList .notice-item, #warningList li'"
        ")].map(node => node.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')"
    )


def main() -> None:
    harness = load_panel_harness()
    observed: list[str] = []

    with Gateway() as gateway, sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True, executable_path=chromium_path(), args=["--no-sandbox"]
        )

        # --- 1. streamed happy path, written into the composer -------------
        page, errors = open_panel(
            browser, harness, extension_mock(harness, gateway.base_url("ok"))
        )
        bind_target(page)
        set_source(page, "请帮我检查这段代码的性能问题，不要重写整体结构。")
        translate_now(page)
        page.wait_for_function(
            "window.__mock.writer.text.includes('please help me review this snippet')"
        )
        english = page.evaluate("document.querySelector('#englishText').value")
        back = page.evaluate("document.querySelector('#backText').value")
        assert "please help me review this snippet" in english, english
        assert re.search(r"[㐀-鿿]", back), f"back-translation not Chinese: {back}"
        writes = page.evaluate("window.__mock.writer.writes.length")
        assert writes == 1, f"expected exactly one composer write, saw {writes}"
        assert errors == [], errors
        observed.append(f"streamed happy path: composer={english[:48]!r} back={back[:24]!r} writes={writes}")
        page.close()

        # --- 2. rate limiting reaches the user and writes nothing ----------
        page, errors = open_panel(
            browser, harness, extension_mock(harness, gateway.base_url("rate_limited"))
        )
        bind_target(page)
        set_source(page, "请帮我检查这段代码的性能问题。")
        translate_now(page)
        page.wait_for_function(
            "document.querySelector('#statusBar').textContent.includes('限流')"
            " || document.querySelector('#statusBar').textContent.includes('429')"
        )
        assert page.evaluate("window.__mock.writer.text") == "", "a failed translation wrote text"
        assert page.evaluate("document.querySelector('#englishText').value") == ""
        assert errors == [], errors
        observed.append(f"429: status={status_text(page).strip()[:70]!r} composer=''")
        page.close()

        # --- 3. a lost stream event blames the transport, not the model ----
        page, errors = open_panel(
            browser, harness, extension_mock(harness, gateway.base_url("sse_dropped_event"))
        )
        bind_target(page)
        set_source(page, "请帮我检查这段代码的性能问题。")
        translate_now(page)
        page.wait_for_function(
            "document.querySelector('#statusBar').textContent.includes('失败')"
            " || document.querySelector('#statusBar').textContent.includes('不完整')"
        )
        combined = status_text(page) + " " + page.evaluate(
            "document.querySelector('#diagnosticSummary')?.textContent || ''"
        )
        assert "复述" not in combined, f"a dropped delta was blamed on the model: {combined}"
        assert page.evaluate("window.__mock.writer.text") == ""
        assert errors == [], errors
        observed.append(f"lost stream event: status={status_text(page).strip()[:70]!r}")
        page.close()

        # --- 4. capability degradation over the real wire ------------------
        page, errors = open_panel(
            browser,
            harness,
            extension_mock(harness, gateway.base_url("reject_json_then_temperature")),
        )
        bind_target(page)
        set_source(page, "请帮我检查这段代码的性能问题。")
        translate_now(page)
        page.wait_for_function(
            "window.__mock.writer.text.includes('please help me review this snippet')"
        )
        stored = page.evaluate(
            "JSON.stringify(window.__mock.local.get('zh2en.provider.v1').capabilities)"
        )
        assert '"jsonMode":false' not in stored, (
            f"a runtime degradation was persisted without an explicit test: {stored}"
        )
        assert errors == [], errors
        observed.append(f"degradation: stored capabilities={stored} (runtime-only)")
        page.close()

        # --- 5. connection test surfaces a broken SSE route ----------------
        page, errors = open_panel(
            browser, harness, extension_mock(harness, gateway.base_url("relay_stream_502"))
        )
        page.locator("#settingsButton").click()
        page.wait_for_function("document.querySelector('#settingsDialog').open === true")
        page.locator("#testProviderButton").click()
        # Wait for the settled verdict: the connection test walks through
        # "正在做真实翻译测试…" and "测试失败，正在定位原因…" before it lands on
        # either 通过 or a classified failure with a 诊断 suffix.
        page.wait_for_function(
            "(() => {"
            "  const text = document.querySelector('#providerTestResult').textContent;"
            "  return text.includes('通过 ·') || text.includes('诊断：');"
            "})()",
            timeout=30000,
        )
        result = page.evaluate("document.querySelector('#providerTestResult').textContent")
        assert "通过 ·" not in result, f"a broken SSE route must not pass: {result}"
        # 0.2.11 promises a buffered-vs-streamed comparison plus the gateway's
        # own message; without it a broken SSE route is indistinguishable from
        # an outage.
        assert "502" in result or "诊断" in result, result
        assert errors == [], errors
        observed.append(f"connection test on a broken SSE route: {result.strip()[:160]!r}")
        page.close()

        # --- 5b. review notices render for corrections and ambiguities ------
        page, errors = open_panel(
            browser, harness, extension_mock(harness, gateway.base_url("ambiguous"))
        )
        bind_target(page)
        set_source(page, "请帮我检查这段代码的性能问题。")
        translate_now(page)
        page.wait_for_function(
            "window.__mock.writer.text.includes('please help me review this snippet')"
        )
        page.wait_for_function(
            "document.querySelectorAll('#ambiguityList .notice-item').length > 0", timeout=15000
        )
        rendered = notices(page)
        assert "性能" in rendered, rendered
        assert errors == [], errors
        observed.append(f"review notices: {rendered.strip()[:110]!r}")
        page.close()

        # --- 5c. automatic mode: a typing burst costs exactly one request ---
        gateway.reset()
        page, errors = open_panel(
            browser,
            harness,
            extension_mock(
                harness, gateway.base_url("ok"), automation_mode="auto_sync", debounce_ms=250
            ),
        )
        bind_target(page)
        # Type the draft in pieces, faster than the debounce window.
        for length in range(3, 16, 3):
            page.fill("#sourceText", "请帮我检查这段代码的性能问题。"[:length])
            page.dispatch_event("#sourceText", "input")
            page.wait_for_timeout(60)
        page.fill("#sourceText", "请帮我检查这段代码的性能问题。")
        page.dispatch_event("#sourceText", "input")
        page.wait_for_function(
            "window.__mock.writer.text.includes('please help me review this snippet')",
            timeout=20000,
        )
        page.wait_for_timeout(700)  # let any stray debounce fire
        burst_cost = gateway.paid_requests()
        assert burst_cost == 1, f"a typing burst cost {burst_cost} paid requests"

        # --- 5d. re-translating unchanged text must replay from cache -------
        before_cache = gateway.paid_requests()
        page.locator("#translateButton").click()
        page.wait_for_timeout(1200)
        after_cache = gateway.paid_requests()
        assert after_cache == before_cache, (
            f"an unchanged draft was re-billed: {before_cache} -> {after_cache}"
        )
        # A whitespace-only edit normalizes to the same source and must not bill.
        page.fill("#sourceText", "请帮我检查这段代码的性能问题。 ")
        page.dispatch_event("#sourceText", "input")
        page.wait_for_timeout(1200)
        after_space = gateway.paid_requests()
        assert after_space == before_cache, (
            f"a whitespace-only edit was billed: {before_cache} -> {after_space}"
        )
        assert errors == [], errors
        observed.append(
            f"billing: typing burst={burst_cost} request, re-translate=+0, trailing space=+0"
        )
        page.close()

        # --- 5e. IME composition must not translate half-typed pinyin -------
        gateway.reset()
        page, errors = open_panel(
            browser,
            harness,
            extension_mock(
                harness, gateway.base_url("ok"), automation_mode="auto_sync", debounce_ms=200
            ),
        )
        bind_target(page)
        # A Chinese IME fires input events for every composition update. Those
        # intermediate values are half-formed and must never be billed.
        page.evaluate(
            """async () => {
              const editor = document.querySelector('#sourceText');
              editor.focus();
              editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
              for (const partial of ['q', 'qing', '请b', '请bang', '请帮w']) {
                editor.value = partial;
                editor.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: partial }));
                editor.dispatchEvent(new Event('input', { bubbles: true }));
                await new Promise(resolve => setTimeout(resolve, 120));
              }
              editor.value = '请帮我检查这段代码的性能问题。';
              editor.dispatchEvent(new Event('input', { bubbles: true }));
              editor.dispatchEvent(new CompositionEvent('compositionend', {
                bubbles: true, data: '请帮我检查这段代码的性能问题。'
              }));
            }"""
        )
        page.wait_for_function(
            "window.__mock.writer.text.includes('please help me review this snippet')",
            timeout=20000,
        )
        page.wait_for_timeout(600)
        ime_log = [entry for entry in gateway.request_log() if entry["endpoint"] != "models"]
        assert len(ime_log) == 1, f"IME composition cost {len(ime_log)} paid requests"
        sent = ime_log[0]["body"]["messages"][-1]["content"]
        assert sent == "请帮我检查这段代码的性能问题。", f"a partial composition was translated: {sent!r}"
        assert errors == [], errors
        observed.append(f"IME composition: 1 request, sent={sent!r}")
        page.close()

        # --- 5f. a transient 500 recovers without user action ---------------
        gateway.reset()
        page, errors = open_panel(
            browser, harness, extension_mock(harness, gateway.base_url("flaky_500"))
        )
        bind_target(page)
        set_source(page, "请帮我修复部署失败的日志。")
        translate_now(page)
        page.wait_for_function(
            "window.__mock.writer.text.length > 0", timeout=20000
        )
        recovered = page.evaluate("window.__mock.writer.text")
        attempts = gateway.paid_requests()
        assert "deploy" in recovered, recovered
        assert attempts == 2, f"a transient 5xx should cost exactly one retry, saw {attempts}"
        assert errors == [], errors
        observed.append(f"transient 500: recovered after {attempts} requests")
        page.close()

        # --- 5g. pasting an oversized document costs nothing ----------------
        gateway.reset()
        page, errors = open_panel(
            browser,
            harness,
            extension_mock(
                harness, gateway.base_url("ok"), automation_mode="auto_sync", debounce_ms=200
            ),
        )
        bind_target(page)
        oversized = "请检查这段代码的性能问题。" * 5000  # ~65k code points
        page.fill("#sourceText", oversized)
        page.dispatch_event("#sourceText", "input")
        page.wait_for_function(
            "document.querySelector('#sourceCount').textContent.includes('超出')", timeout=15000
        )
        translate_now(page)
        page.wait_for_function(
            "document.querySelector('#statusBar').textContent.includes('50,000')", timeout=15000
        )
        page.wait_for_timeout(600)
        assert gateway.paid_requests() == 0, "an over-limit draft was sent to the provider"
        # The draft itself must survive: 0.2.x preserves oversized text so the
        # user can split it instead of losing it.
        kept = page.evaluate("document.querySelector('#sourceText').value.length")
        assert kept == len(oversized), f"the oversized draft was truncated: {kept}"
        assert errors == [], errors
        observed.append(
            f"oversized draft: 0 paid requests, {kept} chars preserved, "
            f"status={status_text(page).strip()[:40]!r}"
        )
        page.close()

        # --- 5h. a late answer for a superseded draft never lands -----------
        gateway.reset()
        page, errors = open_panel(
            browser, harness, extension_mock(harness, gateway.base_url("slow_once"))
        )
        bind_target(page)
        set_source(page, "请帮我修复部署失败的日志。")
        translate_now(page)
        page.wait_for_timeout(150)  # request #1 in flight, deliberately slow
        set_source(page, "请帮我检查这段代码的性能问题。")
        translate_now(page)
        page.wait_for_function(
            "window.__mock.writer.text.includes('please help me review this snippet')",
            timeout=20000,
        )
        page.wait_for_timeout(1600)  # long enough for request #1 to come back
        composer = page.evaluate("window.__mock.writer.text")
        assert "deploy" not in composer, f"a superseded translation reached the composer: {composer}"
        preview = page.evaluate("document.querySelector('#englishText').value")
        assert "deploy" not in preview, f"a superseded translation reached the preview: {preview}"
        assert errors == [], errors
        observed.append(f"stale race: composer={composer[:44]!r} (superseded answer discarded)")
        page.close()

        # --- 5i. another window changing the provider invalidates in-flight -
        gateway.reset()
        page, errors = open_panel(
            browser, harness, extension_mock(harness, gateway.base_url("slow_once"))
        )
        bind_target(page)
        set_source(page, "请帮我修复部署失败的日志。")
        translate_now(page)
        page.wait_for_timeout(150)
        # Simulate a second Edge window saving a different provider.
        page.evaluate(
            """async (url) => {
              const provider = { ...window.__mock.local.get('zh2en.provider.v1') };
              provider.baseUrl = url;
              provider.credentialId = 'credential-rotated';
              await window.__mock.externalSet('local', { 'zh2en.provider.v1': provider });
            }""",
            gateway.base_url("ok"),
        )
        page.wait_for_timeout(1800)
        after_switch = page.evaluate("window.__mock.writer.text")
        assert "deploy" not in after_switch, (
            f"an in-flight request survived a provider change: {after_switch}"
        )
        assert errors == [], errors
        observed.append(f"provider rotated mid-flight: composer={after_switch!r}, status={status_text(page).strip()[:38]!r}")
        page.close()

        # --- 5j. independent back-translation over the Responses protocol ---
        gateway.reset()
        page, errors = open_panel(
            browser, harness, extension_mock(harness, gateway.base_url("ok"))
        )
        page.evaluate(
            """async () => {
              const provider = { ...window.__mock.local.get('zh2en.provider.v1') };
              provider.apiProtocol = 'responses';
              provider.modelBackTranslate = 'gpt-4o-mini';
              const settings = { ...window.__mock.local.get('zh2en.settings.v1') };
              settings.backTranslationMode = 'independent';
              await window.__mock.externalSet('local', {
                'zh2en.provider.v1': provider,
                'zh2en.settings.v1': settings
              });
            }"""
        )
        page.wait_for_timeout(300)
        bind_target(page)
        set_source(page, "请帮我检查这段代码的性能问题。")
        translate_now(page)
        page.wait_for_function(
            "document.querySelector('#backText').value.trim().length > 0", timeout=25000
        )
        back_text = page.evaluate("document.querySelector('#backText').value")
        log = [entry for entry in gateway.request_log() if entry["endpoint"] != "models"]
        assert all(entry["endpoint"] == "responses" for entry in log), [e["endpoint"] for e in log]
        assert len(log) == 2, f"independent mode should be two requests, saw {len(log)}"
        assert re.search(r"[㐀-鿿]", back_text), back_text
        # The second request must not carry the Chinese source.
        second = json.dumps(log[1]["body"], ensure_ascii=False)
        assert "性能问题" not in second, "the back-translation request leaked the Chinese draft"
        assert errors == [], errors
        observed.append(
            f"responses + independent back-translation: {len(log)} requests on /responses, "
            f"back={back_text[:20]!r}"
        )
        page.close()

        # --- 5k. repeated failures must never surface the API key -----------
        gateway.reset()
        page, errors = open_panel(
            browser, harness, extension_mock(harness, gateway.base_url("ok"))
        )
        bind_target(page)
        secret = page.evaluate("window.__mock.local.get('zh2en.secret.local.v1')")
        assert secret, "the harness must have a stored key for this check to mean anything"
        # Walk the panel through a series of gateway failures, including ones
        # whose bodies echo the key back.
        for scenario in [
            "forbidden_echoes_key", "bad_gateway_html", "rate_limited",
            "json_error_200", "sse_dropped_event", "route_not_found", "plain_text"
        ]:
            page.evaluate(
                """async (url) => {
                  const provider = { ...window.__mock.local.get('zh2en.provider.v1') };
                  provider.baseUrl = url;
                  await window.__mock.externalSet('local', { 'zh2en.provider.v1': provider });
                }""",
                gateway.base_url(scenario),
            )
            page.wait_for_timeout(120)
            set_source(page, f"请帮我检查这段代码的性能问题{scenario}。")
            translate_now(page)
            page.wait_for_timeout(700)
        page.locator("#diagnosticsButton").click()
        page.wait_for_function("document.querySelector('#diagnosticsDialog').open === true")
        surfaces = page.evaluate(
            """() => ({
              diagnostics: [...document.querySelectorAll('#diagnosticLog li')]
                .map(node => node.textContent).join(' ~ '),
              diagnosticCount: String(document.querySelectorAll('#diagnosticLog li').length),
              status: document.querySelector('#statusBar').textContent,
              dom: document.body.innerText,
              stored: JSON.stringify([...window.__mock.local.entries()].filter(
                ([key]) => !key.includes('secret')
              )) + JSON.stringify([...window.__mock.session.entries()].filter(
                ([key]) => !key.includes('secret')
              ))
            })"""
        )
        for where, text in surfaces.items():
            assert secret not in text, f"the API key leaked into {where}"
            assert "Bearer " + secret not in text, f"the auth header leaked into {where}"
        # The draft text is not secret, but prompts and full response bodies
        # must not be retained in diagnostics either.
        assert "faithful Chinese-to-English translator" not in surfaces["diagnostics"], (
            "the system prompt was retained in diagnostics"
        )
        assert errors == [], errors
        observed.append(
            f"7 consecutive gateway failures: key absent from diagnostics/status/DOM/storage, "
            f"{surfaces['diagnosticCount']} diagnostic entries"
        )
        page.close()

        # --- 5l. a storage failure is reported, never a silent lost draft ---
        gateway.reset()
        page, errors = open_panel(
            browser, harness, extension_mock(harness, gateway.base_url("ok"))
        )
        page.evaluate(
            """() => {
              // Drafts, history and diagnostics live in chrome.storage.session.
              const original = window.chrome.storage.session.set;
              window.__mock.restoreSet = () => { window.chrome.storage.session.set = original; };
              window.chrome.storage.session.set = async () => {
                throw new Error('QUOTA_BYTES quota exceeded');
              };
            }"""
        )
        set_source(page, "请帮我检查这段代码的性能问题，磁盘配额已满。")
        page.wait_for_function(
            "document.querySelector('#statusBar').textContent.includes('未能保存')", timeout=15000
        )
        quota_status = status_text(page)
        kept = page.evaluate("document.querySelector('#sourceText').value")
        assert "磁盘配额已满" in kept, "the draft was dropped when storage failed"
        page.evaluate("window.__mock.restoreSet()")
        assert errors == [], errors
        observed.append(f"storage quota failure: status={quota_status.strip()[:40]!r}, draft kept")
        page.close()

        # --- 5m. first run: no key, and an empty draft ----------------------
        gateway.reset()
        page, errors = open_panel(
            browser, harness, extension_mock(harness, gateway.base_url("ok"))
        )
        bind_target(page)
        # Empty draft: the button must not reach the network.
        translate_now(page)
        page.wait_for_function(
            "document.querySelector('#statusBar').textContent.includes('请先输入中文')"
        )
        assert gateway.paid_requests() == 0, "an empty draft was sent to the provider"

        # No key configured: fail fast and open settings instead of spending a
        # request to collect a 401.
        page.evaluate(
            """async () => {
              await window.__mock.externalSet('local', { 'zh2en.secret.local.v1': undefined });
              window.__mock.local.delete('zh2en.secret.local.v1');
              window.__mock.session.delete('zh2en.secret.session.v1');
            }"""
        )
        set_source(page, "请帮我检查这段代码的性能问题。")
        translate_now(page)
        page.wait_for_function(
            "document.querySelector('#statusBar').textContent.includes('API Key')", timeout=15000
        )
        assert gateway.paid_requests() == 0, "a request went out with no API key"
        assert page.evaluate("document.querySelector('#settingsDialog').open === true"), (
            "the settings dialog should open so the user can fix it"
        )
        # The external-config notice is debounced and then awaits a storage
        # read, so it lands after this error. It is informational and must not
        # overwrite it — otherwise the status bar claims the automatic flow is
        # continuing while the translation actually aborted.
        page.wait_for_timeout(800)
        settled = status_text(page)
        assert "API Key" in settled, (
            f"an informational notice overwrote the actionable error: {settled!r}"
        )
        assert "已采纳" not in settled, settled
        assert errors == [], errors
        observed.append(
            f"first run: empty draft and missing key both cost 0 requests, "
            f"status={status_text(page).strip()[:24]!r}"
        )
        page.close()

        # --- 5n. append contract: badge and send-archive still work ---------
        # The composer now ENDS WITH the translation instead of equalling it,
        # so every "is this our text" comparison had to become a suffix test.
        # Miss one and the badge never turns 已同步 and a sent draft is never
        # archived.
        gateway.reset()
        page, errors = open_panel(
            browser, harness, extension_mock(harness, gateway.base_url('ok'))
        )
        bind_target(page)
        page.evaluate("window.__mock.writer.text = '我自己的笔记'")
        set_source(page, '请帮我检查这段代码的性能问题。')
        translate_now(page)
        page.wait_for_function(
            "window.__mock.writer.text.includes('please help me review this snippet')",
            timeout=20000,
        )
        composed = page.evaluate('window.__mock.writer.text')
        assert composed.startswith('我自己的笔记'), composed
        page.wait_for_function(
            "document.querySelector('#syncBadge').textContent.includes('已同步')",
            timeout=15000,
        )

        # Sending the composed message must archive the draft and start a new one.
        page.evaluate("() => {\n  const writer = window.__mock.writer;\n  const sent = writer.text;\n  writer.text = '';\n  writer.pluginOwned = false;\n  writer.ownedTail = '';\n  writer.epoch += 1;\n  window.__mock.emit({\n    type: 'SEND_CONFIRMED', tabId: writer.tabId,\n    writerSession: writer.session, targetEpoch: writer.epoch,\n    sentText: sent, intentKind: 'button'\n  });\n}")
        page.wait_for_function(
            "document.querySelector('#sourceText').value === ''", timeout=15000
        )
        assert errors == [], errors
        observed.append(
            f'append badge+archive: composer={composed[:34]!r}, draft archived after send'
        )
        page.close()
        # --- 5o. editing the composer is ordinary; only incidents stop us ---
        # Under append nothing is at risk when the user types, so an ordinary
        # edit must not abort the in-flight request, pause automation or raise
        # the conflict banner. An interrupted write still must.
        gateway.reset()
        page, errors = open_panel(
            browser, harness, extension_mock(harness, gateway.base_url('ok'))
        )
        bind_target(page)
        set_source(page, '请帮我检查这段代码的性能问题。')
        translate_now(page)
        page.wait_for_function(
            "window.__mock.writer.text.includes('please help me review this snippet')",
            timeout=20000,
        )
        page.evaluate("() => {\n  const writer = window.__mock.writer;\n  writer.text = writer.text + ' 我又补了一句';\n  writer.pluginOwned = false;\n  writer.ownedTail = '';\n  writer.epoch += 1;\n  window.__mock.emit({\n    type: 'TARGET_MANUAL_EDIT', tabId: writer.tabId,\n    writerSession: writer.session, targetEpoch: writer.epoch,\n    text: writer.text, reason: 'manual_edit'\n  });\n}")
        page.wait_for_timeout(400)
        banner_class = page.get_attribute('#manualBanner', 'class') or ''
        assert 'hidden' in banner_class.split(), 'an ordinary composer edit raised the conflict banner'
        assert page.inner_text('#pauseButton') == '暂停', 'an ordinary composer edit paused automation'
        quiet_status = status_text(page)
        assert '人工修改' not in quiet_status, quiet_status

        # A genuine write incident still stops everything.
        page.evaluate("() => {\n  const writer = window.__mock.writer;\n  writer.epoch += 1;\n  window.__mock.emit({\n    type: 'TARGET_MANUAL_EDIT', tabId: writer.tabId,\n    writerSession: writer.session, targetEpoch: writer.epoch,\n    text: writer.text, reason: 'write_interrupted'\n  });\n}")
        page.wait_for_function(
            "!document.querySelector('#manualBanner').classList.contains('hidden')",
            timeout=15000,
        )
        assert page.inner_text('#pauseButton') == '恢复', 'a write incident must pause automation'
        assert errors == [], errors
        observed.append(
            f'manual edit quiet={quiet_status.strip()[:26]!r}; write incident still pauses'
        )
        page.close()
        # --- 6. model detection populates the picker ------------------------
        page, errors = open_panel(
            browser, harness, extension_mock(harness, gateway.base_url("ok"))
        )
        page.locator("#settingsButton").click()
        page.wait_for_function("document.querySelector('#settingsDialog').open === true")
        page.locator("#detectModelsButton").click()
        page.wait_for_function(
            "document.querySelectorAll('#modelList option').length > 0"
        )
        options = page.evaluate(
            "[...document.querySelectorAll('#modelList option')].map(node => node.value)"
        )
        assert "gpt-4o-mini" in options, options
        assert not any("whisper" in value for value in options), options
        assert errors == [], errors
        observed.append(f"model detection: {len(options)} options, sample={options[:4]}")
        page.close()

        browser.close()

    for line in observed:
        print(f"  {line}")
    print("panel live-provider test: PASS")


if __name__ == "__main__":
    main()
