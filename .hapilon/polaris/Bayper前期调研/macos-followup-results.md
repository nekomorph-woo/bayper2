# macOS窗口与进程闭环补测结果

2026-10-25，Asia/Shanghai。合同macos-followup-cases.md。macOS27.0.1 arm64、Electron45.0.0、Tauri2.12.5；窗口/fixture执行版本为0.1.16，归档快照的后续版本元数据不是重新测量。代码由Claude Code实施，Codex审查、构建、运行与验收。排除签名分发及Bayper产品设计。

## 窗口对照

| 真实配置 | 启动/显示与点击焦点 | 普通Spaces | 自有原生全屏 |
| --- | --- | --- | --- |
| Electron panel + Accessory | 启动保持底板前台；真人中心点击后底板失key、前台变为Electron2054，失败 | 用户实际切到另一普通桌面并确认可见；底板有切换通知 | 未单独重测该模式；不能从其他模式挪用结论 |
| Electron panel + Prohibited | 启动时底板仍前台；隐藏/重显不激活；7次真人点击时窗口focused=false，未成为前台，观察窗口通过 | 本模式未单独请求再次普通桌面切换；同panel的Accessory模式有正向证据 | 复核时240×240窗口onscreen、layer3高于全屏底板layer0；用户报告一直可见与透明角落，见下文时间边界 |
| Tauri社区NSPanel + Accessory | 启动前台变为2556；真人点击focused=true，底板失key；失败 | 用户实际切换并确认另一普通桌面可见 | 原普通窗口缺失问题改善：NSPanel在真实全屏时onscreen、layer5，底板isFullScreen=true |
| Tauri社区NSPanel + Prohibited | 启动时底板仍前台，修复了本次启动激活；本模式真人点击未重测 | 本模式未单独重测 | 未单独重测，不能挪用Accessory的全屏证据 |

