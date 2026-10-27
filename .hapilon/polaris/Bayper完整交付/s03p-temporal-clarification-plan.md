# S03p correct 时间澄清承接方案（r2 修订，待 master 审核）

状态：2026-10-28；基线 `5f03cdf`、VERSION `0.1.205`。master 审查 **不批准 r1 实施**，退回理由保留：A5 把检索/上下文/再提炼留为非目标；CORRECT-TIME-003 Given/Expected 矛盾；多项“全表一致”忽略聊天审计新增；sourceId 256 仅凭 224～232 估算；普通换话题被当成零写；重试把内部 sourceId 编码当授权；假定存在聊天来源撤销入口。**master 2026-10-28 受托批准 r2 preference 最小切片实施（非完整 S03 接受）**，并追加五点：① CT-002b 只表示无跨独立身份 verification，回答的 operationProof 授权/审计标记仍须保留；② CT-004 普通聊天允许 grounded 新事实提炼，不笼统 MEM 全零写；③ CT-008 同时核对 B 副本有效读与授权链，不假定删除长期锚必留无效临时；④ 双消息来源必须验原正文与“就今天”语义、同会话同角色、时效，不能只凭 message ID，篡改/不支持回答无效；copy/edit 保留原来源归因，面板正文不称聊天原话；⑤ FTS 区分物理索引与有效检索，旧失效临时不得进入有效检索/上下文。GUI 由另一任务独占；本批不修改 renderer/desktop，`effective` 只落 API。本方案下的代码/测试实施沿用此批准；仍非用户确认。

**中期审查（2026-10-28，master 对会话 34869 SIGINT 终态）**：初次实现触及生产净增 **616**（chat 372、operations 127、source-context 78、temporary 16、memory 12、temporary-source 11），超过批准 290～420 且未在 400 前报告；当时为半成品，不构成验收。已发现阻断缺陷：`chat.cjs:580` 函数头挤行；`memory-source-context.cjs:296-305` 在 `correctedSnapshot` 引用未定义 `parsed`；`:863` 的 `resolveEdit` 使用未定义 `timeAuth`。另未接线 `temporaryInfo.timeAuthorizedToday`/`memoryEntryLine` 授权文案；semantic/公开删除/在途/来源协议回归均未运行。详见 [s03p-review.md](s03p-review.md)。

**收口结果（2026-10-28）**：三处缺陷已修；授权文案、source/copy/edit 双来源读门、生命周期已接；只合并 marker/失败失效/本地 respond/关闭清理五个同形 helper，业务重验与执行保持独立；source→operations 方向保留并注释纯校验用途。最终生产净增 **630**（chat 382、operations 127、source-context 80、temporary 17、memory 12、temporary-source 11、renderer 1），测试 816。focused chat 26/26、semantic 12/12；回归 chat 100/100、semantic 138/138、corrected-source 99/99、source-context 6/6、relation-protocol 10/10，均 exit 0、0 skip；全量 `node --check` exit 0。GUI 未运行（睡眠会话独占），待 master 安排；仍待 master 独立复验，不写 PASS。

## 1. 只读核查：真实读门、重扫与来源入口

