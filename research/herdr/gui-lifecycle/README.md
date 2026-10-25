# 真实GUI生命周期研究fixture

仅用于隔离Herdr0.9.5、macOS和既有Electron窗口探针，不是Bayper产品插件。Codex负责调度/运行/验收，Claude Code实施代码。完整结果见../../../.hapilon/polaris/Bayper前期调研/macos-followup-results.md。

沿用上级README的独立XDG设置；再给两个测试server注入BAYPER_GUI_BUILD_ROOT，指向已构建窗口探针的/tmp/bayper-window-spike-*根。该目录应有deps/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron和source/electron/、source/shared/。不要接入现有Herdr配置或会话。

server运行时link本目录不会执行startup；需显式enable后invoke bayper.research.gui.start，或在启用状态重启测试server。stop动作只写本socket的标记；disable/unlink由守护轮询识别；只有显式start清除stop标记。锁和状态按socket区分，不是产品多宠物规则。

bridge.py短命入口启动守护，守护持有flock并启动真实Electron；GUI退出、stop、disable、unlink、连续请求失败、信号或10分钟上限使其退出。正常路径只回收自己Popen的GUI；守护遭SIGKILL时依靠Electron的owner检测自退。PID复用、快速stop/start竞争和长时间系统休眠未保证，不提供自动崩溃重启。

调用返回“action已启动”不代表GUI已就绪：独立核对gui-lifecycle.jsonl的daemon_started、Electron startup/shown、实际PID与窗口。状态JSON可能是退出后的旧记录，不能只凭其存在判断存活或据此广域kill。收尾先停止GUI、unlink、停止两个测试server，归档证据后删本轮临时根目录。
