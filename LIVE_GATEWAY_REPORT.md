# 真实网关联调报告（0.2.14）

## 为什么要做这一轮

到 0.2.13，Provider 层的自动测试全部是这个形状：

```js
globalThis.fetch = async () => new Response(JSON.stringify({ choices: [...] }), { status: 200 });
```

手写 `Response` 能覆盖**响应结构**，但整条 HTTP 传输链从未被执行过。以下全部在覆盖范围之外：

- 分块传输（chunked）与不带 `Content-Length` 的响应；
- SSE 事件被切在 TCP 包边界上，以及多字节 UTF-8 字符被切在中间；
- 请求头的内容协商（`Accept`）；
- `Content-Encoding`（gzip / 声明与实际不符）；
- 重定向、socket reset、发完响应头就僵死的连接；
- 客户端因超限取消流时，**服务端是否真的观察到断开**；
- 网关把 `Content-Type` 标错、把错误正文写成 HTML、把 JSON 用 GBK 编码等真实中转站行为。

所以这一轮先**自建一个 OpenAI 兼容网关**（`scripts/mock-provider.mjs`，零依赖，111 个场景），把扩展放到真实 socket 上按真实使用方式跑，再逐项对照预期行为。

## 方法

三层，全部走真实 HTTP：

| 层 | 载体 | 覆盖 |
| --- | --- | --- |
| 传输/翻译管线 | `tests/e2e-provider.test.js`（89 项，`npm test`） | `lib/translator.js` + `lib/provider.js` 直接打真实 socket |
| 真实 UI 全链路 | `scripts/panel-live-provider-test.py`（`npm run verify:full`） | Chromium 里跑真实 `panel.js` → 真实 HTTP → 真实 writer 链路 |
| 人工联调 | `npm run mock:provider` | 侧载真实扩展，Base URL 指向本地网关（见 TESTING.md 场景表） |

模拟器内置一个确定性词典翻译"模型"，遵守扩展要求的 `english` / `back_translation` / `corrections` / `ambiguous` 契约与占位符规则，因此正常场景真的会走到成功路径，而不是只测失败分支。

## 确认并修复的缺陷

| # | 缺陷 | 严重度 | 现实触发条件 | 复现 |
| --- | --- | --- | --- | --- |
| 1 | 流式请求发 `Accept: application/json` | 中 | 做内容协商的网关以 406 拒绝，用户只看到"HTTP 406" | `/strict_accept/v1` |
| 2 | 流式响应丢弃 `usage` / `reasoning_tokens` | 中 | 流式预览默认开启 → 0.2.9 承诺的推理用量诊断在默认配置下从来不生效 | `/sse_usage_final/v1` |
| 3 | 流式路径不接受 typed content parts | 中 | 代理非 OpenAI 模型的中转站常用数组 content → 关掉流式能用、开着报"assistant 文本字段为空" | `/sse_array_content/v1` |
| 4 | 三个可降级字段只有两次降级预算 | 中 | 逐项拒绝 `response_format`/`temperature`/`stream` 的网关永远无法被满足，且不提示"关掉流式预览" | `/worst_case/v1` |
| 5 | 标错 `text/event-stream` 的 JSON 响应白白失败 | 低 | 对所有响应一律标 SSE 的网关；正文其实已在内存里 | `/sse_content_type_json_body/v1` |
| 6 | 丢失的流式事件被算到模型头上 | 中 | 中间丢一个 delta，流仍以 `finish_reason: stop` 收尾 → 报"模型可能复述了原稿"并多花一次修复请求 | `/sse_dropped_event/v1` |

配套的工程问题（同样修复）：

| # | 问题 | 影响 |
| --- | --- | --- |
| 7 | `npm run check` 只检查 `.js`，`.mjs` 整体跳过 | `scripts/audit.mjs` 自己从未被语法检查 |
| 8 | 4 个浏览器套件中 2 个把 Chromium 路径硬编码为 `/usr/bin/chromium` | 非 Debian 环境 `npm run verify:full` 直接跑不起来 |
| 9 | `TranslationValidationError` 的 errors 不去重 | 用户会看到"模型返回的 back_translation为空；…；模型返回的 back_translation为空" |

第 6 项的修复自身带一个陷阱，已一并处理：`[DONE]` 以 `[` 开头，若把 `data: [DONE] `（带尾随空白）送进 JSON 解析路径，就会被判成丢包。终止符改用 trim 比较，并加了回归测试。

