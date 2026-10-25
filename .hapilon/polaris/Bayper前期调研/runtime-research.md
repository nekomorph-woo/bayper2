# Herdr 状态、事件、多会话与进程生命周期实测

日期：2026-10-25，Asia/Shanghai。定位：PRD 前期技术预研，不包含 Bayper 产品设计。

本文记录首批实测；用户随后授权目录信任后的真实 Claude Code 完整闭环见 [HDR-11 补测](real-cli-followup.md)。本文中的“未覆盖”是首批实验边界，后续覆盖以补测记录为准。

## 环境与证据

- 本机 macOS，Herdr `0.9.5`；安装二进制导出的 schema 为 `schema_version=1`、`protocol=22`。schema 的 SHA-256 为 `9e2af207e9aa8183d4aeca5fde9cc48e7909bb40cdbd7cf21608a6d3ea78075b`。schema 来自二进制，不等于任意其他版本的运行服务必然具备同样能力。
- 用户明确授权从 Codex 外部创建、控制、清理两个隔离会话，覆盖 Herdr skill 的默认入口限制。实验根目录 `/tmp/bayper-herdr-spike-P85k3g`，macOS 解析为 `/private/tmp/...`。使用独立 XDG_CONFIG_HOME、XDG_STATE_HOME、XDG_DATA_HOME 和配置文件；会话名为 `a`、`b`，没有连接现有工作会话。
- shell 使用 `/bin/sh`、`non_login`；关闭更新检查、声音和通知、Agent 自动恢复。实验插件只注册在隔离配置目录中。
- Claude Code 编写研究脚本，Codex 审查、派发返修并独立运行。脚本位于 `research/herdr/`，属于技术探针及 fixture，不是 Bayper 产品实现。一次性探针的首版因过度封装被拒绝，未执行；随后改为简单 socket 客户端和按步骤的实验。
- 完整原始证据在同目录 `evidence/2026-10-25/`，按 polaris 约定仅本地保留。本文、技术合同、可复现探针纳入 Git；完整 CLI 生成日志只在临时目录保留。
- 实验执行时 fixture manifest 的版本字段为 `0.1.0`；归档时仅将版本元数据同步为项目 `0.1.8` 并补充说明，Python 实现与调用命令未变。归档配置文件与实际启动配置经逐字节比对一致。

## 核实结果

### 1. 状态获取：请求成功不等于状态持续生效

安装 schema 区分两组状态：`pane.report_agent` 只接受 `idle/working/blocked/unknown`，查询结果还可包含 `done`。实际向服务上报 `done` 得到 `invalid_request`，并明确列出允许值。

