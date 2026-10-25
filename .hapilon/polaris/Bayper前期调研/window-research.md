# Electron / Tauri 2 最小窗口实测

日期：2026-10-25，Asia/Shanghai。仅技术研究，不涉及产品设计。候选限 Electron / Tauri 2，原生底板只是独立测量工具。

环境：macOS 27.0.1（26A434）、Mac mini M4、32GB、主屏 2560×1440 逻辑分辨率。Electron 45.0.0（Chromium 156.0.8078.48），Tauri 2.12.5，Rust 1.96.0。源码由 Claude Code 编写，Codex 独立审查、构建与观察。Tauri 使用 release，Electron 使用正式 runtime、无 dev server / DevTools；本轮没有签名、公证、安装包或分发测试。

合同见 window-cases.md。两个候选共用 240×240 Canvas，中心 120×120 色块，静止/约 30fps 两种负载；不接 Herdr、不加载网络素材。底板与采样器不纳入候选进程组。

## 已识别的测量边界

CUA 的应用级点击会绕过桌面遮挡/命中测试。校准中，关闭穿透时直接点底板仍增加计数；开启穿透时直接点 overlay 仍触发 renderer-click。因此这些自动化点击只用于识别测量问题，全部排除出穿透通过证据。工具返回单窗口 JPEG，也没有保留 alpha 或其他窗口合成，白色角落不能证明背景不透明，底板截图看不到 overlay 也不能证明 overlay 不存在。

跨 Space 观察结合实际原生全屏/Space 变化、CGWindowList 的 onscreen 列表、层级和前台 PID。它可以证明窗口服务器仍把 overlay 放在当前屏幕较高层，不能替代逐像素的桌面合成效果或所有全屏应用兼容性。

## 资源采样

每组 20 秒、每秒一个点，共 21 个 RSS 点、20 个 CPU 区间。一核 100%；RSS 为进程合计，可能重复共享页，不是独占内存或电池结论。动画采样包含启用后的起始区间，未另做长时间稳定性检验。

| 候选 / 负载 | 进程组平均 RSS MiB | 区间 CPU 平均 | 当前边界 |
| --- | ---: | ---: | --- |
| Electron 静止 | 369.29 | 0.20% | 主进程及 3 个后代辅助进程 |
| Electron 动画 | 356.16 | 7.55% | 同一进程组；运行顺序与页面回收影响 RSS，不能解释为动画更省内存 |
| Tauri 静止 | 166.64 | 0.40% | 主进程加本次新建的 GPU / WebContent / Networking |
| Tauri 动画 | 173.42 | 11.29% | 同一组四个进程；归属依据见下文 |

Electron 的 animation-stop 为 610 帧 / 20,137.9ms，约 30.29fps；不是显示器逐帧呈现或 GPU 帧时间测量。

Tauri 的 animation-stop 为 1,188 帧 / 42,853ms，约 27.72fps。两个 stop 记录覆盖各自整段动画开启时间，资源表只取其中 20 秒；没有为了凑相同测得帧率更改共同的计时目标，也没有把不同实际节奏当作完全相同的呈现工作量。

Electron 纳入主进程 89685 及后代 89691/89692/89693；四个进程都在退出后消失。Tauri 主进程为 90469；启动前保留系统 WebKit 基线，随后只新增 GPU 90476、WebContent 90478、Networking 90481，启动时间对应 Tauri 启动。这三个由 launchd 托管，因此需额外显式纳入采样。没有把系统原有 16 个 WebKit 都算给 Tauri。普通权限无法通过 launchctl procinfo 取得系统 responsible PID，归属结合启动与退出观察推断，不能冒充 OS 精确归属账单。

静止 Tauri 采样期间对 WebContent 运行了约 1 秒 sample，用于检查进程身份；保留该干扰，不将 0.20% 与 0.40% 的小差异解释为稳定性能排名。动画为相同 JavaScript 计时目标，实际节奏需按 trace 计算，不能把计时回调等同于真正呈现帧。

