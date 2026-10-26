# S06d在途生产活动审查

94916仍在实施，本页仅记录实际源码发现与后续验收重点，不抢GUI、不替Claude修改实现。

## daily必须具有可见活动表现

当前main.desktopPresentation明确activityVisual=status-only，canvas仅显示“日常中”徽标，继续idle；activity-runtime的isDesktopReady只看通用idle资源ready，随后仍可request daily并在节点扣精力。这不能满足计划001“正确动作”与004“无可见daily不扣费”。诚实标注status-only不能把缺失活动动画变为已完成的日常。终态按现有候选C01实际播放审查再启用，或保持daily不可用且Case对应NOT_COVERED，不接受仅idle+徽标作为正式日常通过。探索出发的明确降级表现可另审，但不可把全部动作需求缩成状态标签。

需要实际Case：idle正常、daily动作缺失/损坏时，自动机会不启动daily、不扣2；未来动作可用时真实播放器显示该动作并在自然节点收束，满足时长与完成节点后才结束。素材候选尚未批准，不能由Claude自行将assetAvailable改true。当前实现尚未终态，最终以diff和真实播放为准。

## 多原因恢复不能丢失待恢复活动

当前resumeFromSystem在activeChat仍存在时跳过resumeActivities，然后无条件清空systemPausedActivityIds。若暂停活动属于其他名单成员，且聊天没有捕获该ID，之后关闭聊天也不会恢复。另handleDesktopReady先清空assetPausedIds再尝试resume，资格暂时不满足可能丢失故障恢复来源。最终003必须覆盖系统/聊天/画布故障叠加与解除顺序，而不仅每种单独通过。需沿既有持久活动事实恢复，不凭内存数组清空就认为已恢复，不无限重试不合资格活动。

这些为源码路径推断，未跑新增失败，不标已复现。终态核对实际Case与实现再确定最小返修范围。

## 实际画面核对

Codex已查看开发批次run-20261026152329678-2ed033/runtime-001-daily-desktop.png：角色站立待机，头顶“日常中”白色徽标覆盖头饰/头部区域。此图不能证明正确daily动作；在128pt附近展示中标签也遮挡形象，不接受为最终表现。另查看已保存stretch-pixel-v2浅棋盘8帧，具备收手→举臂伸展→回落姿势序列，但尚需独占GUI下实际128pt播放/idle衔接/中断验证，不能仅凭本次静态检查将其批准为生产动画。

## 终态与独立验收

94916已终态；Codex独立99317执行activity/source/chat-ui共26项全部PASS、无skip、exit0，日志evidence/s06d-codex-final.log。真实活动批次20261026154603128-4a04c9四Case正常退出且清理；实际查看探索接替者管理窗，凛探索、琥珀当前归属清楚，名单结构保持，未把返回者强行换回当前位。使用真实Electron/main/SQLite，时钟、随机、模型HTTP是构造fixture，不声称真实模型语义验收。

终态修复已取消idle+徽标，daily缺动作时不请求活动、不额外扣2；自然陪伴时间仍可能消耗基础精力，不把数值完全不变当作业务要求。多原因恢复扫描持久活动事实，不再丢内存ID。单一用途轮转由main持有，来源执行器没有第二调度器。

| 原Case | 当前覆盖 | 决定 |
|---|---|---|
| 001 | 不可用动作不启动、不扣活动费用通过；正式daily播放/完成未覆盖 | NOT_COVERED，不能称daily完成 |
| 002 | 探索节点交接、唯一同屏、只扣8、返回不抢位、无接替者不开始 | PASS；出发动画仍候选缺口 |
| 003 | 探索聊天、锁屏、跨重开、多原因恢复同ID | 探索部分PASS；daily中断仍NOT_COVERED |
| 004 | 单机会用途、来源失败不双发、无预算仍后续本地探索、退出清理 | 已实现部分PASS；daily可播放路径未覆盖 |

受托接受的是“单一自动用途与探索持久生命周期”自洽基础切片，不接受完整S06d交付。未降低原001/003 Expected；接下来必须接入获审查的真实daily动作，补上述NOT_COVERED。本次不产出故事/线索；后续正式故事链仍需接入。

产品文案收尾：6698仅移除角色页工程说明，保留自然活动进度，未改Expected或业务逻辑。Codex另运行4个活动Case复验，结果见evidence/s06d-codex-copy-final.log；独占GUI重跑排除手动预览短暂冲突的证据影响。
