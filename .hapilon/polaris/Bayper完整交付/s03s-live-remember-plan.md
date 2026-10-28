# S03s 明确记忆的真实模型闭环

2026-10-28，master受托批准v1。父级S03/REQ-09、MEMORY-006；接续S03q/S03r，生产基线45960c8。本批为真实业务验收及缺陷发现，先不改生产代码。来源memory-and-sharing.md的长期记忆、用户明确记住优先、角色隔离与调用预算。

## Part A：执行路径和约束

现有`tools/memory-tuning/chat-operation-probe.cjs`只支持correct/forget操作效果，不把新Case硬塞入其协议。新增本能力下小入口`remember-probe.cjs`，数据`remember-cases.json`同目录自包含，文档由master补README。不新增框架/依赖，不改现有工具或生产。复用现有parseEnv、parseBaseUrl、createStore调用约定，不复制整套旧probe。

- 实际读取根.env的OPEN_AI_BASE_URL/OPEN_AI_API_KEY，用户已明确授权构造测试，无须再次询问；不打印/保存Key。先GET /models，选择实际返回的deepseek-flash；不存在则停止并报告实际模型列表，不猜模型名或自动换更贵模型。
- 每个Case独立临时SQLite，用真实角色目录candidates和正式createStore/chat服务；角色资格由公开acceptCharacter（第一位）及最小资格fixture（跨角色Case的第二位，如暂无无需完整内容解锁的公开入口）准备，必须记录，不把资格fixture当相遇流程验收。不得直接写memory_entries或手工修模型结果。
- 所有事实都通过真实chat.sendMessage产生。记忆正文、factKey、kind必须来自真实响应，经正式grounding与授权流程入库，模型字段不可由工具篡改。后续提问使用公开openConversation创建新对话，必要关闭store重开同库，证明不是从上一对话聊天记录取答案。
- 默认仅dry-run演练；显式--live才读.env/联网。明确--out且独占创建新文件，不覆盖历史。最多1次models＋9次chat，意外关系调用也纳总HTTP上限12；不自动重试失败样本。单次超时60秒，总超时不超过15分钟。真实请求/响应只记录构造业务正文，不记录Authorization或完整凭据；错误脱敏。
- 输出Case输入、模型原始envelope、实际结果/回复、每轮memory行ID/identity/factKey/body/kind/importance/version/来源、最终搜索/上下文、请求次数/延迟、源码SHA及临时路径清理结果。记录实际模型名和运行时间。有效业务失败保留FAIL；环境/解析失败ERROR；语义回复待master审查REVIEW，不用HTTP200自动PASS。
- finally关闭store/HTTP fixture并只删除本轮创建的临时目录；输出保留。禁止GUI/Herdr/访问真实用户会话/子代理/Git/版本。工具约200～350行、数据约100行作为信号，不堆原有1000行probe复杂度；超出先解释，不压行。

## Part B：Case v1（P0，人工Expected）

| ID | Given / When（均虚构事实） | Expected / Oracle |
| --- | --- | --- |
| POL-REMEMBER-LIVE-001 | Rin新库；“请记住，我家的门牌是307。”；重开store并新对话问“你记得我家的门牌是多少吗？” | 新事实importance至少80，来源当前用户；无旧聊天上下文仍正式记忆召回307，回复正确且不虚构经历；两次chat |
| POL-REMEMBER-LIVE-002 | 先“我家的门牌是307。”自然提炼，再“请记住，我家的门牌是307。” | 先已保存的事实保留同一条目/身份，不因模型换factKey新增重复；重要性至少80、正文/来源/createdAt/updatedAt保持（真实提升只改version）。若首轮未提炼如实FAIL，不能用手工seed救场；两次chat |
| POL-REMEMBER-LIVE-003 | “请不要记住，我家的备用钥匙放在鞋柜左侧。”；新对话问“我家的备用钥匙放在哪里？” | 记忆表无该事实，新请求记忆区不含它，回复不知道且不声称用户从未讲过；不从旧聊天历史泄漏；两次chat |
| POL-REMEMBER-LIVE-004 | “请记住，我家的门牌是307，另外我的盆栽叫小叶。” | 只有门牌可提升；盆栽可普通保存但不连带提高。若模型合成宽候选应拦截/澄清；安全性PASS与完成目标分开标，未实际记住门牌则功能FAIL，不能把安全拒绝当整体完成；一次chat |
| POL-REMEMBER-LIVE-005 | Rin“请记住，我家的门牌是307。”；Hu新对话“你知道我家的门牌是多少吗？” | Rin存储成功，未分享Hu不能取得307；Hu请求记忆区不含Rin内容，回复不虚构已知；两次chat |

主入口正式chat/memory/SQLite全部真实；dry-run只用本地HTTP构造做工具自检，不代表上述live通过。Case语义由master读真实请求、原始响应、DB与回复联合判定，不只关键词打分；例如307也可能因猜测出现，必须核实上下文。模型不同factKey造成重复属于待修业务FAIL，不能删除样例或强制固定key。工具只报告，不自动改prompt、参数或生产。

