# S07 睡眠运行 master 中期审查

2026-10-28，基于尚在实施的 Runner，只记录问题，不构成最终验收或变更生产授权。Claude 99046 正在执行失败基线，先保留其原件，终态后交回修正并复验。

## 已发现的验收缺口

1. `tests/acceptance/desktop-sleep.spec.cjs` 的 POL-SLEEPUI-002：`natural.length > 0` 才检查连续，wake 也仅遍历现有元素，故直接跳到 sit、没有任何后续困倦/唤醒帧时两个空数组可能通过。必须独立断言实际自然段完成到7、唤醒发生且最终到0，再到sit末帧；处理采样时已显示当前帧不会重复发事件的事实，不要求重复帧。当前 raisedEntry 来自首次 >=2 的历史条目，不必等于点击发生时实时帧，须固定观察时刻并验证之后的合法序列，避免错误期望造成偶发失败。
2. POL-SLEEPUI-005 当前只覆盖构造 lock/unlock；计划中的 hide、asset error、exit 不能因此一并标PASS。补对应真实公开入口测试，或在矩阵明确 NOT_COVERED 并继续补齐；既有通用清理测试不足以证明睡眠新增计时器/帧停止。
3. 所有约20秒和帧边界结果以真实时间及实际帧证据为准；截图与连续动画审查仍待 master，测试通过不自动发布正式素材。

修正仍由 Claude Code 执行；不在其当前失败基线运行中修改 Runner。无用户人工体验结论。

## 第二轮只读检查

- 旧实现 GUI 基线已终态：`evidence/s07-sleep-runtime/attempt-20261028-baseline-before-impl/gui-exit.txt` 为1，日志实际因困倦未开始失败；不等于新实现通过。
- 当前 `companionship.cjs` 的探索资格改变同时影响 requestActivity 和 startScheduledActivity，两者复用 activityEligibility；不是只改变已排队活动的启动判断。现测试004B使用 insertScheduledExploration 直接插入排队记录，只能证明消费队列，不能独立证明正式请求及预算入口仍闭环。应补通过既有公开活动服务请求的场景，验证低精力、交互、无接替者和活动额度仍阻止，不能靠新例外绕过原门禁。此为计划允许的实际探索路径，但变更影响面必须明确。
- 当前计划 B2 列出 companionship 文件，而初始派发允许清单摘要未列出；master依据实际调用链将范围明确为该资格判断及必要邻近活动回归，禁止新增活动触发器或提高活动频率。

## 第三轮中期退回

master 在生产接线中发现 `validRestSleepBoundary` 只检查 displayedFrame 属于任意 drowsy/sleep 帧，未证明是动作收束帧；与函数注释及批准的有限末边界不符。应按具体收束语义核对真实末帧（困倦7、睡眠7、唤醒0等实际协议），同时保留身份/token/generation匹配。应增加非末帧、旧代次、旧token拒绝及合法边界接受的独立检查，不能只测试自愿发正确事件的renderer。

因实际正确性缺口，master 对精确PID40633发送SIGINT；99046已终态exit0，此退出不代表验收通过。保留所有现有改动和失败基线，不重新从头实现。继续前须读取本文完整反馈；main当前约220行新增、host约60，renderer尚未完成，原350规模信号即将触发，先报告完整职责估算再扩写，不压行。

## 首次修后GUI中期观察

`attempt-20261028-fix-r2/gui.log`前四项仍失败。只读检查renderer的`drowsy`/`sleep`仅有`let ... = null`声明，没有后续赋值（rg确认）；因此即使main发sleepEligible，startDrowsy前置守卫也会返回。必须补素材读取/预载/身份更新/清理接线，再真实复验。该结果不是最终整批状态，当前58616仍运行，待其终态反馈。

## 第四轮：GUI观察窗口错误

master确认 enterRest 在canvasPage安装window.__sleepTrace，而001及其他Case将管理page传给waitDrowsyStart/waitSleepLoop/waitTrace。管理窗无该trace，返回空数组，导致困倦超时。此类历史结果应标ERROR（观察入口错误），不可据此证明产品未播放；实现前GUI基线同受影响，仍保留原件，unit基线独立判断。renderer曾未给drowsy/sleep赋值是独立的源码缺陷，不与Runner混淆。

master对精确PID44282 SIGINT，58616终态exit0；同UUID恢复67193，直接修复正确页面引用、005B const重新赋值和临时诊断清理，先001再全套，禁止弱化断言。代码由Claude完成。

## 修正观察入口后的阶段证据

