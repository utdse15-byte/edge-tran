# v0.2.2 深度缺陷审查报告

审查日期:2026-07-19
审查对象:`claude-zh-en-edge-extension` v0.2.2 全部源码(panel.js、writer.js、sw.js、lib/*、manifest.json、审计与测试脚本)
基线状态:`npm run verify` 全部通过(52 个单元测试、语法检查、审计脚本均无告警)

审查方法:三路并行深度代码审查(panel.js / writer.js / sw.js+storage+provider),外加对 lib 基础模块的独立复核;所有列入本报告的问题均经过第二轮人工代码路径验证,URL 规范化问题经实际运行验证。仅报告有具体失败路径的真实缺陷,不含风格问题。

结论概要:整体代码质量很高,大量竞态与安全边界处理严谨(详见文末"已检查且未发现问题的领域")。共确认 **1 个高危、7 个中危、12 个低危** 问题。多数问题集中在"发送确认/清除抑制"状态机、跨窗口/跨文档生命周期事件,以及个别校验的一致性缺口。

## 修复状态(v0.2.3)

本报告列出的全部问题已在 **v0.2.3** 中修复,逐项变更见 [CHANGELOG.md](CHANGELOG.md)。唯一例外:L14(内联编辑器可能被评分选中)未单独调整评分权重,而是通过 M3 的"隐藏输入框宽限期"机制缓解——主输入框短暂不可见时不再立即改绑其他编辑器;如需彻底解决需依据 claude.ai 实际 DOM 增加区分信号。

修复后验证:`npm run verify` 全部通过(Node 测试从 52 项扩充到 57 项,新增 7 个针对本次修复的回归断言),`npm run smoke:browser` 的 4 个 Chromium 冒烟/状态机安全测试全部通过。涉及 claude.ai 真实 DOM 的行为(M5 预渲染触发、L10 事件时序、L13/L14 附件与编辑器结构)仍建议按 README"首次页面验证"流程在真实账户中人工复验一次。

---

## 高危

### H1. 自动清除失败后留下的"抑制陷阱"会吞掉真实发送(writer.js)

**位置**:`writer.js:1256-1258`(布防)、`writer.js:1310-1320`(失败路径未撤防)、`writer.js:385-388`(抑制判断)、`writer.js:1061-1068`(focus_write_disabled)

**缺陷**:`handleClearIfOwned` 在尝试清除**之前**就执行 `clearSendIntent()`、`expectedWriteText = ""`、`suppressUntil = now + 900`。当清除失败(最常见:contenteditable 上 `allowFocus:false` 必然返回 `focus_write_disabled`)时,没有任何路径撤销这三项。此后:

- `reconcileComposerText` 第 385 行先更新 `lastObservedText = current`,再在 387/388 行判断抑制,因此被抑制的清空事件**永久丢失**(后续 reconcile 因 `current === previous` 直接返回);
- 388 行 `!trusted && current === normalizeText(expectedWriteText)` **没有时间上限**——按钮点击触发的发送经 ProseMirror 程序化清空 DOM,只会走 MutationObserver 的 `trusted:false` 路径,只要 `expectedWriteText` 仍为 `""`(即上次清除失败之后、下次成功写入之前),真实发送就会被无限期吞掉,而不只是 900ms 窗口内。

**触发场景**(默认配置即可):`clearStaleTarget` 默认开启,用户修改中文后 `panel.js:1412-1426` 定时以 `allowFocus:false` 发起 `CLEAR_TARGET_IF_OWNED`;在真实 Claude 富文本编辑器上该清除**每次必然失败**(`focus_write_disabled`),陷阱每次布防。用户随后在 Claude 中点击发送按钮发出旧英文 → 既无 `SEND_CONFIRMED` 也无 `TARGET_CLEARED`:草稿不归档、面板仍认为旧英文在输入框中,`pluginOwned`/`lastWritten` 保持旧值;下一次 `WRITE_TARGET` 在 `writer.js:1138-1140` 把空输入框误判为"人工修改",弹出错误的人工修改横幅并暂停自动覆盖。

**附带观察**:由于 `setComposerText` 对 contenteditable 在 `allowFocus:false` 时直接拒绝,README 宣传的"中文一修改,就尝试无焦点清除旧译文"功能在真实 Claude 编辑器上实际上从不生效,只剩"旧译文横幅"这一兜底,同时每次都触发上述布防。

**修复建议**:清除/写入失败的所有出错路径上恢复 `expectedWriteText`/`suppressUntil`(或改为成功后才布防);`clearSendIntent()` 延迟到确认将实际改动 DOM 之后;并给 388 行的非受信抑制加时间上限。

---

## 中危

### M1. SPA 导航后插件写入的文本被误判为"人工内容",`previouslyOwned` 是死代码(writer.js)

**位置**:`writer.js:572-586`(`resetForNavigation` 先清零 `lastWritten`)、`writer.js:562`(重认领比较)、`writer.js:614-622`(同节点分支不恢复所有权)

**缺陷**:URL 变化时 `resetForNavigation()` 先把 `lastWritten` 置空,随后 `bindComposer(..., {previouslyOwned: wasPluginOwned})` 中 `previouslyOwned && current === normalizeText(lastWritten)` 对非空文本永远为假;同一编辑器节点保留的分支也从不恢复 `pluginOwned`。结果:任何保留草稿的 URL 变化都会把插件自己写入的英文重新归类为"人工内容",面板弹人工修改横幅,后续自动写入一律被 `manual_edit` 拒绝,必须走破坏性的强制覆盖确认。

### M2. 无效的普通 Enter + 3 秒内手动清空 → 伪造 `SEND_CONFIRMED`,草稿被归档重置(writer.js)

**位置**:`writer.js:421-434`(任何普通 Enter 都记录发送意图)、`writer.js:405-409`(只有插入换行的 inputType 会取消意图,删除类不取消)、`writer.js:390-393` + `313-343`(清空即按意图确认发送)

**缺陷**:Enter 在页面处于错误/限流状态下未产生任何效果时,意图仍保留 3 秒;期间用户全选删除输入框内容,reconcile 将其确认为发送 → 面板执行归档并清空中文原稿(可从"最近草稿"找回,但用户视角是"没发出去的消息被当成已发送")。另注:405-409 行的换行守卫对 ProseMirror 实际无效——PM 在 keydown 阶段取消原生编辑,受信的 `insertParagraph` input 事件根本不会出现。

### M3. 编辑器短暂不可见被误报为"外部清空",恢复后又变"人工内容"(writer.js)

**位置**:`writer.js:625`(可见性丢失即重绑)、`writer.js:88-94/66-79`(可见性属于 candidate 判定)、`writer.js:542-546`(`bindComposer(null)` 对仍存在的文本执行 `confirmClear`)

**缺陷**:任何遮挡/隐藏编辑器超过约 80ms 的覆盖层(模态框、`display:none` 祖先、`opacity:0`)都会触发重绑;`locateComposer()` 找不到候选时 `bindComposer(null)` 把**仍然存在**的文本当作外部清空上报 `TARGET_CLEARED`,面板中止在途工作并暂停;覆盖层消失后,因 `lastWritten` 已被 `confirmClear` 清零,原样的插件文本被再归类为人工内容,需要强制覆盖才能恢复自动同步。

### M4. 绑定的标签页被拖入其他窗口后,所有写入永久失败且诊断错误(sw.js)

**位置**:`sw.js:117/148/202`(`windowId` 仅在绑定/HELLO 时设置)、`sw.js:171-188`(前台判定查询旧窗口)、`sw.js:406-416`(`onActivated` 事件按旧 windowId 过滤)、无 `tabs.onAttached/onDetached/onMoved` 监听

**缺陷**:用户把已绑定的 claude.ai 标签页拖到另一个 Edge 窗口后(页面不重载,writer 端口存活,绑定保持),`isBoundTabActive()` 仍查询旧窗口的活动标签页,永远返回 false → 每个 `WRITE_TARGET`/`CLEAR_TARGET_IF_OWNED`/`GET_TARGET_TEXT` 都以 `target_inactive`("标签页不在前台")失败,即使该标签页在新窗口中处于前台聚焦状态;新窗口的 `onActivated` 事件也被过滤,状态无法自愈,直到用户手动重新绑定。

### M5. 预渲染(prerender)文档可接管 writer 槽位并继承租约(sw.js)

**位置**:`sw.js:325-353`(`registerWriter` 未检查 `sender.documentLifecycle`,按 tabId 替换并继承 `ownerPanel`/`lease`)、`sw.js:364-365`(HELLO 时重发 ATTACH)、`writer.js` 尾部 450ms 自动重连

**缺陷**:内容脚本会在预渲染文档中运行。同一 tabId 下,预渲染的 claude.ai 文档连接后会顶掉可见页面的 writer、继承租约并通过 `WRITER_HELLO` 重新 ATTACH,使后续写入通过全部租约/会话校验、落入**不可见的**预渲染输入框;与此同时可见页面 450ms 后重连又抢回槽位,两个活文档反复互踢。触发依赖 Claude 站点/地址栏实际发生预渲染,代码层面确认无防护。同一注册表还缺 `chrome.tabs.onReplaced` 处理(`sw.js:418-431` 只处理 `onRemoved`),标签页被替换后 `boundTabId` 指向死 id。建议:忽略 `documentLifecycle === "prerender"` 的连接(或等 `prerendering` 结束),并补 `onReplaced`。

### M6. 暂停状态下,用户显式点击"同步到 Claude"被静默丢弃;关闭回译模式下状态栏卡死(panel.js)

**位置**:`panel.js:1721`(守卫静默 return false)、`panel.js:2885-2889`(按钮 handler 不提示)、`panel.js:429`(按钮未因暂停禁用)、`panel.js:1579-1615`(off 模式只在 `synced` 时更新状态)

**缺陷**:Esc 暂停(界面只说"自动翻译与同步已暂停")后,"同步到 Claude"按钮仍可点击,`syncEnglishNow` 通过全部就绪检查后在 1721 行静默返回——无写入、无状态提示,按钮表现为"点了没反应"。关闭回译模式下更糟:暂停时点"立即翻译"能完成翻译并把状态设为"翻译完成,正在准备同步…",随后同步静默失败,该状态**无限期停留**。

### M7. 重新绑定时无条件把 `targetPhase` 设为 `synced`,旧英文显示绿色"已同步"(panel.js)

**位置**:`panel.js:1086-1092`(BIND_RESULT 不检查 `englishSourceRevision`)、`panel.js:405-409`(徽章判定中 `synced` 优先于旧译文检查)、`panel.js:972-986`(`bindCurrentTab` 的 `abortInFlight` 取消未触发的旧译清除定时器且不再重排)

**缺陷**:英文 R 已同步(pluginOwned),用户修改中文到 R+1(徽章"旧译文"),此时点"绑定当前页":在途的旧译清除定时器被取消且不再重排,`BIND_RESULT` 把阶段翻回 `synced` → 徽章变绿色"已同步",而 Claude 输入框里仍是与当前中文不匹配的旧英文,诱导用户直接发送。

---

## 低危

### L1. Base URL 末尾裸 `?` / `#` 绕过校验,生成必然失效的端点(provider.js)

**位置**:`provider.js:82-84`(`url.search`/`url.hash` 对空查询/空片段返回 `""`)、`provider.js:89-98`
**已实证**:`normalizeBaseUrl("https://api.example.com/v1?")` 返回 `https://api.example.com/v1?`,`endpointUrl` 生成 `https://api.example.com/v1?/chat/completions`(整个路径进入查询串);`#` 变体中片段被 fetch 丢弃,请求打到 `/v1`。复制粘贴带尾随 `?` 的 Base URL 能通过校验,但每个请求都 404/405,只显示"端点不存在"。应检查 `raw.includes("?")`/`raw.includes("#")` 或序列化结果。

### L2. `providerBinding` 写入无上限、读取截断到 120,000 字符,极端配置下 Key 保存成功却永远读不出(storage.js)

**位置**:`storage.js:260-274`(写入不截断)vs `storage.js:286`(读取截断)vs `storage.js:542`(逐字节相等比较)
最多 50 个额外 Header(名 ≤120 + 值 ≤2,000,JSON 转义可翻倍)可使绑定串超过 120k;截断后与新计算的绑定不相等,`getSecretForProvider` 永远返回空。截断应改为拒绝,保持相等性契约。

### L3. `saveConfiguration` 回滚可能覆盖另一窗口已提交的保存(storage.js)

**位置**:`storage.js:481-507`
快照→写入→失败→无条件恢复快照。窗口 A 拍快照后、失败前,窗口 B 的保存已提交,A 的回滚会把 B 的 Provider、设置和两个密钥区一并回退(保存串行化只在单窗口内,`panel.js:674-684`)。B 的内存 `credentialId` 与存储不再匹配,Key 读取变空。竞态窗口小但真实。

### L4. 凭据绑定串用 `localeCompare` 排序后持久化,跨语言环境/ICU 版本可能失配(storage.js)

**位置**:`storage.js:250`
ICU 对 `-`、`.`、`_` 等标点采用可变权重,排序结果可能随浏览器/系统语言环境或 ICU 升级变化;绑定串是持久化后逐字节比较的,顺序一变,已存 Key 静默失效。应改用码元排序(如 `(a, b) => a < b ? -1 : 1`)。

### L5. 非 Latin-1 的 Header 值/鉴权前缀通过校验,运行时被误诊为"网络错误"(provider.js / storage.js)

**位置**:`provider.js:137/166-171`、`storage.js:71-74/150`(均只拒绝 C0 控制符与 DEL)
`X-Route: 中文` 或前缀"令牌"可正常保存,但 `fetch()` 对非 ISO-8859-1 Header 值抛 `TypeError`,`requestJson` 的兜底把它归为 `network_error`("请检查网络、权限与 Base URL"),用户被引向完全错误的排查方向,且每个请求必现。

### L6. 错误响应体超过 128KB 时,`response_too_large` 抢在 HTTP 分类之前抛出(provider.js)

**位置**:`provider.js:263-271`(先读体后分类)、`provider.js:273-356`
代理返回大 HTML 错误页的 429 会变成 `response_too_large` 而非 `rate_limited`,`Retry-After` 不被解析、面板限流冷却不触发;大体积 401 同理丢失"检查 API Key"的提示。非 OK 响应应先按状态码分类(或分类时忽略读体失败)。

### L7. `minimum_chrome_version: 116` 低于 `storage.local.setAccessLevel` 的最低版本要求(manifest.json / sw.js / storage.js)

**位置**:`manifest.json:7`、`storage.js:374-386`、`sw.js:16-31`
`chrome.storage.local.setAccessLevel` 在 Chrome 118 才可用(session 区自 102 起)。在 116/117 上 `hardenStorageAccess()` 必然抛错:面板按设计失败关闭("安全初始化失败"),但 `sw.js:31` 的 `void initializeExtension()` 留下未处理拒绝且到不了 `setPanelBehavior`,工具栏按钮甚至打不开侧栏来显示错误。建议把最低版本提到 118,或在 SW 捕获并展示失败。(版本号请以 Chrome 官方文档为准复核。)

### L8. `registerPanel` 不校验发送方上下文,内容脚本隔离世界可获取面板级权限(sw.js)

**位置**:`sw.js:304-323/401-404`
任何以 `name: "zh2en-panel"` 连接的同扩展上下文(包括 claude.ai 标签页中的内容脚本隔离世界)都会被当作侧栏面板,可绑定标签页、发 `WRITE_TARGET`、接收含输入框文本的 writer 状态。仅在隔离世界被攻破时可达,属纵深防御缺口:注册面板前检查 `!port.sender?.tab` 即可关闭。

### L9. 文本控件(textarea/input)作为目标时,页面侧清空完全不可观测(writer.js)

**位置**:`writer.js:481`(MutationObserver 刻意跳过文本控件)、`writer.js:811-899`(却完整支持写入文本控件)
程序化 `value` 赋值既不触发 input 事件也无 mutation,页面发送后清空永远检测不到:无 `SEND_CONFIRMED`/`TARGET_CLEARED`,`lastObservedText` 永久过期,下一次写入误入"人工修改(空文本)"分支。当前 claude.ai 用 contenteditable,此路径仅在回退场景生效。

### L10. 编辑器上的 keydown 发送意图监听无法真正先于页面的 Enter 处理(writer.js)

**位置**:`writer.js:551`(注册在目标元素自身,`capture:true` 在 at-target 阶段无优先权)
事件目标即编辑器时,监听按注册顺序执行,ProseMirror 挂载时注册的处理器先运行;若其同步清空文档,`recordSendIntent` 读到空文本直接放弃(`writer.js:299-300`)→ Enter 发送永远只报 `TARGET_CLEARED`,不归档。点击路径无此缺陷(注册在 document 捕获阶段)。需实机验证实际时序。

### L11. 隐式 `type="submit"` 按钮一律计为发送控件(writer.js)

**位置**:`writer.js:441`
HTML `<button>` 默认 type 为 submit,表单包裹配置下,附件/麦克风/模型选择等未标 type 的工具按钮点击都会记录"button"发送意图;若点击导致编辑器 3 秒内重挂载且文本匹配,产生伪 `SEND_CONFIRMED` 归档重置。

### L12. 真实发送与 0ms reconcile 之间插入的 `WRITE_TARGET` 会毁掉发送确认(writer.js)

**位置**:`writer.js:1138-1140`(空文本走 `reportManualEdit("")` 并清掉有效发送意图)
发送清空 DOM 后、排队的 reconcile 执行前,恰好处理一条写入命令:空输入框被报为人工修改,意图被清除,随后 reconcile 因 `current === previous` 不再执行 `confirmClear` → 发送未归档。该前置检查缺一条"current 为空 → confirmClear"分支。竞态窗口极窄。

### L13. 附件失败关闭检测只扫描 contenteditable 的后代节点(writer.js)

**位置**:`writer.js:238-263`(`element.querySelector(...)` 仅查编辑器内部)
claude.ai 的文件/图片卡片通常渲染为编辑器的**兄弟节点**(同一输入容器内),此时写入/清除会在附件存在的情况下照常执行,与 README"存在附件即自动写入失败关闭"的承诺不符;后续 `SEND_CONFIRMED` 归档的文本也缺附件上下文。需按真实 DOM 结构扩大扫描范围(如输入容器层级)。

### L14. `locateComposer` 可能绑定到 Claude 的"编辑历史消息"内联编辑器(writer.js)

**位置**:`writer.js:143-178`
内联编辑框同样是 contenteditable(+50)、标签含 "message"(+45),加位置/宽度加分轻松过 60 阈值,没有与主输入框区分的减分项。当主输入框短暂不可见触发重绑(见 M3)且编辑框打开时,下一次 `WRITE_TARGET` 会改写用户的**旧消息**而非草稿。

### L15. `translateNow` 绕过 `abortInFlight` 直接 abort,回译徽章可能卡在"等待回译/回译中"(panel.js)

**位置**:`panel.js:1488-1489`(直接 abort,不重置 `backPhase`)对比 `panel.js:608-624`
独立回译模式:翻译 A 成功、回译进入 waiting;再点"立即翻译"后新主请求失败(如网络错误),catch(1616-1630)不触碰 `backPhase`,徽章停在"等待回译"且无任何在途任务,直到下一次输入或暂停切换才复位。`!apiKey`/`!permitted` 提前 return 同样留下此状态。

### L16. 目标不可用后 `pluginOwned` 未复位,产生"幽灵所有权"(panel.js)

**位置**:`panel.js:1220-1242`(TARGET_UNAVAILABLE/TARGET_TAKEN 清 tabId/session/currentText,但不清 `pluginOwned`/`composerReady`)
已同步后关闭 Claude 标签页,`pluginOwned` 仍为 true:点"清空草稿"会走 `targetStillContainsText` 分支,面板暂停并显示"Claude 中仍可能保留插件上次写入的英文"的错误横幅(标签页早已关闭);从历史恢复草稿同样误入 `stale-uncleared` + 无意义的强制清除路径。

### L17. 设置对话框已打开时 `translateNow` 的配置缺失路径会重置表单并抛 `InvalidStateError`(panel.js)

**位置**:`panel.js:1501-1505/1520-1524/1533-1537`(三处无条件 `openSettings()`)、`panel.js:2302-2307`(`openSettings` 总是 `invalidateFormRequests` + 清表单 + `showModal`)、`panel.js:2287`(`ui.apiKey.value = ""`)
自动翻译开启且未配置模型/Key 时输入中文会武装防抖定时器;若用户随即打开设置,定时器(≤2s)触发的 `translateNow` 走缺配置路径再次 `openSettings()`:表单被整体重填(丢弃刚粘贴的 Key)、在途"检测模型/连通测试"被中止,且对已打开的 dialog 调 `showModal()` 抛 `InvalidStateError`——模型缺失路径在 try 之外,成为未处理拒绝;另两处被 catch 吞掉后显示伪"翻译失败"。触发窗口窄(限防抖延迟内),但打开设置前应先取消防抖定时器、`openSettings` 应对已打开状态幂等。

---

## 已检查且未发现问题的领域

以下高风险区域经专项审查未发现缺陷,可作为后续维护的信心基线:

- **绑定代际协议**(sw.js):`bindGeneration`/`bindRequestId` 在每个 `await` 边界的过期检查完整;慢速旧绑定不会覆盖新目标(有测试覆盖)。
- **写入路径的租约/会话/纪元校验**(writer.js):`validateLease` + `expectedWriterSession`/`expectedTargetEpoch`/`deadline` + 串行化 mutation 队列,无重叠写入;写入 CAS(`expected+1`)规则在面板两侧一致。
- **panel.js 的核心竞态矩阵**:防抖 vs Ctrl+Enter 去重、`operationEpoch`/`revision`/`providerEpoch` 在每个 `await` 后的守卫、迟到 WRITE/CLEAR 结果的采纳路径、IME 组合守卫、50,000 码点与长文阈值边界、`storage.onChanged` 自回声抑制(覆盖 `saveConfiguration` 的多键序列)。
- **密钥事务与绑定**(storage.js):保存顺序(密钥→清陈旧→配置)在每个中间态对 `getSecretForProvider` 都失败关闭;旧版裸 Key 仅在双方均为旧格式时可读;无绑定读取接口确实未导出(审计脚本强制)。
- **兼容降级**(provider.js):最多两步、逐项、有界;无关 400/422 不重试;超时/中止分类与清理正确,面板的 Abort 不会被误分类。
- **占位符保护**(placeholders.js):随机前缀防碰撞、缺失/重复/未知占位符硬失败、恢复顺序安全。
- **XSS/密钥泄漏面**:全部 DOM 输出走 `textContent`/`.value`;诊断日志、状态串、配置导出中无密钥;审计脚本禁止 innerHTML 等模式。

## 验证状态说明

- 已实际运行验证:L1(URL 规范化)。
- 代码路径完整人工复核:H1、M1、M2、M3、M4、M6、M7、L2-L6、L8、L12、L15-L17。
- 代码确认存在缺口、触发条件依赖运行时环境,建议实机复验:M5(依赖预渲染实际发生)、L7(依赖具体 Chrome/Edge 版本行为)、L10(依赖 ProseMirror 事件时序)、L13/L14(依赖 claude.ai 当前 DOM 结构)。
