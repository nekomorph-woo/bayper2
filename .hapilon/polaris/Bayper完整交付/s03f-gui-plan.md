# S03f 正式聊天窗口验收补片

2026-10-27，Codex受托决定。S03f服务已提交ebd2080/v147，正式窗口仍未验。沿用s03f-chat-memory-operations-plan.md，不新增业务规则。

POL-CHATMEM-UI-001：Given真实Electron首次配置并接纳凛、独立SQLite构造可控的三条事实（饮品偏好、住址、出行偏好）与无关事实；When通过真实聊天输入框发送明确纠正、禁分享、删除，再在同一对话追问已删住址，最后关闭聊天从正式记忆页回看；Expected用户看到本地实际结果的确认，纠正后的完整正文与无关事实保留，禁分享落库且relay被阻止，删除住址及本轮命令不进入后续模型messages、不再展示为有效记忆，重启后状态一致，无角色/名单/数值意外变化。Oracle为实际DOM可见结果、只读SQLite和构造HTTP收到的messages三侧，不用直接调用IPC代替发送按钮。

Execution Boundary：真实main/preload/renderer/chat/memory/SQLite；模型为本地构造HTTP服务，角色与记忆seed明确记录，不声称真实模型学习。不得使用用户数据或.env。不修改服务、动画、主窗口视觉与其它业务；发现业务失败保留证据后报告，由Codex审查再决定修复。

代码范围仅新增tests/acceptance/chat-memory-operations-ui.spec.cjs，复用既有测试设施，约200～350行信号，不复制整个chat-ui、不建通用Runner。证据唯一批次，保存失败、截图、actual messages、必要数据库状态、源码SHA与清理；确认子进程退出后删除fixture。

调度：Claude先写测试并做语法检查，禁止启动GUI；Codex当前47550独占窗口。CLI终态后由Codex确定GUI已释放并执行。业务与清理失败都应令测试失败，不吞finally异常。用户体验结论标Codex，不冒称人类。
