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

## Part C 最终独立复验与有限接受

95216终态exit0后master审实际diff并独立运行显式记忆、chat、chat-memory-operations、memory四文件：178/178，exit0、0skip、前后四文件SHA一致，证据evidence/s03s-master-final-3Na8fwqw/。master dry-r2五Case/57确定性检查全过，旧宽候选已拦，临时环境全部清理。修复只在explicitRemember同键提升容忍末尾中文句号；原字段/来源/身份保持，授权范围与拒绝保存分别判断，外部引用事实保留；chat提炼增加原文片段与数字/标识符边界，旧错误Oracle已纠偏，旧失败原件保留。代码为局部函数与原有入口，未建新框架。

master live-r2实际deepseek-flash，1models+9chat/0relation，总10、五临时库清理完毕。001重开新对话真实记忆召回、003不保存及未知回应、005角色隔离在本次样本通过；004门牌80/盆栽20，模型给分离候选，宽候选仍以本地测试为证。本次004回复窗边椅子为角色场景表达，不是共同经历来源，未存入记忆。002仍FAIL：首轮user_home_door_number，次轮home_door_number，同正文却产生新id/identity/来源，原条目20未升。不得通过固定模型key、删除样例或重试挑绿解决。

受托接受本批已测句号兼容、宽候选/拒绝保存和原文数字保护修复；不接受POL-REMEMBER-LIVE-002、一般异键语义、自动整理或S03整体。新增POL-REMEMBER-006/007映射Part C，仅作为此修复范围的构造HTTP场景。下一步针对真实异键重复确定接口与不变量，复用既有身份/语义研究，不因同正文就跨角色/不同经历误合。

当前未覆盖边界：来源片段精确匹配可能拒绝大小写/全半角/内部空白改写；CJK数字及全部标识符语义未保证。实际落库使用用户evidence原文，不把模型改写当事实。没有GUI或人类长期体验通过声明。

## Part D 独立复验与 live-r3 语义审查（2026-10-28）

master核对开发CLI43335终态后的实际diff、来源/身份/删除门禁与测试；独立五文件205/205、0 skipped、exit0，证据evidence/s03s-master-crosskey-ZOG5s2J5/。before/after SHA相同，并与提交前当前源码逐项核对一致。POL-REMEMBER-008覆盖异键唯一复用、幂等、三个类别、多条/metadata冲突、部分完成、角色隔离、删除及来源失效；一般同义/经历归并仍未覆盖。007原来同一上下文再次创建相同事实，定位器改为旧auth.exact.307并追加新键不存在断言；importance和主体隔离断言保留，属于定位更新而非降低Expected。局部实现规模增加来自完整来源门禁与冲突处理，未增加依赖、模型调用或泛用框架。

真实批次tools/memory-tuning/results/remember-master-live-20261028-r3.json使用实际deepseek-flash：1 models＋9 chat、0关系调用，五个临时库均关闭删除。57项确定性检查通过不等于语义通过，原始结果保留REVIEW，由master单独判定如下：

| Case | 本次语义判定 | 观察 |
|---|---|---|
|POL-REMEMBER-LIVE-001|PASS（单样本）|新对话没有旧聊天历史，正式记忆上下文含307，回复307；detail80、来源用户。|
|POL-REMEMBER-LIVE-002|PASS（单样本）|模型从home.door_number换到home_door_number；仅原条目20→80、version1→2，旧id/identity/key/body/source/时间全部保持，无新条目。|
|POL-REMEMBER-LIVE-003|FAIL|未保存事实且新对话无泄漏；但回复“我们之前好像没有聊过备用钥匙放哪儿的事”，违背不得由当前缺失推断历史未交流的约束。“好像”不构成豁免，确定性检查未识别此表达。|
|POL-REMEMBER-LIVE-004|PASS（分离候选样本）|门牌detail80、盆栽detail20；未输出宽候选，宽候选以构造测试为证。|
|POL-REMEMBER-LIVE-005|PASS（单样本）|Rin存储80，Hu上下文无此记忆并回复不知道，未虚构知道用户门牌；角色场景口吻不作真实用户事实保存。|

受托接受Part D异键同文提升修复；S03s整体仍未通过，003新失败必须继续修复，不能重试挑绿或把工具退出0当验收完成。S03父级还欠一般语义、自动整理、GUI及整体集成；完整Goal不变。本轮使用Polaris的独立语义审查发现实际缺陷，现行skill已明确该要求，无需为执行失败机械改skill。

