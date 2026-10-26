# S07c Codex预审

本记录依据实际diff及开发批次，不是独立通过结论。CLI98666仍在途，GUI由其独占。开发批次052431三Case通过，早期失败与清理记录保留，待固定源码后独立复验。

## 需补核查：拖拽中断与旧事件

当前main的dragState仅在drag-end清空，renderer的drag也仅在endDrag清空；applyState隐藏/素材失效/切角色及invalidateDisplay未取消已有拖拽。refreshHit将dragState置于alpha与可见性判断之前（仅全局ignore更优先），可能在鼠标按下后角色被隐藏、换代或显示错误时继续保持接收；若系统没有把pointerup交回该窗，后续透明处会被误拦截。当前POL-HIT-003只测正常释放后的ignore/error，不覆盖按住期间中断。

另外drag-start有epoch/key校验，drag-move/end只有sender校验。仍是同一webContents时，旧拖拽消息可能影响新状态。需用实际按下→隐藏/换代或错误→释放→恢复的最小对照核实，必要时在显示失效时同步取消两侧drag/capture，并确保取消不会触发wave。不应建立拖拽框架或全局输入钩子；不把每次正常心跳epoch变化都当作用户拖拽失效。

派发返修前先核对最终源是否已有处理；若尚无，就保留现有PASS的正常路径，补这项业务Case及旧代消息无副作用检查。系统输入、底板计数、恢复后透明/身体点击是最终Oracle，不能仅看drag变量已清空。

## 工具与证据

tools/desktop-input的入口、依赖和安全使用边界需有简短README，明确仅自建窗口、权限不可用时的结果，以及各工具输入/输出。当前屏幕scaleFactor=1，不能将其写成真实Retina屏实测；坐标单测可覆盖scaleFactor逻辑，但必须区分实际显示硬件证据。最终提交移除临时ping/逐事件debug（当前diff已在移除中），保留必要且有界诊断。

## 中断修订后的剩余核对

已看到cancelDragState、两侧cancel与token隔离，以及开发053115中断Case通过。还需核对同一个displayKey/素材不变、拖拽按住期间切为ignoreMouse=true：当前applyState的取消条件不含globalIgnoreMouse，主进程drag-move仍只看token；如果忽略时未收到释放，再恢复ignoreMouse=false可能留下拖拽。请以分段down→ignore→up→恢复→透明/身体双侧计数核对，必要时将全局忽略视为拖拽失效，不能只测未拖拽时的ignore。该核对沿用POL-HIT-003，不扩输入框架。

## Codex独立验收与受托接受（2026-10-27）

98666及补覆盖28180均终态exit0。补覆盖把现有隐藏中断块改为四项本地表驱动，未改生产：隐藏/同displayKey且同素材全局ignore/error/切澄，逐项实际down→drag→中断→up→恢复Hu；取消无wave，透明底板+1，身体wave1且底板0，当前拖拽注入旧token仍保持真实目标位置。开发最终批次054128，旧失败完整保留。

Codex **47550** 独占串行执行专属真实输入及桌面回归，均exit0：POL-HIT三Case全部PASS（约87秒核心执行），桌面 **11/11**（约55秒），独立unit **18/18**。证据`s07c-transparent-input/codex-20261027-r1/`、`s07c-codex-r1-native.log`、`s07c-codex-r1-desktop.log`、`s07c-codex-unit.log`。14项源码/工具摘要核对全部一致，实际查看本批canvas-final与plate-final，透明背景/小尺寸角色完整，下层输入框保持key。

| Case | 结论与实际边界 |
|---|---|
| POL-HIT-001 | PASS；Hu/Cheng/Rin真实CGEvent身体与透明点击双侧计数，底板输入框不失焦 |
| POL-HIT-002 | PASS；静止指针下当前帧、换角色、初现/位置变化按实际PNG alpha命中；实际屏scaleFactor=1，Retina硬件未覆盖 |
| POL-HIT-003 | PASS；正常拖拽/透明起拖/global ignore/error，四种按住中断恢复与旧token隔离均实际核对 |
| 清理 | PASS；canvas PID29044与底板退出，光标恢复，自建profiles移除；无系统配置修改 |
| 正式主目录集成 | 尚待转移后相邻通知/活动验证；不能由旧worktree main的回归替代最新主项目整合 |

生产约408新增/净372行，超初估是实际alpha、窗口状态与拖拽取消/token协同所需；逻辑集中于desktop与小helper，无输入框架/全局hook/截图轮询。工具说明、依赖与入口自包含。受托接受本切片的已测系统输入能力；不冒称人类长期体验、Retina或最终Spaces/全屏全流程验收。

## 最新主目录整合验收

Claude产物16项已逐文件SHA一致转入主目录；与基线9c59663比较确认目标desktop文件无其它主目录修改，未复制旧版本元数据、记忆或整个app。Codex92439在主目录串行运行activity-runtime **6/6真实Electron**＋notification-presentation **9/9领域**，总15/15；日志s07c-codex-main-integration.log。实际活动批次`s06d-runtime-activities/run-20261026214733562-64c9aa`六条appExit=0/cleanup=ok。通知领域使用测试自动生成批次2026-10-26T21-48-53-789Z-c2dd55；命令中的BAYPER_NOTIFICATION_EVIDENCE_BATCH未被该Runner识别，不据此命名证据。

随后独占26957对实际desktop-notifications选测UI-002/004/005/009 **4/4**：三普通+独立P0、窗口重建/暂停、边缘与聊天互不打断、无角色必需通知。日志s07c-codex-main-notifications.log；批次`s05j-desktop-notifications/run-20261026214923672-d2e402`四Case cleanupErrors均为空，进程退出有记录。未声称本轮重跑全部11项通知GUI或所有Herdr恢复场景。

上述两个工具均终态exit0，主目录整合受托接受。正式窗口源已固定；桌面输入不改变名单、数值、故事、素材发布标志。原生独立的裁切角色/底板截图可随成果提交；桌面回归全屏截图保留本地，不将用户桌面背景无差别提交公开仓库。

证据入库范围：保留独立codex-r1、开发最终054128及052207/052259两个代表失败批次；其余调试原件已完整复制主目录本地evidence，不随worktree清理丢失，不将全部逐事件调试输出混入本次提交。
