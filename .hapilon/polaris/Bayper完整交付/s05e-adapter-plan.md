# S05e Herdr逐Agent适配、重订阅与快照对账

Codex受托确认。依据PRD通知/连接器规则、s05b-protocol-review.md、s05d登记事实。接收真实Herdr，不把本地计数伪装成服务端sequence。目标为正式registry→transport→持久ledger；本轮不接main与气泡UI，随后以同一入口接生产发现。

## 范围

新增app/herdr-adapter.cjs；必要窄改app/connector-ledger.cjs、connector-store.cjs来容纳无服务端sequence的已观测事件；新增tests/acceptance/herdr-adapter.spec.cjs，可窄补connector既有Case。禁止main/store/renderer、插件/registry/transport接口无关重写、其他工具、版本Git文档。沿用已有真实协议与同库账本。目标新增生产350～500行/测试约500～700行，先梳理职责；复杂度信号不是压缩行数要求，不建通用Connector SDK。

## 正式行为契约

- adapter接收一个已校验登记(instance/run/socket)与ledger，构造既有正式transport，提供start、refresh/reconnect、dispose等清晰入口。此轮一个实例一个adapter；多实例由调用者持有，绝不共享pane缓存。无GUI/会话正文读取/模型/终端控制。
- 先ping并取初始snapshot获取pane和terminal归属，再订阅状态+拓扑，ack后再snapshot对账以缩短窗口。Herdr状态订阅必须每pane，拓扑事件增删/agent_detected触发有界重新订阅与snapshot。快照agents以真实terminal_id作agentId（附instance/run）；pane/workspace/tab作来源标签。不拿可重用pane_id永久等同Agent。
- Herdr idle→idle、working→working、blocked→needs_attention、done→finished、unknown→unknown。没有明确失败或退出证据不推failed/stopped；pane退出对旧terminal身份确定时才可stopped，快照缺失仅unknown。原始值与来源保留，done不表示验收成功。
- snapshot state_change_seq只用于该terminal的权威当前状态顺序，不能给原事件填造此字段。事件保存实际观测身份（appRun/subscriptionUUID/localIndex），重放同一观测ID幂等；为此允许账本增加独立recordObservation小接口及必要字段。它记录观测事实/通知，不更新权威sequence。未知pane归属时只记录pane来源与不确定性，不归给随后出现的新terminal。
- 一条持续观测流中的真实working→blocked→working都保留。相同状态的重复观测不反复发同一提示；真实往返后同状态是新变化。snapshot只恢复当前，不抹掉中间事件。已有观测所解释的最终快照变化不再追加一份同义通知；可在账本以明确关联字段联结，但不能假称它们有服务端共同eventId。初始基线不补播过往；订阅后实际看到的事件保留。
- snapshot请求在途收到更新时，不把旧响应当最后权威结果，标dirty并串行再取；同实例最多一个在途snapshot，重复trigger合并，不在繁忙流无限并行。必要P0观测可及时入待呈现队列，快照证实已过去后降为历史而非保留当前催促。明确处理最终状态相同但发生多次往返的通知去重。
- EOF、events_lost或协议错时markDisconnected，当前unknown；3秒观察期沿用ledger.tick。重连重新subscribe并snapshot，标注不可恢复的断档，不编造遗漏中间状态，也不因同run恢复重复上线。自动重试用有上限退避（1/2/5/10/30秒）；dispose取消timer/请求/订阅，旧回调不能写新run。测试注入调度时钟，不改系统时间。
- 登记run变化由上层dispose旧adapter再建新adapter；旧run迟到回调不得影响新run/通知。socket失踪不直接confirmStopped；没有实际退出证据只断连。disabled实例不重连，不因refresh自动enable。真实server stop在本轮只验证断连事实，明确下线由后续可信进程证据补足。

## Acceptance Contract

真实SQLite+正式ledger/transport/adapter。构造Unix socket协议server只控制事件、响应顺序和断连（不mockledger或核心方法）；另有一项真实Herdr隔离互通。测试本轮无GUI。

| Case | Given/When | Oracle与Expected |
|---|---|---|
| POL-ADAPTER-001 | 两登记端点各有同名pane局部ID但不同terminal，初始快照并状态事件 | 账本按instance/run/terminal独立；baseline不补过去；状态映射与原始来源正确，不读取正文/不修改角色数值 |
| POL-ADAPTER-002 | 同流working→blocked→working，快照延迟只回最终working；重放同观测及相同状态 | 中间blocked有一条事实及通知，最终当前working；无快照同义重复、无伪sequence；新往返仍记录。已过去blocked不永久P0 |
| POL-ADAPTER-003 | 取快照期间变化、乱序响应、拓扑新增/关闭/pane重用 | 串行重取后当前是最新；新pane可订阅；旧pane事件不误归新terminal；缺失Agent为unknown而非done |
| POL-ADAPTER-004 | EOF与events_lost，连续失败重连后回快照，无重放历史 | ≤3秒短断连不反复播离线；超过窗口一次提示，缺口明确；同run无重复上线，断档中间态不伪造；退避有界 |
| POL-ADAPTER-005 | 旧run请求悬挂时dispose，新run启动/实例disabled | 无旧写入/旧通知，无dispose后定时或socket遗留，disabled不复活；真正关库重开无上一app在线假象 |
| POL-ADAPTER-006 | 新建隔离真实Herdr+正式登记插件，两个pane报告构造working/blocked/working，再stop | 生产adapter最终ledger可见逐Agent状态与中间观测；真实协议与fixture结论分明，stop仅unknown/disconnected无推断done；所有本轮server/socket/temp退出清理 |

真实命令显式本轮随机--session与隔离XDG，不访问默认或已有工作会话，不伪造HERDR_ENV。用户已授权本轮隔离创建/信任。Case006可参照既有herdr-live测试生命周期但不复制巨型探针。若协议缺共享边界导致某个去重结论无法证明，报告具体不可辨识时序并让Codex决定表达，不能删事件以求绿色或宣称exactly-once。

证据evidence/s05e-adapter。先保存有效失败再修；现有ledger与transport必要回归。最终报告实际接口、Case映射、资源清理及未接main/通知UI边界。
