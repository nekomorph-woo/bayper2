# HDR-11：真实 Claude Code 完整状态流程补测

2026-10-25，Asia/Shanghai。仍属技术预研，不包含产品设计。

## 授权与边界

用户明确允许信任上次创建的 `/tmp/bayper-herdr-spike-P85k3g` 隔离测试目录，并继续验证真实 Claude Code working→done。macOS 实际路径为 `/private/tmp/bayper-herdr-spike-P85k3g`；授权只针对该目录。

使用 Herdr 0.9.5、Claude Code CLI 2.1.310、独立 XDG 配置和状态目录、named session a。新建非焦点 pane `w5:p1`，terminal_id 为 `term_65ea2be7209194`。没有安装 integration，没有调用 pane.report_agent，没有运行桌宠 GUI。

CLI 参数为 `--safe-mode --tools Read --allowedTools Read --effort low`。界面显示底层模型是 **DeepSeek-V4.1-Flash**，所以本轮验证的是用户已配置的真实 Claude Code CLI 与 Herdr screen detection，不是 Anthropic Claude 模型的能力或其他模型的兼容性。safe mode 禁用自定义 hooks、skills、CLAUDE.md 等，本轮不据此证明项目规则加载。权限模式沿用本机设置，工具集合限制为 Read；本次只有已授权的目录信任和一次只读任务。

## 预先固定的任务与判据

输入文件只有 `first=37`、`second=58`。提示要求读取该文件、计算两项之和，只回复 `BAYPER_SUM=<计算结果>`；提示不含答案，禁止改文件、执行命令或调用其他工具。独立 Oracle 为 `BAYPER_SUM=95`。

Claude Code 编写了只读监听脚本 `research/herdr/observe_real.py`，复用既有 socket 客户端。Codex 审查后运行：先订阅目标 pane 并等待 subscription_started，再确认获准的目录信任、提交真实任务。监听脚本只读状态，不能确认信任、发任务、focus 或停止 server。

通过条件是在**事件流与查询结果两条记录中**，分别按序观察 working→done→idle；同时核对真实回复、done 只读保持和 focus 行为。时间来自本机原始 trace，下面换算为 Asia/Shanghai。

## 直接观察

| 时间 | 来源 | 状态或操作 |
| --- | --- | --- |
| 12:36:39.464 | poll | 初始 blocked，目录信任对话框仍在 |
| 12:36:44.676 | event + poll | Codex 根据用户授权选择 Yes 后，进入 idle |
| 12:36:55.503 | event + poll | 提交只读加法任务后，进入 working |
| 12:36:56.727 | event | 收到 done |
| 12:36:56.830 | poll | 查询也观察到 done |
| done 期间 | agent.get 两次 | 都返回 done、focused=false；completion_seq 和 state_change_seq 均为 4 |
| done 期间 | 实际终端输出 | 显示 Read 1 file，回复 `BAYPER_SUM=95` |
| 12:37:16.114 | poll | Codex 显式 agent.focus 后，观察到 idle |
| 12:37:16.166 | event | 收到 idle；后续 agent.get 返回 idle、focused=true |

监听结果：

- event_states：`idle → working → done → idle`。
- poll_states：`blocked → idle → working → done → idle`。
- 两条记录均通过顺序校验，监听进程退出码为 0。
- `agent prompt --wait` 正常返回 `agent_prompted`，返回对象中状态为 done、interactive_ready=true。不是仅凭该返回值判定完成，另有事件、轮询与实际回复核查。

初始 blocked 发生在订阅之前，因此只在 poll 序列中；没有补造一条 blocked 事件。working 到 done 的事件间隔约 1.22 秒，仅是这一个简单任务的观察，不代表延迟基准或一般任务性能。

另一个细节：done 与 focus 后 idle 的查询中，state_change_seq 都是 4。这个样本说明，不能把该字段的递增当作所有显示状态变化的唯一证据；这里以原始事件与完整查询结果核对，没有推断跨快照与事件的全局顺序。

## 覆盖与结果

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 按授权确认准确的隔离目录 | PASS | before-trust 屏幕、信任后状态与 trace |
| 真实 CLI working→done | PASS（本样本） | event 与 poll 各自独立的顺序记录 |
| 实际任务输出正确 | PASS | Read 1 file 和 BAYPER_SUM=95 终端输出 |
| done 不因读取清除 | PASS | 连续两份 agent.get 都为 done |
| focus 清除 done | PASS | focus 后 event、poll 和 agent.get 均为 idle |
| 清理环境与本次信任 | PASS | server/监听/CLI 退出，socket 消失，临时目录及该目录专属信任/缓存条目清理 |

## 证据与清理

原始 trace、监听结果、实际输入、CLI 输出及 focus 前后查询保存在本工作目录的 `evidence/2026-10-25-real-cli/`，按 polaris 约定仅本地保留，不提交完整会话日志。结果文件为 `real-cli-followup-result.json`，原始事件和查询为 `real-cli-followup-trace.jsonl`。

归档后停止测试 a server，确认没有测试 server、监听或该次 Claude 进程残留，测试插件列表为空。移除 `/tmp/bayper-herdr-spike-P85k3g` 及其独立 XDG 环境；在停止 CLI 后，仅删除该精确目录对应的 Claude 项目配置条目和项目缓存，因此也撤销了本次信任。其余用户项目条目未被删除。旧批次必要实测证据已保存在本地 evidence，临时生成日志与被拒绝的探针草稿随临时目录一并清理。

没有实测其他 Agent、模型、复杂任务、一般权限审批、长时间运行、事件过载、Windows 或 GUI。HDR-11 的这一个真实只读任务闭环现已补齐；不外推成“状态检测永远准确”。
