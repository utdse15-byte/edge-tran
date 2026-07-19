# edge-tran v0.2.4 修复说明

本目录由用户提供的 v0.2.3 源码直接修复生成。

- 将 HTTP 200 HTML、空正文、非 JSON、逻辑错误、Responses API 和未知 JSON 结构从 `empty_response` 中拆分。
- 对裸 `/chat/completions` 或 `/models` 返回 HTML 的情况提示 Base URL 可能缺少 API 前缀；不自动改 URL 或重试。
- 仅记录安全协议元数据，不保留 API Key、Authorization、提示词、请求正文或完整响应正文。
- 改进 Claude 输入框定位：父级语义、disabled 空态发送按钮、Lexical/ProseMirror、较短内部编辑节点和后出现的更优候选。
- 手动绑定等待 DOM 稳定并验证节点；React 替换、页面导航、租约变化或 detach 时不会虚假报告成功。
- 版本号已统一为 0.2.4。
