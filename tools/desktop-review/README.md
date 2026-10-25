# desktop-review

S02b 桌面画布的原生鼠标、焦点与 Spaces 验收底板。它是测试支架，不是产品界面；工具只观察 Codex 的真实操作，不模拟鼠标/键盘，不自动切换 Spaces、锁屏或修改系统设置。

## 启动

在项目根目录运行：

```bash
node tools/desktop-review/review.cjs
```

启动过程：

- 使用 Playwright Electron API 启动真实 app，`--data-dir` 指向本轮自建临时目录；
- 启动本机 loopback HTTP fixture，配置为 `fixture-model`，通过 UI 完成 onboarding 并接纳 Rin；
- 接纳后立即关闭 HTTP fixture；`fixture-model` 仅用于本次验收，不是真实模型；
- 在真实 app 父进程创建普通 Electron 底板窗口，范围取匹配屏幕的 `workArea`，可手工移动；真实生产画布子进程仍是最上层的 `alwaysOnTop floating` 窗口。底板不依赖 host 上报的子画布位置。
- 底板提供棋盘、焦点/输入探针，并记录真实操作的 pointerdown、键盘和 focus/blur 次数。

## 终端指令

- `snapshot`：立即采集一次底板与管理窗口状态，追加到当前批次日志；
- `quit`：先记录本轮角色画布子进程 PID，关闭底板与 app 后有界等待该 PID 退出；只有本轮 PID 会被检查，失败会写入错误行并以非零码退出，不宣称清理成功；
- `Ctrl+C` / `SIGINT`、`SIGTERM`：执行同样的清理流程。

需要鼠标穿透开关时，请由 Codex 使用产品真实托盘；本工具不复制该业务。

## 证据与边界

每次启动在 `tools/desktop-review/evidence/batch-*/` 创建当前批次（路径会在终端打印）：

- `states.jsonl`：首行记录 fixture 用途与观察边界；之后约每 2 秒串行追加一次有限状态与时间记录，包含底板 DOM/原生 focus/blur/键盘计数、管理端焦点/desktop 状态；退出失败会追加错误行。

不记录 API Key、进程环境或输入文本内容；只记录事件次数。自动日志只用于辅助观察，不构成原生交互或视觉验收结论；Codex 必须亲自操作鼠标、键盘与 Spaces。底板窗口不设为 `alwaysOnTop`，角色窗口的层级由真实产品决定。

本工具编码阶段未启动 GUI，仅做静态语法检查。
