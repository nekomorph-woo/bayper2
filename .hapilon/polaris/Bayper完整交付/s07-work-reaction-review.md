# 工作短反应中期审查（未接受）

2026-10-28，以下是Claude99291实施中的初次审查；该轮随后已被退回（见r153），实际复现见r154。静态推断与运行失败分开记录。

- 一次性host send路径不写latestState，主进程基于新回执事务触发，方向符合计划；待实际重建/重启验证。
- 重点复核POL-WORKREACTION-008：syncWorkReactionContext在聊天/隐藏/暂停时调用stopAnimation；applyState同key分支只syncActivity/syncRest后返回。若后续没有新播放入口，可能把画布停在happy帧并在恢复后仍不动。需真实happy中打开/关闭聊天、隐藏/显示和暂停恢复，不接受仅断言playingWorkReaction=false。
- 同一帧恢复使用剩余时间，应由实际帧时间序列验证，而非只读取保存对象；系统暂停/换人后不得恢复失效代次。
- 001～009必须从真实入口形成观察；P0/日常/探索门禁、子进程退出重启、点击和自然节点等待不可以源码字符串检查或假回执替代。
- 当前净改动规模已超过初始180～260行信号，终态审查职责必要性与重复；不靠压行满足，也不因功能可运行自动接受。

## r153 master退回与下一步（2026-10-28）

99291由master主动SIGINT终止，返回exit0但JSON明确is_error/aborted_tools，不是成功交付；此前r11/r12连续ack10超时，原失败保留。终止后ps未见本轮workreaction测试进程。生产及Runner未接受、未提交。

明确问题与受托处理：
1. Runner声称CLI不接受done因此用fixture替代完成事件，遗漏已存预研runtime-research.md：非焦点pane由working上报idle会投影done，event-recovery.md也已有实测。必须先核并恢复001/003真实Herdr转换；不改Expected迁就fixture。若当前版本行为不同，保留真实输出解释，而非凭CLI枚举推断不可测。
2. Runner943行，明显超过250～400信号，前半约500行大量设施；先核既有工具和fixtures复用。不能以分文件藏总量或压行解决，减少重复与多余真实server+同形server双栈。
3. 002只有恢复帧名、前后几何，没有剩余时长/反应中几何/自然节点断言；005/006显式未覆盖多门禁，仍不得整Case PASS。
4. 008 chat取消stopAnimation后同key返回有冻结happy的静态风险；先单独实际复现，随后修复并测聊天退出、隐藏显示、暂停恢复及换人旧代次不回流。
5. 下一批先仅诊断、复用方案与有效复现，最多两次目标执行，失败分流后报告；不继续盲目整组重试。master审核后再实施修复。

这是实现/测试偏离已明确契约，不是skill描述新矛盾；现行Polaris要求已足够，暂不机械归档改skill。

### master追加静态检查

- Runner trigger查询只按instance_id/state取最新，不约束agent_id/sequence或操作前id；新事件尚未入库时可返回旧finished，导致回执和冷却Oracle观察错事件。应按真实身份/新事件界限等待，保留严格业务断言。
- boundaryTimeoutFor只取max(idle总时长, happy总时长)+1200。当前idle1880ms+happy1790ms=3670ms，max+margin=3080ms；若happy刚开始且idle尚余较长时用户请求等待自然节点，存在有效播放尚未完成就超时的风险。需实际边界测试，不把happy末冒充idle-loop。
- 新回执ID来自presentation未ack项，与ledger是否首次presented的语义需复核窗口重建路径；当前重建关闭呈现且pending队列不再选presented，静态未证成重复bug，必须测试而非先增状态表。

## r154 定向复现已取得证据

Claude只读诊断54338执行两次既有渲染Runner，未改代码；master已读取两份原始日志与002记录，实际查看002截图。