## Part E：可见范围改进的有限验收（2026-10-28）

Claude18433终态，仅chat.cjs和chat.spec.cjs；master实际diff审查、独立chat/显式记忆/聊天记忆操作177/177，exit0、0skip，evidence/s03s-master-history-clKzj5Ty前后SHA及当前源码一致。旧基线POL-HISTORY-001/002确实失败，003原有不裁句行为保持；该基线只证明缺少范围说明，不证明语义因果。新提示根据真正发送的recent.length说明局部消息，明确有证据可正常回忆；无输出替换、无新增请求。

预登记三批全部执行，原始tools/memory-tuning/results/remember-master-history-live-20261028-e1/e2/e3.json，均实际deepseek-flash、1models+9chat/0relation，共30HTTP，15个临时库清理。每批57确定性检查通过，原始semantic保持REVIEW，下面是master独立语义判断，不覆盖原件。

|Case|e1|e2|e3|依据与边界|
|---|---|---|---|---|
|001|PASS|PASS|FAIL|三批都真实记忆召回307、无旧聊天；e3附加“窗边那把椅子，我记得是往这个门里留的”，把角色场景与用户门牌作无依据的历史关联，不能当正确记忆体验。e2仅“椅子还在”是设定内场景，未声称与真实住宅关联。|
|002|PASS|PASS|PASS（身份提升范围）|三批同键原条目20→80、version1→2，身份/正文/来源/时间保持；异键本批未自然出现，已有r3与008为证。e2/e3的“别人问住哪能说”另记未经授权转告的表述风险，未发生真实共享写入，不等于可接受的全部角色表达。|
|003|PASS|PASS|PASS|记忆空、无旧历史/事实泄漏；e1表示当前没有记下，e2/e3询问是否说过，未断言以前没说。询问不是否定事实，不能事后把Expected改为禁止任何询问来凑失败；自然度仍有改善余地。|
|004|PASS|PASS|PASS|均分离门牌detail80和盆栽detail20，未输出宽候选，不能声称真实宽候选路径覆盖。|
|005|PASS|PASS|PASS|Hu无Rin记忆、无307与虚构已知；角色口吻未作为用户事实保存。|

受托接受POL-HISTORY-001～003的接线和本次003三样本表达改进；不声称稳定概率或一般语义保证。S03s整体仍FAIL（e3/001），记录后续角色设定不能伪装成用户事实/共同经历、不得承诺无授权传播；不重试挑绿、不默认增加第二模型调用。父级S03自动整理/语义和最终GUI仍未完成。按Polaris在有限批次结束回到父级检查：当前真实入口已验证且新增缺陷有清楚来源；先推进已批准的S07 E03候选导入，后续再接角色表达约束，不让局部提示调优取代正式动画/通知交付。此顺序由master受托决定，未取消任何目标。

## Part F：角色资料分层独立验收（2026-10-28）

开发CLI d6354123-7ce0-4e48-8350-b915f0b9e69f终态exit0/is_error=false；Codex审查发现合并提示删了memoryRelay对象协议，已退回恢复并核对。实际只改chat.cjs与chat.spec.cjs，生产约35行diff、新增测试186行（多回合真实chat/SQLite正反例，规模合理，无新框架）；未新增模型调用/输出裁剪。旧测试基线3项失败只证明缺少声明，不证明随机语义因果。开发回归中600字符候选预算失败已通过重新分区修复，旧预算断言未放宽。

master独立5文件202/202、0skip、exit0，证据 `evidence/s03s-persona/master-final-s4y3ijxk/`，前后SHA一致；生产chat SHA5387becc2f6fdb9d2af136102e80a1cb993ae8367e402c62d38f98c92e0a2485与两批live一致。

|Case|构造HTTP/真实业务结果|边界|
|---|---|---|
|POL-PERSONA-001|PASS：正式出站规则/设定/事实分层且保留来源，单次chat|不能凭提示证明所有模型表达|
|POL-PERSONA-002|PASS：明确记住不新增其他角色持有者，随后用户授权转告真实写入Hu|模型对象为构造响应，协议说明已恢复；不是新一轮真实模型转告验收|
|POL-PERSONA-003|PASS：保留正常角色回复、真实新经历；助手/虚构提议不落用户事实|局限于本Case输入与既有来源门禁|

