# 事件断连与恢复实验

日期：2026-10-25，Asia/Shanghai。Herdr 0.9.5，本机 macOS。技术预研，不包含产品设计。

## 范围与判据

技术合同见 event-recovery-cases.md。使用全新 `/tmp/bayper-herdr-spike-8OhOrR`、独立 XDG 配置/状态/数据目录和 named session a。只控制自己创建的会话，没有使用现有工作会话、外部插件、GUI 或系统通知。

自定义状态报告以持续前台 sleep 为载体；独立真值来自实际写入后读取的权威快照。它不是实际 AI 状态准确率实验。

这里的“通知”是研究用计数器：只对 blocked/done 计数。naive 每观察一次就加一；去重组对权威快照中的 `(terminal_id, agent_status, state_change_seq)` 相同键只加一次。该键没有被声明为通用事件 ID 或 exactly-once 保证。

官方契约说明：订阅历史不持久化，恢复依赖重新订阅与权威快照；快照和事件没有共享序列边界，事件不能无条件覆盖新快照。[Socket API](https://herdr.dev/docs/socket-api/#event-subscriptions)

## 第一批：主动断连与对账

Claude Code 实现 `research/herdr/recover_events.py`，Codex 审查并独立执行。审查时修复了尚未上报 Agent 就读取 agents 数组的前置条件，以及误将 working 事件计入通知的计数错误；没有改变预先固定的 Expected。此批运行退出码为 0，各项实际断言通过。

| 条件 | 实际操作及观察 | 结论 |
| --- | --- | --- |
| REC-01 | working 基线，关闭订阅；期间报 blocked；新订阅 ack 后快照为 blocked，0.3 秒窗口没有历史事件 | 当前状态可恢复，不能据此声称历史回放 |
| REC-01 计数 | 同一 blocked 的三次权威读取：naive=3、去重=1 | 重复观察与重复通知必须区分；仅为本组计数对照 |
| REC-02 | 断线期间真实写入并确认 blocked→working；重连快照为 working，0.5 秒窗口没有历史 blocked | 证明断档的中间状态可遗漏，当前快照不能还原全部历史 |
| REC-03 | 捕获旧 working 快照，延迟应用；真实服务随后经历 blocked→working→idle，最新快照为 done | 把迟到的 blocked 载荷直接用于覆盖新快照会暂时回滚；新权威读取恢复 done |
| REC-04 | 两个独立 blocked episode，中间经过 working；实际收到对应 blocked 事件，又重复读取快照 | naive=6，去重=2；相同 episode 不重复计数，新的 episode 没有被永久压掉 |

REC-03 是**受控延迟应用**实验：事件一直由真实服务产生，在步骤间读取并缓存在客户端；不是伪造网络乱序或声称同一订阅改变了事件顺序。它展示逐条应用陈旧载荷可能出现的暂时回滚；后续同一连接上的新事件仍可能纠正状态。本批没有实现或验证一个生产级并发缓存框架。

REC-04 的原始 blocked 事件与快照观察分别保留。naive 的重复计数来自消费策略，不能据此声称 Herdr 重复发送了 blocked 事件，也没有调用 Herdr notification.show。

此批结果已保存在本地证据目录 `evidence/2026-10-25-event-recovery/`：recovery-trace.jsonl、recovery-result.json、recovery-context.json。源码和正式研究记录纳入 Git，原始证据默认仅本地保留。

## 第二批：真实 events_lost

首轮实测已通过。健康订阅持续读取 workspace metadata；慢订阅在 ack 后将 SO_RCVBUF 设置为 1024 并暂停读取，同时订阅 metadata 与目标 pane 状态。经独立请求连接并发提交 8 批、每批 128 次 metadata 更新，每批等待健康订阅收到本批全部索引。总共 1,024 次更新，没有修改 Herdr 或伪造错误。请求中的 padding 为 512 字符，但服务端实际会规范化、截短 token；请求长度不是事件长度。

控制端在第 512、768、1024 次更新后分别写入并确认 blocked、working、blocked。这些是实际服务端权威读取，与慢订阅是否收到事件独立。

| 观察项 | 首轮实际结果 |
| --- | --- |
| 洪峰写入 | 1,024 次全部应答，写入阶段 4.025 秒 |
| 慢订阅 | 收到 69 条 metadata；没有收到上述三个状态事件 |
| 错误 | 原始 error.code 为 events_lost，id 与初始订阅请求一致，随后 EOF |
| 健康订阅 | 包括恢复后的 marker，共收到 0..1024 的全部 1,025 个索引，无缺失、无重复，连接未中断 |
| 恢复当前状态 | 新订阅 ack 后持续读取，同时取三次权威快照，均为 blocked；相同键 naive=3、去重=1 |

并发请求的索引是请求标签，不是提交顺序或 Herdr sequence；实际收到的索引顺序不递增不能用作网络乱序证据。健康订阅收到 metadata 也不能代替目标状态订阅的准确率检验。

首轮原始记录保存在 evidence/2026-10-25-event-recovery/loss-run1/。

审查后补加阶段期限检查、恢复订阅 marker 断言和短暂在途消息等待，再独立重跑：1,024 次写入全部成功，写入阶段 4.202 秒；慢订阅收到 81 条 metadata，仍未收到三个控制状态事件，随后收到真实 events_lost 与 EOF。健康订阅收到全部 1,025 个索引，无缺失或重复；恢复订阅独立收到新 marker n=1024，证明新连接继续消费。三次 blocked 快照仍为 naive=3、去重=1。此轮退出码为 0。

第二轮结果在 loss-run2/loss-result.json；loss-run2/loss-trace.jsonl 保留两轮追加的完整原始日志，可按 run_start/run_end 区分，不把它们合并计算为一轮。最终脚本 SHA-256 见 source-sha256.txt。这里的 69、81 是两次环境时序下的观察值，不是固定容量。

## 第三批：server 重启恢复

`restart_recovery.py` 建立背景 pane w5:p1、上报并确认 blocked，再订阅。出现 READY 后，由 Codex 显式停止并重新启动同一个隔离 server；脚本没有自行启停服务。

- 旧订阅实际抛出 EOFError；没有把超时当断连。
- 原 terminal_id 为 term_65ea317cf26835，重启后变为 term_65ea31886120c5；pane_id 仍为 w5:p1。
- 重启快照中该 pane 为 unknown，agents 为空；新订阅 ack 后再次读取仍为 unknown。此前的 blocked 没有自动恢复。
- 在新终端重新启动 sleep 载体并上报 working→blocked，新订阅实际收到这两个状态事件。
- 新 blocked 的 state_change_seq 为 2，旧 blocked 为 23；三次权威观察的相同新键只计一次，与旧 terminal 的键不同。这验证本组身份边界与计数结果，不代表任意重启场景都有通用通知幂等性。

实际运行退出码为 0。证据为 restart-result.json、restart-trace.jsonl、restart-ready.json；订阅 ack 后的第二次快照与各项断言也保留在 trace 中。

## 覆盖、结论与清理

| 合同 | 状态 | 实际覆盖与限制 |
| --- | --- | --- |
| REC-01 / REC-02 | PASS | 断连后恢复当前状态；确实存在无法补回的中间 blocked |
| REC-03 | PASS | 受控延迟应用展示陈旧载荷暂时回滚；未验证生产并发缓存实现 |
| REC-04 | PASS | 两个 blocked episode 计数 naive=6、去重=2；未调用系统通知 |
| REC-05 | PASS | 实际 server stop/start、旧连接 EOF、新 terminal、重新订阅与新状态事件 |
| REC-06 | PASS | 两轮均捕获原始 events_lost 和 EOF；健康客户端继续工作 |
| REC-07 | PASS | 新订阅持续读取并收到 marker，权威状态为 blocked，重复快照去重；断档历史仍缺失 |
| REC-08 | PASS | 显式停止隔离 a，server、shell/sleep 与探针退出，socket 和临时目录清除 |

技术结论：重新订阅与权威快照可以恢复**当前状态**，不能保证补回断档历史；逐次观察就通知会产生重复计数。本组按 terminal 身份与状态变化键去重能消除重复快照计数，但没有证明通用 exactly-once。恢复时应先等待订阅 ack、持续消费事件，再在另一个连接读取快照；事件只使缓存失效，刷新须串行，读取期间有变化则再读。这一处理原则来自官方契约，本组只验证固定实验切片，不将其说成已实现的产品恢复模块。

未覆盖：长时间网络故障、反复重连风暴、多会话同时过载、并发缓存的系统性压力检验、持久化通知账本、GUI/系统通知及 Windows。此次自定义状态实验也不替代上一轮真实 Claude Code 状态准确率验证。

清理时确认原 server PID 85556、新 server 86673、shell 86678、sleep 86679、两个代码生成 CLI 86154/86474 均已退出；find 未发现残余 socket，lsof 未发现仍打开此目录的进程。必要证据已归档，随后删除 /tmp/bayper-herdr-spike-8OhOrR 并确认不存在。两次代码生成 CLI 在文件写入后未及时结束，由 Codex 终止；以独立审查及实际运行结果验收，没有把生成器完成声明作为证据。没有注册插件、启动 GUI、发送系统通知或改动现有工作会话。

源码辅助依据：官方 v0.9.5 的 [event_hub.rs](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/event_hub.rs) 将共享历史窗口设为 512；[server.rs](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/server.rs) 订阅轮询间隔为 100ms、流写超时为 5 秒。这些是该 tag 的实现细节，不是稳定 API 配置承诺；必须由运行时捕获原始 events_lost 才能确认复现。
