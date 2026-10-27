# S03l-b 结构化事实核验审查

2026-10-27，Codex受托主持，依北极星计划→派发→审查返修→独立执行→报告。计划s03l-grounding-plan.md，Claude session7bc5cbf4-6449-4d69-9fce-0dcb45bf05f6，exec58430/58452均终态。正式记忆原子关联入口没有新增调用者。

## 实现与静态审查

新增233行生产协议、约300行专属测试；probe净增76行，复用生产build/parse，默认baseline保持原v2消息与请求预算。规模略高于信号，额外部分用于结构/原文引用/数量上限与完整raw/structured证据，没有框架、词表或pair硬编码。源文件注释明确引用存在不代表解释正确，模型不是权限来源。

Codex发现纯空格quote可通过“正文包含”校验，退回Claude先复现后修复，两处改为拒绝trim后为空；专属Case同时覆盖subjectQuote/timeQuote。Claude记录修复前8tests中7PASS1FAIL，首断言失败后另一项未执行，不冒称两项均复现。修复后Codex独立8PASS（evidence/s03l-grounding-codex-r2.log），npm test独立19PASS（s03l-grounding-unit-codex.log）。本协议不写库、不调模型，模拟输出只用于确定性边界；不替代真实语义验收。

Codex独立dry结果tools/memory-tuning/results/grounding-baseline-compat-codex.json确认默认messages与原v2逐字相同；grounding-holdout-dry-codex.json确认0调用、未读凭据、Expected不发送。该dry生成于仅空白引用校验返修之前，消息构造不变，最终生产SHA以真实批次为准。历史probe的trust/sourceKind为诊断标签，不是正式生产授权；专属生产Fixture已改stated/user。

## 真实结果与Coverage

Codex实际运行exec2704/80804，均终态，真实deepseek-flash；每批1models+1chat，累计2+2达到本轮上限，无重试。最终源/数据/生产model与protocol SHA逐项一致，完整结构化结果及原始响应已保留。实际API Key不在4份live JSON/log，临时三个Claude dry文件已确认清理；未启动GUI、产品数据库或常驻环境。

| Contract | 最终实际观察 | 结论 |
| --- | --- | --- |
| POL-REL-001 | 正式build/parse同义与同日事件、Expected不进入消息 | PASS（构造输出边界） |
| POL-REL-002 | 模型equivalent遇主体/时间/scope/来源边界时降uncertain，非equivalent不放行 | PASS（构造输出边界） |
| POL-REL-003 | 非法输入/响应、伪造或纯空白quote整批拒绝；注入作数据 | PASS（构造输出边界） |
| POL-REL-004 baseline | 16PASS0FAIL0ERROR，falseMerge0、missedEquivalent0、uncertain2；models141ms、chat3411ms、总3554ms | PASS（单次构造真实模型） |
| POL-REL-004 holdout | 14PASS2FAIL0ERROR，falseMerge1、missedEquivalent0、uncertain1；models167ms、chat3196ms、总3364ms | FAIL |

证据tools/memory-tuning/results/grounding-baseline-live-codex-v1.json/.log与grounding-holdout-live-codex-v1.json/.log。Expected和原始两个数据集均未修改。

holdout11“我们昨天一起看了流星”这次raw/effective均uncertain，左右subject/time均null，原误合并已不发生。12“用户说她喜欢蓝色”仍被误判equivalent：模型把左右subject都填写为“用户”、subjectQuote均为真实存在的“用户”，本地无法根据存在性检查发现指代错误。15安静环境与独处raw/effective=different，Expected uncertain，仍FAIL；没有误合并但不能把证据不足变成永久否定。

## 决定与下一步

接受的是可复用结构协议、确定性拒绝边界及可复查失败证据，不批准自动合并接线。局部指标改善（2次误合并降1次）不代表风险已经消除。提示或结构化解释仍能自洽地解释错；不得将quote包含校验称为真实语义证明。协议当前只有诊断工具调用，未给associateFacts/IPC/调度加调用者，未动已有产品行为。

接续优先核对原始发言来源与提炼证据，保留说话者/被谈论者区别；比较更可靠的模型/判定方式时保持同一冻结数据，不对固定失败词添加规则。实际/models应发现可用模型，不能虚构名称；新增真实调用须另立有界批次。本轮不继续为16条改提示刷分。最终生产仍需现有资格/全局预算、来源及版本失效、角色上下文隔离与已删除关联管线，不能以本片代替原SEM产品Case。

完整Goal active；前一原子执行器已验收，语义判定仍缺可靠证据。没有Polaris新缺陷，不为措辞改skill。
