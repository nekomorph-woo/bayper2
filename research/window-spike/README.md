# Electron / Tauri 2 窗口探针

仅技术预研。共用 240×240 Canvas，测试透明窗口、穿透、焦点和 Spaces；不是 Bayper 产品代码。Claude Code 实现，Codex 审查、构建和验收。合同见 ../../.hapilon/polaris/Bayper前期调研/window-cases.md。

## 隔离构建

创建 /tmp/bayper-window-spike-<随机后缀> 目录，以 BAYPER_WINDOW_ROOT 注入。将本目录复制到该根目录的 source/，所有构建在复制件进行。不要直接在仓库构建：Tauri 的 build.rs 会生成所需的 1×1 RGBA 图标。

- Electron：用 npm 在隔离 deps/ 安装 electron@45.0.0，npm cache 也指向隔离目录；Electron 45 需要再执行其 install.js 下载 runtime，使用 electron_config_cache 指向隔离目录（该安装脚本不读取 ELECTRON_CACHE）。通过 runtime 的 Electron.app/Contents/MacOS/Electron 启动 source/electron/，不启动 dev server 或 DevTools。
- Tauri：CARGO_HOME、CARGO_TARGET_DIR 指向隔离目录，使用 cargo build --release --locked --manifest-path source/tauri/Cargo.toml。使用生成的 release 可执行文件；不要将 cargo/编译器纳入运行资源数据。测试窗口使用 incognito，避免持久 WebView 数据。
- oracle.swift：swiftc -O -framework AppKit -framework CoreGraphics 编译。其 GUI 只是点击底板；--observe 后接显式 PID 时，只读这些进程的窗口元数据与前台 PID。可将可执行文件包装为临时 .app 供桌面工具定位。

三个 GUI 程序都有 8 分钟自动退出保护。长时间人工等待可能需要另开批次，不能把退出后的点击算入原批次。

macOS补测将自动退出延长到20分钟。BAYPER_PANEL=0保留普通窗口路径，=1启用panel：Electron使用内置type=panel，Tauri使用固定rev的tauri-nspanel社区适配。BAYPER_ACTIVATION_POLICY=prohibited可选；不设置仍Accessory。模式会写日志，不能把不同模式的点击、Spaces与启动证据混算为同一套配置全部通过。它仅用于本轮无键盘输入的悬浮画布实验。

Tauri锁文件含固定git依赖，首次构建需要可访问其仓库。编译出现旧cocoa API弃用及block未来兼容警告，详见补测报告，不代表已完成长期兼容验证。所有依赖/编译仍在隔离复制件进行。

## 固定控制与证据

根目录 command.json 是一次性控制数据，seq 必须递增。支持 ignore、visible、animate、x/y 和 quit。Electron 和 Tauri 复用同一控制文件，按顺序单独运行，避免同时响应同一条命令。

补测可为每个候选设置不同的BAYPER_WINDOW_ROOT子目录，以免共享控制文件串扰。写入下一条命令前等待上一seq出现在实际执行日志，不能快速连写后假定每条都执行。底板控制文件board-command.json支持seq、fullscreen、active、quit，仅操作自己的窗口。Electron另支持可选BAYPER_OWNER_PID，每400ms检查owner是否存在，owner不存在则自行退出；该机制不防PID复用，不是系统级守护。

静止不执行 Canvas 动画定时器；动画固定约 30fps，每 30 帧上报实际累计帧数和耗时。资源用 measure.py 的 --root、--label、--pids 和 --seconds 采样；首个 PID 为主进程，其余仅填写已核对归属的 WebKit 等辅助进程。不要自动纳入所有系统 WebKit。

两个候选写 electron.jsonl / tauri.jsonl，底板写 oracle.jsonl。资源数据为 resources-<label>.json，区间 CPU 以一核 100% 计；RSS 合计可能重复共享页，不是物理 footprint。

应用级自动化点击可能绕过桌面命中测试。必须先做关闭穿透的对照；若关闭/开启都能直接点击指定底板，不能据此宣布穿透通过。工具的单窗口截图也不能代替屏幕合成截图。权限或工具不足时保留 INCONCLUSIVE，不改系统权限来通过。

结束先恢复自有全屏窗口，再退出候选与底板，核对 PID、归档日志、截图、锁文件和构建错误；最后删除该次隔离根目录。不得清理用户既有缓存、窗口或工作会话。
