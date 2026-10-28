# S06m 自动告知 master 审查

## r181 Part A 初审与独立执行

2026-10-28。原CLI82925已终态exit0/is_error=false，session a09ef114-4a03-4cad-a0b6-571ee9bf19b3。Codex读取实际四文件与既有发现/故事代码，独立运行automatic-notices、discovery-outcomes、story-progress、story-window、story-runtime五套：33/33、0skip、exit0，四个改动文件执行前后SHA一致。证据`evidence/master-a-yuw5xzss/tests.log`与`result.json`。真实SQLite/正式领域入口；时间、作者目录、素材回调为fixture，没有GUI、模型或Herdr证据。

已观察准备不计数、两种ACK正常写入、精确1h/8h边界、重启/回拨、旧token、非空记忆/名单/已穿/API预算保持，以及收据插入失败、邀请更新失败后的事务回滚。内部能力尚待收口，不记父级Case整体PASS。

返修仅测试：数据库回滚错误挂006A，须改005；006保留实际GUI含义。补衣装确认UPDATE失败回滚分支，补真实作者目录assetAvailable=false的准备门禁，补另一speakerId仍共用限制。未发现需要改变Expected的依据。规模虽超原信号，当前固定领域fixture及明确断言仍可追踪，不为凑行数拆散文件或搭框架。生产359+118行尚无通用总线；实际可见门禁/文案/独立ACK协议仍留B，不能根据A回调称GUI通过。

返修单CLI14134，输出/tmp/bayper-s06m-part-a-review.json，同session；未提交实现，VERSION保持0.1.240。Polaris对真实副作用与Case映射的要求足够，当前是Runner覆盖收口，无新skill矛盾，无需机械修订skill。下一步返修终态后独立复验，接受A则立即snap，随后细化B接回真实用户路径。

## r182 Part A有限接受

CLI14134已终态exit0/is_error=false。master实际读取补充断言并独立重跑unit全部及automatic-notices/discovery-outcomes/story-progress/story-window/story-runtime/outfits-runtime/automatic-budget/automatic-opportunities：78/78、0skip、exit0，四文件执行前后SHA一致。证据`evidence/master-a-final-2t6vg1aw/tests.log`与`result.json`。衣装UPDATE失败已证明收据回滚、pending/shownAt保留并同token恢复；真实catalog下架拒绝prepare；跨speaker共享1h/8h额度；数据库Case映射归005，未借006填GUI覆盖。

|Case|Part A证据|整体状态|
|---|---|---|
|001|准备/实际ACK接口/幂等/重启/非空副作用快照通过|GUI未覆盖，不记整体PASS|
|002|邀请prepared→pending/7日额度/稍后拒绝/手动旧邀请通过|自动显示与用户操作链路未覆盖|
|003|两类/两speaker全局额度与毫秒边界/重启回拨通过|领域通过；运行接线待B|
|004|只有取消保留内容；无真实门禁|NOT_COVERED|
|005|旧token/严格素材/目录下架/三种SQL写失败与重试通过|领域通过；旧窗口/子进程回执待B|
|006|无GUI点击证据|NOT_COVERED|

受托接受A内部能力，按snap保存。712行Runner使用真实领域构造、固定流程和直接断言，无通用框架；规模有当前覆盖依据，不为行数拆散。正式资源发布门未变。B必须接入用户可见路径，不再扩展无关内部探针。现行skill无新增实际矛盾，不修订。所有测试临时库按t.after清理，未启动GUI/API/Herdr。

## r183 B进行中审查信号（未形成终态结论）

60641已轮询确认仍运行，首次落地runtime/main/desktop-host。master读取实际中间差异，后续终态必须核对：automaticNoticeGate目前仅tryPresent使用，tick只因工作presentation取消，ACK回调直接进入runtime；准备后休息/探索/切换/子进程stopped路径是否会撤下、回执前是否重核尚需最终代码与GUI证据。runtime markVisible用Number(visibleMs)<350，NaN/缺失值本身不能被该比较拒绝，应核对子进程入口是否强校验，不预判完整链已安全。close是否要求当前可见窗口、结果回传是否保持原请求token亦待最终审查。

