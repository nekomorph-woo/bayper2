# S03l-b语义判定对照审查

2026-10-27，当前未运行真实服务，不是产品语义验收通过。计划s03l-semantic-probe-plan.md；实现由Claude session8375cbdd-2f99-4533-a41c-7448bc381337完成，首轮exec13767终态，报告evidence/claude-s03l-semantic-probe.json。

## r1静态问题与返修

- 数据集自行使用dietary_habit、identity_preference、temporary_preference、physical_trait、instruction等生产不存在的kind，尤其负例通过不同专用类别泄漏判定线索。统一为现有identity/preference/experience/detail，02/06/10/14为preference、04/11/15为identity、05/08右/12/13为experience、16右为detail；07姐姐为preference。正文和Expected保持不变，不能靠特制类别改善评分。
- participants只能提供正文中明确的主体/参与者；07右仅姐姐，不把用户算作事实参与者。其余不新增额外语义标签；05为已明确的用户独自旅行，13未知仍null。未来生产尚未提供结构化参与者时，不能据本实验假称已有可靠元数据。
- 358行规模略超预期但仍为单入口/明确校验与证据，无框架；不为凑行压缩。删除默认输出路径的便利分支，live必须显式--out且拒绝覆盖，减少意外调用和归档歧义。
- summary补falseMerge（Expected不含equivalent但actual为equivalent）、missedEquivalent（Expected为equivalent但actual不同）、uncertain数量；不是只看总正确率。结构ERROR不混成关系FAIL。
- 首轮自述做过/tmp守卫验证；本项目工具测试产物应自包含，清理自己创建的临时守卫（若仍存在），不得清理其他/tmp文件；后续dry-run输出放tools/memory-tuning/results的明确批次。不要用工程外长期依赖。

r2只改这两个工具文件，node --check与dry-run，不真实请求、不app/Git/版本/文档。Codex随后审查并独立执行最多1models+1chat。

## Codex独立r2真实结果

Claude8105正常终态。Codex先syntax与dry-run核对16对、四种生产kind、模型messages无Expected、零调用/凭据读取；结果tools/memory-tuning/results/semantic-probe-codex-dry-r2.json。随后独立exec46833实际1models+1chat，真实/models包含deepseek-flash，chat974ms，总1142ms。16项15PASS1FAIL0ERROR，falseMerge=0、missedEquivalent=0、uncertain=1。输入/工具/生产model摘要与脱敏输出见semantic-probe-codex-live-r2.json/.log；无数据库/GUI/真实聊天。

01～06同义正例全部equivalent，07～12/14负例及16注入不合并。13（A/B各记得“我们去了海边”，参与者未知）actual=different而Expected=uncertain，原失败保留。15性格相关但不等价正确uncertain。13虽未误合并，但不能把证据缺失当作已证不同，否则未来补充参与者证据可能被错误的永久否定关系挡住。

## 下一轮有据调优（v2，不改Expected）

Codex受托决定：仅在SYSTEM_PROMPT明确holder是存放/讲述归属，不是事件参与者；participants未知时不得从holder推定参与者，只有主体/含义/时间等有明确冲突证据才判different，无法判断是否同一命题/事件则uncertain。不能提pair13、海边或任何固定答案，策略版本递增。工具与数据其余不变，不为全绿改Expected。

允许Codex在审查v2后独立追加一个批次（仍每批最多1models+1chat、无自动重试）；本轮研究累计上限2models+2chat。即使通过，也需要独立留出和生产预算/隔离/失效接线，不把probe当SEM产品通过。现阶段不持久化永久different关系；来源/正文版本变化后必须重新判断。脚本仍由Claude改，Claude只syntax/dry-run。

## v2独立真实对照与取舍

Claude62592正常终态，仅通用提示与策略版本变化。Codex独立syntax后执行v2，1models+1chat，总1009ms（models145ms、chat864ms）；真实模型仍deepseek-flash。tools/memory-tuning/results/semantic-probe-codex-live-v2.json/.log；源/数据/生产model模块SHA逐项匹配。两轮累计2models+2chat，达到本次研究上限，无自动重试、无产品数据库/真实会话/GUI操作。

v2结果仍15PASS1FAIL0ERROR，falseMerge=0、missedEquivalent=0、uncertain=4。13未知“我们”的经历从错误different修正为uncertain；11“用户喜欢牛奶”对“用户乳糖不耐受”从different变为uncertain，Expected仍different，保留FAIL。16注入由different变uncertain，属于原允许集；15仍uncertain；01～06均equivalent，其余强负例仍different。

取舍：v2作为下一阶段候选策略，不以15/16或单次零误合并宣称生产可靠。11是保守不关联，不能据此把Expected改为通过；优先保护13的信息缺失语义，不再为固定16项总分反复改提示。后续只允许显式equivalent提出关联，different/uncertain都不合并，且不持久化永久否定关系；主体、时间、事实/虚构、参与者等明确不一致由本地边界先拒绝。分类建议仍需版本、来源与事务校验，不能直接触发删除/纠正或给未知角色新增事实。

本轮接受的是可复查的轻量诊断工具及真实证据，不是产品关联功能。脚本约370行，明确字段挑选、索引校验、固定预算、摘要/脱敏与错误分类，无框架或常驻进程。Expected未发送；工具所有持久产物在tools/memory-tuning自包含。数据kind已对齐正式枚举，但participants为构造数据的显式已知信息，正式记忆当前没有该结构字段；不能拿此实验冒称生产已具备参与者理解。

## 下一步实施前条件

1. 使用未参与提示调优的留出样例核验正/反/歧义，尤其来源互异、时间区间、用户与其他人、第一人称、信息变更。留出结果仍需逐项看，不只平均分。
2. 明确语义判定与角色回答上下文的隔离；已有全局自动预算和名单资格不能绕开，不为每条聊天加评审请求，不新建无限后台。先确定触发点与已有调用如何配合。
3. 明确离线/未判定期间已选中纠正删除的本地生效、未核实关联的处理与如实反馈；不因模型离线假称全部同步。
4. 建立经版本验证的关联提交和取消/迟到/旧来源/未知角色不新增Case，再让正式链路执行原SEM业务Expected。原工具仍3PASS5FAIL，不能因为probe分类通过就写成SEM通过。

按snap保存研究工具和证据，产品代码零改动；完整Goal继续。
