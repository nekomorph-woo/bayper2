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

本探针通过持续前台 sleep 承载自定义状态报告，不测试真实 AI 的工作质量。真实 Claude 的启动阻塞实验是 Codex 另行执行的补充检查，没有自动代答信任或审批界面的实现。