这些是开发中待核查点，不冒称已复现生产FAIL，不在实现中途自行代改。现有通知Runner包含旧token、SQL重试、隐藏/重建/暂停、满位/加急与长文本分页，B必须回归受影响路径。旧Herdr实测Runner会启动隔离server，执行时另按现有授权/技能记录边界，不与开发GUI并行。

## r184 实际开发证据审查：抢占显示FAIL与时钟Oracle无效

60641仍运行，以下为master已直接核对的中间实际证据，原件不覆盖。

- `evidence/s06m-automatic-notices-ui/run-20261028124115877-90664-c532f12e/case-003.json`的workText同时含工作通知与完整自动衣装卡；对应`003-work-priority.png`由Codex实际查看，两张卡上下并存。违反B“任意工作presentation取消自动卡”的Expected，POL-AUTONOTICE-004/006抢占子项FAIL；只检查工作文案存在不足以验收。当前companion-notice.js的card是{root,...}对象，而clearCard调用card?.remove()，是具体排查点，待Claude修正，不由master代改。必须断言旧companion-card DOM不存在并检查pageerror，不能只看主进程已清payload。
- `run-20261028124025276-90513-571455dc/case-001.json`显示visibleDelayMs=1860582，来自主进程+31分钟fixture时钟的收据减子进程真实shownAt。这不证明350ms实际可见，相关时间断言证据INCONCLUSIVE。需要同一真实时钟的可见开始/回执观察，或可复核的统一offset转换，保留独立时钟Oracle。对应001-visible图已查看，文案清晰且有明确故事来源；这不等于时长与交互通过。

另继续核查主进程动作门禁重新验证、旧结果token与隐藏close；开发者尚未终态，不重复派发或并行GUI。后续最终差异及自测即便修正，也保留本批失败证据并由master独立复验。

### r184终态返修清单补充

开发中已修clearCard为card?.root?.remove()，但需要最终GUI直接断言清除。后续集中返修：main回执/action/close前重新核对automaticNoticeGate并撤卡；tick期间对当前卡资格失效处理，desktop状态stopped/restarting等不只failed/error。回执结果应携带原请求noticeToken/transport token/generation，renderer不能只按稳定noticeId接纳旧结果；同故事取消再准备会复用noticeId。close会确认显示时也须实际可见验证，不能沿用工作通知close的免可见路径；runtime对NaN可防御但子进程已把非有限值归零，不能把中间runtime比较问题单独夸大为真实入口绕过。最终返回前仍需真实GUI与原通知回归，不以本清单代替运行。

## r185 B终态审查与定向返修

60641终态exit0/is_error=false。开发者最终GUI/runtime9、领域33、活动6、unit24、工作反应3、原通知12通过报告只作为开发证据；master尚未独立复验B。最新run-20261028125127466-93922-968f5abf抢占截图已由master查看，只剩工作卡；最新Runner已以forceOpportunity设置next到期并由正式心跳运行，所有Date保持真实，之前跨时钟Oracle已修正。SQLitenext写入/Math.random控制须明确为fixture，不称真实30分钟等待。原FAIL与INCONCLUSIVE保留。

最终仍需返修：1 main ACK/action/close前重新检查当前门禁；当前卡tick时因休息/探索/切换/桌面不可用撤下，不只工作卡抢占；非ready所有子进程状态不得留旧卡。2 close若能确认显示，同ACK必须要求当前可见通知窗；工作close的例外不能照搬。3 companion结果回传原请求token/generation/noticeToken并由renderer严格匹配，当前sendCompanionResult用最新transport token且renderer只比noticeId，同故事新展示会复用ID，不能接受旧结果；重试也不应因STALE_NOTICE永久卡住。4 001衣装测试仍DOM.click，仅验证路由，改真实Playwright mouse/locator输入并保留未自动穿用断言，记录并断言pageerror无异常。

