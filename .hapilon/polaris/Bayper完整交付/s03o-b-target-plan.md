# S03o-B forget 目标澄清方案（r2 修订，2026-10-27，master 受托批准实施）

## 批准与实施细化（2026-10-27，master 受托批准，非用户亲自确认）

- 批准范围：生产 `app/chat.cjs`、`app/chat-memory-operations.cjs`、`app/chat-store.cjs`；测试 `tests/acceptance/chat-memory-operations.spec.cjs`、`tests/acceptance/memory-semantic-operations.spec.cjs`、`tests/acceptance/chat-verification-ui.spec.cjs`；文档 plan/cases/acceptance-plan/evaluation/state。禁止 Git、版本、skill、真实 API/.env、子代理。
- 实现顺序 B1（核心垂直）→ B2（授权范围）→ B3（重试/持久标记）；B1/B2/B3 是内部顺序，不得交付缺少授权过滤或重试约束的半成品并称成功。
- 实际拆分行数合计约 **290～415**：B1 220～295、B2 40～65、B3 30～55；不是 r2 原估 250～325。生产总净增超过 420 行或需额外模块先报告，不压行、不重建通用状态机、不复制两阶段执行链。
- 细化：`matchingCandidates` 仅作词面依据，必须核实通用词过滤不因共同“喜欢”等扩大授权；显示编号重排必须映射回内部 target，覆盖“原 M2 变显示第 1 条”断言。选择标记复用 `operation_proof` 但不得与 verification proof 解析冲突；`prepareRetry` 清 proof，重试执行前必须重新持久标记，并覆盖该窗口崩溃/重开。取消/关闭/dispose/新命令/新话题同时使失败回答快照不可复活；清标记不得导致 retry 退回普通聊天，用现有 error/status 诚实终止。只把可重试事务失败归 `FORGET_SELECTION_FAILED`。同 identity 直接删除与独立 identity 核验分别 fixture；有独立候选时一次 relation，无候选 0；scope self 保留不传播。原命令与回答 source 都防回流，`commandSourceHash` 只对应原命令；旧模型路径 source 行为不变，旧 proof 兼容。普通聊天不泛称零写；选择拒绝回合不提炼候选。
- 验证：先新增真实 chat/store Case 并在 HEAD 生产取可复现失败基线，再实现；每次独立 attempt、防覆盖、保留退出码/before-after SHA/失败；相关 5 套有界回归 + 真实 Electron GUI；GUI 构造 HTTP 不称人类/真实模型验证。

## 中期独立审查缺口（2026-10-27 r78，返修中）

- master 首版不接受。上一 CLI 由 master 在已完成回归并报告停止后 SIGINT 收束，terminal 状态不是测试超时，也不是业务通过；原 attempt/log 保留。
- **缺口 1**：`parseForgetTargetAnswer` 对 pending 只有咖啡候选时的“今天天气怎么样？”和“如果明天下雨，我们聊点什么？”返回 invalid，违反普通闲聊应正常进行的批准 Case 006b。修正为“先判断是否选择式输入，再对选择式输入做问号/引用/假设/转述拒绝”；普通闲聊的问号/假设走正常聊天。必须通过真实 `chat.sendMessage` 增加 006b 的问号与普通假设验证；选择式“加糖那条？”仍本地拒绝。
- **缺口 2**：`forgetTopicCandidates` 新增 `expiresAt === null` 过滤未获批准，静默缩小了删除能力。现有 `memory.forget` 可删除未过期临时 identity 当前理解；检索层已过滤过期临时项。修正为不做该过滤，并在承接时增加临时条目到期复核；补未过期临时目标选择真实场景。若临时两阶段仍有架构依赖，记录边界，不扩张新引擎。
- **缺口 3**：测试覆盖不完整，不能以 001～013 全绿代替所有条件。补：同角色不同会话隔离；失败回答后新话题/新命令/取消/关闭/重启再 retry 均不复活；跨本地午夜但未满 10 分钟；仅 source 控制变化（与一般记忆新增 context 变化区分）；scope self 独立/同 identity 不删 B；重排后第 1 条真正删除原 M2（现 009b 只验证拒绝杭州）；已知 C/未知 D 无新增。未执行分支记 NOT_COVERED，不改 Expected；循环负例逐项断言。
- **缺口 4**：规模未提前报告是执行偏差，已记录；现有约 +544 作为返修起点，不做机械压行，不扩模块；修实际问题时精简明显重复。新增净增 >100 行先报告并停止，不再先做完后补报。
- 保留：选择标记与旧 proof 兼容、原命令/回答双 source 防回流、两阶段事务复用；不声称 master 已接受。