- r153-diag-renderer-r1.log：exit1，CDP连接超时，ERROR，不是业务FAIL。
- r153-diag-renderer-r2.log：exit1，line883退出聊天后等待idle超时；008冻结问题实际复现，FAIL。测试finally清理检查没有报错；不等于人工体验。
- run-20261028084542494-f293f8/case-POL-WORKREACTION-002.json确实观察happy00～07后回idle03；前后窗口89×128、图像104.34375×156.53125、pixelated，master已看恢复截图。只接受这段观察，剩余时长/反应期间几何/节点未测，002整体仍NOT_COVERED。

001/003真实链路尚未恢复，005/006/007/009未完整独立验收。此审查文档可以独立保存，但生产和Runner仍不得随之提交。

## r156 返修后master独立复核

18535终态exit0/is_error=false，但开发者如实报告三组各两次均未全过，不能按CLI成功接受。新Runner1073行，虽删同形server，完整门禁增长；未提交生产/测试。

master独立运行002/008现行渲染组：master-r155-render-9whedlnl/stdout.log，exit0、1/1、0skip、前后源码SHA一致。该组实际通过帧恢复/几何与点击、聊天、隐藏、暂停、休息、日常、换人的已有断言；自然节点等待尚无实际waiter测试，idle advancing只要求至少一帧不能证明持续推进，整002/008仍保留这些边界。

master代码审查定位：
- 门禁组用第二次restCompanion()尝试唤醒，正式app.js的继续陪伴实际调用switchCompanion(current.characterId)，已有desktop-rest.spec.cjs提供真实按钮路径。修Runner而不是修改休息业务语义。
- 001在ACK后重复ack、delay250才sample，happy首帧250ms可能已过去；004也在等多个事件ACK后才采样。应在触发前开始持续帧观察，避免边执行边错过证据，不删除8帧/一次性断言。
- assertIdleAdvancing当前350ms且仅idle.length>=1不能排除idle静止；完整待机周期内至少两个不同帧，并确认不含任意happy帧，非仅不含frame00。
- 005/006测试仅标注构造DB不能证明内部门禁状态已生效：隐藏和交接不能混成一个反例；必须观察快照/窗口状态，探索断言是不召回/不破坏活动，不能把当前仍为凛当产品预期（用户要求探索离桌并接替）。
- 同事件无新finished计数不足以完整替代无额外事件，保留来自Herdr的idle等合法事件，并核其来源/事件类型，不能删除禁止副作用要求。

master另独立执行资产/边界单测及notification-presentation全9项：master-r155-core-4vfeldms，11/11、0skip、exit0、前后SHA一致。证明受影响通知账本回执/重建等既有领域行为未在该批退化，不证明反应与真实通知UI的全部集成。

## r157 真实链路独立复验与剩余门禁

23005终态exit0/is_error=false。master独立两组001/003/004/007/009与002/008：master-r156-chain-m6gv9y4h，2/2、0skip、exit0、前后源码SHA一致，约96秒。真实Herdr非焦点done、8帧、重复/重启、冷却/P0及恢复的现有断言通过；开发者把有来源标签/逐条批量文案缺口的001/004称PASS不予沿用，按完整Oracle仍待补。

实际查看独立批次run-20261028091548480-8daa86恢复截图及happy光底图集；人物脚底没有明显跃迁。进一步独立RGBA测量master-workreaction-foot-ilt1zlj5：16帧alpha>=128实体底行为374～375，底48px脚带中心126.5～128。按实际128/314比例，垂直差不超过0.408pt、水平差不超过0.612pt；结合DOM前中后几何一致，符合像素轮廓变化下稳定落脚。不是对manifest锚点自证，也不冒充人类连续体验。

r156-gates-r1实际是非凛切换尚未更新画布的rin!=hu断言，非报告所称helper类型错误；r2交接前快照pending=true，随后happy出现，但没有ACK时pending证据，当前只判INCONCLUSIVE，不能断言产品门禁坏。现有main在每次idle-loop可清除pending，此构造可自然结束。睡眠/隐藏恢复/未就绪及实际交接仍未完成。

## r158 末段测试驱动审查

