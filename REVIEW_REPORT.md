# v0.2.2 代码自审与修复报告

审查日期：2026-07-19  
基线版本：**0.2.1**  
修复版本：**0.2.2**

## 结论

v0.2.1 已经解决 Claude Writer、附件保护、发送识别和富文本事务中的主要风险。本轮继续沿以下链路审查：

1. 多窗口 Provider/Key 更新；
2. Provider capability 兼容回退与持久化；
3. 扩展存储事件与旧请求失效；
4. 自定义 Header 规范化；
5. Chat Completions 参数兼容；
6. Claude 编辑器候选定位。

确认的最高风险问题是：**一个窗口缓存旧 Provider，而另一个窗口保存新 Provider/Key 后，旧窗口可能从共享 Secret 槽位读到新 Key，并把它发往旧目标。** v0.2.2 用 Provider 身份绑定和凭据代次修复该问题，并让外部配置变化立即作废当前运行上下文。

## 已修复问题

### 1. 多窗口下旧 Provider 可能配到新 Key

旧设计以本地/会话两个固定 Secret 槽位保存 Key。窗口 A 持有旧 Provider 对象，窗口 B 保存新 Provider 和新 Key 后，窗口 A 若只读取当前 Secret 槽位，就可能把新 Key 放入旧 Base URL 请求。

**修复：**

- 每次明确保存配置生成新的 `credentialId`；
- Secret 保存为版本化 envelope；
- envelope 记录 `credentialId` 和规范化的 `providerBinding`；
- 请求前同时读取当前存储 Provider 与 Secret；
- 比较 Provider Base URL、鉴权 Header、鉴权前缀、额外路由 Header、Key 保存模式和凭据代次；
- 任一不一致都返回配置变化错误，不发网络请求。

### 2. 旧窗口可在新配置保存后继续运行

旧侧栏不会主动知道另一窗口已经改了模型、Base URL、Key 或回译方式，旧请求可能继续完成并尝试写入。

**修复：**

- 监听 `chrome.storage.onChanged`；
- 外部 Provider、设置或 Secret 变化会合并处理；
- 取消主翻译、回译和写入相关异步任务；
- 增加运行上下文代次；
- 自动暂停并显示“配置已在其他窗口变化”；
- 用户检查配置后才能恢复。

当前窗口自己的事务保存会携带预期签名和凭据代次，因此不会被自身存储回声误暂停。

### 3. 行为设置保存可能覆盖另一个窗口的新 Provider

旧的通用保存路径有机会把内存中的 Provider 快照与普通行为设置一起写回。若另一个窗口刚保存新 Provider，旧窗口修改防抖时间等行为项时可能回写旧 Provider。

**修复：**

- 新增 `saveBehaviorSettings()`，只写行为设置；
- Provider 仅在用户明确保存完整配置时写入；
- 普通翻译流程不再持久化整份 Provider 快照。

### 4. 运行时 capability 回退可能持久化过期配置

兼容网关拒绝 JSON mode 或 temperature 时，旧逻辑可能把当前内存中的 Provider 连同 capability 一起写回，覆盖外部的新配置。

**修复：**

- 运行时 capability patch 默认只更新当前冻结请求上下文；
- 不在普通翻译时写 Provider；
- 只有用户明确执行连接测试并保存，才将经验证的 capability 持久化。

### 5. 旧版本裸 Key 迁移边界

直接禁止旧 Key 会让升级用户立即失去已保存凭据；长期兼容裸字符串又无法提供 Provider 绑定。

**修复：**

- 旧 Provider 仍无 `credentialId` 时，可以读取对应旧裸 Key；
- 下一次明确保存生成新 `credentialId` 并迁移到 envelope；
- 新 Provider 已有 `credentialId` 后，旧窗口或旧代码不能读取新 Key；
- 本地与会话保存模式切换仍以事务执行并可回滚。

### 6. 存在无 Provider 绑定的 Secret API