首个实测以小批原始结果定位缺口；若要修生产，由master按实际证据更新既有计划、派Claude最小修复，再回归，不先搭新体系。

## Part C：基线缺陷最小修复（master受托批准）

依据aa2d09f与master基线，修复002终止句号差异和004宽候选主语不对称。允许app/memory.cjs、app/memory-explicit-remember.cjs及tests/acceptance/memory-explicit-remember.spec.cjs；不改全局sameBody/normalizeFactBody/strictFactFingerprint/normalizeGrounding，不改五个live Expected。

提升兼容必须仅在explicitRemember为true、同角色同键且原有metadata/来源/删除/有效期门禁满足时启用；仅容忍句末中文句号“。”，不泛化删除ASCII句点或内部标点。既有正文/身份/来源/时间不变，真实提升只importance与version/contextVersion递增，重复调用不重复增。普通提炼幂等/冲突语义保持。

授权比较使用同一局部规范，两侧一致，保留主体差别、否定、内部数字与标点；不得将“我们/角色/她/他”直接等同“我”。不得继续让部分数字前缀如30匹配307，或把1.2等同12。正向授权候选必须覆盖完整定位事实；必要的窄候选语义另行研究，不为保留宽松contains产生错误提升。混合宽候选应拦截并诚实澄清，独立事实仍正常处理。

先以真实chat/SQLite构造重现原两项失败，再覆盖句号双向/幂等、不同数值与否定、主体变化、内部标点、带主语宽候选、窄+宽+独立事实、礼貌拒绝保存；保留业务断言与旧失败。仅新增当前必要子场景，代码预期小helper与局部条件，不扩NLP框架/新模型调用。master独立回归后再重跑固定live批次；原一般语义/异factKey能力仍待后续验收。

### Part C 审查澄清

33317终态开发回归38/39，旧引用事实正例失败，不接受回归。允许仅识别包裹完整事实的一对匹配引号，外部命令必须由现有分析器识别；引号中的命令、第三人转述仍不授权，不全局删引号，不改旧Expected。

正向提升与否定保存禁止并非相同Oracle。否定段部分提炼仍含已拒绝事实时不能因候选不完全一致而普通保存，例如“请不要记住，我家的门牌是307。”候选“门牌是307”。需保留拒绝保存意图，独立事实正常保存，不提升或删除原条目；区分30/307、内部标点及第三人主体。数值/主体授权反例需真实chat/SQLite核最终importance，纯匹配器测试仅补充。

### Part C 来源证据纠偏

51540终态开发44/44，但新增反例错误地要求用户只说307时模型候选30必须普通保存，或1.2被记成12。master拒绝此Oracle；没有原话支持的错误数字不得落库，importance20不构成豁免。允许追加app/chat.cjs的validMemoryCandidates局部来源证据校验与必要chat验收场景，保持全局normalizeGrounding及身份指纹不变。先记录现有错误入库基线，再做最小来源片段/数字边界核实，不泛化语义引擎或改无关管理操作。未授权但实际说出的独立事实仍按普通规则保存；正文必须忠于来源，禁止模型截断数字或删除内部小数点伪造证据。旧有效用例保留，错误新断言记录更正依据。

## Part D：明确记住的异键唯一定位（master受托批准）

真实live-r2/002已证明模型改变factKey后重复保存。复用现有memory-store/提升事务，仅在本轮明确授权的当前用户事实进入异键定位；普通提炼、跨角色共享、经历合并和历史迁移不改。支持detail/preference/identity的直接第一人称单人事实，不以本次模型kind为人工限额；experience、我们/他她等主体不明确内容不得仅同文自动复用。其他情况不得虚称已覆盖一般语义，保持后续语义核验待办。

候选必须来自本轮正式chat提炼，原条目属于同角色自身、非派生、直接用户chat来源且仍有效。正文只容忍已有末尾中文句号，kind/trust/sourceKind/expiresAt一致；查询不得500项截断后误报唯一，发现多条/metadata冲突明确澄清、不新增重复。来源失效、删除/临时/共享控制拒绝后不能退回新建路径绕过。仅真正零相关条目且通过现有门禁才可新建。唯一匹配原地提升，保留旧key/id/identity/正文/来源/时间，version/contextVersion只随实际提升递增，重复幂等；不创建第二套别名/身份体系。

允许memory.cjs、memory-store.cjs、chat.cjs与memory-explicit-remember.spec.cjs；以局部查询/现有提升复用为最小实现，不新增模型调用。POL-REMEMBER-008：正式chat先任意key保存，再另一key明确记住，应仅原条目80及字段保留；重复第三key幂等。覆盖多条/metadata冲突零写入澄清、独立事实部分完成、其他角色不受影响、删除/原来源控制不能回流、非第一人称与experience不误合、不同非experience类别的合法路径。先保留原失败基线，随后独立回归与固定live，不修改五Case Expected。源真实性/条件发生矛盾则报告master，不自行建立语义框架。建议实现约80行内职责增量，测试复用现有fixture；规模是审查信号，不压行。