| 入口 | 真实行为（代码） | 结论 |
|---|---|---|
| `memory.searchMemories` | `memory.cjs:717-750` → `temporary.filterSearch`（`memory-temporary.cjs:1029-1037`）→ `temporaryInfo`（`:997-1026`）→ `validateTemporary` = `memorySourceContext.resolve` | 失效临时项**已被过滤**；FTS 先召回、后按权威来源剔除 |
| `memory.buildContext` | `memory.cjs:1895-1947` → `temporary.annotateContext`（`:1041-1079`）→ 同一校验器 | 失效临时项**不进入**聊天记忆上下文，也不再抑制长期锚 |
| 聊天上下文 | `chat.cjs:559-603` 用 `buildContext` + `buildOperationContext`（`searchMemories`）；近期消息按 source control 过滤（`:561-568`） | 两个有效读入口都已走来源校验；只需把时间来源纳入校验 |
| `listMemories`/`listMemoriesPage` | `memory.cjs:604-637` 直接返回 active entries，**不校验临时来源**；面板 `app/renderer/memory-panel.js:129-132` 只显示 kind/source | 管理列表会把失效临时项当普通条目展示；需最小 `effective` 标记，不能留为非目标 |
| `getHeldEntry` | 原样返回条目；写入/临时操作另有 `validTemporaryEntry`/`applyUnderstanding` 校验 | 保留原样以支持删除/清理；有效使用仍由校验器把关 |
| 关系/候选 | `chat-memory-verification.cjs:240-286` 候选要求成功来源快照；`:297-321` 临时同步 pair 的 `text` 是**长期锚** `targetSnapshot.excerpt` | 本次“最近”正文不进入关系判定，不会被关系模型标 vague；后续以临时项为边时快照已带 `expiresAt` |
| 再提炼 | `source-analysis.cjs:288-322` 发布前查排除来源；`applyExtractionBatch` 的 `insertFactIfAllowed` 查 source control（`memory.cjs:462-497`）；聊天候选必须由**当前用户消息** grounding（`chat.cjs:640-688`） | 旧临时的回答文本不能成为新记忆来源；外部重扫受来源控制；不存在聊天消息重扫管线 |
| 公开撤权 | `externalSources.revokeDirectory`（`external-sources.cjs:319-322`）只撤目录分析授权，不删既有记忆、不针对聊天消息 | **没有公开的“撤销聊天来源”入口**；不得假定。验收用公开 correct/delete；构造 source_controls 只作防御单测，不作最终验收 |
| 在途 | `runModelRequest` 响应后复核 `isContextCurrent`（`chat.cjs:1629-1631`）；公开 correct/delete 会 bump context | 在途请求转 stale、不存 assistant/不写回；已发出的 prompt 仍可能含旧临时项，不能追溯撤回，此点如实保留 |
| 重启 | pending 为内存态；有效读每次按 SQLite 重解来源 | pending 丢失后不回放旧授权；失败选择标记使 retry 返回 expired |

## 2. Part A：最小闭环

### A1 触发与资格（第一切片只做 preference）

`correctionPlan`（`chat-memory-operations.cjs:952`）在 `info.temporal === "vague"` 时，仅当：`trust==="stated"`、`target.entry.kind==="preference"`、`expiresAt===null`、`body` 含 `VAGUE`（最近/近来/这几天/这阵子/暂时/临时/目前/现在），且不含 `TODAY/EARLY_DAY/OTHER_TEMPORAL/FUTURE_TIME/FUTURE_PLAN/EXPLICIT_PAST_EVENT`，才返回结构化时间澄清；`planOperation` 的模型 operation 与显式 null 两路都转 `{kind:"clarifyCorrectTime"}`。其他 vague、经历/身份/detail、未来/过去/目标或锚不唯一保持原澄清，**不建 pending**。模型 reply 丢弃，提问本地生成。

### A2 pending 与回答语法（避免重犯 forget 误拒）

- 内存 `Map` key=`characterId\0conversationId`，每会话一条；字段含原请求/原消息/原来源/原话/contextVersion/createdAt/evidence/body/trust/目标快照；TTL 10 分钟 + 同本地日；新明确操作、普通换话题、取消、close、dispose 清除；不建统一状态机。
- 先判“是否时间式选择输入”，再只对该类应用问号/引用/假设拒绝；**普通问题先走正常聊天**。封闭接受：归一化后属 `{今天, 就今天, 仅今天, 只今天, 只是今天, 只限今天}`（可带“对/嗯/是的”与“吧/就好/就行/一天/而已”）。取消词本地零写。
- `就今天？`、`“就今天”` 属时间式选择 → 本地 invalid；`明天吧/长期吧` 属时间式但不支持 → invalid；`如果是今天呢？`、`就今天，而且我要加糖` 不属封闭时间式 → 普通聊天，**旧 correct 一律不执行**。新明确操作优先，清 pending 后按新命令处理。

### A3 承接执行（正文与授权分离）