本组结果只支持：Tauri 的估算进程 RSS 较低；本次动画 CPU 高于 Electron。不是所有内容/机器/窗口数量的框架性能排名，没有测 GPU 使用率、功耗或长期内存增长。

## 焦点：窗口状态与前台应用不同

Electron 启动、隐藏后 showInactive 均报告 focused=false；底板在启动时保持前台。用户实际点击关闭穿透的青色中心时，renderer 收到点击，同时底板出现 windowDidResignKey、frontmostPid 变为 Electron 89685；Electron 的窗口 focused 仍为 false。这说明 focusable=false 并不能保证点击不激活应用。

Tauri 于 13:23:30 启动并 show；在 CUA 第一次读取该应用之前，底板 heartbeat 已于 13:23:31 将 frontmostPid 从原应用 28257 记录为 Tauri 90469，且持续保持。Tauri 自身始终 is_focused=false。按“显示时不切走前台应用”判据，该标准配置不通过，不能只用 is_focused 宣称成功。

本轮先保留失败基线，没有用第三方 NSPanel 插件或平台补丁修饰结果；这不证明框架无法实现，只证明当前最小标准配置尚未满足完整的非激活要求。

## 透明、点击与 Space 观察

Electron：用户确认青色块悬浮在 Codex 上方。首轮人工回复到达时已切换为 ignore=true，不能把该回复冒充关闭穿透的证据；当时实际原生底板接收了中心附近的连续点击。随后固定 ignore=false 并停止自动化输入，用户明确重复操作“点棋盘、再点青色块”，Electron 在 13:21:48、13:22:01、13:22:49 记录真实中心点击，区别于此前 13:18:26 的工具定向点击。原生底板日志保留空白处点击与 key 状态。关闭/开启穿透的真实命中路径不同。用户没有明确确认 Electron 的透明角落；单窗口截图不能填补此项。

Tauri：ignore=false 期间没有发送定向点击，用户确认点击青色块及中心，并明确“青色方块外面是棋盘底板”；renderer 记录 9 次真实点击，支持桌面透明背景的人工观察。不是 alpha 数值或像素边缘质量测量。13:28:32 实际应用 ignore=true，用户随后确认完成穿透组；底板在 13:28:54 同一位置收到两次点击，而 Tauri 的真实 click 数保持 9。按当时底板的新位置 X=770、Y=229、高度632及点击局部坐标 X≈451.09、Y≈379.35 换算，屏幕点约为 (1221.09,481.65)，与 overlay 中心 (1220,480) 对应。保留窗口位置变动，不错误套用最初的底板坐标。

Electron 设 visibleOnAllWorkspaces(true, visibleOnFullScreen=true)，底板进入原生全屏后仍见 overlay（window 77788）在 onscreen 列表、layer=3，高于全屏底板 layer=0；前台仍为底板。Tauri 标准 visibleOnAllWorkspaces=true 在普通桌面 layer=5；同一底板进入原生全屏后，overlay 不在 onscreen 列表，退出全屏后重新出现。证据分别为 electron-fullscreen.json、tauri-normal.json、tauri-fullscreen.json、tauri-restored.json 与底板的 enter/exit/activeSpaceDidChange 日志。

上述包含实际进入/退出全屏 Space；没有单独完成两个普通 Desktop Space 的可靠切换。CUA 的应用定向快捷键与 Dock 状态读取未提供可靠的 Mission Control 控制，本轮不据 all-workspaces 配置推定普通 Spaces 全覆盖。Electron 的全屏结果是窗口服务器层级证据，不是所有应用全屏的视觉与交互保证。

Tauri 另做 hide/show：隐藏前、隐藏后、重新显示的前台 PID 均为原应用 28257；此路径没有再次激活 Tauri。不能把启动时的失败泛化为每次 show 都失败，也不能用本次 show 成功抹去启动失败。

## 覆盖与技术判断

