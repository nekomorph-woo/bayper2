# Herdr 0.9.5 隔离技术实验合同 v1

来源：用户要求深入核实状态、事件、多会话和桌宠进程生命周期，并于本轮明确授权从外部创建、控制和清理两个隔离会话。Codex 自主确定实验细节，不构成产品设计。

## 环境与边界

真实 macOS 本机 Herdr 二进制；单独 XDG_CONFIG_HOME 和 HERDR_CONFIG_PATH，两个 named session，禁用登录 shell、更新检查、通知和 Agent 自动恢复。只在此隔离命名空间调用 API，不读取现有工作会话，不注册到用户全局插件表。

状态来源使用 `pane.report_agent` 自定义报告，**它是真实 Herdr API 的测试输入，不是实际 Claude/Codex 的 screen detection**。进程实验使用无 GUI 的短 hook 和独立 heartbeat 子进程替代桌宠，不声称验证桌面渲染。

## 预先确定的实验

| ID | Given / When | Expected 与 Oracle |
| --- | --- | --- |
| HDR-01 | 导出安装二进制 schema | 记录真实版本、protocol、可报告/可返回状态；以 schema 内容核对，不推断运行服务能力 |
| HDR-02 | 自定义 Agent 在非焦点 pane 报 working、blocked、idle | agent.list 与 pane.get 可观察对应状态；记录 idle 是否投影为 done；固定代码校验 working/blocked，done 以实际观察验证 |
| HDR-03 | Agent 已完成且未查看；重复读取后执行显式 focus | 读取不清除 done，focus 后变 idle；与原始 API 回复比对 |
| HDR-04 | 先订阅具体 pane，再报告状态 | 收到 subscription_started；收到同 pane 的 blocked 事件，记录时间；不把单次时延当性能保证 |
| HDR-05 | 已有状态变化后建立新订阅；另建混合有效/无效 pane 订阅 | 新订阅无历史回放；无效请求产生明确错误，观察连接是否关闭；有超时边界 |
| HDR-06 | 两个独立 session 报不同状态 | socket 路径不同；各自快照只包含本会话数据；记录 pane_id 是否跨 session 重复 |
| HDR-07 | 已连接订阅；关闭会话并重新启动 | 旧连接结束或失效；新连接可 ping 和 snapshot；不假定旧 Agent authority 自动恢复 |
| HDR-08 | 隔离插件 link/disable/enable/reload 后，再重启 server | 记录 startup 次数；预期 link/enable/reload 不补跑、server 启动时执行；用 hook 日志与 plugin log 核查 |
| HDR-09 | hook/action 启动脱离的 heartbeat 进程；随后 disable/unlink/stop server | 记录各阶段进程存活与 heartbeat 是否继续；先观察后判断，不预设 Herdr 自动清理；最终由探针显式终止它创建的 PID |
| HDR-10 | 全部实验结束 | 两个测试 server 和 heartbeat 均退出，用户现有配置与插件未被实验命令访问；保留脱敏证据及可复现实验脚本 |

待运行：`events_lost` 过载、真实 Claude/Codex screen detection、Windows named pipe、GUI/休眠/显示器测试不纳入本批次已通过范围。

前置条件修订记录：首轮空闲 shell 上的报告虽返回 ok，但状态为 unknown。随后保留原始失败，增加 `sleep 180` 作为持续前台载体，重新验证同一组 Expected；不是修改 Herdr 或降低断言。真实 Claude 的补充覆盖见 HDR-11，不将载体等同于真实 Agent。

补充实验 HDR-11：完成自定义报告与进程清理后，在同一隔离 a 会话中启动一个真实 Claude Code CLI，执行一次不修改文件的短回复任务。观察 Herdr 的检测、prompt/wait 和结束状态；不安装集成、不改用户配置，结束后停止自己创建的会话。只有实际观察到的状态才记录为已验证；这不是准确率或所有提示类型的覆盖测试。

实现计划：Claude Code 仅编写独立研究脚本与受控 fixture；Codex 审查后启动服务器、运行脚本、核对原始结果。每条操作保存真实 request/response/event 和阶段观察。探针错误先修探针并保留原始失败，不改变 Expected 迎合实现。

## HDR-11 继续验证（用户已授权目录信任）

用户明确允许信任上次创建的 `/tmp/bayper-herdr-spike-P85k3g` 隔离目录；继续使用同一套 XDG 隔离配置，只在 a 会话中启动真实 Claude Code。此次授权不泛化到其他目录或其他审批。

Given：真实 CLI 停在该目录信任确认；为该 pane 建立状态订阅并收到 ack。When：Codex 确认已授权的目录信任，等待 idle 后提交一个仅读取测试输入、计算加法并回复的任务。Expected：记录真实 working→done 事件与查询状态；重复查询不清除 done；focus 后观察 idle，并检查实际回复正确。Oracle：固定输入 37 与 58，期待输出 `BAYPER_SUM=95`；任务提示不提供答案。Execution Boundary：真实 Claude Code 及其已配置模型、真实 Read 工具、真实 Herdr screen detection，无手工 report-agent 或 Mock。所有状态和事件保存为本地原始证据。

监听探针不提交提示、不确认信任、不 focus、不 stop server，这些操作由 Codex 显式执行。每次运行有独立证据文件；结束后停止监听与测试 server，核实无残留。没有观察到的状态不能补造为已通过。
