# S05b Socket传输独立审查

87707 completed。Codex独立现有3/3通过（evidence/s05b-codex-first.log），但逐字段对照本机schema发现真实兼容缺陷，不能接受。以下由Codex受托确认，不缩减原契约，先补有效失败再修。

## 必修

1. validateSubscriptions只返回type，丢掉必需pane_id；且按type去重，无法在同一订阅包含两个pane的状态。request.$defs.Subscription明确pane.agent_status_changed required[type,pane_id]，agent_status为可选合法AgentStatus/null过滤。必须校验并保留pane_id，支持不同pane同type，只拒绝相同订阅重复；handle元数据/本地序号正确按type+pane归属。事件内容缺pane和订阅参数缺pane是两个独立校验，现有测试只做前者。
2. subscription_event.$defs.PaneAgentStatusChangedEvent required[pane_id,workspace_id,agent_status]，没有data.type。handleEvent目前要求data.type匹配canonical，因此拒绝真实status wire。应分别按status订阅数据与普通event数据校验，不强迫二者同形。不加猜测性兼容掩盖schema；真实fixture应抄录最低合法schema字段，更新既有错误fixture，不改业务Expected。
3. 所有subscribe都使用sub-0/sub-1，当重订阅/多连接时身份冲突，不能实现规格约定的“订阅代次+接收序号”。本地ID包含本transport唯一前缀与每次subscribe唯一代次，订阅成员再标type/pane；它仍不是服务端ID。测试两个同时订阅和close后重订阅同pane，localIndex可从1重启但组合身份不可相同。
4. pre-ack buffered数组没有总量上限。合法小行持续到来可在ack超时前大量积累。为确认前缓存设清楚条数/字节上限（可用256条/1MiB，测试注入小限），超出明确gap/error并终止，不能丢一部分后继续称完整；end清空缓存。保留ack后有序投递与取消不再回调。
5. events_lost分支在id匹配前就终止；不匹配请求ID的错误也会杀死本订阅，与原不串ID约束冲突。无ID的流级events_lost或匹配当前ID才终止；别的ID忽略。补有效反例。

## Case修订

POL-TRANSPORT-001按schema核对实际request，两个不同pane状态订阅必须保留各pane，缺pane本地拒绝；POL-TRANSPORT-002使用真实无data.type状态payload，保留普通拓扑payload，检查事件归属/次序。新增POL-TRANSPORT-004涵盖重订阅身份、pre-ack上限及错ID events_lost，实际临时Unix socket运行、onClose一次、完整清理。原003失败/退出行为继续回归。不得擅自连接现有Herdr。

限app/herdr-transport.cjs与tests/acceptance/herdr-transport.spec.cjs，证据s05b-transport新日志。420行生产已偏大，不再加通用SDK/复杂适配框架；直接修订阅元数据与明确分支。无需删必要错误路径来压行数。真实Herdr隔离接线仍为下一步，测试通过不代替真实协议验证。

## r2独立接受（仅传输模块）

78824 completed，Codex独立herdr-transport.spec.cjs 4/4，evidence/s05b-codex-r2.log。原schema错误已在run-review-fail.log形成001/002/004真实失败。核对实际代码：pane参数/过滤保留、同type多pane、无data.type状态payload、每transport/每订阅本地身份、preack256条/1MiB上限、错ID先过滤，均对应修订契约。普通拓扑仅基本形状校验，不宣称完整schema验证。493行生产/791行测试偏大，但协议读请求/订阅两条路径直接分开，无通用SDK，暂保留必要失败矩阵。

本地transportSerial只保证当前Node进程内实例唯一；正式持久化adapter必须将appRunId/来源run与订阅ID共同作为观测身份，不能跨应用重启直接复用transportSerial当全局唯一ID。尚无正式adapter/插件/GUI通知或真实Herdr互通PASS。真实互通下一步按s05b-live-plan.md执行，首次协议错误证据保留，不能被后续成功掩盖。
