# S06i 生产故事接线审查

Codex预审，CLI72827尚在执行，本记录不是独立通过结论。首版差异已将INITIAL_STATS提取为唯一常量，避免discovery-outcomes↔store循环；main接既有心跳和自然节点，未新增计时器。正式目录assetAvailable仍false，未扩renderer或模型调用。

## 终态后需明确反馈

1. **活动消费的原子性缺口。** 当前evaluateActivity先调用storyProgress.recordNode（内部事务已经提交），再插入story_runtime_activity_results（另一写入），后者失败会留下已推进故事而运行记录缺失。现有POL-STORYRUN-004只在story_facts插入前触发故障，没有覆盖最后一笔运行记录失败。如果该节点刚好让最后一个故事成熟，重试时selectNextStories可能没有候选，会把已经成功的活动登记成NO_STORY_CANDIDATE，丢失真实结果；有其他候选时则依赖recordNode重复返回，行为不一致。补真实SQLite故障Case（单节点最后故事，runtime结果INSERT失败→关库重开→重试），要求原子回滚或明确可恢复的同一结果，不增加/换目标、不丢来源；不要只加catch吞错或声称当前已有事务覆盖两者。沿既有领域事务做最小修复，不造事务框架。
2. **证据归属。** 本轮新tools/story-runtime/目前仅装测试日志，没有对外能力或工具入口。它是产品切片验收证据，应归完整交付/evidence的唯一批次，不能凭任务名创建假工具目录。保留现有日志原件，迁移不覆写，后续命令输出到正确批次；不要为合理化目录补建无需求工具。
3. **真实接线验证尚缺。** Node领域入口不能证明main实际调用时机。完成修正后由Codex安排真实Electron主进程检查（需补小Case时仍由Claude写），覆盖启动默认目录、真实daily完成后运行消费、重启不重放及正常退出。保持正式内容未发布的业务门，不用main源码字符串匹配冒充运行证据。

原计划允许本轮准备成熟结果，但不强制在没有正式展示入口时自动接纳或ACK；不得为补此切片而放开素材门。邀请/服装窗口与正式发布后全链仍须后续验收。

## 返修在途预审

88734已实际派发上述三项及旧S06e/f/g夹具更新。新增recordNode的事务内onResult回调使运行评估与故事进度同事务，新增004B对最后一笔写失败/关库重开进行核对；开发者fix-domain目前35/35，仍待独立验收。旧夹具只增加completeDailyAction与自然节点收束，未删原业务断言。证据已迁移至工作目录独立批次。

新story-runtime-ui约271行，真实main心跳触发daily、renderer完成8帧、主进程写skipped结果，正式目录未发布门与重启幂等已有开发运行证据。小缺口：finally中fs.rmSync异常只设置failure却不抛出，会导致业务成功但清理失败时Node仍PASS；HTTP close若抛出也会跳过证据保存。终态后反馈最小修复：记录各清理结果，确保新增清理错误在无原业务失败时令测试失败，保留原业务失败；确认进程退出才删目录。不要扩大为资源管理框架。

## 独立复验批次边界

88734退出0，之后39486仅修新GUI Case清理且退出0；实际finally保留主错误并在清理结束后抛出failure，记录server/exitConfirmed/directory结果。生产SHA保持不变。首轮独立62314为60/60，其中54项Node业务Case与6项activity-runtime真实Electron；独立unit13/13。日志s06i-codex-domain.log和s06i-codex-unit.log，生产版本s06i-codex-source.sha。

调度纠正：Codex首轮误将activity-runtime.spec.cjs视作纯Node领域套件，与39486的单项GUI短暂重叠。日志保留，不用该6项GUI或同期开发GUI作为独占窗口验收。两边明确终态后，Codex以7147串行运行activity-runtime六项+story-runtime-ui一项，独占GUI，结果另存s06i-codex-gui-r2.log与s06i-story-runtime/codex-20261027-r2；接受以该独立批次为准。54项纯Node结果不受GUI共享影响，未改源无需为计数重复执行。

## 最终受托接受

7147退出0，独占串行GUI **7/7**，无失败或跳过；与独立纯Node **54/54**、unit **13/13**共同构成本轮必要回归。生产SHA最终再次一致。活动六项独立批次为`s06d-runtime-activities/run-20261026203136696-b5d5a8`，本轮新增主进程Case为`s06i-story-runtime/codex-20261027-r2`。

| Case | 实际核查结论 |
|---|---|
| POL-STORYRUN-001 | 真实领域活动完成才消费；重复/重启无新事实；未完成与取消不推进，不额外改数值名单；PASS |
| POL-STORYRUN-002 | 跨日延续、已有邀请/拒绝过滤和服装可达，耗尽不造新内容；PASS |
| POL-STORYRUN-003 | 正式assetAvailable=false保持，无假进度；测试内发布/下架/恢复不换故事身份；PASS |
| POL-STORYRUN-004 | 首次接线历史基线、时钟回拨、写入故障后重试幂等；PASS |
| POL-STORYRUN-004B | 单节点最后故事的运行记录写入失败时五类事实均回滚；关库重开后同目标/节点/来源一次落定；PASS |
| POL-STORYRUN-005 | 成熟领域准备不等于显示/接纳/穿用，默认数值唯一来源；PASS。自动准备/展示尚未接正式main窗口，不能据此称完整发现链通过 |
| POL-STORYRUN-UI-001 | 真实Electron首次配置→main自动机会→八帧daily→自然节点→运行结果；正式目录不可用时skipped/NO_STORY_CANDIDATE，故事/邀请/衣装均0；重启同活动仅1记录、未重放；PASS |

新增GUI原始证据记录`action_frame=8`、active_elapsed_ms=10000与completed；两次Electron退出0、HTTP closed、exitConfirmed=true、directory removed、cleanup ok。加速时钟/随机数及本机模型HTTP属于明确fixture，未使用真实API或用户会话，未模拟整个故事服务。Codex基于源码、SQLite事实与实际主进程执行受托接受本切片，不冒称人类体验或已发布内容的完整故事体验。

本轮代码约260行生产增量，事务回调局部、未加通用框架；GUI315行含真实启动/清理，Node687行覆盖六个独立业务Case。旧夹具更新恢复13项业务验证，没有降低Expected。实际纯Node与GUI分类失误已在此保留并复验，现行polaris本来要求明确真实依赖和执行边界，不因执行遗漏凭空修订skill。

后续仍须S06j正式故事/邀请/衣装窗口、显示回执、正式素材发布后的全链、记忆删除影响展示，以及S07b三角色真实表现。Goal保持active。