## master 有限接受（2026-10-28 r79，非用户确认，不是完整 S03）

- 独立后端 `evidence/master-s03o-b-core-HAu7KrCs` **313/313、0 skip、exit 0、before/after 一致**；独立 GUI `evidence/master-s03o-b-gui-M3KWYxVe` **9/9、0 skip、exit 0、before/after 一致**；当前 SHA 均核对 OK。
- master 实际查看截图 `evidence/s03m-lifecycle/gui-shots/2026-10-27T16-01-26-121Z-30808` 的 clarify-question/phase1-pending/phase2-final：真实候选问题、输入、单 assistant 原位更新与输入恢复可读；真实 Electron/SQLite + 构造 HTTP，不是人类体验或真实模型。
- 接受仅限本批已测删除目标澄清；不笼统称所有 Case 完整 PASS。保留先前失败、越规模与返修事实。
- 未覆盖：真实模型/自然泛化、临时跨持有者/回答前到期独立 Case、GUI 多候选/同 identity/临时/self、correct 时间、完整 S03。
- 生产 561/测试 1219 经 master 依据职责与独立场景审查允许作为本片成果；未提前报告为执行偏差（skill 已有要求，本批不改 skill）。版本 `0.1.201 → 0.1.202`（10 文件 11 处仅字面量，不升级依赖/不重生成 lock）。

## 0. 修订记录与边界

r1 被拒要点：同 identity relay fixture 与 Expected 冲突；把“原文逐字包含”当唯一歧义判据、把 recentText 检索候选当原命令授权集合；retry 会丢失选择；来源只加 `commandSourceHash`，未说明 phase 2 控制一致性；`planOperation` 描述不准确。r2 按下述返修，未改代码/测试/版本/Git/skill/API，未运行测试或真实模型，未用子代理。

- 基线：HEAD `4ce18ea`、VERSION `0.1.201`；S03o-A 已 snap 并有限接受，S03o-B 未批准、未实施。
- 需求：REQ-18/61、`POL-CHAT-007`、[s03o-clarification-plan.md](s03o-clarification-plan.md) 第 9 节未解项、C02 真实场景。
- 目标：删除目标真实歧义只需一次简短选择即可完成，接回真实 `chat.sendMessage` 与现有两阶段 forget。
- 范围：仅 forget 目标澄清；不做 correct 时间澄清、不扩展 exact-unique null forget 补全、不改 C02/C03/C07 原 Expected、不改评分工具。原命令完整匹配且模型 null 的现有缺口明确保留，不称已修复。
- 不变量：模型 reply 不参与提问/授权/判真；本地提问不透传模型 reply；回答只选择原授权候选；scope 默认 `all`；equivalent 同步删除、different/uncertain 不传播、不向未持有角色新增；关系最多一次；原命令和回答均保留真实 source；目标 version/source/context 失效阻止旧 pending；不做通用状态机/新表。

## 1. 只读核查结论

### 1.1 现有链（修正描述）

