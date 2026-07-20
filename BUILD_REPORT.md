# Build Report

- Version: **0.2.12**
- Date: 2026-07-20
- Baseline: `npm run verify:full` 全部通过
  - Node 测试（`node --test tests/*.test.js`）
  - 语法检查（`scripts/check-syntax.js`）
  - 静态审计（`scripts/audit.mjs`：版本一致性、清单资源、权限、CSP、安全不变量）
  - 4 个 Chromium 套件（writer 冒烟 / writer 安全 / panel 冒烟 / panel 状态机）

## 版本内容

- 0.2.5：深度缺陷审查修复（1 高危 / 5 中危 / 7 低危），见 CHANGELOG。
- 0.2.6：Responses API 支持与使用稳定性修复（按钮卡死回归、空态定位、换会话/断连恢复）。
- 0.2.7：外部审计核验修复——暂停原因隔离、跨窗口密钥回滚防护、纠错语义边界扩展（极性/异体数字）、中文复述与回译比例硬门禁、中文数字数值核对、审阅门禁（纠错/歧义/数量提示阻断自动同步）、SW 异步边界租约再校验、还原后长度上限、Responses/Chat 解析严格化（completed/assistant/finish_reason 白名单、对象标记校验、去除 legacy text 回退）、/models 结构校验、密钥样式请求头扩展拦截、诊断路径默认脱敏、附件兄弟节点 aria 检测、可写性命令前再校验、编辑器周期性重排名、Markdown 变长围栏与多反引号行内代码、路径分隔符扩展、保护词去重后限额与重叠匹配。
- 0.2.8：速度优化——流式预览（SSE，透明缓冲回退）、会话级翻译缓存、规范化等价编辑不重译。
- 0.2.9：思考强度兼容层 v1——方言编码器（OpenAI Chat/Responses、OpenRouter、DeepSeek、thinking_type、enable_thinking）、别名先剥离后构造、严格拒绝语义（reasoning_rejected 不重试）、映射预览与 reasoning_tokens 证据、凭据绑定不受思考配置影响。
- 0.2.10：体验收敛——主按钮如实文案、三态自动化（含旧配置迁移）、单向 Esc、人工修改保护默认、双上限计数器、回译请求次数标注、:focus-visible 可达性。
- 0.2.11：摩擦清除与可诊断化——系统性暂停自愈（pauseKind 四分类）、外部配置采纳并继续、评审门默认非拦截（可选严格评审）、HTTP 错误网关证据（脱敏正文摘录/request-id/协议+流式标记）、连通测试传输镜像与失败自动定位（缓冲/协议对照）。
- 0.2.12：零删除与定位稳定——移除旧译文自动清理（含中途换稿闪空）、已有内容安静保护态、CLEAR_TARGET_FORCE 显式清空按钮（附件仍受保护）、居中主输入框形状识别修复切页定位、visibilitychange/focus/状态询问重扫触发。

## 注意

- 涉及 claude.ai 真实 DOM 的发送确认行为，仍需按 README「首次页面验证」在真实账户复验。
- 发布打包目录应与既有侧载目录一致，避免 Edge 识别为新扩展。
