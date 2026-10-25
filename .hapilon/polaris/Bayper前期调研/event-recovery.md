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

## 后续批次

真实 events_lost 及 server 重启恢复尚待本轮后续实测，不将以上成功结果外推到这些路径。

源码辅助依据：官方 v0.9.5 的 [event_hub.rs](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/event_hub.rs) 将共享历史窗口设为 512；[server.rs](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/server.rs) 订阅轮询间隔为 100ms、流写超时为 5 秒。这些是该 tag 的实现细节，不是稳定 API 配置承诺；必须由运行时捕获原始 events_lost 才能确认复现。