1. `app/chat.cjs:1793-1857` `sendMessage` 写入真实用户消息与请求；`recordUserTurn`（`:609-633`）给用户消息 `sourceId=chat:<userMessageId>`。
2. `app/chat.cjs:340-366` 仅在 `detectOperationIntent` 有 action 时检索候选；候选同时来自原话与近期对话，**不能全部视为原命令授权集合**。
3. `app/chat-memory-operations.cjs:338-402` 得到唯一 action、`authorizedText`、`clauses`、`scope`。
4. `app/chat-memory-operations.cjs:959-1083` `planOperation`：只有模型给出非 null operation 时才校验 action/target/evidence/`resolveTarget`；`memoryOperation` 缺失按原协议不补全，显式 null 仅 correct 走 S03o-A 本地补全，forget null 落到 `notProcessed`（`:1013-1015`）。
5. `app/chat.cjs:1444-1526` 捕获 forget 目标证据与候选；`app/chat.cjs:1556-1706` 阶段 1 事务执行、写请求/assistant、生成 proof。
6. `app/chat.cjs:1194-1353` 阶段 2 复核 proof/目标/候选，一次 `verification.verify`，按 equivalent 执行 `deleteApprovedCandidates`。
7. `app/chat-memory-verification.cjs:134-157` 目标证据；`:182-183` `seenIdentity` 以目标 identity 初始化；`:297-345` 关系请求只用目标快照 excerpt 与候选，不使用回答文本。
8. `app/memory.cjs:869-971`：scope `all` 在**阶段 1** 删除该 identity 的全部持有者；`sourceIdsToExclude` 最多 5 个，当前只排除命令来源。
9. 生命周期：`app/chat.cjs:1859-2020` 的 retry/cancel/close/dispose；`app/chat-store.cjs:161-167` retry 会清空 `operation_proof`。

### 1.2 关键修正

- **同 identity relay**：B 的 relay 副本与 A 目标同一 `factIdentityId`。阶段 1 `memory.forget(scope=all)` 已删除 A/B 全部同 identity 条目；`captureCandidates` 的 `seenIdentity` 又排除该 identity，候选为 0，因此**没有 proof、没有关系请求**。若同 identity 之外另有独立候选，仍可能由该候选触发恰好 1 次关系核验；本 Case 只覆盖“无独立候选”的情况。不得用 different/uncertain 的 Expected 约束这条同 identity 路径。
- **独立 identity**：B 另有独立事实 identity 时，阶段 1 只删 A；`captureCandidates` 找到 B 的独立候选，关系请求恰好 1 次；equivalent 删 B，different/uncertain 不删 B。C02 live 的 B“我的咖啡都要甜的”属于此类。
- **授权候选**：先用 `matchingCandidates`（`app/chat-memory-operations.cjs:636-639`）按**本轮命令**过滤 topic 实际匹配的候选；recentText 带来的完全无关候选不提问、不执行。逐字正文包含只作为“是否已完整点名”的子信号，不是唯一判据。
- **同义边界**：匹配依赖现有 `segmentQueryTokens` + 汉字 bigram + `normalizeGrounding`，并排除通用词/时间词；只处理词面重叠，不做任意同义、代词或语义 NLU，不新增模型分类器。“饮品偏好”与“咖啡”无词面重叠时不做澄清、不执行，这是已知边界。
- **来源**：删除回合需要同时排除原命令 source 与回答 source（最多 5 个，2 个可复用）；phase 1 的 `controlProof.sourceControls` 已记录两者哈希，phase 2 需拿到原命令 source 做幂等再排除，不能只加 `commandSourceHash`。
- **retry**：回答执行前按 requestId 保存“已核验原命令 + 选择快照”；pre-commit 失败可同 request 重试，重试必须重查 context/version/source/TTL；完成不重复、取消清理、重启丢内存时如实失败，不能退回普通聊天。

### 1.3 可复用接口

`detectOperationIntent`、`matchingCandidates`/`contentTokensOf`、`planOperation`、`applyChatOperation`、`captureForgetTargetEvidence`、`captureCandidates`、`verification.verify`、`startVerification`/`runVerification`、`deleteApprovedCandidates`、`memory.getHeldEntry`、`memory.listExcludedSources`、`memory.isContextCurrent`、`memorySourceContext.resolve`、`recordUserTurn`、`store.insertMessage`/`updateRequest`/`setVerification`。不新增表；仅复用 `chat_requests.operation_proof` 存一个选择标记。

## 2. Part A：技术设计

### 2.1 触发、授权候选与歧义

候选集合 `authorized` = 以 `intent.authorizedText` 为 context，经 `matchingCandidates` 命中的本轮候选（保留原 `target/entry`，显示时重排为 1..n）。建立 pending 的前置：