回答接受后记录真实用户消息/请求，`operationProof` 标记 `{kind:"correct-time-selection",version:1}`；该标记是后续 retry/防回流依据，**成功后不得删除**（无 verification proof 时保留；有 proof 时把 `timeAuthorization:{kind:"today",contentSourceId,timeSourceId,answerUserMessageId}` 写入 temporary proof，审计链仍可在 `operation_proof` 追溯）。执行前重验：TTL/同本地日、`isContextCurrent`、目标 `entryId/version/factIdentityId/sourceIdHash`、未到期、原/回答/目标来源未排除、`memorySourceContext.resolve` 为 ok、原消息仍在且 `locateCorrectionSegments(originalCommandText, body)` 唯一成功。通过后构造 `{action:"correct", target, body:<原消息正文>, trust, evidence, mode:"temporary", expiresAt:<回答受理日的当日结束>, contentSourceId:<原命令来源>, timeSourceId:<回答来源>}`，复用 `applyChatOperation`→`applyTemporaryUnderstanding` 与既有两阶段；`expiresAt` 在回答受理时确定并写入快照，执行/重试不得按更晚时钟重算，跨日重验失败；正文**不拼接“今天”、不采用回答文本**；A 长期正文/版本不变。同 identity 阶段 1 直接同步（关系 0；只是没有跨独立 identity 的 verification，不代表回答请求没有 operationProof）；独立 identity 恰一次关系（equivalent 同步、different/uncertain 不动、未知不新增）。回复用既有 temporary 文案。

### A4 双来源有效性与失效传播

- 扩展 `memory-source-context`：direct 与 copy 解析可选时间消息段；除 message ID 存在外，必须校验两条消息的 source_id、user 角色、同角色、**同一会话**、时间消息在正文消息之后、holder 未排除；正文消息仍须经 `locateCorrectionSegments` 重建临时正文；时间消息必须通过封闭“今天”语法，且临时 `expiresAt` 等于时间消息本地日的当日结束、两条消息同日。篡改、任意普通 chat 消息 ID、跨会话、问句/引用/不支持时间均 unavailable。copy 还须与 origin 的 `timeSourceId` 一致；edit 保留原来源与时间链，但面板正文不要求也不声称是聊天原话。校验失败 → `status!=="ok"`，`filterSearch`/`annotateContext` 自动剔除，聊天上下文/FTS/候选/关系不再有效；`getHeldEntry` 保留原样供删除清理。**不新建读门框架**。
- 管理列表：`listMemoriesPage`/`listMemories` 对临时项调用同一 `temporaryInfo`，返回 `effective:false`（非临时恒 true）；不隐藏、不改分页；删除仍可进行，编辑/转告由既有校验诚实失败。renderer 标签由 GUI 任务另行接入，本批不改。
- 再提炼：聊天候选仍只接受当前用户消息 grounding；旧临时回答不含正文，不能借此重建；外部分析按 source control 排除；不新增重扫器。
- 在途/重启：在途请求响应后按 context/stale 或执行前重验收口，不写回旧结果；重启后 pending 丢失，失败选择标记 retry 返回 expired；有效读每次重解，不缓存“已授权”结论。
- 公开发起来源失效：用 `chat.sendMessage` 的 correct/forget、面板 correct/forget 验收；**不构造 source_controls 冒充用户行为**。没有聊天来源撤销入口，故“撤授权”在产品中表现为新的 correct/delete，Case 按此验收。

### A5 时间表达的数据形状（不伪造正文）

