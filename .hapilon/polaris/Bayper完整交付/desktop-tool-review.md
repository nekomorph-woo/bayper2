# 原生验收工具审查返修

仅允许 tools/desktop-review/，禁止运行 GUI、改 app、Git、版本。先读 AGENTS.md。

1. 当前底板依赖 host.bounds，该边界可能未收到子画布实际位置，不能保证在角色下面。使用匹配屏幕 workArea 作为普通底板窗口范围，允许手工移动，不改变任何系统设置。
2. shutdown 只 app.close 后删除 data-dir，未核实独立子画布进程退出。关闭前捕获本轮 child pid；关闭后有界等待其退出。失败必须记录并非零退出，不宣称清理成功。只能清理确属本轮的进程，保留错误证据，不影响其他 Electron。
3. SIGTERM 与 SIGINT 一致清理。采样串行避免 interval 重叠与退出竞争。

保持小工具，不建设通用进程框架；在现有约200行基础上少量修复。只做语法/非GUI验证，交Codex实际原生验收。