canvas-fix-r1已走过困倦与sleep循环，但精力100上限夹具令+20/h线性断言错误，应正确考虑上限并用未满精力夹具检验实际恢复。canvas-fix-r3的001已经PASS。002已采到点击困倦2、后续3/4/5/6/7/6/0，唤醒成立；失败在关闭后再次入睡。waitDrowsyStart只找历史任一0帧，重复调用会立即命中第一次记录；需要按本轮since时刻或trace下标等待新事件，锁屏/隐藏恢复同样应核对。不以这个Runner错误反推产品未重新等待。

## 邻近回归审查（2026-10-28）

final-r1睡眠9/9后又修改sit暂停收束，旧整组不能直接接受新版。activity-runtime实际5/6，003锁屏期间已开始伸展未记录；desktop-notifications的004暂停窗口仍可见失败。必须保持原有活动完成语义与通知实际隐藏/冻结回执；不能通过仅将notificationStatus或notification-shown事实改为false来伪造窗口隐藏。检查真实子窗口isVisible及恢复后的同一事件去重，保留原失败。当前Claude仍运行，此为中期审查而非最终接受。

## 当前版独立边界复验与覆盖缺口

master独立运行desktop-assets、desktop-host、desktop-canvas-ipc三份unit，实际8/8、0skip、exit0；证据`evidence/master-sleep-unit-LVqiwUe5/`，before/after SHA256一致。此结果仅证明素材计划与协议校验，不代表GUI或全S07。

005B当前明确覆盖隐藏与子进程退出，不含独立素材加载错误。A1.6仍要求素材错误停表停帧、旧回调失效与恢复重新等待，因此该分支NOT_COVERED；需Claude在当前全套终态后补最小真实错误场景，不能把子进程退出当作asset-error。错误注入需走实际素材加载失败/已有正式错误通道，不能直接修改restQuiet获得预期。保留当前素材原件，隔离副本中构造失败并恢复；不得改共享正式资源。

final-r1通知失败后final-r6单项通过，目前未看到通知生产修复，应保留原失败并调查其时序来源；复跑通过不能自动称根因已修复。后续master独立GUI应观察实际BrowserWindow.isVisible和宿主事实，并核对延迟shown回报的边界，不只检查被intendedVisible钳制的状态。

## 第五轮：P0夹具错误，必须补正确加急路径

master读final-r2的003 JSON发现priority=1；进一步核对insertFactNotification把priority/original_priority均写1，003断言也要求1。正式账本与PRD的P0为0，urgent按effective_priority=0选取。因此历史003仅证明普通通知，不得记P0通过；保留原件并标夹具ERROR。修为0并核对新增eventId确实处于urgent面板/真实DOM、已回执且至少6s读取规则未改变。第二条不能只等待任意窗口已可见和panels>=1，这会匹配第一条；必须按新增eventId等待显示，再检查不唤醒、无额外模型请求。

001/002当前截图已由master实际查看，小尺寸像素轮廓与闭眼/清醒可辨、无明显切边；仅静帧观察，不代表连续播放与全部资源接受。final-r2记录真实首次静默19976ms、关闭聊天后20033ms、换人2824ms、探索2822ms且只扣8精力；这些为开发者证据，仍待独立GUI。

## P0补测首轮观察

`p0-005c-r1`的003失败，005B通过。master只读定位新helper `snapshotHasUrgentEvent`读取panel.items，但desktop-host.notificationStatus实际输出eventIds而非items；此为新的Runner观察结构错误，应按真实快照schema修正，不据此判断产品P0失败。保留断言意图和失败证据，不改业务。14977仍在当前聚焦执行/修复中，不另起并发测试。

## 当前版本独立检查与流程复盘

master再次检查包含actualVisible观测的当前版本，独立运行素材、host、canvas IPC、presence-boundary四份unit，9/9、0skip、exit0，before/after SHA一致，证据`evidence/master-sleep-boundary-zJBxDqFK/`。presence-boundary现有用例验证旧manifest等待及超时语义，睡眠具体有限边界仍以GUI004A/B判断，不把该unit说成新增睡眠所有时长覆盖。git diff --check通过。

本轮反复暴露错误页面、P0优先级、快照字段、重启旧CDP观察等执行偏差；现行Scenario Acceptance已明确独立Oracle/真实入口/不得自证，execution已要求最小假设验证与保留失败，未发现需要修改skill才能执行的冲突。因此本轮不修skill、不制造归档；落实已有约束：先聚焦错误场景，按实际schema验证观察，再进行整体回归。正式Case/报告中必须区分夹具ERROR、真实FAIL与主动中断，不能用最后一次绿色覆盖历史。

## 公开活动资格独立验收