1. 唯一 forget、无 multiple_actions、有 `authorizedText`；
2. 模型显式 `memoryOperation:null`；
3. `authorized.length >= 1`；
4. 不是“唯一候选且原命令已完整点名其正文 core”（body 归一化并去开头“用户/我们/我/角色”后，命令完整包含 core）。

四种结果：

- `authorized.length === 1` 且仅部分匹配：提问确认这一条（C02）。
- `authorized.length > 1`：列出全部 authorized 候选供选。
- `authorized.length === 0`：不提问、不执行，保持 `notProcessed`。完全无关候选（如咖啡命令 + 仅杭州记忆）走这里。
- 唯一候选且完整点名：不建立 pending，保持现有 `notProcessed`；该 exact-unique 缺口明确保留。

回答只能从 pending 的 `authorized` 快照选择；混合候选（咖啡 + 杭州）只显示/允许咖啡候选，回答“杭州那条”或越界编号被拒。不得把 recentText 候选并入授权集合。

### 2.2 pending、选择快照与持久标记

`app/chat.cjs` 内存 `Map`，key=`characterId + "\0" + conversationId`，每会话最多一条：

```
{
  originalRequestId, originalUserMessageId, originalSourceId,
  originalCommandText, evidence, scope, contextVersion, createdAt,
  candidates: [{ target, entryId, version, factIdentityId, sourceIdHash, body }]
}
```

回答命中后、执行前，另存按 `answerRequestId` 绑定的已核验快照（内含原命令信息、选中候选、`answerSourceId`、TTL 起点）。同时在 `chat_requests.operation_proof` 写最小标记 `{kind:"forget-selection", version:1}`：用于重启/失败后识别“这是选择回合”，不存正文、不新增列。`app/chat-store.cjs` 增两个窄方法 `setOperationProof`/`clearOperationProof`；成功且无 proof 时在同一事务清除，成功有 proof 时由 `setVerification` 覆盖。标记不是通用状态机，只是重启诚实失败的依据。

### 2.3 本地提问

由 `chat-memory-operations.cjs` 新函数按 authorized 候选生成，不拼接模型 reply：

- 单候选部分匹配：`我只找到一条可能相关的记忆：\n[第 1 条] <正文>\n\n要忘记这条吗？回复“第 1 条”，或说出候选里的关键词加“那条”。`
- 多候选：列出“第 1 条…第 n 条”的正文（每条折叠空白、约 160 字截断），要求回答编号或关键词+“那条”。
- 原请求 completed、`memoryApplied=0`；assistant 消息 source 仍是原命令 source。澄清回合不学习 memoryCandidates，因此正常回答前原 `contextVersion` 不变，严格门不会因提问本身误判。

### 2.4 回答分类与封闭语法

`parseForgetTargetAnswer(text, pending)` 返回：

- `select`：`第1条`/`第一条`/`M1`（1..n）；唯一候选下的 `对/是/就这条/这条`；描述式 `<候选正文唯一短语>那条/这条`（短语≥2字且只命中一个 pending 候选）。
- `cancel`：`取消/算了/不用了/先不删了/不改了`。
- `invalid`：编号越界、单候选下多义肯定、描述命中多个、含候选短语但带否定/引号/假设/归属/新事实，或用户用“第 n 条”指向未授权候选。**本地明确未操作**，不调用模型、不发关系。
- `none`：没有选择标记的普通闲聊。清 pending 后走正常聊天路径；不笼统宣称整库零写。

无论 `select/cancel/invalid/stale`，回答都作为真实用户消息写入；本地拒绝/过期/失效以 completed + 本地未操作回复收口，不冒充模型回复。

新明确操作优先：`detectOperationIntent(text).action` 非空或 multiple_actions 时，清 pending，按新命令正常处理，不并入旧授权。

### 2.5 承接执行、来源、proof 与 context

回答为 `select` 时：

