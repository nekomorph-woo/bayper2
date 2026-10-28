# S07/S05 工作结束欣喜短反应 v1

2026-10-28，Codex master受托批准，已有项目增量。依据state-and-rhythm.md、animation-plan.md E03、s07-happy-asset-review.md。Claude只读诊断55625终态已核，产品仍欠5类短反应/其他角色与完整24+12，本片不替代全量。

## 技术设计

交付完整凛finished→必达文字→首次回执→一次happy→恢复idle的垂直切片，不先堆仅测试注入的无业务动画入口。复用connector_events.id与notificationPresentation.acknowledge事务；返回本次新成功回执的eventIds（包括零新项时空数组），主进程仅选择非historical finished，不把done等同业务成功。文字先可见、不等待动画、不改变槽位/优先级/阅读时长/回执。一次回执多条finished只表演一次，事件本身与文字全保留。

主进程发送一次性work-reaction消息，经desktop-host当前有效子进程通道、desktop/main到preload/renderer。明确禁止把反应放进会重发的desktopPresentation或latestState，不加持久队列/表、不在启动时扫描旧事件补播。消息关联稳定eventIds、当前角色身份/显示代次；host或canvas未就绪就跳过，不缓存到重连。子进程崩溃不重播，首次回执已提交但动作未送达时允许缺少装饰表演，不能丢文字或伪称播放完成。renderer同事件拒绝重复且新代次/换人丢弃；若不用Set即可由主进程事务唯一性证明，避免再造无界缓存。

单一10秒冷却，只在有效发送后起计；冷却期间不排队不补播。P0 needs_attention正在展示时不庆祝。用户隐藏/系统暂停、未就绪、聊天interacting、resting/sleep、当前日常/探索、交接或已有自然节点等待、非凛/无同衣装素材均跳过；探索者不被召回，当前合资格同屏者承担文字。新事件仍独立记录。门禁在主进程和renderer各依本层真实状态核对，不能靠模式字符串代替真实活动/休息意图。

接入happy-v4到凛资产、共同显示计划、预载与命中allowlist，候选标识保留；不改变原六动作共同128/314比例和脚锚。记录idle当前帧和该帧剩余时间，happy播放1790ms后从原帧剩余时间继续，不重置0、不虚报idle-loop/daily-complete/rest-settled、不写数值或活动进度、不新增模型调用。反应期间新聊天/休息/换人/隐藏/暂停优先，取消旧反应不恢复已失效状态；用户点击按原交互处理，不能因新增反应吞掉点击，允许取消反应后进入原wave流程。自然节点等待不能因反应挂起或提前成功，必要加入已有边界时长计算。

允许app/desktop-assets.cjs、desktop-host.cjs、desktop/main.cjs、desktop/preload.cjs、desktop/renderer/canvas-app.js、app/main.cjs、notification-presentation.cjs、presence-boundary.cjs；优先原文件局部实现，不新增泛用调度器。生产净增约180～260行作为审查信号；若明显超出先报告职责与必要性，不压行。测试复用desktop/notification/activity工具及fixture，可新增一个tests/acceptance/desktop-work-reaction.spec.cjs集中本片约250～400行，必要更新desktop-assets单测/已有通知返回结构断言；不复制庞大Runner。

## Case与验收计划

|ID|Given / When|Expected与独立Oracle|
|---|---|---|
|POL-WORKREACTION-001|实际凛桌面，首次finished通知可见并回执|一次happy完整8帧，文字仍已结束/来源清楚；事件/回执不新增，数值/API/活动无额外副作用。真实SQLite与画布帧序核查。|
|POL-WORKREACTION-002|idle非0帧处触发，结束|恢复该帧及剩余时长而非0，几何/脚锚/128pt不变，无伪自然节点；DOM/帧时间序列+真实截图，首尾视觉master审。|
|POL-WORKREACTION-003|重复源事件/回执、气泡重排/窗口重建、画布子进程退出重启|同事件不重演；文字事实/回执持续正确，不用仅重复相同token代替重建验证。|
|POL-WORKREACTION-004|同批多个finished、10秒内再来、新冷却后事件|一批一次、冷却内不补播，冷却后新事件能演；文字逐条保留，真实返回变化而非时间无限等待。|
|POL-WORKREACTION-005|聊天、休息/睡眠、日常中到达finished|文字不丢，无happy、不退出聊天/唤醒/打断日常，不修改活动ID/进度/数值；覆盖实际状态门禁。|
|POL-WORKREACTION-006|探索/交接/非凛/无素材/隐藏/暂停/未就绪|不召回不借用，不补播；通知按既有规则继续，不将未执行说成播放完成。|
|POL-WORKREACTION-007|P0待处理仍在展示，收到finished|不播happy，P0与普通文字仍各自可见，不能用丢finished解决冲突。|
|POL-WORKREACTION-008|happy中用户点击/聊天/休息/换人/隐藏|主动动作优先、旧代次不续写，不恢复旧角色帧；自然节点等待不挂起或提前假完成。|
|POL-WORKREACTION-009|历史快照finished或重启后旧presented|无补播；随后真实新finished仍能正常反应。|

入口采用真实正式Electron/SQLite/通知服务；至少001/003走已授权隔离Herdr server/reportAgent，复用现有真实测试设施，只操作本轮自建server/窗口/数据。其余时钟/通知输入可构造但标明边界，不直接写业务结果伪造成功。现有通知回执/UI、desktop/sleep、activity回归按受影响路径执行，不重跑全仓凑数字。先保留旧缺少反应的真实基线，开发完成后master独立回归。每批唯一证据目录、命令/exit/SHA/逐Case记录；清理本轮自建环境。GUI操作遵守当前工具能力，无法取得物理输入即如实记录，不冒称人类体验。

代码由Claude Code实现，文档/Git/版本/master验收由Codex；禁止子代理、.env/真实模型API、全局配置修改。流程缺陷发现依AGENTS归档再修，本次诊断揭示产品缺口而非skill缺陷，不为凑迭代机械改skill。