## 复核确认无问题（不改动）

真实网关下逐项验证，行为符合设计：

- **凭据**：Key 只出现在鉴权头；秘密形状的 `extraHeaders`（`X-Api-Key` 等）被丢弃；`Cookie`/`Content-Type` 覆盖被拒绝；网关把 Key 原样写进 403 正文时，错误对象里也拿不到它；401/403 不重试、不携带远端正文。
- **限流**：`Retry-After` 的秒数与 HTTP-date 都能解析；冷却下限 3 秒、上限 24 小时；429 不触发重试风暴。
- **重试边界**：5xx、普通 400、无名参数错误在 Provider 层都不重试；只有"明确指名可降级字段"才降级。
- **安全上限**：超限响应在有 / 无 `Content-Length` 两种情况下都被截断；无尽流被取消，且服务端确实观察到连接断开；超大错误正文不会掩盖 HTTP 状态分类。
- **传输鲁棒性**：逐字节 SSE、切在多字节字符中间、CRLF + 注释心跳、`data:` 无空格、pretty-print 多行 data、`\uXXXX` 全转义且逐字节送达、无 `[DONE]` 收尾、close 定界正文、gzip、BOM、缺 `Content-Type` —— 全部正确还原，流式预览始终是最终文本的前缀。
- **拒绝该拒绝的**：重定向（`redirect: "error"`）、GBK 乱码、`error: null` 之外的逻辑错误、同时带可用 choices 与 error 对象的 200、Responses 只给 `output_text`、协议错配、空 choices、截断、拒答、工具调用、非 assistant 角色、未知 finish_reason。
- **内容保全**：Windows 路径、`~/`、`$VAR/`、URL、邮箱、行内与围栏代码、emoji 与星平面字符、字面占位符文本全部原样保留；占位符缺失/重复/伪造/换序分别报错或告警；占位符还原后超 100,000 字符按设计硬失败。
- **越界纠错**：中文数字改写、极性反转、超量纠错、非数组 corrections 全部本地拒绝；被拒绝后自动改走"禁止纠错"的字面重译。
- **计费**（服务端计数核对）：连打一串键只产生 1 次付费请求；重复翻译同一稿 +0；只加尾随空格 +0；流式回落到缓冲响应时不产生第二次请求；标错 Content-Type 的复用也不产生第二次请求。
- **运行期降级不落盘**：真实网关上发生的能力降级只存在于内存，未经显式连通测试不写入存储。

## 仍存在的限制与后续建议（本轮未改）

1. **Azure OpenAI 无法配置**。`normalizeBaseUrl` 拒绝查询参数，而 Azure 需要 `?api-version=…`，且路径是基于 deployment 的。设置里没有 Azure 预设，因此不算回归，但值得在文档里写明"不支持 Azure 端点"。
2. **单次草稿的最坏付费请求数为 5**（实测：流式 + 网关逐项拒绝三个字段 + 模型始终返回不可解析 JSON）。每层都有界，但**跨层没有累计预算**。建议：给单次草稿加一个总请求预算并在诊断里显示本次实际请求数。
3. **`Content-Encoding` 声明与实际不符**被归类为 `network_error`，文案指向"网络、权限与 Base URL"，与真实原因（解压失败）不完全对应。属罕见的代理配置错误，拆分收益不大。
4. **24 小时限流冷却没有界面内取消入口**。逃生路径是重新保存 Provider 设置或重开侧栏，但不可发现。建议在状态栏加一个显式"结束冷却"操作。
5. **受保护片段超过 1000 个**时抛的是裸 `Error`；`testTranslationConnection` 会把未知错误统一转成"连接测试失败"，从而吞掉"请减少重复保护词或拆分文本"这句可行动信息。路径很窄，但修起来也很便宜。
6. **Responses 只返回 `output_text`** 的网关被拒绝（0.2.7 起的严格策略）。如果实际遇到这类中转站，需要一次显式的取舍决策，而不是悄悄放宽。

## 如何重跑

```
npm run verify        # 语法（含 .mjs）+ 181 项 Node 测试 + 静态审计
npm run verify:full   # 追加 5 个 Chromium 套件（含 panel-live-provider）
npm run mock:provider # 人工联调：把扩展 Base URL 指向 http://127.0.0.1:8787/<scenario>/v1
```