- `temporarySource`（`temporaryInfo`）增加 `timeAuthorizedToday:true`（来源快照 `timeAuthorization==="today"`）；`memoryEntryLine`（`chat.cjs:416-451`）对带该字段的临时项输出：`来源:用户今天明确说明，且只授权今天；正文保留原话；时效:有效至...；引用:chat-current:...`。副本输出“经X的今日说明同步，原授权只到今天”。正文仍为原分句，不插入“今天”。**当前实现尚未接线这两处，属于半成品阻塞项，见 review。**
- source-context 快照增加 `timeAuthorization:"today"|null`，仅供 `temporaryInfo`/聊天行使用（不加入 digest；`sourceId` 已含两条消息 id）；关系协议首切片不改，`normalizeSourceContext` 仍只转发既有 `expiresAt`（`memory-relation-protocol.cjs:244-262`）。本次临时同步的关系 pair 用长期锚，故不把“最近”送进关系模型；以后临时项作为边时快照带 `expiresAt`，模型仍可能 `time:null`，**本地以 expiresAt 为准，不依赖模型时间标签**。若 master 要求关系模型显式读取授权，另加 `timeAuthorization` 字段与一句 prompt、bump `SOURCE_POLICY_VERSION` 并回归，规模另报。
- 具体形状：`temporarySource={kind:"direct",longIdentityId:"...",rootIdentityId:"...",originCharacterId:"a",relayFrom:null,edited:false,timeAuthorizedToday:true}`；`sourceContext={format:"corrected_v2",excerpt:"不是咖啡，我最近想喝茶",expiresAt:1793...,timeAuthorization:"today",sourceMessage:{...},segments:[...],...}`。聊天行示例：`[偏好] 不是咖啡，我最近想喝茶（来源:用户今天明确说明，且只授权今天；正文保留原话；时效:有效至2026-10-28T15:59:59.999Z；引用:chat-current:...）`。

### A6 来源协议、长度依据与迁移

- 协议（向后兼容）：direct `chat-current:<L>:<createdAt>:<contentMsg>[:<timeMsg>]`；copy/edit 末尾追加可选 `:<timeMsg>`；`memory-temporary-source.cjs:4-8` 正则可选，parse 返回 `timeSourceId`；`memory-temporary.cjs:244-260` 校验，`:370/451/527/695/842/971` 传参；旧 4 段 parse 为 null，行为不变。
- 长度依据（非估算）：entryId 由 `crypto.randomUUID()` 生成，固定 36（`memory.cjs:234-236`）；version 接受 safe integer，最多 16 位（`memory.cjs:176-183`）；消息来源 `chat:`+UUID=41；prefix：direct 13、edit 15、copy 18。最坏 copy = `18+36+1+16+1+36+1+16+1+36+1+16+1+41+1+41 = 263`；edit 260；direct 150。故 **256 不足**，建议 `memory.cjs:36 sourceId:320`（仅校验上限，TEXT 列/旧行不变，无数据迁移，不升级依赖）。
- 兼容与损坏：旧 4 段、旧数据不变；新格式第 5 段非 `chat:`、空段或多余段 → parse null → 有效读 unavailable（安全失败），不崩溃；重开后重新解析。旧版本代码读新 5 段会解析失败，有效读丢弃、但旧代码的 list 仍可能原样展示，**不宣称降级完全安全**。
- 作用域核对（中期审查）：`correctedSnapshot` 不得引用 `parsed`/`timeAuth`，只接收显式 `timeAuthorization`；`resolveCorrected` current、`resolveTemporaryCopy`、`resolveEdit` 各自定义 `timeAuth` 并在失败时 unavailable。`resolveEdit` 当前缺定义，必须先补。source-context 对 chat 层存在直连依赖（无循环，但层向倒置）；收口时把纯解析/`endOfLocalDay` 下沉或登记为已知问题。

### A7 重试、生命周期与授权充分性

沿用 forget 的 pending/取消/关闭/dispose/`prepareRetry`/`setOperationProof` 模式，但不复制候选选择工具。回答执行失败新增 `CORRECT_TIME_SELECTION_FAILED`（可重试），零写并保留快照/标记；同 request retry 必须重验两来源（原消息正文/来源、回答封闭语法/来源）、目标版本/身份/来源哈希、同本地日/TTL、contextVersion、未排除与 source-context；任一失效 → 零写 expired/changed。重启无快照时即使标记存在也返回 `CORRECT_TIME_SELECTION_EXPIRED`，**内部 sourceId 只作追溯，不当作授权**。并发/在途由既有 context/proof 重验收口。

### A8 文件、规模与分批

