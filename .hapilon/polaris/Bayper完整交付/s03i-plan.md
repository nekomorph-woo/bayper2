# S03i 自动共享的持久全局控制

Codex受托决定，2026-10-27。来源：memory-and-sharing.md「默认不全员共享」。这是完整自动共享链的第一个可使用切片，不声称自动主题分享已接入。

## 范围与方案

正式设置页增加紧凑的「记忆」分区，提供「允许角色之间自动分享主题见闻」开关与明确说明：仅主题日常/探索小故事，私聊偏好和Coding Agent内容不自动分享；关闭不删除已共享内容，明确转告仍有效。默认开启代表允许窄范围分享，不代表已经有后台分享行为。状态持久化在现有SQLite，使用既有app_state或记忆存储的最小入口，不造新配置框架。memory.share为自动/派生入口，必须受此控制；memory.relay显式用户转告不受全局自动开关影响，原逐事实限制仍强制。设置读取与修改仅正式可信主窗口IPC，不从模型/正文执行。

本轮不做自然语言全局开关识别、自动主题调度、24小时上限、主题选择或模型新请求；接续片必须补齐。不得以本开关替代主题白名单、名单资格与预算检查。界面不得说已全面支持自动共享。

## Acceptance Contract

| ID | Given / When | Expected / Oracle |
|---|---|---|
| POL-AUTOSHARE-CONTROL-001 | 新库，正式设置读取并关闭，重开应用 | 默认开启；关闭后实际SQLite保存且重启UI保持关闭；不删除任何记忆，不改变名单/数值，不发API |
| POL-AUTOSHARE-CONTROL-002 | A有可分享事实，关闭全局开关后调用真实memory.share | 明确拒绝且B无新增记忆/FTS/上下文变化；重新开启可使用原share路径；既有逐事实禁分享仍拒绝 |
| POL-AUTOSHARE-CONTROL-003 | 全局关闭，用户通过真实relay明确转告给已结识B | 指定事实分享成功、保留来源；不更改全局开关；其他事实和角色不变；禁分享事实仍拒绝 |
| POL-AUTOSHARE-CONTROL-004 | 正式设置页960×680和1200×800，切换记忆分区并操作 | 开关/说明/反馈完整可见，无整页滚动；保存失败不假显示成功，非布尔参数和非可信窗口请求拒绝 |

Runner采用项目现有Node领域与Electron/Playwright真实应用路径，各自清楚标注SQLite真实/模型本地HTTP或无请求边界。独立固定Case，不建通用Runner，保留截图、源码摘要、实际状态与清理。Codex冻结生产后独立执行并看截图；所有自建应用/临时库/HTTP必须清理，禁止访问用户来源或.env。

## 允许改动与规模

Claude Code实现：app/memory.cjs、app/memory-store.cjs（或已有store的最小接线）、app/main.cjs、app/preload.cjs、app/renderer/index.html、app/renderer/app.js、必要最小CSS；新增一个本能力Renderer文件仅在避免app.js职责混杂确有需要时。测试只新增本片领域和GUI Runner，必要更新原有精确IPC白名单并说明。实现预期约150～250行、领域测试约200行、GUI约300～450行；规模是审查信号，勿压缩可读性凑数，超范围先报告。不得改版本/Git/PRD、无关动画或现有Expected。遵守AGENTS与CLAUDE，不读取.env或运行GUI；Codex统一安排GUI。

## Codex静态审查补充

新记忆分区须覆盖「记忆→连接器→记忆」往返：既有connector-settings.js独立展示面板，而app.js的state.settingsTab可能仍为memory，按钮早返回会令第二次记忆点击不切换。修复应统一准确记录当前分区或消除失效早返回，保持来源面板停用逻辑，不扩张重构。