回归须补准备后门禁失效→旧ACK/action/close不计数不导航、恢复下一合法机会展示；旧结果同源新token不能影响新卡；收起真实GUI。不重复扩展框架，生产scope沿B现有文件，测试新增量约200～350行；修完由master独立GUI与受影响旧通知复验。无需立即重跑全套原通知，仅修复相关与新GUI；原始证据不覆盖。方案范围/Expected保持，无新skill矛盾，不为实现缺陷另改skill。

### r186 返修进行中补查

70804持续确认运行。新diff已增加tick/ACK/action/close当前门禁、非ready撤卡、hidden撤可见证明及结果原身份校验；不能据此提前标PASS。新005验证的是旧请求ACK/action/close，仍需核对是否真正注入旧结果包到新卡renderer（两者不是同一方向）。

另读main.flushNoticeTarget与renderer.applyNoticeTarget/init：did-finish-load立即发送并清pending，而renderer snapshot非accepted会直接丢弃目标；异步init完成仍可能显示home。这是r182明确“窗口未加载时目标保留”的未验证竞态，后续须真实重建/延迟初始snapshot验证并修复，不能只用已加载管理窗点击通过。当前为源码风险，尚未实际复现，不虚报FAIL。主进程source fallback已有activityRuntime blockedNow优先于用途游标，日常/探索另查isDesktopReady，来源分析自身资格/授权/预算；允许保留原分工，不能让通知门禁替代所有用途规则。

## r187 master独立GUI复验

36244已终态exit0。独立六GUI+六runtime共12/12、0skip，app/tests全部文件SHA前后一致。证据evidence/master-b-r185-vvrcbfv7/gui.log/result.json；实际GUI批次evidence/s06m-automatic-notices-ui/run-20261028131107621-98318-23ab5849。001真实时钟459ms、实际鼠标点击、原四字段结果身份、未穿用；003只剩工作卡；005旧请求不能撤新卡/改页面且真实收起一次；006休息/子进程杀死恢复后新token一次回执；所有pageErrors和cleanupErrors为空。master实际查看001-character-outfit、002-story-later、003-work-priority三图，目标页面和来源可读、旧卡已清。操作者是Codex自动化/截图审查，不冒充用户体验。

本批采用真实Electron/SQLite/通知窗，构造故事/初始业务行/强制next机会/Math.random、loopback模型、构造lock/unlock和工作事件。没有真实模型/真实Herdr/物理锁屏声明。runtime时限测试为stub时钟。父级Case剩余义务不被12/12掩盖；B尚未提交，先补r186两处明确缺口：旧结果方向注入、管理窗异步初始化目标。限制两处与相关测试，避免泛化扩大。

## r189 最后修复独立复验与时序缺口

master独立执行13/13、0skip、app/tests SHA稳定，证据evidence/master-b-final-y9h0l_wu。007截图确为凛衣装页且未穿用；但整个007仅1685ms，小于刻意延迟初始snapshot的2000ms。Runner在首次正确导航后立即清理，未观察迟到初始响应，不足以证明目标不会被init的showPage(home)覆盖。因此该稳定性子项INCONCLUSIVE，保留13项命令通过但不据此接受该业务路径。要求单Claude先增强Oracle：记录延迟handler进入/返回并等待返回后仍为正确页面，覆盖snapshot-updated先于初始response；实际复现后窄修。其他子项证据不作废，不改Expected。

## r190 时序缺陷确认与修复复验

单Claude87172终态exit0/is_error=false。修前run-20261028133120159-2607-653a9808/case-007.log实际观察home覆盖characters，r189的INCONCLUSIVE已定位为业务FAIL。生产只增一次性noticeTargetApplied防止迟到init导航覆盖；测试通过正式setFixedCompanion触发snapshot-updated，记录初始handler进入/返回并在返回后检查。开发者13/13不替代master结果；master独立批次evidence/master-b-r189-h39bm342，运行句柄4984。无新Polaris文档矛盾，本轮按现行Oracle/失败保留规则发现并修正验收遗漏，不为实现缺陷机械改skill。