1. 复核 `characterId+conversationId`、TTL/跨日、`memory.isContextCurrent(characterId, pending.contextVersion)`；
2. `memory.getHeldEntry` 重读选中目标，要求 entryId/version/factIdentityId/sourceIdHash 与快照一致；检查原命令与目标 source 哈希未在 `listExcludedSources`；`memorySourceContext.resolve(..., nowMs)` 为 `ok`；
3. 失效：零写、清 pending/标记、本地提示“我准备删除的那条记忆已经变化，这次没有改动；请重新告诉我要忘记哪件事。”，不发关系；
4. 有效：构造 `{action:"forget", target:{target, entry}, scope:pending.scope, evidence, commandSourceId:originalSourceId}`；
5. 记录回答为真实用户回合（自己的 source），跳过聊天模型与 memoryCandidates，用 `runModelRequest(preplannedPlan)` 复用阶段 1/2；
6. 阶段 1 `applyChatOperation` 的 forget 排除 `[commandSourceId, answerSourceId]`（去重；≤5）；按现有 forget 语义，两来源聊天原文保留，但不再进入后续提炼/上下文，避免回流。`commandSourceHash` 仍只代表原命令；回答 source 不会冒充 command 来源；
7. proof 增加 `commandSourceId`（供 phase 2 再排除）与 `commandSourceHash`、`initiatorContextVersion`；`controlProof.sourceControls` 已含两 source 哈希；
8. `applyForgetControls` 把 phase 1 实际控制带入 targetEvidence/candidate increments；phase 2 `verifyOperationProof` 校验 context 与哈希仍存在；`deleteApprovedCandidates` 对发起者幂等再排除 `[commandSourceId, answerSourceId]`（回答 source 由 `inside.userMessageId` 重读），不引入新控制；
9. `verification.verify` 恰好一次；equivalent 删独立 B，different/uncertain 不删；同 identity 在 phase 1 已删，无候选、无关系。

### 2.6 生命周期、失败与重试（最小契约）

- 超时 10 分钟/跨本地日：读取时先按快照分类再清理；选择式回答本地如实“澄清已过期，未改动”，普通闲聊按正常路径处理。TTL 已接受，不再扩展。严格 `contextVersion` 门先接受；若后续发现无关记忆变化也导致重选，可再评估目标/来源级窄门以降低负担，本轮不做。
- 新明确操作：清 pending，按新命令处理。取消回答（`算了` 等）：本地零写，清 pending/标记。
- `closeConversation`/`dispose`：清对应/全部 pending、快照与标记；沿用既有取消/在途收束。
- `cancelRequest`：对已完成澄清请求清 pending，返回值保持现有 `cancelled:false/status` 语义；回答请求取消时同时清绑定快照/标记；阶段 2 取消沿用既有 verification cancel。
- 失败未提交：选择承接的 pre-commit 事务/存储失败统一 `FORGET_SELECTION_FAILED`（加入 RETRYABLE_ERRORS），保留快照与 `operation_proof` 标记；编程/契约异常保留原错误并清快照，不伪装可重试。`retryRequest` 同 requestId 重查 TTL、contextVersion、目标 version/source/identity、来源排除后重跑 preplanned；stale/source 失效则清快照与标记并如实失败。
- 完成：清快照；有 proof 由 `setVerification` 覆盖标记，无 proof 同事务清除；不重复执行。
- 重复 requestId：`sendMessage` 既有幂等返回同一结果，不追加用户消息、不重复删除/关系。
- 重启：内存快照丢失；若 `operation_proof` 标记或 `FORGET_SELECTION_FAILED` 表明这是选择回合，retry 返回 `FORGET_SELECTION_EXPIRED`（stale/失败）而不是普通聊天；无标记的普通请求不受影响。

### 2.7 分批、允许文件与规模

生产预计净增按批准细化合计 **290～415 行**，按垂直批次：

- **B1 核心垂直**（C02 单候选部分匹配 → 本地确认 → 选择 → 两阶段删除/同 identity 直接删除 → 来源/proof → 失效/取消/关闭/dispose/过期 → GUI）：`chat-memory-operations.cjs` 约 90～120、`chat.cjs` 约 120～160、`chat-store.cjs` 约 10～15；合计 220～295。
- **B2 授权范围**（多候选、topic 过滤、无关/混合负例、会话隔离、新操作优先）：约 40～65。
- **B3 重试/持久标记/重复 request**：约 30～55。

