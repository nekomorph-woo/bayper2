# S05a 连接来源与独立 Agent 事实账本

Codex受托确认。依据PRD连接器归属、双向启动/重连、每Agent独立及通知必达规则，state-and-rhythm.md七种工作状态。先交付真实SQLite服务，不连接真实Herdr、不接GUI；后续适配和气泡要消费本服务，不另建并行事实源。本轮不声称已完成插件或通知体验。

## 业务边界与接口

只新增app/connector-ledger.cjs（确需可另拆connector-store.cjs）和tests/acceptance/connector-ledger.spec.cjs。禁止改已有文件/main/store/renderer/其他测试/版本/Git/文档。factory注入db、now、appRunId；返回明确的登记上线、断联、确认停止、时间推进、写Agent变化、应用快照和读取接口。具体命名可由开发者决定，但以下语义不变。

一个来源instanceId标识稳定安装/端点，runId标识来源进程运行代次，二者由适配层提供，不能只用显示名。Agent键含instanceId/runId/agentId，适配层必须让agentId包含实际终端/运行身份。来源名称和会话/工作区/终端可读标签只是展示字段。实例状态online/reconnecting/offline，主动停用持久化；连上已停用实例不得自动复活，只有明确启用才可恢复。初始无连接对象无需伪造connecting记录。

返回状态/账本读取只给结构化事实，不生成模型台词、不消费角色精力/亲密度/心情。数据库工厂幂等建表，复用注入连接，不再开生产库。业务事务失败必须全部回滚。

## 不变量

1. 来源首次可用在本次appRunId+instanceId+runId下仅产生一次online(P2)。重复登记/握手不重复。新runId使旧代次当前对象失效；迟到旧runId事件/停止/断线不能更改新代次，不自动切回旧runId（保留已知运行代次，旧代次登记也拒绝）。app重启的新appRunId允许一次上线提示，旧连接记录须先暂不可确认，不把上次online当已连接。
2. 首次断联保留首次时间，不因重复EOF延后。Agent当前effectiveState改为unknown但lastKnownState保留，不生成所有Agent的finished/stopped。满3000ms产生一次disconnected(P1)。短断联恢复不出新online/recovered；已提示断联后恢复一次recovered(P2)。确认停止一次offline(P1)；重复不追加。明确停止与临时断联区分。主动停用停止自动恢复，记录停用事实但不伪造server stop。
3. Agent工作状态为idle/working/needs_attention/finished/failed/stopped/unknown；保留rawState、来源时间（可空）和接收时间。done不在此模块猜成成功，由适配层映射finished，不能推定成果正确。首次权威快照建立基线，无Agent变化通知；在线事件真实working→needs_attention→working三条均入账；needs_attention P0，finished/failed/stopped P1，其他P2。
4. 同一事件eventId在来源运行代次内只入一次；同一状态后来的新episode不被永久去重。事件需带可比较非负整数sequence（由有依据的适配器提供，本轮fixture为可控来源）；当前状态只接受更大的sequence。晚到旧sequence若是真实未记录事件，可补入历史，标historical，不回滚当前；与当前sequence相同但状态冲突拒绝，不静默覆盖。不要把本模块sequence约定宣称成Herdr全局原生事件序列。
5. 快照每Agent带sequence，用于当前状态对账。重连快照与已知最高sequence比较，不能回滚。快照比已知新且状态变化，可记录一条reconciled变化（含观测缺口，不补造中间事件）；当前needs_attention按P0，其余按对应优先级。重连快照状态不变不重复旧episode通知。事件先于快照到达或快照先于事件到达，同一Agent/sequence/state的事实只产生一个通知项，后来补事件身份仍记去重关联。初始基线相同episode的迟到事件不冒充新变化。没有共享snapshot序列时，Herdr适配器须重新权威读取，本轮不解决网络缓存顺序。
6. 快照中缺少某Agent只标其当前状态unknown/不在当前快照，不能据此伪造stopped或finished。快照完整性由调用方明确声明；不完整快照不能将其他Agent清空。传入gapped标记留下一次可追溯缺口记录，重复恢复批次不刷屏。停用/断联不删除历史。
7. 账本存储事件身份、Agent/来源、状态、receivedAt、occurredAt可空、priority、historical/reconciled、通知状态pending。提供分页明细及pending列表，外部后续可标记已呈现；这里不得把入队等同用户可见。列表上限合理有界、稳定顺序，不用一个内存数组代替持久化。正常退出/重启保留未呈现事实，同appRunId服务重建不重复上线。多实例互不干扰。

当前只做这一薄服务，建议总生产350～500行、场景350～500行，复杂度超出先报告拆分，不堆通用事件框架、不压缩写法凑行数。若接口无法同时满足以上语义，报告具体冲突，不自行削弱Expected。

## Acceptance Contract（执行后再标结果）

真实临时SQLite和生产服务；可控now/来源事实fixture，无网络/GUI/真实Herdr。独立SQL与对外读取共同判Oracle，测试用Given/When/Result/Expected清楚表达。临时DB finally清理，失败日志保留。

| ID | Given / When | Expected / Oracle |
|---|---|---|
| POL-CONNECTOR-001 | 两实例同名/同局部AgentID，重复登记+初始快照 | 各一次online；Agent隔离，初始快照不冒充变化，标签不作身份 |
| POL-CONNECTOR-002 | working→attention→working及重复event、同Agent再次attention、迟到低seq事件 | 真实过程完整，重复不入账，后续episode通知；当前不倒退，历史条目可区分 |
| POL-CONNECTOR-003 | 1秒短断、重复EOF后满3秒长断、恢复、重复恢复、明确stop | 短断无闪动提示；长断一次P1，恢复一次P2；stop一次P1，无批量Agent完成 |
| POL-CONNECTOR-004 | 断档恢复，事件/快照以两种顺序交错，缺Agent、相同episode重读 | 当前不倒退、不双通知；新状态对账、缺口留痕；缺Agent unknown而非stopped |
| POL-CONNECTOR-005 | 真重启新runId+旧消息/旧握手迟到；主动停用后自动登记 | 新生命周期一次上线，旧运行不能污染新；停用不自动启用；明确启用后可连接 |
| POL-CONNECTOR-006 | pending入库、同appRunId重建/新appRunId启动、故障trigger事务回滚 | 持久化保留通知与去重；新app运行需重新连接才online；失败无半个来源/Agent/事件结果 |

后续S05b真实插件/发现/订阅映射须验证server run身份和每Agent序列来源；S05c消费pending实现3普通+1加急可见气泡、时限、阅读时长与排队，不把本轮账本通过当通知交付。
