# Herdr 隔离技术探针

这些文件仅用于技术预研，不是 Bayper 产品插件或正式业务测试。使用 Python 标准库、macOS Unix socket 和 Herdr 0.9.5；未验证 Windows。

`probe.py` 是按步骤执行的 API 探针，`fixture_hook.py` 提供一次性 startup 记录和最多运行 120 秒的脱离 heartbeat。插件清单只启动这两个受控入口。详细 Expected、覆盖和失败记录见 [技术合同](../../.hapilon/polaris/Bayper前期调研/technical-cases.md) 与 [实测报告](../../.hapilon/polaris/Bayper前期调研/runtime-research.md)。

## 复现前提

由人类操作，或由已获准控制隔离会话的调度器执行。Herdr skill 的默认入口限制仍有效，不得通过伪造 HERDR_ENV 绕过。不要把以下目录换成用户正在使用的 Herdr 配置，也不要省略指定 session。

每次完整复现使用一个全新的根目录。实验记录按批次追加，`inspect` 预期启动记录初始为空。初始化环境后，在所有实验终端使用相同的环境变量：

```sh
export BAYPER_RESEARCH_ROOT="$(mktemp -d /tmp/bayper-herdr-spike-XXXXXX)"
export XDG_CONFIG_HOME="$BAYPER_RESEARCH_ROOT/xdg"
export XDG_STATE_HOME="$BAYPER_RESEARCH_ROOT/state"
export XDG_DATA_HOME="$BAYPER_RESEARCH_ROOT/data"
export HERDR_CONFIG_PATH="$BAYPER_RESEARCH_ROOT/launch.toml"
cp research/herdr/isolated-config.toml "$HERDR_CONFIG_PATH"
```

不同终端必须复用上述同一个 BAYPER_RESEARCH_ROOT，不是各自执行 mktemp。该配置禁用登录 shell、更新检查、声音、通知及 Agent 自动恢复。

## 执行顺序

1. 在两个实验终端分别运行 `herdr --session a server` 和 `herdr --session b server`，使其保持运行。不要运行默认会话。
2. 在控制终端、项目根目录中创建两个初始工作区，再运行探针：

```sh
herdr --session a workspace create --cwd "$BAYPER_RESEARCH_ROOT" --label control-a --focus
herdr --session b workspace create --cwd "$BAYPER_RESEARCH_ROOT" --label control-b --focus
PYTHONDONTWRITEBYTECODE=1 python3 research/herdr/probe.py inspect --root "$BAYPER_RESEARCH_ROOT"
```

3. 运行 `watch`。出现 READY 后，在另一控制终端的 30 秒等待窗口内停止 a；watch 应观察到旧订阅连接结束。

```sh
PYTHONDONTWRITEBYTECODE=1 python3 research/herdr/probe.py watch --root "$BAYPER_RESEARCH_ROOT"
```

另一个终端执行：`herdr --session a server stop`。

4. 重新运行 `herdr --session a server`。待根目录 plugin-events.jsonl 出现 startup 记录后，读取 snapshot 并执行生命周期实验：

```sh
herdr --session a api snapshot
PYTHONDONTWRITEBYTECODE=1 python3 research/herdr/probe.py lifecycle --root "$BAYPER_RESEARCH_ROOT"
```

5. lifecycle 完成后立即停止 a，再运行 cleanup；必须在 heartbeat 的 120 秒寿命内观察 server stop 后的存活，才有对应证据。

```sh
herdr --session a server stop
PYTHONDONTWRITEBYTECODE=1 python3 research/herdr/probe.py cleanup --root "$BAYPER_RESEARCH_ROOT"
herdr --session b plugin list --json
herdr --session b server stop
```

## 结果与收尾

根目录 trace.jsonl 保留请求、回复、事件和断言；results.jsonl 追加各阶段结果，失败返回非零。应核对实际字段和最终进程状态，不能只看退出码。fixture 的 PID 写入 heartbeat.pid；cleanup 校验命令行后只终止自己创建的 heartbeat，不执行 pkill，也不代为停止 Herdr。

中途失败时先保存原始证据，再用已知 PID 和显式 session 完成清理。若失败发生在插件 unlink 之前，应在测试服务器仍可用时执行 `herdr --session a plugin unlink bayper.research.lifecycle`。配置命名空间与脱离进程是两回事，不能只删目录了事。

probe.py 通过持续前台 sleep 承载自定义状态报告，不测试真实 AI 的工作质量。真实 Claude 的启动阻塞实验和获准后的只读任务由 Codex 另行执行，没有自动代答信任或审批界面的实现。

## 真实 CLI 状态监听

`observe_real.py` 仅监听指定 pane 的真实事件和查询结果，要求两条记录都出现 working→done→idle。CLI 启动、目录信任、任务提交及 focus 由已获授权的操作者显式完成。不能把上次授权推广到新目录或其他审批。

```sh
PYTHONDONTWRITEBYTECODE=1 python3 research/herdr/observe_real.py --root "$BAYPER_RESEARCH_ROOT" --pane "$BAYPER_REAL_PANE_ID" --seconds 120
```

BAYPER_REAL_PANE_ID 必须来自实际创建结果。出现 READY 后才进行操作；默认 120 秒内完成任务并 focus。原始数据追加到 real-cli-followup-trace.jsonl，结果写入 real-cli-followup-result.json；同一根目录重跑前应先归档上一批结果。实测样本与清理记录见 [HDR-11 补测](../../.hapilon/polaris/Bayper前期调研/real-cli-followup.md)。

## 事件恢复实验

另用全新的隔离根目录，按上述环境初始化配置，只启动 named session a，并创建一个 focused control workspace。此组不运行 inspect、不注册插件、不需要 session b 或真实 AI。技术判据与边界见 [恢复实验合同](../../.hapilon/polaris/Bayper前期调研/event-recovery-cases.md)，实际结果见 [恢复报告](../../.hapilon/polaris/Bayper前期调研/event-recovery.md)。

```sh
PYTHONDONTWRITEBYTECODE=1 python3 research/herdr/recover_events.py --root "$BAYPER_RESEARCH_ROOT"
PYTHONDONTWRITEBYTECODE=1 python3 research/herdr/force_event_loss.py --root "$BAYPER_RESEARCH_ROOT"
PYTHONDONTWRITEBYTECODE=1 python3 research/herdr/restart_recovery.py --root "$BAYPER_RESEARCH_ROOT"
```

最后一个脚本出现 READY 后，在 30 秒内于另一终端停止测试 a，等待 server 退出，再用同一环境重启 a；不要另建 root 或 control workspace。脚本只负责监听和对账，不代为启动或停止 server。重启后恢复布局的 pane 是新终端，脚本会重新启动 sleep 载体并上报受控状态。

洪峰为固定 1,024 次 metadata 更新、64 个并发请求，每批 128 次；暂停读取慢订阅，同时持续消费健康订阅。每批前检查 20 秒阶段期限，单请求另有 3 秒超时；不是严格的全进程 20 秒硬截止。只有收到真实 events_lost 和随后 EOF 才确认复现，普通超时不算成功。没有保证每台机器均能在写超时之前触发相同结果。

各脚本结果和原始 trace 写入 root。重跑前先归档上一批，避免覆盖结果或将追加 trace 混为一批。结束时执行 `herdr --session a server stop`，确认 server、sleep 载体与订阅退出、socket 消失，归档证据后删除该次临时目录。研究计数器不是系统通知，也不提供通用 exactly-once 保证。
