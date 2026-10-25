# macOS窗口与安装生命周期补测合同

2026-10-25。用户授权继续技术研究，macOS优先、代码交Claude Code、保留证据并清理；不验证签名分发，不进入Bayper产品设计。沿用既有两候选基线及隔离Herdr授权。

| ID | Given / When | Expected与独立Oracle | 边界 |
| --- | --- | --- | --- |
| MAC-01 | 两候选采用非激活panel路径，前台为自有底板，启动/隐藏再显示/点击 | 应不切换前台应用；底板heartbeat与真实点击日志核对，不仅看窗口focused | 手工鼠标或明确区分工具定向点击；失败原样保留 |
| MAC-02 | 候选在普通桌面、第二普通Space和自有底板原生全屏中显示 | 记录是否仍onscreen及窗口层级；能观察合成画面则补视觉证据 | 无可靠普通Space切换时NOT_COVERED，不用全屏替代普通Space |
| MAC-03 | panel路径开关穿透、透明区域对照 | 不因修焦点回归既有透明/穿透行为 | 缺真人对照不得以应用定向点击声称桌面命中通过 |
| LIFE-01 | 独立XDG中真实GitHub插件install、list、update、uninstall | 记录build、安装根、版本/commit、config/state与旧安装留存 | 安装前审查源码，阻止参考插件GUI自动启动，不使用其广域pkill停止动作 |
| LIFE-02 | 本地研究插件通过startup/action启动真实GUI，重复/并发调用及两会话 | 同一会话不重复启动，不把另会话当同一owner；启动入口完成后可观察真实GUI | 是研究机制，不冻结产品多宠物/单宠物规则 |
| LIFE-03 | 研究GUI/守护进程异常退出、server重启、插件disable/unlink | 区分宿主本身行为与研究watchdog；正常退出不遗留GUI；崩溃后有明确恢复触发 | 不虚称Herdr有daemon supervisor；如崩溃导致孤儿保留失败 |
| LIFE-04 | 停止、取消注册、server stop、收尾 | 只回收本次PID、socket、临时目录与GUI，证据留本地 | 不连接现有会话，不改全局系统/工具偏好 |

对照研究仅取用户给定两插件及Tauri panel适配器，核对平台支持、窗口/焦点、多会话与进程归属，不扩成竞品功能设计。