测试不造通用 Runner，按独立 Given 复用现有 fixture；预计合计 480～640 行，单批超预算先报告：

- B1：`chat-memory-operations.spec.cjs` 约 240～300、`chat-verification-ui.spec.cjs` 约 50～70。
- B2：`chat-memory-operations.spec.cjs` 约 70～100。
- B3：`chat-memory-operations.spec.cjs` 约 70～100、`memory-semantic-operations.spec.cjs` 约 50～70（独立 identity 传播/控制一致性）。

允许文件：`app/chat.cjs`、`app/chat-memory-operations.cjs`、`app/chat-store.cjs` 及上述测试。`app/memory.cjs`、`app/chat-memory-verification.cjs`、renderer/main 预期不改；若要改先报告。超过单批生产 300 行先停下报告，不压行/删断言。

### 2.8 失败回退

模型失败/非法结构不建立 pending；承接失效零写并如实提示；阶段 2 失败保留阶段 1 删除并如实收口；pending/快照丢失不执行旧授权。所有分支不得显示模型成功文案。

## 3. Part B：自动化验收计划

### 3.1 Case（新 ID；不改原 C02/C03/C07）

| ID | Given → When | Expected（独立 Oracle） | Boundary |
|---|---|---|---|
| POL-CHATMEM-FORGET-CLARIFY-001 | A“我平时喝咖啡一定要加糖”，B 独立 identity 同主题；模型 null；用户“请忘记我喜欢咖啡这件事。” | authorized=1（咖啡）；本地提问只含该候选；模型 reply 不显示；库不变；关系 0；pending 仅内存 | 真实 chat/SQLite；构造 chat HTTP |
| POL-CHATMEM-FORGET-CLARIFY-001b | 承接 001，回答“第 1 条” | 阶段 1 删 A；关系 1；B equivalent 删除；回答回合 0 次聊天模型；原命令与回答 source 均被排除；proof 含 commandSourceId/Hash；阶段 2 原位更新；无重复 | 同上 + 构造关系 HTTP |
| POL-CHATMEM-FORGET-CLARIFY-001c | 承接 001，回答“加糖那条”或唯一候选“对/就这条” | 与 001b 相同；选择只来自 pending 快照 | 同上 |
| POL-CHATMEM-FORGET-CLARIFY-002 | A 有两条 topic 匹配候选；模型 null；回答“第 2 条” | 问题列两条；只删第 2 条 identity；第 1 条保留；关系按第 2 条候选 1 次 | 同上 |
| POL-CHATMEM-FORGET-CLARIFY-003 | 承接 001，回答“第 9 条”/“加糖那条不要删”/`“加糖那条”`/“如果加糖那条”/“加糖那条是我朋友的” | 本地明确未操作；不调用聊天模型/关系；库不变；pending 清除；后续“第 1 条”不再执行 | 构造 fixture |
| POL-CHATMEM-FORGET-CLARIFY-004 | pending 存在，用户发新明确 forget“请忘记我住在杭州这件事。” | 旧 pending 清除；只执行新命令；咖啡保留；关系只按新目标 | 同上 |
| POL-CHATMEM-FORGET-CLARIFY-005 | 001 后目标 correct/delete、source 被排除、或 A `contextVersion` 变化；回答“第 1 条” | 零写；本地要求重新选择；清 pending；无关系；请求 completed | 真实 memory 外部变更 |
| POL-CHATMEM-FORGET-CLARIFY-006 | A 会话 pending；B 会话或 A 另一会话回答“第 1 条” | 其他会话无承接、库不变、无关系；A 原会话仍可回答并执行 | 内存隔离 + 真实 chat |
| POL-CHATMEM-FORGET-CLARIFY-006b | A 会话 pending；用户发普通闲聊“今天天气怎么样” | pending 清除；走正常聊天路径；fixture 空候选/无 operation 时库不变，并独立断言旧 forget 未执行；不泛称任意闲聊整库零写 | 构造 fixture |
| POL-CHATMEM-FORGET-CLARIFY-007 | A 将咖啡 relay 给 B；B 副本与 A 同 identity，且无其他独立候选；模型 null 提问后回答“第 1 条” | 阶段 1 即删 A/B 同 identity；候选 0、proof 无、关系 **0 次**；回复为本地删除确认，不出现“核验中” | 真实 chat/SQLite |
| POL-CHATMEM-FORGET-CLARIFY-008 | A/B 独立 identity（B 自有“我的咖啡都要甜的”）；模型 null 提问后回答“第 1 条”；关系 equivalent | 阶段 1 删 A；关系 1；equivalent 删 B；两 source 控制保留；phase 2 proof/sourceControls/context 复核通过 | 同上 + 构造关系 |
| POL-CHATMEM-FORGET-CLARIFY-008b | 同上；关系 different 或 uncertain | 仅 A 删除；B 行/版本不变；关系仍恰好 1 次；如实收口 | 同上 |
| POL-CHATMEM-FORGET-CLARIFY-009 | 咖啡命令 + 仅杭州候选；模型 null | authorized=0；不提问、不执行、无关系；保持 `notProcessed` | 构造 fixture |
| POL-CHATMEM-FORGET-CLARIFY-009b | 咖啡命令 + 仅一条咖啡及一条杭州的混合候选；模型 null；回答“杭州那条”或“第 2 条” | 问题只列咖啡候选（显示为第 1 条）；回答被本地拒绝、未操作、无关系；咖啡保留 | 同上 |
| POL-CHATMEM-FORGET-CLARIFY-010 | 001 的模型 reply 含“已删除”/澄清文案 | 只显示本地提问；无模型成功文案；`memoryApplied=0` | 构造模型 |
| POL-CHATMEM-FORGET-CLARIFY-011 | 001b 承接时注入 phase 1 事务失败；随后同 requestId retry（目标/context/source 仍有效） | 首次失败零写、请求 failed 且可重试、快照/标记保留；retry 重查后成功；只删一次、关系 1 次；不重复 assistant | 真实 SQLite 故障注入 |
| POL-CHATMEM-FORGET-CLARIFY-011b | 011 失败零写后关闭并重开（内存快照丢失；请求已 failed、标记保留）；retry 同 requestId | retry 返回 `FORGET_SELECTION_EXPIRED`/stale，不调用聊天模型、不删除；不假装正常聊天 | 真实重开 store/chat |
| POL-CHATMEM-FORGET-CLARIFY-011c | 失败后目标/context/source 变化，再 retry | 零写；如实失败/要求重新选择；不重放旧快照 | 真实 memory 变更 |
| POL-CHATMEM-FORGET-CLARIFY-012 | 001b 成功后用同一 requestId+同文本再次 sendMessage | 幂等返回同一结果；不追加用户消息、不重复删除、关系仍 1 次 | 真实 chat |
| POL-CHATMEM-FORGET-CLARIFY-013 | 001 后 10 分钟超时/跨日；或 cancelRequest(原澄清请求)/close/dispose；或回答“算了” | pending/快照/标记清理；不执行旧 forget；取消请求返回值保持现有 API 语义；无关系 | 可控时钟/真实生命周期 |
| POL-CHATMEM-FORGET-CLARIFY-GUI-001 | 真实 Electron：001 提问可见 → 回答“第 1 条” → 阶段 1 删除、阶段 2 原位更新 | 问题/回答均为真实消息；输入恢复；同一 assistant 刷新；A/B 删除；无模型成功文案；DB/请求独立核对 | 真实 Electron/SQLite；构造 chat/relation HTTP |

