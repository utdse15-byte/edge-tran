# Build and validation report

- Version: **0.2.2**
- Build date: **2026-07-19**
- Node: **v22.16.0**
- Python: **3.13.5**
- Chromium validator: **144.0.7559.96**, Debian 13

## Result summary

| Check | Result |
|---|---:|
| JavaScript syntax | 12/12 files passed |
| Node unit/integration tests | 52/52 passed |
| Chromium Writer smoke | passed |
| Chromium Writer safety suite | passed |
| Chromium Panel smoke | passed |
| Chromium Panel state-machine suite | passed |
| Static manifest/security/resource audit | passed |
| Chromium extension pack validation | passed |
| Clean release-tree verification | passed |
| Final ZIP extraction and full verification | passed |
| ZIP integrity | passed |
| Embedded API Key/private-key scan | passed |
| Remote-code/dangerous DOM sink scan | passed |
| Content-script storage/network boundary scan | passed |

The complete source-tree command was:

```bash
npm run verify:full
```

The same command was run from the clean release directory and from a fresh extraction of the final ZIP.

## Coverage

The Node-instrumented modules reached:

- Lines: **85.05%**
- Branches: **74.60%**
- Functions: **83.86%**

These percentages do not instrument `panel.js` and `writer.js` in their real browser environment. Their high-risk paths are exercised by four separate Chromium harnesses instead.

## v0.2.2 paths covered automatically

The automated suites cover, among other paths:

- a single Provider request returning both `english` and `back_translation`;
- independent and disabled back-translation modes;
- short-Chinese language validation and non-Chinese back-translation rejection;
- one controlled repair/retry path without open-ended loops;
- independent back-translation receiving only English user content;
- English and back-translation placeholder integrity as separate hard gates;
- user text that merely resembles a plugin placeholder;
- fenced JSON, gateway metadata and bounded malformed-JSON scanning;
- duplicate, overlapping and unsafe typo claims plus forced literal retry;
- exact Provider/Key destination binding and credential-generation checks;
- refusal of a new-generation Key to an old or mismatched Provider snapshot;
- transactional Provider/settings/Secret rollback across local/session storage;
- behavior-only settings saves that do not rewrite Provider state;
- external Provider/Key storage changes that invalidate and pause a stale panel;
- current-panel configuration saves that do not falsely trigger the external-change guard;
- case-insensitive custom Header de-duplication and sensitive Header removal;
- bounded sequential fallback for unsupported `response_format` and `temperature`;
- model-not-found versus endpoint-not-found HTTP 404 classification;
- truncated, filtered, tool-call, function-call, structured-refusal and non-text response rejection;
- request, response, model-list and stored-state resource limits;
- window-scoped draft/history/diagnostic storage and legacy migration;
- Writer lease transfer, not-ready recovery and stale-bind rejection;
- `history.pushState()` session invalidation before stateful Writer commands;
- expired command rejection, Target Epoch and Writer Session checks;
- textarea, ordinary contenteditable and `contenteditable="plaintext-only"` discovery/write paths;
- multiline editor serialization and meaningful blank-line preservation;
- transactional restore and fail-closed recovery;
- attachment, media and atomic-rich-content protection;
- manual-edit detection and explicit confirmed overwrite;
- trusted send, plain-Enter line break and external-clear classification;
- monitored asynchronous draft/history persistence failures;
- preservation of active drafts up to 250,000 characters while keeping the translation limit at 50,000.

## Static audit boundary

The audit verifies:

- Manifest, package and runtime version agreement;
- only the intended required and optional permissions;
- no `debugger`, Cookie, history, proxy, webRequest, clipboard-read or broad required host permission;
- strict extension CSP with no `unsafe-inline` or `unsafe-eval`;
- no remote JavaScript;
- no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` or `Function` constructor;
- `writer.js` contains no storage access, fetch/XHR/WebSocket/beacon, Cookie, localStorage or sessionStorage access;
- secure storage access-level initialization is present;
- runtime Secret access is Provider-bound and unbound Secret APIs are not exported;
- Provider identity, credential generation, cross-window invalidation, bounded compatibility fallback, route/session synchronization, attachment protection, window scoping, transactional configuration and tool/refusal rejection invariants are present.

## Chromium package validation

Chromium successfully produced a disposable test CRX from the clean release tree. The temporary signing key and CRX were deleted and are not included in the user ZIP. Headless Chromium can emit container-specific system warnings, but the pack operation produced both expected artifacts and exited successfully.

## Release-content checks

The ZIP excludes:

- `.git`;
- `__pycache__` and `.pyc`;
- CRX/PEM signing artifacts;
- operating-system metadata files.

A scan for common OpenAI/xAI key shapes and private-key blocks found no embedded credential. The final ZIP was tested with `unzip -t`, extracted into a new directory, and subjected again to the full verification command.

## Validation boundary

The package has **not** been tested inside an authenticated Claude account in this environment. The first real installation must run the built-in **页面诊断** and manually verify that visible composer text equals the message actually sent.

Claude can change its editor implementation at any time. Until that GO/NO-GO check passes for the current frontend, use the English preview/copy fallback for important text. The extension intentionally does not read sent Claude messages, so this final comparison cannot be automated without expanding the privacy boundary.

The default same-request back-translation is a **model self-check**, not an independent semantic proof, because the same model sees the original Chinese. Important instructions can use the optional independent mode, in which the second request receives only the English text.