只按存储模式读取 Secret 的通用接口，未来容易被新功能误用，重新引入 Key/目标串用。

**修复：**

- 删除运行时导出的无绑定 `getSecret()` / `setSecret()`；
- 所有请求使用 `getSecretForProvider(provider)`；
- 静态审计明确禁止重新导出无绑定 Secret 读取和写入。

### 7. 自定义 Header 大小写重复

HTTP Header 名称大小写不敏感，但对象键大小写敏感。用户可能同时配置 `X-Project` 与 `x-project`，浏览器或网关的合并行为不一致。

**修复：**

- 保存和运行时均按小写名称去重；
- 保留第一项合法值；
- 继续拒绝 Cookie、Host、Origin、Referer、正文控制 Header、敏感凭据 Header和危险对象键。

### 8. 参数兼容可能需要两步而不是一步

部分兼容网关第一次只报告不支持 `response_format`，移除后第二次才报告不支持 `temperature`。只允许一次综合回退会让本可使用的网关失败；同时无界重试会产生费用和循环风险。

**修复：**

- 每次只移除远端明确拒绝的字段；
- 最多移除 `response_format` 和 `temperature` 各一次；
- 最多两次受控兼容重试；
- 任意无关 400/422 不重试；
- capability 仅在当前上下文更新，除非连接测试后明确保存。

### 9. `contenteditable="plaintext-only"` 未被识别

部分现代编辑器使用 `contenteditable="plaintext-only"`，旧选择器只覆盖 `contenteditable="true"`，可能无法定位。

**修复：**

统一编辑器选择器，支持：

- `textarea`；
- text/search/url/email 类型 input；
- 无 type 的文本 input；
- 任意 `[contenteditable]`，但排除 `[contenteditable="false"]`。

所有候选仍要经过可见性、尺寸、位置、发送控件和写入能力评分，避免误选页面其他编辑区域。

## 继续保留的关键设计

- 中文、Key 和 Provider 请求位于 Edge 侧边栏扩展上下文。
- 内容脚本不访问扩展存储、不发网络请求、不读取 Claude 对话。
- 默认一次请求同时返回英文和中文回译；独立回译和关闭回译仍可选。
- 中文原稿永不静默修改；越界纠错本地拒绝。
- Writer 使用明确标签页租约、Writer Session、Target Epoch、事务回读和条件回滚。
- 带附件或不可安全替换的原子富文本节点时拒绝自动覆盖。
- 最终发送由用户完成；零自动点击、零自动回车、零回复抓取、零风控规避。

## 自动验证

本轮最终工作树通过：

- JavaScript 语法：12/12；
- Node 单元/集成：52/52；
- Writer Chromium 冒烟：通过；
- Writer Chromium 安全套件：通过；
- Panel Chromium 冒烟：通过；
- Panel Chromium 状态机：通过；
- Manifest、权限、资源与危险 API 静态审计：通过。

新增回归直接覆盖：

- Provider/Key 目标和代次精确绑定；
- 旧面板不能读取新代次 Key；
- 当前窗口自保存不误暂停；
- 外部 Provider/Key 更新取消并暂停旧上下文；
- 行为设置不覆盖 Provider；
- Header 大小写去重；
- 两步参数兼容降级；
- `plaintext-only` 编辑器定位和写入。

## 仍需人工验证的边界

构建环境没有登录用户的 Claude 账户，因此无法自动核对：

> Claude 输入框中看见的英文，是否与用户点击发送后真正发出的消息全文完全相同。

这是首次安装、升级和 Claude 前端明显改版后的 GO/NO-GO 项。未通过前，重要内容应使用英文预览和复制模式。

## 后续可提升但未纳入本版

- Responses API 方言；
- 兼容要求 query 参数的 Provider；
- 极简术语表/不翻译词表；
- 更细的费用与请求计数；
- 对真实 Claude 前端的可选手工诊断导出，但仍不收集对话正文。
