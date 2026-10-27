# S03s工具中期审查（未接受）

2026-10-28，CLI37926/UUID155d248a-8591-4f85-be79-e26e5002043c仍live，未运行真实API。

首版remember-cases.json的004使用secondaryMaxImportance=79，但现行独立已知默认importance为identity90/preference60/experience50/detail20。PRD要求未授权事实不被连带提升，不要求默认identity降到79。终态须改为按候选kind对应的预定基线比较（基线在数据中明确列出，不调用被测normalizeFact生成Expected），同时由master检查kind语义是否合理；未知类别不能放宽通过。此为执行前Oracle澄清，不是看真实结果后改Expected。

001/003/005公开新建对话能够避免近期消息混入：master已核app/chat.cjs buildMessages只读取指定conversationId。工具仍须保存实际messages核查；只标newConversation=true不足以证明隔离。002不能因为首轮模型未提炼就手工seed补救，必须保留FAIL；004安全拒绝与完成记住分别报告。

## 首版终态与返修决定

37926终态exit0仅代表CLI完成，dry-r5为exit1；004宽候选仍保存，保留FAIL，未执行live。工具002将候选factKey/正文必须相同作为业务通过条件过严：业务需要存储条目稳定且无重复，候选差异应作为诊断。返修保留存储正文/来源/时间不变，补精确version及sourceVersion/sourceKind约束；004采用预定类别默认值。73261负责工具/数据返修，不改生产。571行规模来自固定五Case的取证与断言，暂不以拆文件凑行数，继续检查控制流与重复。

## Master 独立基线验收

73261已终态exit0。master执行node --check成功，独立dry结果`tools/memory-tuning/results/remember-master-dry-20261028-r1.json`为exit1：58检查仅004 safety失败，宽候选仍入库。独立live结果`tools/memory-tuning/results/remember-master-live-20261028-r1.json`为exit1：GET /models真实返回deepseek-flash与deepseek-v4-pro，实际使用deepseek-flash，1models+9chat/0relation，总10，预算内；5个临时目录均关闭删除。全程构造数据，无GUI/Herdr。

| Case | Master判定及依据 |
|---|---|
|001|PASS（本样本）：detail80、当前用户来源，重开库/新对话只有当前提问，正式记忆区含307，答307，无虚构经历。|
|002|FAIL：两轮同factKey，首轮正文末尾有句号、次轮没有；原条目身份/来源/版本仍稳定，但importance停在20，未履行明确记住。回复诚实说明未保存。|
|003|PASS（本样本）：两轮记忆表空，新对话无旧历史/事实，回答想不起来，并非断言从未告知。|
|004|本次分离候选路径PASS：门牌80、盆栽detail20；本模型没有输出宽候选，因此宽候选路径依旧以dry失败记录，不能由本次live覆盖。|
|005|PASS（本样本）：Rin成功保存，Hu新对话无Rin记忆并回答未知；角色口吻未冒充共同经历。|

工具按预定边界如实报告失败，本轮接受诊断工具，不接受整体产品记忆能力。未覆盖一般同义、不同factKey合并、GUI和长期体验；S03与完整Goal仍未完成。静态及最小调用定位004：授权段保留“我”，候选标准化先去“我”，导致反向包含失败而未加入blockedKeys；该原因需Claude以正式chat复现再修。002需支持无语义变化的末尾句号差异，同时保持正文/来源/身份不被重写，不可使用泛化去标点误合不同事实。