固定两批全部执行，原件 `tools/memory-tuning/results/remember-master-persona-live-20261028-f1.json` 与 `f2.json`：实际 /models 有deepseek-flash及deepseek-v4-pro，使用flash；每批1models+9chat，合计20HTTP；每批57确定性检查通过，10个临时库均关闭删除且master核实路径不存在。没有重试挑绿。

|Live Case|f1|f2|实际观察|
|---|---|---|---|
|001|PASS（样本）|PASS（样本）|正式记忆召回307，新对话无旧聊天，两次回复仅确认307，没有椅子/住宅无据关联。|
|002|PASS（身份提升范围）|PASS（身份提升范围）|原条目detail20→80/version1→2，身份来源时间保持，没有新条目；没有无授权披露承诺。|
|003|PASS（样本）|PASS（样本）|记忆空且无原事实泄漏，回复现在想不起来/没有记录，没有推断从未交流。|
|004|PASS（分离候选样本）|PASS（分离候选样本）|门牌80、盆栽20，宽候选仍以构造测试覆盖。|
|005|隔离PASS，表达待改进|隔离PASS，历史表达FAIL|Hu无307、无Rin记忆；f1“记不住/只记路和石头”过度概括能力，f2“可没记过你家门牌号”从当前空记忆推出历史未记录，违背已确认局部可见范围规则。不能用技术全绿覆盖。|

受托接受本轮已测分层接线和有限样本改进，不接受S03s整体；旧失败原件保持。后续应针对跨角色未知表达做独立可重复对照，避免只围绕凛的固定门牌样例无限堆提示；不增加请求或删句作为未授权捷径。其他S03语义/自动整理/GUI与完整交付缺口保持。此次问题为提示合并引入协议遗漏与语义覆盖不足，按现行Polaris审查返修即可，没有新skill矛盾需归档修改。

## Part G：三角色对照基线（2026-10-28）

Claude CLI28e87014-3435-45ee-a36d-46bc39a2239e终态exit0。master审查437行固定probe、93行Case数据；规模超过最初信号，但主要是隔离生命周期、dry服务、出站取证、来源核查与清理，不再拆框架或压缩行数。生产/旧工具均未改。工具自动条目持久检查只核id仍在，master额外逐项比对K的完整before/after字段，不能只靠该弱断言宣布身份保持。

master独立语法与dry：`tools/memory-tuning/results/unknown-master-dry-20261028-g1.json`，6Case/51检查通过、10构造HTTP、无凭据读取。固定一次live：`unknown-master-live-20261028-g1.json`，实际deepseek-flash（/models预检），1models+9chat/0relation；源码与当前SHA一致。六个独占临时库均关闭删除，master核实路径不存在。原始语义状态保留REVIEW，下面为受托人工审查（操作者Codex，不冒称用户体验）。

|Case|本样本判断|依据|
|---|---|---|
|RIN-U|PASS|仅当前问题、空记忆，答“现在想不起来”，未猜早餐或断言过去。|
|RIN-K|PASS|正式chat存偏好80，重开新会话正式记忆召回豆浆配烧饼，完整条目字段保持，未补造经历。|
|HU-U|PASS|空记忆，答“现在想不起来”，未猜展览或声称从未告知。|
|HU-K|PASS|真实经历来源、重要性80，新对话答琉璃灯展；问票根属新提问，不是声称用户已捡到；完整条目保持。|
|CHENG-U|PASS|空记忆，只请用户再说，没有猜位置或失忆原因。|
|CHENG-K|PASS|细节80，新会话正确答书桌右侧抽屉；身份、来源、时间等完整行保持。|

这是不同角色/题材的有限成对基线，不是角色人格影响的因果实验，也没有统计稳定性结论。Part F f2/005历史否定FAIL继续保留，不能用本批不同输入通过覆盖。现有策略能在这些样本区分已知/未知；没有新的明确根因，不再从单次回复猜测追加提示或连续重复抽样。受托接受诊断工具，S03仍未完成。按Polaris回到父级范围，下一步推进S06服装解锁/换装未闭环路径，记忆语义稳定性保留后续总体体验核查；无新skill缺陷需归档修改。