C02/C03/C07 原 Case/Expected 不变；001 系列是新增验收，不把 C02 的模型 operation 成功路径当本片证明。

### 3.2 Case→实现→Runner

| Case | 生产路径 | Runner |
|---|---|---|
| 001/007/009/009b/010 | `planOperation` forget-null 分支 → `forgetTargetClarification`（topic 过滤/部分匹配/提问）；`runModelRequest` 注册 pending | `tests/acceptance/chat-memory-operations.spec.cjs` |
| 001b/001c/002/008/008b | `sendMessage` pending 分支 → `parseForgetTargetAnswer` → `planForgetTargetSelection` → `runModelRequest(preplannedPlan)` → `applyChatOperation` → `startVerification`/`runVerification` | 同上 + `memory-semantic-operations.spec.cjs` |
| 003/004/005/006/006b/013 | `sendMessage` 分类、新操作优先、pending/快照生命周期、cancel/close/dispose、普通闲聊正常路径 | `chat-memory-operations.spec.cjs` |
| 011/011b/011c/012 | `retryRequest` 绑定快照、`operation_proof` 标记、`FORGET_SELECTION_FAILED`、重复 requestId | 同上 |
| GUI-001 | `app/main.cjs:1251` → `chat.sendMessage`；renderer 现有消息/输入处理 | `chat-verification-ui.spec.cjs` |

