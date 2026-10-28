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

## r155 返修方案（master受托批准，Expected不变）

依据s07-work-reaction-review.md r153/r154及54338只读诊断（exit0、is_error=false）。本轮将现有未接受实现修到原001～009契约，不以诊断所称“Case002通过”替代完整Oracle。

- 真实001/003：一个隔离Herdr server、focused control与非焦点target，working→idle→权威done→Bayper finished；删除同形server双栈。idle观测与finished对账均按已有通知规则保留，本片不顺手重写适配器；若没有真实finished则报告缺口。事件查询必须绑定新id界限和agent身份。
- 停帧：取消短反应后同身份同代次交由现有idle/聊天/休息/日常规则接管，不能留下happy冻结或重新续播；旧身份和失效进度不恢复。隐藏/暂停恢复也须实测，不能只断言没有happy起点。
- 002选择足够长的非0 idle帧，触发前故意消耗一段时间，使“原剩余时间”与“完整重播该帧”可区分；记录实际时间序列及容差、反应中/前后几何与脚锚，收集真实onNodeComplete。
- 008补自然节点等待：happy剩余加恢复idle的剩余周期可能超过现有max+1200，允许presence-boundary按串行路径计算合理有限上限，测试不能把happy结束冒充idle-loop；已有等待时新反应仍跳过。
- P0门禁保留保守实现，本批不新增隐藏P0时庆祝的行为；关键是冷却已过、P0实际可见、其他门禁均满足时验证抑制，新finished文字在可见/回执时捕获。拒绝仅调换if顺序伪造覆盖。
- 005/006主门禁实际路径均补齐（聊天/睡眠休息/日常/探索/交接/隐藏/暂停/未就绪/非凛），构造输入明确边界。003补窗口重建，009分开历史与重启旧presented，不利用冷却掩盖重复。
- 净生产约335行暂按跨四进程边界/门禁/恢复的职责有条件接受，仍查重复与必要性；Runner删双栈，约350～450行信号，必要超过先解释，禁止压行或拆文件隐藏总规模。原白名单有效。可复用既有fixture，不扩工具框架。
- 每组最多两次有根据的定向执行，仍失败即报告根因和原证据供master继续调度；不是降低Case要求，也不覆盖原失败。之后master独立复验和视觉审查。

## r156 Runner修正与补验（master受托批准）

保持原001～009。只修改desktop-work-reaction.spec.cjs及必要已有测试；生产当前先冻结，若有效反例证明新生产问题则报告后再修。使用review r156具体反馈：继续陪伴调用真实switchCompanion(rin)或正式按钮并assert result.ok；采集从触发前持续开始（可复用已有DOM帧trace思路），首帧不能采丢；自然节点waiter要真正创建并断言不早于恢复idle-loop且不超时，旧代次也要观测。

门禁逐一排除冷却等其他原因：聊天/睡眠休息/日常/探索/交接/隐藏/暂停/未就绪/无素材与非凛，读已有生产接口和相关Runner，必须先断言目标状态真实生效。探索者离桌且活动不受事件影响；有继任者时由合资格同屏者接文字，不能继续要求探索者仍在屏。通知窗口不可见/系统暂停时冻结阅读回执；仅隐藏角色不等于隐藏独立通知窗口（r159澄清）。角色隐藏时仍应显示必需文字且跳过装饰反应，不用“没人ACK”冒充发送门禁通过。构造历史输入明确边界，不改产品Expected。

本批scope不再机械要求450行：master阅读确认约400行是隔离Herdr/Electron/SQLite与观察清理设施，后约600行为9Case分组，当前1073行可有条件保留，避免为行数压缩/隐藏。总量目标不超过1250，若超出先给必要性和真实复用方案；不搭通用框架、不扩大生产。每个修正组至多两次定向运行，仍失败报告；原始失败保留。002旧数据仍可引用但本次修改Runner后由master复跑相关覆盖，不能用旧绿替代新版本。

## r157 只补剩余Oracle（master受托批准）

生产继续冻结。master已独立现行真实链路及渲染2/2通过，不必再次重做生产。剩余Runner修改：

1. 通知按data-event-id观察每条真实可见内容及.item-source，001匹配本轮已知server/agent标签；004两事件分别留可见文案与ACK证据，不仅一条“已结束”。从触发前采集，不能在已消散后才找。
2. 交接门禁须在事件ACK/反应观察期间仍pending。允许声明仅控制canvas渲染时钟的fixture（例如现有Playwright clock/CDP能力），保持真实主进程/Herdr/SQLite/通知运行，让自然节点不提前结束交接；若该控制连通知也冻结则不是有效实验。分别记录pending前/ACK时/结束，恢复clock后确认自然交接可结束。不能关动画导致未ready或其他门禁混淆；不能放宽为“交接结束后也禁反应”。
3. 005补实际sleep子态（已有20s静默，无需调用模型）；006角色隐藏时独立通知仍可见并真实ACK，但不播放装饰反应；恢复不重播旧事件，未就绪可用真实host未启动/正在启动发送拒绝后启动无补播来覆盖传输边界，明确它不是主进程入口全链。无同衣装素材和非凛按实际资产状态验证不借用。门禁采样断言无任意happy帧，不仅frame00。
4. 探索保持活动不变且实际角色窗离桌/已接替；只读exploring布尔不是离桌视觉证明。允许构造活动输入，但核窗口状态；如构造绕过正式探索离桌流程，改用已有活动入口/fixture，不修改产品迎合构造。
5. 自然waiter在happy真正开始后创建，模拟用户此时请求节点；当前测试在反应前创建仅证明host时限，不覆盖主进程“已有等待则拒反应”规则。保持实际不早于恢复idle-loop。

规模在既有1219行基础只增必要观察/门禁，目标不超过1400，若超出说明职责；不新增抽象框架/生产测试后门。各组最多两次有效定向运行后报告；不以组green冒充缺Oracle的Case完成。

## r158 最后驱动修正（master受托批准）

只改当前Runner，生产仍冻结；禁止再改Expected来适配错误状态。
- 来源文本允许同一本轮Agent的已知label（t0/t1/t2）或真实agent_id回退，必须同时匹配本轮server短标识和data-event-id；这是现有sourceLabel语义，不要求生产强制一种。
- 所有持续帧trace须由测试资源拥有并在finally停止/等待后关闭app，错误应保留原assert原因；不能让未await后台采样遮盖真实失败。避免为此造通用资源管理器，局部集合/已有resources即可。
- 交接先把canvas置Debugger暂停（仅测试夹具），再写pending并等待snapshot/主心跳；主进程、通知、Herdr保持运行，ACK时再次确认pending。trace在暂停前启动，恢复后直到交接完成再采一段，禁止在完成后才开始观测；断言无任意happy，不只frame00。恢复后必须能自然结束，finally释放Debugger/session。若暂停也冻通知则报告ERROR，不改主进程绕开。
- 历史009开始前断言无可见P0且冷却已过、凛idle；否则007的门禁会掩盖错误历史表演。
- 本轮总规模目标≤1450行，允许必要资源收口与因果断言；不要为了小幅数字压缩。只跑修正真实/门禁两组各至多两次；已有渲染数据保留，master最终再统一验。无.env/API/子代理/Git/版本/文档写入。