master独立执行完整`tests/acceptance/character-activities.spec.cjs`：16/16、0skip、exit0，`evidence/master-sleep-activity-ju2PbNrp/`，companionship与Runner before/after SHA一致。新增休息探索Case经过公开requestActivity与completeNaturalNode，验证出发一次−8、有接替者、低精力/交互/无接替者/4h限制；既有全套保留预算与活动生命周期检查。不把该服务验收替代GUI睡眠末边界或真实模型。

## 桌面旧共同边界夹具同步

final-r3通知11/11、rest3/3、activity6/6；desktop两处失败是旧manifestDisplayPlan只枚举idle/wave/stretch/sit，得到88pt，而本批A1.8已批准六动作并集216×314、窗口89×128、scale128/314不变。master核对失败输出和实际diff后确认将desktop.spec.cjs纳入受影响Runner范围：两个独立manifest计划补drowsy/sleep，保留所有尺寸/偏移/脚锚/原生窗口断言，禁止仅把预期硬改成当前观测数值。此为已批准素材范围的旧夹具同步，不改产品Expected；旧失败及desktop-r2复跑分开保留。Claude自行完成代码修改，master不代改。

## 通知长名称连续可读性不稳定：尚未接受

final-r3/desktop-notifications-r2实际10/11，010报“事件19在6秒阅读期内被裁切”；此前整组11/11，随后notify-010-r2单项1/1不能证明根因修复。失败证据`evidence/s05j-desktop-notifications/run-20261027181501296-e08839/case-010.json`保存auto/pageGroups/debug，但缺失败时timeline（当前timeline仅本地变量，断言前未存），无法凭最终几何判断当时是否真实裁切。

master要求保留该问题未解决，不能只写flaky后接受。后续最小补证应保存每个异常采样的时间、事件ID、DOM/窗口/容器/文字rect、clipped判定及对应ack/holdUntil；时间在实际DOM采样中取并保留请求区间，避免异步采样前时间错配。先定位最小原因、复现/反证，再决定改产品或Runner；不得放宽6秒阅读、不删断言或只循环跑到绿。该调查仅围绕已发现回归，不扩通知功能。


## master完整GUI独立结果与视觉边界（2026-10-28）

独立执行 `desktop-sleep.spec.cjs` 全部10项：10/10、0skip、exit0、460103ms，证据 `evidence/master-sleep-gui-DEBjNHPB/`，before/after SHA一致。逐个读取实际JSON，10项appClosed/browserClosed/httpClosed/tempRemoved均true、无error；GUI图与事实在 `evidence/s07-sleep-runtime/master-sleep-gui-DEBjNHPB/`。实际操作者Codex，以operator.txt说明，不冒称人类体验。

实际查看001 sleep-loop与002 wake-and-requiet的canvas截图，89×128窗口内闭眼/清醒可辨、像素簇和轮廓清楚，无明显裁边。静态截图不足以通过完整连续动画美术验收，drowsy/sleep正式素材资格及S07总体仍未接受。已测运行行为通过；相关通知010历史裁切仍待归因，不以独立010/011复跑绿覆盖。

通知只读调查确认more按钮属于head，高度已计入；ack标签挤宽和末页容量不重测仍是候选。新增012首版存在重排时漏采、截断末250ms、错误clipped字段和提前失败未保存timeline，且擅改011预热；master退回Claude修正。任何阅读期内裁切都需记录，不能只把持续整个holdUntil视为失败，不放宽业务Expected。

## POL-NOTIFY-UI-012 v1 聚焦验收契约（master受托确认）

需求来源：S05通知连续阅读规则与010真实失败调查；不新增产品概念。Given：真实隔离Herdr、正式Electron通知窗口、420pt高度上限、单条长来源P0末页。When：真实P0进入并显示回执标签，随后三普通位进入。Expected：同一P0在acknowledged_at至hold_until的完整6秒内保持正文和来源可读、不被移出；普通三位实际到达；不得靠隐藏标签、减少文字或缩短阅读期通过。Oracle：DOM内时间与source/meaning/list/window矩形、正式SQLite ack/hold_until、事件ID对应，记录换行是否真的变化；采样首点≤800ms、尾点距结束≤1000ms、最大间隔≤1000ms，有限离散采样不宣称逐渲染帧证明。必须保存异常现场及清理结果。

执行边界：真实Electron/Herdr隔离server/SQLite，构造长名称及状态；不读取用户工作会话，不请求模型。名称未产生换行变化时，仅证明该名称的标签/普通位重排，不宣称覆盖2→3行假设。012不能单独关闭010六条分页旧失败，需结合原场景几何及最小原因。