### 3.3 回归命令（计划，未执行）

- `node --test tests/acceptance/chat-memory-operations.spec.cjs`
- `node --test --test-concurrency=1 --test-timeout=90000 tests/acceptance/memory-semantic-operations.spec.cjs`
- `node --test tests/acceptance/memory-source-relation.spec.cjs`
- `node --test tests/acceptance/memory-corrected-source.spec.cjs`
- `node --test tests/acceptance/memory-relation-protocol.spec.cjs`
- `node --test --test-concurrency=1 tests/acceptance/chat-verification-ui.spec.cjs`

S03o-A 旧五套 277/277 只作历史基线；新版本按 attempt 新建，不覆盖旧证据。

### 3.4 GUI 与 Mock 限制

入口：真实 Electron、`chat-verification-ui.spec.cjs` 的 `launchApp`、`#chat-input`/`#chat-send`、真实 SQLite；阶段 2 沿用 `onVerificationSettled`/`chatUpdateReady` 原位刷新。聊天与关系 HTTP 均为本机 fixture；断言聊天/关系请求次数、回答不进入 relation pair、请求不含 Expected。不得称真实模型语义、人类体验、真实断网/锁屏或原生鼠标；截图/日志写入新 evidence，不覆盖既有 `master-*`/attempt。

## 4. 已接受的 master 决定与本轮待审

已接受并写入方案：同 identity 阶段 1 直接传播/关系 0；独立 identity 关系 1；topic 过滤授权候选、单部分匹配确认、无关候选不提问；严格原 `contextVersion` 门；10 分钟/跨日；非选择闲聊正常处理、无效选择本地未操作；双 source 排除；retry 绑定/重启如实失败；exact-unique 与 correct 时间本轮不扩展。待 master 审核：本 r2 的 topic 匹配边界、`operation_proof` 最小标记、分批规模与 Case 集合。

## 5. 实施结果与中期返修

- 首版实现后 master 中期审查不接受；原 309/309 与日志保留，不作验收。返修前基线 `evidence/s03o-b/attempt-20261027-235522-review1-baseline/`：direct-probe 普通假设闲聊 invalid，真实 chat 006c 失败，SHA 一致。
- r78 修正：选择式输入先判定，普通问号/假设闲聊走正常模型；移除未批准临时过滤并补到期复核；补齐同角色不同会话、失败后新话题/新命令/取消/关闭/重启 retry、跨午夜未满10分钟、仅 source 控制、scope self、重排真正删除原 M2、C/D 无新增等 Case。
- 最终回归：chat-memory 74/74、semantic 126/126、source-relation 4/4、corrected-source 99/99、relation-protocol 10/10、GUI 9/9，合计 **322/322 pass、0 skipped、6 命令 exit 0、before/after SHA 一致**（`evidence/s03o-b/attempt-20261027-235859-review10-final/`）；GUI 截图 `evidence/s03m-lifecycle/gui-shots/2026-10-27T15-59-44-578Z-30351/`。矩阵与 NOT_COVERED 见 [repair-summary-r2](evidence/s03o-b/repair-summary-r2.md)。
- 生产净增 **+561**（返修起点 +544，本轮 +17；<100）；未机械压行/扩模块。总规模仍高于 420，按 master 返修起点处理。未覆盖：真实模型/live、人类体验、自然语义泛化、临时目标跨持有者同步、GUI 多候选/同 identity/临时/self、C07、correct 时间、完整多轮与 S03 聚合。