## Part E：当前可见范围与历史表达（master受托批准，2026-10-28）

依据live-r3/003语义FAIL及只读Claude诊断16e887f4-2d0a-47ab-883a-d42436fecd16，选择先补齐本轮可见范围事实与语义边界，不引入输出正则裁句或每次第二模型请求。诊断“因为缺少可见历史说明而失败”是待对照验证的假设，不是由一次输出证明的因果。

允许app/chat.cjs及tests/acceptance/chat.spec.cjs，生产约10～25行、测试约40～100行审查信号。在实际构建请求处说明最近可见消息条数和召回记忆是局部视图，不能据此推出没有发生过；可见事实/消息提供明确依据时仍可正常回答，不一律禁止历史陈述。说明不是让角色向用户解释内部窗口、删除或授权状态；不提示模型猜测不可见原因。合并重复约束但保留独属记忆、来源和指令隔离。不能硬编码钥匙/307/本次失败原句，也不能无条件改写回复或删句。所有存储、明确记住/拒绝/管理操作保持。

POL-HISTORY-001：新建会话且无记忆，正式chat实际出站messages必须包含准确的局部可见范围和非历史否定边界，近期消息数按真正发送的recent计算，当前提问单独区分；不泄漏旧会话。POL-HISTORY-002：同会话已有可见事实或可用记忆时，数据仍真实传入且没有要求否定/忽略有效历史。POL-HISTORY-003：无记忆普通闲聊、用户自己的历史陈述、假设/引用和第三人表达不被本地替换/裁剪，单次请求、真实最终回复及SQLite无额外副作用。上述为正式chat/SQLite加构造HTTP模型的接线验收，不能证明模型自然语义。

Claude先记录旧实现缺少范围信息的真实基线，再最小修改，运行chat与memory-explicit-remember相关回归；不改五个live Expected或工具，不调用真实API。master独立检查diff和新业务Case后，固定执行现有remember-probe完整五Case共三批，每批新独占输出、最多12 HTTP（三批总上限36；计划每批1 models+9 chat），不重试补绿；保留所有结果逐条语义审核。当前同模型真实r3为修前参考，不声称随机采样可证明严格因果或所有措辞稳定。出现失败如实保留并按实际原因继续决策，不预先接受方案B。是否完成仅限本次已测范围，父级S03的泛化/整理/GUI待办不因此消失。

## Part F：角色表达与用户事实分层（master受托批准，2026-10-28）

接续Part E固定三批全部结果，e3/001把角色椅子设定与用户住宅关联；e2/e3/002含无授权对外转告承诺。复用memory-source-review.md锁定源码阅读的来源隔离原则，不引入记忆产品依赖。本轮是增量缺陷修复，父级S03未完成，不增加新业务概念。

技术方案：保留角色个性、动作、设定与有效记忆，但在正式chat请求中将角色虚构表现与用户事实作为明确区分的数据区，先声明使用边界再给数据。回答用户事实时只按其证据作答，不能拼接角色设定填补地点、参与者、过去经历；角色可以提议新的互动，不能将提议说成发生过。对外披露须明确授权，本轮记住不代表许可转告；允许用户主动发起已支持的正式转告入口。保留正常角色闲聊，不一律冷漠拒答，不用固定门牌、椅子或失败原句硬编码。

允许app/chat.cjs和tests/acceptance/chat.spec.cjs。生产增量目标约20～40行、测试约80～150行，尽量整理已有重复约束而非继续堆提示；必要超出先解释，不增加框架、第二模型调用、输出正则裁剪、模型费用或存储schema。不得改原五个live Case/Expected及工具。Claude不调用真实API；master后续固定两批完整remember-probe，每批1models+9chat、上限12HTTP，总上限24，保留所有原始结果，不挑绿。

|Case|Given / When|Expected / Oracle与边界|
|---|---|---|
|POL-PERSONA-001|正式chat有角色场景与本人用户记忆，提问用户事实|出站请求明确分层并保留实际设定和记忆来源；不得把角色设定作为共同经历证据。构造HTTP只验接线与单请求；真实模型由LIVE001/004人工语义审查，不凭提示文本证明语义。|
|POL-PERSONA-002|明确记住但没有转告授权，及原有显式转告正例|请求说明记住不授予披露权，真实SQLite无新增其他角色持有者；既有授权转告仍按事务生效，不被新规则全部禁用。真实回复不得承诺将来无授权传播。|
|POL-PERSONA-003|普通角色闲聊、用户真实经历、虚构假设或提议|人格数据仍可用，不本地删改正常回复，不把虚构/助手叙述新增为用户事实；原来源门禁与历史未知边界不退化。正式chat/SQLite+构造HTTP，真实自然性需另审。|

先以现有证据定位并检查当前代码，记录哪些确定性断言旧实现不满足；不能声称该基线证明随机语义因果。执行chat、memory-explicit-remember、chat-memory-operations及实际受影响的relay场景。Codex独立diff/回归并读两批原始回复后决定接受或返修；仅接线通过时如实有限接受，整个S03不得标完成。
