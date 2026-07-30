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