45326终态exit0/is_error=false；渲染r157-render-r1 1/1通过，真实组与门禁组各两次未全过。原始failure.log显示真实组r1为来源/t0/不匹配（当前展示真实terminal id），r2为批量来源实际t1但断言terminal id；console又被清理后仍运行的帧采集Target closed异常遮盖。真实来源有label时展示label、无label回退agent id，验收应核本轮身份的允许显示形式，不能每次遇到一种就把断言切到另一种。

交接r157-gates-r2明确ACK时pending=false，实验前提失效，不判产品门禁FAIL。修改后的Debugger.pause尚未执行；其采集在恢复并等pending消失后才开始，会遗漏恢复时错误庆祝，因此要在暂停前建立追踪、在恢复后到交接完成期间持续观察。先冻结canvas，再设置pending并等待主进程心跳读入，避免已在途idle-loop清除先前的pending；通知ACK必须继续真实发生。

009历史反应还需排除007残留P0：当前在007后立刻插入historical，P0可能仍展示，单纯无happy不足以证明historical过滤。等待可见P0自然消散、冷却已过且当前合资格，再触发历史输入与新事件对照。原Expected不变，属于因果隔离的Oracle补齐。

## r159 隐藏语义澄清与收口Oracle

master核对既有s05j计划和main.onToggleVisible：role visible与notification window visible分开管理；原006“通知按既有规则继续”仍正确，r156/r157补验说明误将角色隐藏等同通知不可见，已修正该说明，不改PRD/生产行为。r158-gates-r2实际exit0，case005-006记录handoffAtAck=true、hiddenWindowVisible=true、hiddenAck非空、hiddenText含已结束、recoveredStarts=0。应把这组确定语义写成断言，不能“ACK有无两种都算过”。

同组sleepFrame实际是drowsy frame07，尚非sleep循环；已有r157/r158对sleep/drowsy任一都放行，不能把它当005睡眠完成。补等真实sleep帧后再送finished、再核未被唤醒。

帧trace当前捕获failure但stop返回frames不报告；正常测试路径采样失败必须导致ERROR，不允许空/不完整trace使“没有反应”假通过；finally清理可抑制二次异常但应记录，不覆盖原始业务assert。

## r160 工作结束短反应受托接受（2026-10-28）

Codex master 独立最终回归 `master-workreaction-final-iw5eg66x`：exit 0，13/13、0 skip，13个被测文件前后 SHA 一致；实际原始 Case 证据位于 `evidence/s07-work-reaction/run-20261028094232057-63ab14/`。结合先前独立领域/单测11/11，受托接受本轮凛 E03 工作结束短反应实现，不代表 S05/S07 或完整 Goal 完成。

001/003/004/007/009 使用真实隔离 Herdr 0.9.5 非焦点 working→idle→done：来源/已结束文案与回执、8帧、去重/重建、批量一次与冷却、P0优先、历史不补播及新事件对照均有实际证据。002/008 正式画布验证原 idle frame07 的剩余时长恢复（预期195ms、采样153ms，按计划采样容差）、前中后几何相同、3690ms后真实 idle-loop 边界，以及打断后持续推进。005/006 确认真实 sleep 帧、探索离桌接替、交接 ACK 时 pending、隐藏角色仍有通知及稳定 ACK；部分状态使用构造数据库/系统事件，未就绪只覆盖 host 传输边界，不外推为全链真实系统体验。

相邻回归涵盖自然轮换、素材异步失效、共同几何、休息聊天、睡眠切换和通知暂停/重建。Runner finally 清理断言通过；证据保留本地。检查发现一条与隐藏断言矛盾的旧注释，另交 Claude Code 仅改该注释，执行逻辑保持不变，不为注释修改重复整轮GUI测试。

本轮范围为凛已有服装的候选 E03 业务接线，其他角色/服装及其余动作、最终原生体验仍未完成；S03s真实模型场景混入用户历史的失败继续保留。Polaris 本轮问题为执行与Oracle缺口，已按既有流程返修、独立复验，没有需修改skill的新矛盾。