| 批次 | 允许文件 | 生产预期 | 测试预期 |
|---|---|---|---|
| B1 触发/提问/pending/语法 | `app/chat-memory-operations.cjs`、`app/chat.cjs` | +120～170 | +180～250 |
| B2 执行/来源协议/有效性 | 上述 + `app/memory-temporary-source.cjs`、`app/memory-temporary.cjs`、`app/memory-source-context.cjs`、`app/memory.cjs`（上限/effective） | +110～160 | +200～300 |
| B3 生命周期/重试/在途/重启/列表标记 | `app/chat.cjs`、`app/memory.cjs`（API `effective`） | +60～90 | +120～200 |

合计生产预计 290～420；初次实现到 616，收口后 **630**（chat 382、operations 127、source-context 80、temporary 17、memory 12、temporary-source 11、renderer 1），测试 816；低于 650 但仍高于约 560～600。后续不设“新上限”；按 [review](s03p-review.md) 的收口结果接受 master 复验。`app/chat-store.cjs` 不改；不修改 desktop 文件；renderer 仅加 `effective === false` 失效标签，GUI 未运行；不新增表/模块/Runner；不删 TTL/重试/双来源重验/operationProof。测试落 `chat-memory-operations`、`memory-semantic-operations`、`memory-corrected-source`、`memory-source-context`、`memory-relation-protocol`（回归）及列表 API 用例；只抽 map/marker/lifecycle 小 helper，不合并两种业务执行。

### A9 明确边界

- 第一切片仅 preference；经历/身份/detail、目标/范围澄清、forget 自动补全、GUI/live、人类体验、自然日期/同义、完整 S03 未完成。
- 原新内容不完整/多锚/目标不唯一/含不确定词、未来/过去/年份 → 不建 pending，后续“就今天”不能补全。
- 时间式无效回答本地未操作；普通问题/假设/带新内容回答走正常聊天，旧 correct 不执行；普通聊天允许正常记忆提炼。
- 无公开聊天来源撤销；不把 source_controls 构造当用户行为验收；目录撤权不删既有记忆。
- 面板对失效临时项只标“已失效”，不隐藏；编辑/转告由既有校验拒绝，删除保留。
- 关系协议首切片不改；后续临时项为边时模型时间标签可能为空，本地以 expiresAt 为准。
- 跨日/TTL、目标/来源变化、重启、在途、旧格式/损坏格式均按上述读门与重验收口；降级不宣称完全安全。

## 3. Part B：稳定 Case（Given/When/Expected/Oracle/Boundary）

Oracle 约定：`MEM` = `memory_entries`、`memory_fact_identities`、`memory_fact_relation_edges`、`memory_temporary_links`、`memory_temporary_entry_links`、`memory_derivations`、`memory_source_controls`、`memory_context_versions`；`CHAT` = `chat_messages`/`chat_requests`（**必然新增，绝不断言全表相等**）。**FTS 分两层**：物理 `memory_fts` 行是否随删除/更新保留按现有 store 行为如实记录（不把“长期锚仍在 FTS”误写成“FTS 只含新临时”）；有效检索只以公开 `searchMemories`/`buildContext` 为准，旧失效临时不得出现在其中。所有 Case 均走公开 `chat.sendMessage`/面板入口；构造 source_controls 只作防御单测，不作最终验收。

