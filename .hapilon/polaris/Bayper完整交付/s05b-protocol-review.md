# S05b Herdr正式适配协议核对

2026-10-26，Codex只读核对，没有连接或控制现有Herdr会话。本机/opt/homebrew/bin/herdr --version为0.9.5；herdr api schema --json导出的原始schema在evidence/herdr-0.9.5-api-schema.json。此命令读取安装包schema，不依赖运行会话。

依据：官方[Socket API](https://herdr.dev/docs/socket-api/)与[Plugins](https://herdr.dev/docs/plugins/)，以及既有Bayper前期调研/event-recovery.md真实隔离实验。在线文档可能更新，具体字段以本机schema及后续真实隔离响应为准。

## 会影响接线的事实

- success_response.$defs.AgentInfo含terminal_id、state_change_seq、completion_seq、agent_status、revision与归属字段；SessionSnapshot含agents/panes/tabs/workspaces但没有server_id/runId。
- subscription_event.$defs.PaneAgentStatusChangedEvent只必需pane_id/workspace_id/agent_status；没有terminal_id、state_change_seq、发生时间或全局事件ID。普通EventData的pane_agent_status_changed也没有这些。不能为事件补造快照sequence或认为每次收到就有稳定episodeID。
- pane.revision存在于PaneInfo/AgentInfo，但状态订阅事件没有revision，不能假定它能为所有事件和快照提供共享序列边界。
- 前期实际证明重新订阅后无历史补发，events_lost后EOF，snapshot只恢复当前；真正断档中间态不可还原。已观察到的working→blocked→working不能因快照只剩working而抹掉。
- 官方插件startup为一次性初始化，server恢复/API就绪后启动；link/enable不等于触发startup。插件须提供显式连接action处理已运行server安装/启用；Bayper晚启动也须能读取持久化登记而关联。

## 接线决策与待验证

1. S05a的sequence契约只适用于有可比较episode身份的输入，不等于Herdr原始事件协议。正式Herdr adapter必须分开“观测事件记录”与“权威当前状态更新”；不能强行让事件顺序计数伪装state_change_seq。
2. 订阅ack后持续收取事件，另一路串行取snapshot。事件使当前缓存失效；取样期间有新事件则再取快照，迟到payload不能覆盖权威新状态。接收流内为每条已观察事件分配本地身份（订阅代次+接收序号），明确不是服务端重放ID。已知pane→terminal归属可关联；映射尚不确定时保留pane来源和不确定性，不随意归给新终端。
3. 初次快照作为基线。首次快照前后的事件与快照没有原生共同边界，须以实际隔离实验验证去重/不丢中间变化；无法确定的映射保留观测缺口，不声称exactly-once。S05a后续可能需窄接口接纳观测事实、不改变当前状态，不能重写整套账本或直接绕过持久化。
4. server运行身份需插件登记与本机进程/socket生命周期证据，schema无现成字段。不能只以socket路径/显示名作为runId，也不能每次插件action生成新UUID造成假重启。先实测插件启动context、server进程身份/套接字替换，再定稳定登记。新CLI只在明确隔离测试目录运行。
5. 安装/发现为正式产品能力，插件应放明确生产目录，不能直接上线research fixture或依赖/tmp构建。所有代码继续Claude Code；插件不会控制Bayper退出，Herdr下线后Bayper继续独立陪伴。配置与事件事实不授权外部会话分析。

本记录只确定下一轮实现不能跨越的协议边界，尚无正式adapter/插件或端到端通知PASS。S05a返修终态后，以此及真实隔离证据制定S05b最小接线Case，再派开发，不先制造错误的通用SDK。