首轮实验向空闲 shell pane 上报 `working/blocked`，两个 API 都返回 `result.type=ok`，但随后查询为 `unknown`，`agent explain` 也找不到对应 Agent。原始失败已保留。补充持续前台进程 `sleep 180` 作为受控载体后，相同报告机制可观察到 working 和 blocked。这与官方描述的“回到空闲 shell 后清除 Agent”机制一致；本轮没有据此断言所有状态失效的原因都相同。[自定义 Agent 文档](https://herdr.dev/docs/add-herdr-support/#release-on-exit)

在持续前台载体、非焦点 workspace 上，实际观察到：

| 操作 | 实际结果 |
| --- | --- |
| a 上报 working | pane.get 与 agent.list 均显示 working |
| b 上报 blocked | pane.get 与 agent.list 均显示 blocked |
| a 从 working 上报 idle | 查询显示 done |
| 连续两次只读查询 a | 仍是 done |
| 显式 pane.focus a | 转为 idle |

因此 `done` 是 Herdr 带“尚未查看”语义的状态投影，不是调用者直接上报的成功标记。实测的是自定义状态报告路径，不能冒充真实模型的工作内容或业务正确性判断。

离线补充：用本机 `agent explain --file` 检测一份合成的陌生确认文本，bundled manifest `2026.10.11.1` 返回 `idle`，没有匹配规则，`fallback_reason=default_known_agent_idle_fallback`。第一次离线读取还使用了用户现有的 remote cache，之后指定独立 XDG_STATE_HOME 重跑，本文采用的是隔离后的 bundled 结果。这个合成文本验证的是 fallback 机制，不是真实 Claude 审批界面的准确率。[检测规则说明](https://herdr.dev/docs/agents/#blocked-state)

### 2. 事件订阅：真实确认、事件与错误路径

实测使用独立连接发送 `events.subscribe`，具体指定 `pane_id`：

- 首条确认是与请求 ID 对应的 `result.type=subscription_started`。
- 确认后上报 blocked，收到 `event=pane.agent_status_changed`，data 中 pane_id 和状态均与目标一致。
- 该单次样本从发送报告到读到事件约 **0.206 秒**，包含本地请求、服务处理、探针读写及调度成本。不是性能基准，不代表通常值或时延保证。
- 在已有变化后重新订阅，确认后的 0.5 秒观察窗口没有历史事件回放。这个有限窗口与官方不回放的契约一致，不是对所有负载的证明。
- 同一请求混入一个不存在的 pane 后，整个请求返回 `pane_not_found`，随后连接 EOF；没有出现“有效条目部分成功”的启动确认。
- 停止 a 时，已建立的订阅结束；重启后，新 CLI 连接能读取 session snapshot。旧连接不会因相同路径重新出现而自动恢复。

本轮**未制造 `events_lost` 过载**。官方说明事件历史不持久化、快照与事件没有共享序列边界；丢失后需要重新订阅和权威读取对账。本轮没有把这条文档契约标为已实测。[事件契约](https://herdr.dev/docs/socket-api/#event-subscriptions)

### 3. 多会话：socket 隔离，但插件注册共享

实际 socket 为：

- `.../xdg/herdr/sessions/a/herdr.sock`
- `.../xdg/herdr/sessions/b/herdr.sock`

两个实验 Agent 的 pane_id 都是 `w3:p1`，但 terminal_id 分别为 `term_65ea29d07c3f43` 和 `term_65ea29d130a263`。a 的 agent.list 只返回本会话 working Agent，b 只返回本会话 blocked Agent；不能单凭 pane_id 判断跨会话身份。

a 重启后的快照保留 pane_id `w3:p1`，但 terminal_id 变成 `term_65ea29e39bd792`，状态为 unknown。b 的 terminal_id 和 blocked 状态未改变。这里验证的是关闭自动恢复后的新 shell 与会话隔离，**不是 Agent 会话恢复能力**；也没有证明 terminal_id 在所有机器和生命周期中全局唯一。

在 a link 研究插件后，b 的 plugin.list 也能看到同一个 plugin_id。也就是说，这两个会话的状态数据和传输分开，但插件注册、启用状态在同一隔离用户配置范围内共享。只换 session 名不足以隔离插件实验；本轮独立的 XDG 目录使该共享发生在测试命名空间内。[插件作用范围](https://herdr.dev/docs/plugins/#install-and-link)

### 4. 桌宠进程生命周期：Herdr 不自动回收脱离进程

本轮没有启动 GUI 桌宠，使用一个声明 startup/action 的本地插件，以及 `start_new_session=True` 启动的 heartbeat 进程观察生命周期。

| 操作 | 直接观察 |
| --- | --- |
| server 已运行后 link 插件 | startup 记录 0 条 |
| disable、enable | startup 仍是 0 条 |
| reload-config | startup 仍是 0 条 |
| 停止并重启 a | 新增 1 条 startup，socket 指向 a |
| 显式 action 启动 heartbeat | 得到 PID 82963，心跳开始增加 |
| disable 插件 | PID 仍存活，心跳从 1 增至 2 |
| unlink 插件 | PID 仍存活，心跳从 2 增至 3 |
| 停止 a | cleanup 前 PID 仍存活，心跳在观察窗口从 38 增至 41 |
| 校验命令行后显式 SIGTERM | PID 退出，心跳停在 41 |

startup 记录还确认：HERDR_PLUGIN_CONFIG_DIR 位于测试的 XDG config 目录，HERDR_PLUGIN_STATE_DIR 位于测试的 XDG state 目录。

这证明本次脱离方式不会随 disable、unlink 或 server stop 自动退出，不能把它泛化为所有子进程的命运。startup 是一次性入口，也没有被当作 daemon supervisor。卸载后的真实桌宠资源清理、窗口销毁、应用自更新和签名仍未验证。[官方生命周期约束](https://herdr.dev/docs/plugins/#startup-hooks)

### 5. 真实 Claude Code：已验证启动阻塞识别与发送保护

补充实验使用真实 Claude Code CLI `2.1.310`，`--safe-mode --tools Read --allowedTools Read --effort low`；没有安装 Herdr integration 或更改用户配置。

首次启动错误地带入仅适用于 print 模式的 `--no-session-persistence`，CLI 拒绝启动，Herdr start 最终 timeout；这是实验启动参数错误，已保留并移除该参数重试。

重试后真实 CLI 出现临时目录信任对话框，Herdr 返回 `agent_not_ready`，agent.get 的状态为 blocked。agent.explain 使用 bundled manifest `2026.10.11.1`，匹配 `live_blocked_form`；随后 `agent prompt` 返回 `agent_blocked`，没有发送任务文本。

没有代答信任对话框。本机 [Herdr skill](/Users/chaooswoo/.agents/skills/herdr/SKILL.md) 明确要求：“Inspect the blocked UI and ask the user before answering it.”。本轮额外验证止于真实 blocked 检测；真实 Claude working→done、审批后的恢复和真实 Codex 检测仍未覆盖。

## 覆盖矩阵与失败记录

技术条件定义见 technical-cases.md，不是产品 Acceptance Cases。

| ID | 结果 | 直接依据与限制 |
| --- | --- | --- |
| HDR-01 | PASS | 二进制 schema 与真实版本；不是对其他版本服务的验证 |
| HDR-02 | PASS（补齐前置后） | 首轮空闲 shell unknown 保留；持续前台载体上 working/blocked 可查 |
| HDR-03 | PASS | done 两次读取不变，focus 后 idle |
| HDR-04 | PASS | 订阅确认后收到目标 blocked 事件；单次时间样本 |
| HDR-05 | PASS（本窗口） | 无历史回放的有限窗口；无效混合请求 error + EOF |
| HDR-06 | PASS | 相同 pane_id、不同 terminal_id、不同状态，各自查询与 socket 隔离 |
| HDR-07 | PASS（本配置） | 旧订阅结束、重启可读快照；Agent 自动恢复关闭 |
| HDR-08 | PASS | link/enable/reload 计数为 0，重启后 1 |
| HDR-09 | 已完成观察 | disable/unlink/server stop 后 heartbeat 继续；显式回收后停止 |
| HDR-10 | PASS | 测试插件表恢复为空；两台测试 server 均正常停止，socket 已清除，heartbeat PID 已退出 |
| HDR-11 | 部分覆盖 | 真实 blocked 与 prompt guard 已验证；短任务未发送，working→done 为 NOT_COVERED |

证据中的 results.jsonl 保留了首轮 inspect 失败，以及修正前台进程前置条件后的成功 inspect、watch、lifecycle、cleanup 四阶段。源码审查还修复了把跨会话 pane_id 当全局身份的错误断言；没有通过修改状态 Expected 来消除失败。

## 当前边界

没有产品设计和正式开发决策。仍未覆盖：真实 Agent 状态准确率、事件过载及 events_lost 恢复、Windows named pipe、真实 GUI 进程、sleep/wake、多显示器和全屏、长期 CPU/内存/电池、插件升级安装目录清理、签名和分发。