| ID | Given | When | Expected | Oracle | Boundary |
|---|---|---|---|---|---|
| CT-001 | A 长期 `用户喜欢咖啡`；B 独立同主题；模型返回合法 operation（excerpt=`我最近想喝茶`）或显式 null | 发“不是咖啡，我最近想喝茶，请帮我改过来。” | 只显示本地提问（含“就今天”）；不写记忆、无临时、关系 0；模型成功文案不出现；`memoryApplied=0` | MEM 旧行不变；CHAT +1 user/+1 assistant/+1 request completed；聊天请求 1、关系 0 | 真实 chat/SQLite；构造模型 HTTP |
| CT-002 | 001 的 pending；B 独立 identity；关系 equivalent | 回答“就今天”（另测“仅今天”“今天”） | A 当日临时正文逐字为原新内容（含“最近”，**无新增“今天”**），`expiresAt=当日 23:59:59.999`；A 长期不变；关系恰 1 次；B 临时同正文/到期、长期不变；C/D 无新增；`temporarySource.timeAuthorizedToday=true`；聊天记忆行有“只授权今天”与到期；同步关系请求 pair 用长期锚，不含临时正文 | MEM 预期 entries/临时 links/source controls/context versions；source_id 含两条消息 id且 resolve ok；proof 存在；CHAT +user/+assistant/+request；关系 1；FTS 只含新临时 | 真实 chat/SQLite；构造关系 HTTP |
| CT-002b | A/B 通过 relay 共享同一长期 identity，无独立候选 | 回答“就今天” | 阶段 1 直接同步 A/B 当日临时；**没有跨独立 identity 的 relation verification**（verification none），但回答请求的 `operationProof` 授权/审计标记仍存在（kind=`correct-time-selection`），作为 retry/防回流依据；B copy 来源也含两条消息 id；长期不变 | MEM 预期；CHAT；关系 0；answer request `verification_status=none` 且 `operation_proof` 标记存在；B copy source resolve ok | 真实 relay fixture；标记不是 verification proof |
| CT-003 | A 长期；B 为同 identity relay；C 为独立 identity `用户只喝美式咖啡`（different/uncertain）；D 未结识 | 回答“就今天” | **A 与 B 均有临时**（B 阶段 1 同步）；C 长期/临时均不变；关系恰 1 次（只对 C）；D 无 entry/relation/通知 | MEM 预期；CHAT；关系 1；B 临时来源为 copy 且 resolve ok | 真实 SQLite；构造关系 HTTP |
| CT-004 | 001 的 pending | 回答 `就今天？`、`“就今天”`、`明天吧`、`长期吧`、`如果是今天呢？`、`就今天，而且我要加糖` | 一律不执行旧 correct；时间式问号/引用/不支持时间 → 本地 invalid；假设/带新内容 → 普通聊天；invalid 分支 MEM 旧行不变；普通分支允许 grounded 新事实提炼，不笼统断言全零写；pending 清除；关系 0 | invalid：MEM 旧行不变、无模型/关系请求；普通：MEM 旧行不变但允许新事实，CHAT 按分支新增；不把 invalid 冒充普通 | 构造 fixture；不误拒普通问题 |
| CT-004b | 001 的 pending | 回答“今天天气不错，我住在杭州。”；模型返回 grounded 候选 `用户住在杭州` | 旧 correct 不执行；普通聊天正常执行新事实提炼；无临时；无关系 | MEM 新增杭州事实、旧行不变；CHAT +user/+assistant/+request；`memoryApplied=1`；关系 0 | 构造 fixture；证明不是全局零写 |
| CT-005 | 原新内容多锚/目标不唯一/含“可能”/未来“以后”/过去“昨天”/经历类 | 原轮及随后“就今天” | 原轮不建 pending，保持原澄清/零写；“就今天”不能补全旧 correct | MEM 旧行不变；CHAT 新增；关系 0 | 构造 fixture |
| CT-006 | 001 的 pending | 推进 >10 分钟或跨本地日，回答“就今天” | 本地过期/未改动；零写；pending 清除；无关系 | MEM 旧行不变；CHAT 新增；请求 completed | 可控时钟 |
| CT-007 | 001 的 pending；通过公开 correct/delete 改变目标或删除长期锚 | 回答“就今天” | 本地“已变化/未改动”；零写；pending 清除；无关系；不显示成功 | MEM 仅公开变更本身；CHAT 新增；关系 0 | 真实 memory 公开变更 |
| CT-008 | CT-002 成功后（A/B 同 identity 或独立副本），分别执行公开入口：(a) chat“忘记今天想喝茶这件事”并选第 1 条；(b) 面板 correct 该临时正文；(c) chat“忘记我喜欢咖啡这件事”并明确选择长期条目 | 每次后对 **A 与 B** 调用公开 `searchMemories`、`buildContext`，再发普通 chat 检查双方记忆段；重启后重查 | (a) A/B 均无旧临时； (b) A/B 均无旧正文、FTS 有效检索只返回新正文； (c) 长期删除后 A/B 副本来源失效，搜索/上下文均不再有效；**不假定一定残留无效临时**（删除可能级联）；若真实残留则 `listMemoriesPage` 给 `effective:false`；重启后同样不回流 | MEM 按公开操作预期；CHAT 新增；**不以构造 source_controls 行作为验收**；A/B 查询/上下文/列表/重启结果；残留按真实规则记录 | 真实 SQLite/chat/面板；不改生产删除规则造残留；不称人类体验 |
| CT-009 | 001 的 pending 或 CT-002 的临时；聊天请求已发出并延迟响应 | 在途期间通过公开 correct/delete 改变临时/长期 | 在途请求 stale 或无成功 assistant；不写回旧结果；后续上下文无旧临时 | MEM 仅公开变更；CHAT 第一条 user 保留、request stale、无成功 assistant | 延迟 HTTP fixture |
| CT-010 | 002 的 pending；用 trigger 使临时写入失败 | 回答“就今天”；修复 trigger 后同 request retry；另在 retry 前通过公开 correct 改变目标或跨日 | 首次 failed `CORRECT_TIME_SELECTION_FAILED`、零写、标记保留；正常 retry 成功且只执行一次；目标变化/跨日 retry 返回 expired，零写；重启无快照亦 expired | MEM 首次零写、成功后预期；CHAT 不重复 user/assistant；关系 1 | trigger/公开 correct/可控时钟/真实重开；不改 Expected |
| CT-011 | 旧 4 段临时来源；新 5 段有效来源（A direct + B copy）；损坏 5 段（非 chat/空段/多余段）；把时间段改成原正文消息 ID、跨会话“就今天”消息、问句/不支持时间、错误到期日；面板 edit 来源 | 读取 source-context、公开 search/buildContext、重开 | 旧格式兼容；新格式重开仍有效；原正文/“就今天”语义/同会话同角色/同日/到期任一不符均 unavailable；损坏 time 段不得凭 message ID 推断今日授权；有效读不返回；列表 `effective:false`；不崩溃；copy 继承 origin 时间来源且 attribution 不变；edit 保留来源与时间链但正文不称聊天原话；降级旧代码只作边界记录 | source-context status、MEM/FTS 有效检索结果、列表标记；无新增写 | 真实 SQLite；协议级 fixture；不宣称降级完全安全 |