| 合同 | Electron | Tauri 2 |
| --- | --- | --- |
| WIN-01 透明 | INCONCLUSIVE：窗口绘制与悬浮已确认，但角落的桌面合成缺少独立确认 | PASS：用户确认方块外直接为棋盘，未量化 alpha/边缘 |
| WIN-02 整窗穿透 | PASS：真人关闭/开启对照，真实命中路径不同 | PASS：关闭时 renderer 收到，开启时中心点击落到底板 |
| WIN-03 不抢焦点 | FAIL：启动/重新显示通过，但真实点击会激活应用 | FAIL：启动激活应用；hide/show 通过；窗口自报未 focused 不足以通过 |
| WIN-04 普通 Spaces | NOT_COVERED：未可靠切换两个普通 Desktop | NOT_COVERED：同左 |
| WIN-05 原生全屏 Space | INCONCLUSIVE（正向层级证据）：全屏时仍在 onscreen 的较高层；无完整合成图 | FAIL：普通桌面存在，全屏时不在 onscreen，退出后恢复 |
| WIN-06 资源 | PASS（测量完成）：四进程，单机小样本 | PASS（测量完成）：主进程与三个新 WebKit，归属为启动/退出推断 |
| WIN-07 清理 | PASS | PASS |

当前取舍证据：Electron 的标准全屏覆盖控制更直接，但 RSS 较大；Tauri 的估算 RSS 较低，但本次动画 CPU 较高，标准跨工作区配置未覆盖原生全屏。不激活应用的要求在两者都没有完全达成。暂不把这些结果提升为最终技术选型；无需进入产品设计即可保留这些技术边界。

## 证据与清理

本地证据在 evidence/2026-10-25-window-spike/：两候选与底板 JSONL、四组资源逐点数据、窗口元数据快照、单窗口 JPEG、三轮构建日志、依赖锁与源文件 SHA-256。原始证据默认仅本地，合同、探针与报告入 Git。人工证据来自本次用户的明确回执，未伪造人工体验。

Electron 运行复制件使用首次完整写出的同功能 main.cjs，CLI 随后整理了声明位置、换行、注释及等价的位置局部变量；两份实际差异在 electron-runtime-format.patch，hash 分别保留。Canvas 与 Tauri 运行复制件和源码 hash 一致。测试构建版本为 0.1.12；后续 0.1.13 只同步快照版本元数据与完成研究记录，不代表重新做了一轮性能测试。

Electron 和 Tauri 经 quit 命令退出；底板已退出全屏后用显式 PID 终止。旧/新底板 89610/90585、Electron 89685 及后代、Tauri 90469 和三个 WebKit helper 均消失；lsof 未发现仍打开隔离目录的进程。停止后的 WebKit 同步退出进一步支持本组归属推断。没有残余测试 Space（只进入/退出自有全屏，没有创建普通 Space），也未改系统权限或桌面偏好。

安装时发现 Electron 45 install.js 使用 electron_config_cache 而非 ELECTRON_CACHE，首轮下载因此写入默认缓存。已按 13:12:47 的新建时间核对并仅删除本次 Electron 45 arm64 zip 及其空 hash 子目录，保留既有缓存；复现说明已修正变量名。Tauri incognito 下未发现该测试标识的 WebKit、Caches 或 Saved Application State 目录。

必要证据归档后，已删除 /tmp/bayper-window-spike-ueR1x3 的依赖、Cargo cache、release 产物、用户数据和临时 .app，确认目录不存在。未安装到 Applications，探针未接入 Herdr 或外部业务服务，未触碰原有工作会话。

## 构建问题

Tauri 首轮因缺少 icons/icon.png 编译失败，即使 bundle.active=false 也需要默认图标。Claude Code 用 build.rs 在隔离构建复制件中生成 1×1 RGBA 图标后继续构建。随后发现 set_activation_policy 返回 ()，不能作为 Result 传入日志函数；返修后 release 实际构建通过。保留各轮编译日志，不隐藏失败。

失败和未覆盖项保留原判据；本轮完成的是两套最小配置的实测及边界记录，不是全部窗口要求已经满足。