Electron采用内置type=panel，Tauri依赖tauri-nspanel固定rev `18ffb9a201fbf6fedfaa382fd4b92315ea30ab1a`，经`to_panel()`转换，设置非激活样式、canJoinAllSpaces/fullScreenAuxiliary、hidesOnDeactivate=false、orderFrontRegardless。它的RawNSPanel仍允许canBecomeKeyWindow，因此不能假定focusable=false能覆盖这一原生适配行为。[Electron panel说明](https://www.electronjs.org/docs/latest/api/structures/base-window-options#platform-notes)、[适配器源码](https://github.com/ahkohd/tauri-nspanel/blob/18ffb9a201fbf6fedfaa382fd4b92315ea30ab1a/src/raw_nspanel.rs)

人工回执：用户先后明确Electron和Tauri在另一普通桌面可见；第三组明确Electron青色块一直可见、多次点击、方块外可见棋盘且无白/黑底板。未把工具定向点击算真人命中。第三组期间用户先退出了底板全屏，随后点击实际发生在普通桌面，点击时前台为Codex且保持不变；因此不声称“全屏下点击焦点已验证”或“底板在这些点击时始终持key”。第一次标为electron-prohibited-fullscreen.json的快照也已回到普通桌面。Codex随后用自有控制重新进入全屏，独立观察layer3/全屏2560×1440底板并恢复；stdout转录另存electron-prohibited-fullscreen-recheck-transcript.json，明确不是原始自动写盘JSON。

隐藏/重显补测实际执行seq3/4并记录；早先seq1/2快速连写导致seq1未执行，不能把那一组作为隐藏证据。此控制文件轮询限制已补入复现说明。

**当前窗口选型判断：个人macOS使用优先沿Electron继续，采用panel路径并将Prohibited作为本轮不激活画布的已验证对照。** 它的证据更完整，且不需要为NSPanel引入社区原生适配；代价仍是前轮测到的较高RSS。本轮没有重跑资源排名。Prohibited不是完整应用架构方案：键盘输入、普通交互窗口、系统休眠/显示器热插拔仍需在对应切片验证。Tauri仍可选，但本次尚无同时满足启动与真人点击不抢焦点的同一配置完整证据，不能宣布已排除或完全不可实现。

新panel路径的整窗穿透未再做真人开/关回归，保留前轮标准配置通过证据，但不将其冒充新模式通过；本轮新增重点是焦点、普通Spaces与全屏。

## 安装与GUI进程闭环

真实GitHub安装、更新无变化、卸载后留存与下次启动清理，以及同类实现检查，见install-peer-followup.md。参考插件GUI未启动，自有fixture才运行真实Electron；二者证据分开。

自有fixture采用短命startup/action入口→按socket的flock守护→真实Electron。日志记录Herdr注入的socket/config/state/root；server a与b的pane_id相同也不会共用锁。这个守护是实验实现，**不是Herdr自带的daemon supervisor**。

| 情形 | 实际观察 | 依据 |
| --- | --- | --- |
| a显式start，再并发3次start | 首个守护3258/GUI3259保留；3个后续守护因锁占用退出，未重复GUI | gui-lifecycle.jsonl、PID核对 |
| b start | 不同socket key，独立守护3330/GUI3331；两会话都真实显示 | 状态文件、Electron startup/visible日志及ps |
| a stop | a守护以stop_marker退出并回收GUI；b守护与GUI仍活 | daemon_exit与独立ps |
| 强制杀b GUI3331 | 守护以gui_exited退出，gui_exit=-9；显式start可再次拉起 | CLI记录与守护事件 |
| 强制杀守护3372 | 子GUI3373记录owner-exited后close/closed并退出 | Electron日志及独立PID检查 |
| 停a server | 守护3403连续请求失败后回收GUI3405；b GUI3406继续 | request_failures事件与b ps |
| 重启a server | 真实startup注入event=startup，创建新守护3430/GUI3431 | Herdr日志与ensure/daemon_started |
| disable插件 | a/b两侧守护均检测disabled并退出，GUI均消失 | daemon_exit/plugin_disabled和ps |
| enable本身 | 在1.2秒额外观察窗口未新启动GUI；随后显式start恢复 | 非无限期证明；与既有startup契约一致 |
| unlink运行中的fixture | 守护3504检测plugin_absent并回收GUI3505 | 事件、空plugin列表和ps |

共观察7次有效守护启动、3次锁竞争拒绝。所有17个记录到的守护/GUI/锁竞争PID在结束时均不存在。GUI源码带可选每400ms owner存活检查，因此本轮SIGKILL后能自退；不防PID复用，不能推广为任意故障都不会留孤儿。stop后立即start可能遇旧锁尚未释放，本轮没有实现重试/确认协议；崩溃恢复靠显式action或下一次server startup，不是自动重启保证。守护轮询使用固定1秒、请求超时3秒和3次失败门槛，本机server stop样本约几秒退出，不承诺所有故障同样时延。

## 覆盖与收尾

| 合同 | 结果 | 限制 |
| --- | --- | --- |
| MAC-01 | Electron Prohibited观察窗口PASS；其余配置保留上述FAIL/未覆盖 | 没有全屏点击/键盘输入连续性的普遍保证 |
| MAC-02 | 普通Space人工观察PASS（两者Accessory panel）；全屏窗口服务器证据PASS | 不同模式分开；没有所有全屏App视觉覆盖结论 |
| MAC-03 | Electron透明人工观察PASS；新panel穿透INCONCLUSIVE | 旧普通配置穿透PASS不替代本轮回归 |
| LIFE-01 | PASS（已覆盖的安装链路） | 真实远端新版本升级未覆盖 |
| LIFE-02 | PASS（实际GUI、重复/并发与socket身份） | 不是产品宠物数量设计 |
| LIFE-03 | PASS（本合同固定故障样本） | 不覆盖PID复用/休眠/重连风暴/长期监督 |
| LIFE-04 | PASS | 只回收本轮资源；最终状态如下 |

证据在本地evidence/2026-10-25-macos-followup/：Claude任务/实际Read与实现记录、编译失败/成功日志、窗口JSONL/CG元数据、人工回执摘录、Herdr安装与进程事件、独立PID核查。研究代码与合同/报告纳入Git，原始证据沿用本地排除约定。

构建首轮因锁生成尚未复制完成而出现--locked不一致，复制最终锁后成功；Tauri普通panel与Prohibited版均release编译成功。cocoa弃用和block0.1.6未来兼容警告保留，不是长期维护通过。原生底板编译成功。Electron/Rust实际运行源码与归档源码逐字节相同；后续仅版本元数据更新。

最终审查另发现底板fullscreen布尔值被无条件当作toggle执行；前述窗口证据均以实际enter/exit事件为准。已交回Claude加上目标状态比较。在额外独立临时根实编译并启动修正版底板，连续发送true/true/false/false，实测只有一次enter和一次exit，随后退出、归档并清理（control-idempotent/）。因此最终Swift源码比前述窗口实验多此项已复验修正，不伪称全部是同一旧二进制。

两个测试server已停、插件表为空、socket消失；所有候选/底板PID及自有守护/GUI均退出，未发现本轮启动时段仍残留的WebKit辅助进程。原始材料归档后删除两个隔离根（含依赖、构建产物、参考仓库和临时用户数据）。未调用广域pkill，未触碰原有Herdr会话或用户配置，未改系统权限/桌面偏好，没有做打包分发验证。
