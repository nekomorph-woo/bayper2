# S06b 低频自动机会与名单资格

Codex受托确认，依据state-and-rhythm.md“自动活动与API节奏”。已有预算只限制发送，不能代替30分钟机会/25%概率和用户聊天优先。此切片实现应用级机会入口，并用真实companion、source-analysis与budget验证一个获准来源活动；正式main与设置接线随后完成，不声称全S06交付。

## 写入范围

仅新增app/automatic-opportunities.cjs、tests/acceptance/automatic-opportunities.spec.cjs；不可改其他模块/main/renderer/权限/记忆/预算/版本/Git，不GUI，不真实HOME/.env/远程模型。读取现有store、companionship、source-analysis公共接口。若接口不足说明事实，不自行扩范围。约200～300行生产和300～450行场景是信号，不搭调度框架。

## 业务接口与持久化

小工厂注入store（getAppState/setAppState）、companionship.getSnapshot、now、random、单次执行函数runActivity({characterId,requestId,signal,isEligible})和cancelActivity（如source-analysis.cancel）。生产不自行setInterval，公开evaluate/pause/resume/dispose，由main现有心跳调用。只支持一次机会选一人执行一次，不提供多Agent计划循环。请求ID由crypto生成，全自动活动仍需共用现有budget；本模块不能另计一套API额度或替执行者双重reserve。

1. 应用每30分钟最多评估一次；首次启动和恢复以当前时刻之后30分钟作为下次机会，不立即补旧机会。持久化上次评估/下次最早时刻，反复重建服务不突破频率；时钟回拨不提前机会。迟来一天只产生当前一次评估，不循环追赶。无需保存每次tick日志或不断写DB。
2. 到合法时刻先消费当前机会并安排下一次最早时间。聊天中、系统暂停、无人合资格/全低精力时不派活动、不留欠账。系统暂停期间不评价；resume重新从当前30分钟计，不补抽。概率使用random()<0.25，失败本轮结束，不能为每位角色各抽一次。
3. 只从当前roster且已结识、energy>30、非exploring、非resting、非交接中角色选一位。名单外临时聊天不授予自动资格；全局interaction存在时所有自动活动停止新增。不是仅同屏角色有资格，最多5位共用一次机会。使用新的真实snapshot，不信旧缓存。
4. 单次evaluate异步未结束时，后续evaluate返回busy，不额外抽签/推进执行。选人后、真正runActivity前重新核对资格；提供isEligible给来源服务在异步发送/发布前复核。pause/dispose应abort并cancelActivity；即使执行者迟到，结束状态不能称成功或自动重试。主进程用户聊天发起将调用pause/取消入口（正式接线后验），当前Case调用入口验证，不假装已有UI连通。
5. 活动本身没有可做的来源/预算满/HTTP失败也是一次机会结束，不能换人/换用途重试。手动聊天不由本模块拒绝；本模块不改变亲密/精力/心情，不替代日常/探索实际开始结算。探索>=60、4h/24h限制、日常频率由后续活动执行器继续限制，此处不能假称全部已实现。
6. 持久化失败时不执行、不抽出已开始活动，返回清楚失败，禁止仅内存推进后实际发送。重复resume/dispose幂等，退出无定时器残留。

## Acceptance Contract

| ID | Given / When | Expected / Oracle |
|---|---|---|
| POL-OPPORTUNITY-001 | 真实SQLite app_state+companion，注入时间/随机，跨30min边界、重建、回拨、长间隔恢复 | 一窗口最多一次评估，25%抽签按应用，失败不重抽，恢复无欠账；DB时间与执行次数独立核对 |
| POL-OPPORTUNITY-002 | 已结识名单内/外、休息/低精力/探索、临时聊天、在途状态变更 | 只合资格名单一人可执行，名单外不改名单，同屏不限定资格，聊天与pause/dispose中止，无迟到成功/额外请求 |
| POL-OPPORTUNITY-003 | 与真实source-analysis/permissions/reader/budget/memory组合，本机HTTP fixture | 机会触发一次获准目录分析，仅选中角色inferred记忆，共享预算实际一次；撤权/暂停/资格变化拒绝旧发布，其他合法记忆保留；预算满无HTTP且不换人补发 |
| POL-OPPORTUNITY-004 | app_state写故障、重复evaluate、活动拒绝/HTTP失败 | 无超额/重试/隐藏并发，不部分推进实际活动；所有临时资源清理，旧原始失败保留 |

仅时间/随机/外部模型为fixture，其余通过生产服务。测试不要用stub快照替代全部名单与角色规则；复杂fixture遵循清楚Given/When/Expected，不造通用Case引擎。证据evidence/s06b-opportunities，完成后报告规模、真实依赖、未接main和未实现活动规则边界。

## 补充Case（Codex受托确认，返修前定义）

- POL-OPPORTUNITY-005：已评估后时间推进4小时，同SQLite重建服务，立即evaluate不抽签；至少再过30分钟才执行。验证服务重建边界，真正进程重启留主进程集成。
- POL-OPPORTUNITY-006：已评估后回拨时间，再pause/resume，next不早于已有next和last+30分钟；last后20分钟仍不得执行，到30分钟才可执行。
- POL-OPPORTUNITY-007：真实store事务能力存在；缺少事务接口的依赖明确拒绝，不允许非事务fallback。原004仍核对真实写故障原子回滚。