### r190 master结果

4984终态exit0：独立40/40、0skip，app/tests SHA稳定。包含新GUI7、runtime6、来源/原子确认5、机会7、通知呈现9、活动6。007 enteredAt=1793194508016，目标应用1793194508064，初始返回1793194510020（2004ms），最终检查1793194510374仍characters/凛/衣装可见且未穿用，pageErrors/cleanupErrors为空；实际查看007截图。操作者Codex，受控snapshot延迟/正式setFixedCompanion入口，不冒充真实用户冷启动。修前FAIL保留，当前时序子项修复通过。旧通知与工作短反应独立回归正在执行，句柄78167、evidence/master-b-regression-7_wc_kjm。完成后决定B阶段snap，不将完整POL-AUTONOTICE必需剩余路径抹去。

## r191 旧通知回归发现待定位失败

master原通知回归UI-010失败：等待“滚动后三个普通位”超时；原件evidence/s05j-desktop-notifications/run-20261028133542250-6eb6e4/case-010.log/json。默认分页、六条加急回执、手动展开与滚动前布局已通过；失败时ordinary=[]，末条普通hold_until已在采样前到期。尚不能把测试供给时序假设当确定根因，需单Claude定位并保留原Expected。其余原通知001～009/011/012通过，工作短反应回归仍运行78167；未终态前不并行GUI。B暂缓snap，不以40项通过覆盖该回归失败。

78167终态exit1、SHA稳定，15项14PASS1FAIL；工作短反应三项全通过。单Claude7386限定UI-010 Fixture/Oracle定位，若生产问题须先报告，不擅改。明确不增大超时掩盖、不冻结生产时间、不改变正常消散、不削弱420pt与完整长文本/逐条ACK/普通三位合法输入下布局断言。

## r192 UI-010时序修正审查

7386终态，仅UI-010 Runner +48/-1，无生产改动。原测试滚动循环结束后不再供给普通事件，却在随后等待三个普通位；原失败采样1793194727816晚于最后普通项hold_until1793194719487约8.3秒，证明已显示普通项自然到期（不采用CLI摘要误写的29秒）。修正后通过真实新事件保证采样时三个普通位均未过期，并要求加急仍在场；原420pt/完整长名/逐条ACK/6秒与滚动期间样本断言保留。

中间额外要求剩余1秒的测试失败保留run-20261028134717552-498ae5；这不是产品原Expected，最终以300ms采样余量加采样后精确未过期断言，避免要求过期卡常驻。开发者最终run-20261028135015543-7e1902单项PASS，不能替代master；独立32453/evidence/master-ui010-r191-m32qqqbr进行中。不隐藏原FAIL，不重跑未受影响的14项以制造计数。

### r192 master独立复验与阶段决定

32453终态exit0、1/1、0skip、app/tests SHA稳定，evidence/master-ui010-r191-m32qqqbr。实际批次s05j-desktop-notifications/run-20261028135234014-54a6e3：采样1793195621990，三个普通项最小剩余374ms，加急仍在场，cleanupErrors=[]；Codex查看010-manual-after-scroll截图确认3普通+加急。接受Fixture修正，原失败保留并解释，不视为生产行为修复。

受托接受S06m B已测窗口阶段：独立40项新链路及相关领域/活动检查、旧通知与工作反应14项原通过加UI-010修后独立通过。不同批次明确聚合，不声称同一次15/15。Case剩余实际重启、真实GUI完整时限与接纳/拒绝联动按evaluation继续；正式内容发布/素材与父级S06/S05/Goal未完成。按snap保存自洽阶段，下一批只补这些已列Case义务。