## 4. 验证、未覆盖与待 master 决定

**实际执行（收口后）**：旧生产基线 `evidence/s03p-temporal-clarification/attempt-20261028-010348-baseline-headprod/`（根目录，未搬），chat 26/8 pass/18 fail/exit 1、semantic 12/0 pass/12 fail/exit 1，6 生产 SHA 与 HEAD 一致（master 已核）。收口 focused：#1 `attempt-20261028-011400-close1-chat` 26/26、exit 0；#2 `attempt-20261028-011415-close2-semantic` 12/12、exit 0。回归 `attempt-20261028-011426-close3-regression`：chat 100/100、semantic 138/138、corrected-source 99/99、source-context 6/6、relation-protocol 10/10，均 exit 0、0 skip。**审查补测** `attempt-20261028-012111-coverage`：chat 101/101、semantic 141/141，均 exit 0、0 skip；CT-003 different/uncertain、CT-008 B/重启、CT-010c 跨日重试、CT-011 同会话无效/空段/重开已补；测试新增 +216。GUI 用例已写但**未运行**（NOT_COVERED，待 master 接管）；真实模型/live、人类体验未覆盖。master 独立复验前不写 PASS。

待 master 决定：1) 修复缺陷+授权行+最小去重后，是否继续同一批，或把 B3 在途/重试拆批；2) 是否接受把纯时间回答解析/`endOfLocalDay` 下沉以消除 source→chat 直连倒置；3) 面板 `effective` 标签由 GUI 任务接入的时间点；4) 关系协议显式 `timeAuthorization` 仍另批（需 bump `SOURCE_POLICY_VERSION`）。
