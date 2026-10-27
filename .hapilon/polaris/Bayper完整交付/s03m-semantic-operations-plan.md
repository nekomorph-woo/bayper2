# S03m 显式纠正/忘记的语义核验最小纵向切片（v1）

2026-10-27，master 受托确认 POL-SEMOP-001～008 v1 及 Part A/B（不是用户亲自确认）。两阶段：阶段 1 本地已完成；阶段 2 系统核验独立候选，合格关联/操作在第二事务原子。阶段 2 失败不回滚阶段 1；只更新同一条 assistant 消息，不追加第二条。自动整理/定向共享/完整召回仍后续承接。本文件已并入 r3 审查的三处接口修正：关联后事务内版本重读、correct temporary 路径（最终以 §12 r3 为准）、corrected_v2 来源归属与 isCurrent。首批已按 §8 收口：master 19 套件 185/185 受托接受来源追溯与协议的已测有限能力；2a 长期 correct 两阶段的确定性业务流程亦已由 master 独立 28/28、0 skipped、exit 0 与 GUI 14/14 受托接受为**已测有限能力**。008 聚合仍 NOT_COVERED（部分已验）；2b 已提交为 `27ad18d`/`0.1.191`；2c-1 后续已实施并由 master 独立 20 套件 295/295 受托接受为已测领域/真实 chat 构造 HTTP 有限范围，2c-2 未实施。

## 1. 实际契约与调查事实（实施前时点，非现状）

> 本节记录 2a/2b/2c 实施前的调查基线；`associateFacts` 无 `inTransaction`、`memorySourceContext` 只接受直接来源等描述已被后续实现改变。现状以 §11/§12 与 state 为准。

- `chat.cjs` 的 `sendMessage` 当前等完整请求返回；renderer `chat-panel.js` 在 `handleResult` 后 `refreshConversation`，没有聊天轮询。`preload.cjs` 已有 `onChatClosed`/`onMemoryChanged` 事件；`main.cjs` 用 `webContents.send` 推送。
- `chat_requests` 有 status/context_version/assistant_message_id 等，无 verification 字段；`chat-store.cjs` 无消息正文更新接口。`cancelRequest` 只处理 pending；`closeConversation` 取消该会话 pending；`dispose` 取消全部 pending 并 `Promise.allSettled(inFlight)`；启动 `recoverInterruptedRequests` 只转 pending。
- `memory.correct`/`forget`/`relay`/`share` 均支持 `inTransaction`；`associateFacts` 固定 `store.transaction(applyAssociation)`（`app/memory.cjs:1345`），**无 `inTransaction`**。关联内部会重读条目、身份、来源/删除控制。
- `memorySourceContext.resolve` 只接受直接 `chat:<messageId>`，返回固定字段并以 `digestOf` 校验；`normalizeSourceContext` 要求 `excerpt===text`、`sourceMessage.content.includes(excerpt)`、`characterId===holderCharacterId`。纠正来源 `chat-correct:`、传播副本 `corrected:` 当前均不可用；这与 `direct=false` 的实际传播语义冲突。
- `memory-relation-protocol.cjs` 导出仅 4 个符号，旧测试断言 `POLICY_VERSION="s03l-grounded-relation-v1"`；不能改导出或旧值。`quoteSourcesOf` 当前取 text/utterance/context，`incompleteReasons` 以 utterance 判断自足。
- 关系协议仍只在工具中使用；source-live 06/11、holdout 11/12 与 SEM 5 FAIL 保留；引用存在不等于主体解释正确。

## 2. 业务规则

### 2.1 阶段 1：本地先完成

- 只有明确 correct/forget 且本地唯一定位目标后，才在内存捕获：目标旧正文、目标 identity、按 scope 允许的独立候选（self 仅当前角色；all 才含其他角色）、候选 identity 成员/版本/来源快照。候选仅内存，不写新表/审计/待办/正文副本；候选正文只在阶段 2 实际提交时写入其持有者，不进入 A 的回复/上下文，不复制 B 私聊。
- 第一事务提交：已知 identity 组纠正/删除、本地结果与 assistant 消息、request 完成、无正文 `operation_proof`、`verification_status`。阶段 1 不等待网络；sendMessage 在阶段 1 后即可返回。
- `operation_proof` 只存 action/scope/锚 entry/identity/结果版本或控制哈希/本地计数，不存正文。correct 证明锚条目仍存在、版本/正文/identity 未变；forget 不要求已删锚存在，证明 identity 删除控制、来源控制、删除指纹仍在。
- 阶段 1 前取消 → 零写；阶段 1 后取消 → 只停阶段 2，保留本地完成事实；重启 pending 核验 → `interrupted`，不重试、不回滚。
- 用户文案只写本地结果与可操作澄清，不出现 retrieved/truncated 等技术名词；统计只作内部证据。

### 2.2 阶段 2：独立候选

- 最多一次关系请求/操作、无重试、15s、与聊天共用取消；不占自动活动预算；普通聊天与每角色均不调用。候选以**旧事实**检索；记录实际 retrieved/eligible/unavailable/truncated，截断只说明达到检索上限，不宣称知道全部同义；全库无候选≠全库无同义。
- 排除同 identity、派生/转告/分享、过期、来源受限、主题/推断等不可关联项；同文/同 factKey 只召回，绝不直接关联。按 identity 去重，候选已有同 identity 只处理一次。
- 执行门为保守门，不称语义证明：`effectiveRelation=equivalent`、主体非 null/一致、scope 已知/一致、event 时间一致、来源世界一致；`contextIncomplete` 只在主体/时间确需缺失前文时降级，自足命题不因布尔值误拒。
- **correct 阶段 2（长期）**：事务前重核外部快照与 operation_proof。事务内依次对合格候选 identity 执行 `associateFacts(inTransaction)`；关联会递增锚与成员 version、可能更换 canonical identity，因此**每轮关联后重新读取事务内当前锚与成员版本/identity**，用当前版本调用窄接口，不使用关联前 expectedVersion。锚“不变”仅指正文/来源不重复 correct，不否认 association 必要的版本递增。任一候选关联失败整笔回滚阶段 2，不保留任何关联。
- **correct temporary**：以 §12 r3 为准（master 2026-10-27 受托批准 2c-1/2c-2 方向，不是用户亲自确认）。阶段 1 同事务更新 initiator current 及已证明同一 T/长期 identity 的已知持有者，长期不动；阶段 2 只对独立同义候选一次核验后建/更新 current，不合并长期 identity，不新增未知角色。来源用 §12 A2 的 direct/copy/relay/edit 及 holderAnchor 体系，到期失效；旧“仅当前角色 `.current`/单一 `chat-current:`”描述已由 §12 取代。
- **forget 阶段 2**：不关联已删锚；对每个去重后的合格候选 identity 直接执行 `forget`。self 只处理原角色自己持有的候选（`scope='self'`，不跨角色删除）；默认 all 才处理其他持有者（`scope='all'`）。多个候选同一第二事务，任一失败整笔回滚阶段 2。
- 候选版本/来源/成员变化 → 该候选未确认；不报告全局成功。阶段 2 失败/取消/重启 → 只把同一 assistant 消息原位更新为“本地已完成；其他相近内容未继续核验”，阶段 1 数据保留。阶段 2 成功同样只原位更新该消息，不追加第二条。
- 最小澄清直接说明具体事实，例如“如果你也想把另一条关于咖啡的内容一起处理，请直接告诉我它的说法”，不加按钮、不加待办。

### 2.3 来源追溯（008 必需）

- 保留 `chat-correct:` 前缀与旧测试；解析内嵌 `chat:<messageId>`，核对角色、会话、消息 source_id、role=user、来源版本与正文证据。**不改 correct 既有正文/分句行为**。
- 纠正正文可能由规范化分句拼接，不要求连续子串；来源证据用有限 `segments/offsets`（复用现有纠正提取逻辑重算），每段必须是原话实际片段，按生产 join("，") 逐字重建 `memory.body`（不删除 C++/C、小数、负号等词内符号）。不得假称拼接内容是连续原话，也不额外持久化正文；segments 只是内存证据，含原话。
- `corrected_v2` 明确区分：`sourceAnchorEntryId`/`sourceAnchorVersion`/`sourceAnchorIdentityId`（来源锚）、`sourceCharacterId`（说出原话的角色）、`holderCharacterId`（持有条目的角色）、`entryId`（被核验条目）。`isCurrent` 必须以 `holderCharacterId + entryId` 定位并重解析，不能用来源角色去读持有者条目；digest 覆盖锚 identity/版本/segments/消息内容/持有者/条目版本。
- 传播副本沿 identity/关系**实际核验**到当前 `chat-correct:` 锚；可由 derivation 或 relation edge/同一已证明 identity 证明，不能仅凭 sourceCharacterId≠holderCharacterId 推断派生。`direct=false`、`via="identity_correction"`；来源角色与持有角色相同也可为派生，需按关系判断，不冒充直接告知。
- 临时来源以 §12 A2 为准：direct `chat-current:`、copy/relay `chat-current-copy:`、edit `temporary-edit:`；解析 origin/holder anchor、`expiresAt` 与证据；到期 unavailable，长期条目不受影响。外部来源仍 unsupported 边界。
- 旧来源删除/权限控制/消息变更/锚版本变化 → `isCurrent=false`；不另行持久化正文副本。

### 2.4 主体、删除与权限

- 来源角色/持有角色/direct/via 是系统核验 metadata，不是事实主体；prompt 明确要求主体只按正文与引用判断。
- 删除沿用无正文控制；旧来源重扫、别名重学、relay/share 不得回流。不同主体完全同文无法由正文指纹自动区分：自动重扫一律阻断；只有用户明确新陈述+新来源+显式同意可新建，旧来源仍阻断；不写无法证明的自动区分。

## 3. Case v1（master 受托确认；8 组含子项，008/005/006 为 P0）

### POL-SEMOP-001 correct 正链路
- **001a**：A 直接持有；B 不同 factKey、同义词独立持有；C 未知。阶段 1 先提交 A 的 identity 组；阶段 2 命中 B 并关联/更正；C 不变；同一 assistant 消息原位更新。
- **001b 隔离**：A prompt/回复不含 B 独有私聊或来源上下文标记；同义正文偶然重合不单独判违规。
- **001c 传播语义**：B 新正文来源为 `corrected:`，`direct=false`，不写 B 的 chat 来源、不冒充直接告知；A 不新增正文副本。
- **001d 临时纠正**：用户明确说“今天只想喝茶”；长期偏好与历史经历保留；A/B 只产生当日到期的当前理解，不合并长期/临时 identity，不新增未知角色；`chat-current` 来源可核验；隔日 `isCurrent=false` 且当前理解不再进入检索。“最近”等范围不明确的表达沿用既有澄清规则，不擅自解释为仅今天有效。
- **Oracle**：真实 entries/identity/edges/versions/expires/context_versions、两条 HTTP body、assistant 内容与时间。
- **Boundary**：构造模型输出；不证明真实语义。

### POL-SEMOP-002 forget 范围与澄清
- **002a all**：候选跨角色，按 identity 去重，每个候选 identity 只 forget 一次；所有已有持有者清除。
- **002b self**：只处理原角色自己持有的独立候选；其他角色持有者一个不删；不跨角色。
- **002c 未确认**：来源不可用/uncertain/截断不处理；用户文案直接说明具体事实与下一步，不出现技术计数；不称“全部”。
- **Oracle**：逐角色 entries/FTS/控制/版本、request 状态、同一 assistant 内容。
- **Boundary**：只证明构造候选集，不证明全库召回。

### POL-SEMOP-003 提前返回、原位更新与取消/重启
- **003a**：存在候选时 sendMessage 在阶段 1 后返回，renderer 立即显示阶段 1 回复；阶段 2 完成后事件刷新，同一 assistant 消息内容更新，不新增第二条。
- **003b**：阶段 1 前取消零写；阶段 1 后取消只停阶段 2，本地数据/回复保留。
- **003c**：dispose、closeConversation、系统暂停、重启分别取消/中断 pending 核验；无重试；本地事实保留；消息更新为本地完成文本。
- **Oracle**：main/preload/renderer 事件、request 字段、assistant 数量/内容、逐表快照、重开。
- **Boundary**：最小 renderer/IPC 接线 + 专属 GUI；不做页面重设计。

### POL-SEMOP-004 证明、版本与阶段 2 原子性
- **004a correct**：锚在阶段 1 后被改/删 → `stale`，阶段 2 零写；forget 锚不存在是正常，按控制证明。
- **004b**：候选成员/版本/来源变化 → 未确认；不报告成功。
- **004c**：阶段 2 关联或消息更新故障 → 整笔回滚阶段 2，阶段 1 保留；消息回本地完成文本；无半条边/控制/正文。
- **004d 多候选连合**：两个独立候选 identity 依次关联；每轮关联后锚与成员 version 递增、canonical identity 可能变化；必须用事务内当前版本更新，最终 proof 记录最终版本；第二个候选故障时两个关联均回滚，不保留任何合并。
- **Oracle**：operation_proof、verification_status、逐表前后快照、消息内容、重开。

### POL-SEMOP-005 主体、时间、权限（P0）
- **005a 负例**：同文不同主体、同 factKey 不同来源、同主体不同时间、否定翻转、参与者不完整 → 本地门 uncertain，不关联。
- **005b 正对照**：真正等价 → 可关联，证明未整体禁操作。
- **005c**：`contextIncomplete` 仅在主体/时间依赖缺失前文时降级；自足命题不误拒。
- **005d 权限**：来源控制/删除控制/过期/主题/推断拒绝关联；外部来源 unsupported；不绕过 association 权限。
- **Oracle**：effectiveRelation/reasons、edges/identity/versions、回复范围。

### POL-SEMOP-006 请求、预算与取消（P0）
- **006a**：仅存在独立候选时最多 1 次核验，无重试、15s；无候选/普通聊天/每角色 0 次；automatic_budget 不新增。
- **006b**：超时/网络失败/取消不写阶段 2；阶段 1 保留并如实更新消息；不无限调 prompt。
- **Oracle**：HTTP 计数/顺序/耗时、预算表、request 状态、消息内容。

### POL-SEMOP-007 删除、别名、防回流
- **007a**：自动重扫旧源、旧别名重学、relay/share 全部阻断；控制无正文。
- **007b**：不同主体同文不被自动区分；用户明确新陈述+新来源+显式同意可新建；旧来源仍阻断。
- **007c**：重启/重开后控制仍有效；无隐藏审计正文。
- **Oracle**：entries/FTS/controls/aliases/derivations、重扫返回值、显式同意路径。

### POL-SEMOP-008 纠正来源追溯（P0）
- **008a 直接纠正**：解析 `chat-correct:` 内嵌消息与 segments；直接连续原话与多分句两种形态都验；每段原文存在，按生产 join 逐字重建 body；不要求连续子串、不改 correct 正文。
- **008b 传播副本**：沿 identity/关系实际核验到当前锚，`direct=false`/`via=identity_correction`；来源角色≠持有角色合法，来源角色=持有者也可能是派生；旧 `chat-correct:` 断言不变。
- **008c 失效**：旧来源删除/权限/消息变更/锚版本变化 → isCurrent=false；`chat-current` 临时来源真实可核验且到期失效；外部 unsupported 仅边界。
- **Oracle**：snapshot 的 `sourceAnchorEntryId/Version/IdentityId`、`sourceCharacterId`、`holderCharacterId`、segments/offsets、message/entry/version、isCurrent、关系 pair 输入。

## 4. Part A：接口与实现顺序

### 4.1 数据与状态

- `chat_requests` 增：`operation_proof TEXT`、`verification_status TEXT NOT NULL DEFAULT 'none'`（none/pending/completed/cancelled/failed/interrupted/stale）。旧库 `ALTER TABLE` 兼容；不建队列表。
- `chat-store.cjs`：读写上述字段；`updateMessageContent(id, content)`；`listPendingVerifications()`；`recoverInterruptedVerifications(at)`；`cancelVerifications(conversationId, at)`。
- `chat.cjs`：`verifications` Map（requestId → {promise, controller}，与 `inFlight` 同类的在途跟踪，不是队列）；`onVerificationSettled({requestId, characterId, conversationId, status})` 回调；`sendMessage` 阶段 1 返回；阶段 2 后台执行；`cancelRequest`/`closeConversation`/`dispose`/recover 全部接入。
- `main.cjs`/`preload.cjs`/`renderer/chat-panel.js`：send 返回 pending 时保留 `chat.requestId`；复用既有 `bayper:memory-changed` 事件并带 `kind:"chat-updated"`，不新增 preload API；renderer 只对当前会话 `refreshConversation` 并恢复模式；不新增页面。

### 4.2 来源快照接口（兼容旧直接来源）

`memorySourceContext.resolve` 返回两种形状：

- **direct_v1（旧形状不变）**：`status, characterId, holderCharacterId, speaker, entryId, entryVersion, sourceId, sourceVersion, contextVersion, sourceCreatedAt, excerpt, sourceMessage, messages, contextIncomplete, digest`；`characterId===holderCharacterId`。
- **corrected_v2（新增）**：上述字段 + `format:"corrected_v2"`、`sourceAnchorEntryId`、`sourceAnchorVersion`、`sourceAnchorIdentityId`、`sourceCharacterId`、`holderCharacterId`、`direct`、`via`、`segments:[{messageId,start,end,text}]`。直接纠正：`direct=true`、`via="corrected_chat"`、source/holder 可相同。传播副本：`direct=false`、`via="identity_correction"`，source/holder 可不同也可相同，但必须由 derivation/relation edge/同一已证明 identity 支撑，不能只凭角色不同推断。
- `isCurrent(snapshot)` 先用 snapshot 自身字段重算 digest，再以 `holderCharacterId + entryId` 调用 `resolve`；比较 `sourceAnchorEntryId/Version/IdentityId`、segments、source 消息内容、entry/context 版本与来源控制；任一变化 false。不得用 `sourceCharacterId` 读持有者条目。
- segments 由复用现有纠正提取逻辑的纯函数重算（如 `locateCorrectionSegments({userText, body})`），不额外持久化正文；只接受与生产 `correctionBody` 的 `join("，")` 逐字一致的重建，不删词内标点（C++/C、C#/C、小数、负号）。同一 body 有多个匹配位置或重复命题时视为歧义 → unavailable，不取第一个。
- 解析 `chat-correct:`/`corrected:` 内嵌 revision 时必须为安全正整数且不超过当前 entry.version；未来或溢出拒绝。association 递增版本后，较早的历史 revision 仍可解析。
- 传播副本通过 `factIdentityId` 找唯一当前 `chat-correct:` 锚，并核验 derivation/relation edge 或同一 identity；多个/缺失/关系不成立 → unavailable。临时来源（`chat-current:`/copy/relay/edit）按 §12 A2 解析，到期 unavailable；外部来源仍 unsupported。

### 4.3 关系协议兼容

- 不增导出、不改 `POLICY_VERSION`。`normalizeSourceContext` 分支：
  - 无 `format`：旧 direct 校验完全不变。
  - `corrected_v2`：要求 `sourceAnchorEntryId/Version/IdentityId`、`sourceCharacterId`、`holderCharacterId`、`direct` 布尔、`via` 枚举、`segments` 非空有界；每段为 sourceMessage 的实际 slice、messageId 匹配；按生产 join("，") 逐字重建 excerpt；不删除词内标点；`direct=false` 时要求 `via=identity_correction`，并由调用方/快照提供 derivation/relation/identity 证明，不要求来源角色≠持有角色；`holder===holderCharacterId`。
- `quoteSourcesOf`：direct 保持 text/utterance/context；corrected 只能取单个实际 segment 或单条实际保留前文，不把 canonical `text`（拼接正文）或完整 utterance 当作连续原话；跨片段拼接的引用必须拒绝。
- `incompleteReasons`：corrected 的自足判断只看 segments；prompt 增“segments 是分离原话片段，不得拼接；direct=false 表示经 identity 传播，不是接收者被直接告知；来源角色/持有角色/direct/via 是 metadata，不是主体”。
- 旧 direct 快照与旧协议测试不变；新增分支测试。

### 4.4 记忆内部窄接口

- `associateFacts` 增 `inTransaction`（省略时行为不变）。
- `verifyOperationProof({action, scope, anchor, identityId, expectedVersion|controlHashes, nowMs})`：只读，correct 核条目/正文/identity；forget 核 identity/source/deleted 控制。
- `listIdentityEntries(identityId)`：只读，供候选去重/成员版本捕获。
- `applyConfirmedCorrectionToIdentityMembers({anchorEntryId, memberEntryIds, nowMs, inTransaction})`：仅内核验层调用；在事务内**重新读取当前锚与成员**（不接收关联前 expectedVersion），要求同一 identity、锚正文/信任/时效未变、成员仍存在且非锚、来源未被控制；只更新成员：body/trust/expiry 取当前锚，sourceKind=user，sourceId=`corrected:<member>:<currentVersion+1>`，sourceVersion=1，version+1，FTS/别名/旧来源控制；不碰锚、不接收调用者正文/来源。返回 affected/contextVersions/finalVersions。
- `applyLocalTemporaryUnderstanding`/`applyConfirmedTemporaryCorrectionToHolders` 以 §12 A1/A3/A4 为准：随机 T、initiator/已知 holder/独立候选、copy/relay/edit 来源与 holderAnchor；不合并长期 identity，不新增未知角色，不用旧 `chat-current:<targetEntryId>` 公式；返回 finalVersions/sourceControls/contextVersions。
- `forget` 继续用现有接口；阶段 2 按候选 identity 去重后调用，self/all 由操作 scope 决定。
- `verifyOperationProof` 对 temporary 使用 §12 A4 的 current/T/contextVersion/expiresAt 证明，不把长期锚当临时证明，也不沿用旧单 source 公式。

### 4.5 阶段 2 correct 具体步骤

1. 事务前：读 operation_proof，`verifyOperationProof` 锚有效；重解析候选来源快照，记录外部观察版本；任一用户侧变化 → 未确认。
2. 事务内：按候选 identity 去重，逐个 `associateFacts({left:当前锚,right:候选代表,inTransaction:true})`；每轮后重新读取当前锚与成员 version/identity，用事务内当前版本继续，不使用关联前版本。
3. 全部关联成功后，以当前锚 entryId 与候选成员 entryIds 调用 `applyConfirmedCorrectionToIdentityMembers`；只更新候选，锚正文/来源不重复 correct，无第二 chat-correct，不误标 B 直接告知。
4. 同一事务更新 assistant 消息为最终范围、verification_status/result，proof 记录最终锚/成员版本；提交。任何失败回滚阶段 2（含所有关联），消息回本地完成文本。临时纠正走 4.7。

### 4.6 阶段 2 forget 步骤

1. proof 核锚控制；候选按 identity 去重，重读代表版本/来源。
2. 第二事务内逐个候选 identity 调 `forget`：self 仅原角色条目，all 清除全部持有者；不要求锚存在。
3. 同一事务更新 assistant 消息与状态；失败回滚阶段 2。

### 4.7 阶段 2 temporary 步骤

1. 按 §12 r3 A1/A3：阶段 1 已创建/更新 initiator current 与 T/已知 holder 的 current，长期不动；proof 记录 T、current/长期锚、`expiresAt`、contextVersionsAfterLocal/sourceControlsAfterLocal。
2. 阶段 2 只对独立同义候选一次核验后调用 `applyConfirmedTemporaryCorrectionToHolders`；不关联长期 identity，不改长期条目，不新增未知角色；候选不按 holder 整组跳过。
3. 同一事务更新 assistant 消息与 verification_status；失败回滚阶段 2。到期后来源/当前理解不可用，长期偏好恢复。来源与 holder 作用域按 §12 A2。

## 5. Part B：验收计划

- **B1 确定性**：真实 `createStore`/`chat.sendMessage`/SQLite + 本机 HTTP；覆盖 001～008 全部子项，含 001d 临时到期/隔日、004d 多候选连合、008 连续原话与多分句；003 走最小 renderer/IPC + 专属 GUI（阶段 1 先显示、阶段 2 原位刷新、取消/关闭/重启）。所有 request/proof/status/消息/逐表断言独立。
- **B2 L1**：构造聊天 envelope，关系真实 DeepSeek；**B2 L2**：真实 chat + 真实 DeepSeek 全链。两者都执行，凭据已有授权，master 安排；1 次/操作、无重试、15s。负例含 A/B 同一句“我”、旧 06/11、同主体不同时间、否定、参与者不完整；正例含不同 factKey 同义。Expected 不发送、不修改。
- L2 falseMerge 必须 0；未匹配正例如实 FAIL。最多两轮有依据调整（候选/证据/门），无收益保留失败并换方案，不无限调 prompt。构造数据全绿也不称语义完成；候选召回提升另列后续。

## 6. 三个最小实施批次（每批独立验收，不冒充父级完成）

1. **来源追溯与协议兼容（首批）**：source-context corrected_v2/segments/传播追溯/`chat-current`、关系协议兼容分支、`locateCorrectionSegments` 与只读来源核验；先写失败测试，覆盖 008a/b/c 全部子项及旧 direct 兼容；不先造未使用的 request 状态字段。已有来源问题具备真实入口，可独立验证。
2. **真实两阶段 correct+forget（含 temporary）**：request 字段/迁移、消息原地更新、阶段 1/2、proof、scope self/all、cancel/dispose/close/recover、sendMessage 提前返回、main/preload/renderer 最小事件；覆盖 001/002/003/004/005d/006/007 与专属 GUI；本批才接入状态字段。
3. **真实模型 + GUI 联合**：L1/L2、正负对照、falseMerge 门禁、真实窗口阶段 1 显示与阶段 2 原位刷新；005/008 P0 纳入；temporary 以 §12 r3 为准；不宣称 S03/语义完成。

## 7. 回归、阻塞与待决

- 回归：`chat-memory-operations`、`chat-exclusive`、`chat.spec`、`memory-source-context`、`memory-relation-protocol`、`memory-association`、`memory.spec`、`memory-sharing/exclusive/relay`、现有 18 套件及 GUI 聊天套件。旧 Expected/前缀/直接快照不变；新增字段与 `ALTER TABLE` 需旧库验证。
- 阻塞：无正文 `operation_proof` 的 forget 控制哈希需在实现时定具体列；阶段 2 后台 promise 的 renderer 刷新需最小事件接线，尚无现有聊天轮询；`chat-current` 与 corrected_v2 需同时兼容旧 direct；关系协议 corrected 分支需避免旧 direct 行为变化。
- 已受托解决：阶段 2 any failure 整笔回滚、不保留关联；self/all 范围；临时纠正路径；多候选连合版本重读；最小澄清用具体事实。剩余仅实现细节与 L2 两轮停止条件，不再改业务 Expected。

## 8. 首批收口与下一批（2026-10-27）

- master 独立运行 **19 套件 185/185 PASS、0 skipped、exit 0**，before/after SHA 一致，证据 `evidence/master-corrected-source-TxA5THg1/`；受托接受首批来源追溯与协议的**已测有限能力**，不是用户亲自确认，不代表 S03m/S03 完成。
- **008 聚合仍 NOT_COVERED（部分已验）**：已验 008a 连续/多分句、C++/C 逐字、重复歧义；008b 真实 relay 传播副本、锚版本/删除/正文/歧义/权限、revision 历史/未来/溢出；segments/digest 篡改、消息变动、旧 direct、跨片段引用；008c 当日到期与伪造跨角色 current。
- 未覆盖：同角色派生实际路径、真实 association 后刷新（当前仅 SQL 增 version 兼容）、真实模型 L1/L2、跨角色临时传播、GUI。15 项全绿不等于 008 全部承诺通过。
- 2a 收口：master 独立新 Runner **28/28 PASS、0 skipped、exit 0**、前后 SHA 稳定，证据 `evidence/master-two-stage-closing-3k2ldAMG/`；逐文件比较先前 `master-two-stage-core-LUvtGeld` after SHA，生产文件与 19 旧套件未变，仅新 Runner 变化，故先前 20 套件 212/212 与 GUI 14/14 仍适用于其已测源码范围。受托接受 2a 确定性业务流程的**已测有限能力**，不是用户亲自确认，不是真实模型语义通过，也不是人类体验。
- 聚合 POL-SEMOP-001～008 仍 NOT_COVERED：002 forget、001d temporary、真实模型 L1/L2、跨角色临时传播、完整产品级 GUI 生命周期未覆盖。下一批 2b 推进 forget/temporary 与真实模型/GUI 全链。本批只做文档与版本收口，VERSION `0.1.189` 待 master snap。

## 9. 第 2 批拆分 2a/2b（master 受托决定，2026-10-27）

为避免一次大批代码，第 2 批拆为两个最小纵向切片；2a 只做长期 correct，2b 再做 forget/temporary。现有本地 forget/temporary 功能保持，不因 2a 退化。

- **2a（已受托接受已测有限能力）**：长期 `correct` 两阶段。阶段 0 仅内存捕获旧事实、目标 identity 与独立候选（3/角色、总 8）；阶段 1 同事务本地 correct/assistant/request/无正文 proof，`sendMessage` 提前返回；最多一次系统核验（15s、无重试、不占自动预算）；阶段 2 在同一事务逐个 `associateFacts(inTransaction)`，每轮重读当前锚/成员 version/identity，再用窄接口只更新候选成员；任何失败整笔回滚阶段 2，保留阶段 1；同一 assistant 原位更新；cancel/close/dispose/暂停/重启中断；`onVerificationSettled`→既有 `bayper:memory-changed`（kind=chat-updated）→当前会话刷新。
- **2b（下一批）**：`forget` 的候选自身 identity 删除、`temporary` 的到期当前理解传播（最终以 §12 r3 为准）、对应来源/权限/版本语义、真实模型 L1/L2 与 GUI 全链；不在 2a 提前铺字段或实现。
- **2a Case 映射**：001a correct 正链路、001b 隔离、001c 传播来源；003a 提前返回/单消息、003b 提交前取消/阶段 1 后取消、003c dispose/close/暂停/重启；004a correct 锚失效、004b 候选变化、004c 阶段 2 故障回滚、004d 多候选连合；005a/b/c/d 主体/时间/权限正负；006a/b 请求频率/超时/取消；008 同角色派生实际路径与真实 association 后来源重解析。002、001d、004a 的 forget 部分留给 2b。Case 聚合不因 2a 子项通过而标整组 PASS。

### 9.1 2a 旧事实证据复核（master 中途审查修正）

- 阶段 2 的模型输入必须是阶段 0 捕获的 A 旧事实 snapshot 与 B 旧事实 snapshot；阶段 1 的新正文只用于 proof 核对当前纠正结果，不能冒充旧事实。
- 旧 target snapshot 在阶段 1 correct 后 entry version/source 必然变化，不能直接要求 `isCurrent`。新增窄检查只核对不应由本操作改变的证据：原 chat 消息与有限前文内容/归属/时间未变、segments 仍逐字可重算、来源控制集合等于阶段 0 捕获集合加上本操作新增的旧 source 哈希；不提供通用“忽略权限”开关。无法证明则本地完成并标注未核验。
- 候选证据捕获整组成员 entryId/version/sourceId、每成员 source snapshot 与来源控制集合，并记录阶段 1 对每个 holder 的确切旧 source 增量；重核时只容许该增量，其他后续控制变化拒绝。第一关联前重核代表、全部成员、消息/context 与权限；凭据返回后、发送核验前再次复核并剔除失效候选，全部失效则不发 HTTP。网络等待期间任一变化 → 该候选未确认，不应用旧结果。
- 同角色 identity 的非锚成员来源必须是 `corrected:`、`direct=false`、`via=identity_correction`，sourceAnchor 指向发起条目的 chat-correct 锚；仅选中 held 条目为直接来源。旧版 `chat-correct` 指向其他 id 时按同身份同正文、旧锚存在/stated/user/未过期/实际 source 一致兼容，不再冒充直接告知。
- 证据复核同时核对原 chat 消息的 conversationId 与 `chat:<id>` 来源归属；候选仍 fresh 时优先用 `isCurrent`，只有阶段 1 造成的必要变化才走窄证据检查。

## 10. 2b forget 切片实现约定（master 受托确认 Part A/B，2026-10-27）

HEAD `88ff9c7`（VERSION `0.1.189`，已由 master snap）。master 已受托审核并确认本节 Part A/B（不是用户亲自确认）；本批只做文档与版本 `0.1.190` 收口，下一次才实施 forget。temporary 随后沿用本计划，不并入本切片，也不减少其范围。本轮未写代码/测试、未运行测试或真实模型，以下为已确认的实现约定，不是验收结果。

### 10.1 范围、触发与阶段 0 捕获

- 只对 `action="forget"` 且 `target.entry` 存在的聊天操作启用两阶段；scope 仍只取用户本轮原话（`intent.scope`），模型返回值不授权。correct/temporary 行为不变。
- 阶段 1 删除前（阶段 0）在内存捕获：目标旧 fact 的 `memorySourceContext.resolve` 快照、目标 identity 全部成员（entryId/characterId/version/sourceId）、按 scope 允许的候选 identity。self 的候选检索持有者仅当前角色；all 为全部已结识角色。
- 候选代表必须是可直接核验的用户来源（`snapshot.status==="ok"`、`direct!==false`）；排除与锚同 identity、代表为派生、过期、推断/主题、来源受限、纯派生 identity。纯派生 identity 不因“看起来同义”进入 all。
- forget 模式下候选整组成员必须捕获并重核 `entryId/characterId/version/sourceId` 与来源控制；成员快照可解析则记录并核验，不要求每个派生成员都有来源快照。2a correct 的“全部成员必须有快照”保持不变，不放宽。
- 候选仍为每角色最多 3、总 8、按 identity 去重；达到上限只记录 truncated，不宣称知道全部同义。

### 10.2 无正文 operation_proof 具体列

不新建表，继续用 `chat_requests.operation_proof TEXT`。forget 阶段 1 在存在候选、进入 `pending` 时写 JSON：

```json
{
  "version": 2,
  "action": "forget",
  "scope": "self|all",
  "anchorEntryId": "...",
  "anchorIdentityId": "...",
  "deletedEntryIds": ["..."],
  "retainedEntries": [{ "entryId": "...", "characterId": "...", "version": 2, "sourceIdHash": "..." }],
  "deletedCount": 2,
  "sourceControls": { "a": ["<sourceId sha256>"], "b": ["..."] },
  "identityControls": { "a": "<identityId>" },
  "deletedFingerprints": { "a": ["<strictFactFingerprint>"] },
  "commandSourceHash": "<userSourceId sha256>",
  "initiatorCharacterId": "a",
  "initiatorContextVersion": 12
}
```

- 只存 id、版本、哈希、计数；不存正文、excerpt、原始 sourceId。删除指纹沿用 `strictFactFingerprint` 的既有哈希，不新增正文副本。
- `sourceControls` 是本次操作覆盖的来源控制键集合，可能包含阶段 1 之前已存在的控制；按集合语义取并集，不把“已被覆盖”误写成“必然新插入”。`commandSourceHash` 同时包含在 `sourceControls[a]`，单独列只为便于核对。
- self 的 `retainedEntries` 记录目标 identity 中未删除的其他持有者成员；all 为空。用于证明“应保留的未被误删”，也用于识别后续新写入。
- **proof 仅在存在候选、`verification_status` 进入 `pending` 时持久化**；没有阶段 2 工作时不写持久 proof，保持最小。`memory.forget` 仍返回内存中的 `controlProof`，调用方按需使用，不落库。
- `initiatorContextVersion` 是阶段 1 事务结束时发起角色 A 的 `memory.getContextVersion(A)`；阶段 2 在发送核验前、凭据返回后、事务首删前分别与当前值比较，任一不等即 `stale`。这样用户以新来源+明确同意新建**新的 identity** 时也会递增 A 的 contextVersion，旧 forget 不会继续删除候选；只比较发起角色，不把无关角色全部上下文纳入 stale 判断。
- 阶段 2 完成后在同一 JSON 追加 `verification`、`candidateIdentityIds`、每 identity 的删除计数与 `contextVersions`，仍不写正文。
- correct 的既有 proof 形状与写入时机不变；2b 不回头改造 2a 已验收路径。

### 10.3 最小接口

- `memory.forget(...)` 返回值新增 `controlProof`（上述无正文结构，按实际删除条目计算），既有字段与行为不变。进入 pending 时，阶段 1 直接持久化实际返回值，不用预测值；无候选时不落库。
- 新增只读 `memory.verifyOperationProof({ action:"forget", identityId, controlProof, initiatorCharacterId, expectedContextVersion, nowMs })`：
  - `deletedEntryIds` 均不存在；
  - `listEntriesByIdentity(identityId)` 与 `retainedEntries` 的 id 集合完全一致，且每个保留成员的 version/sourceIdHash 未变；
  - 每个 `identityControls`、`sourceControls`、`deletedFingerprints` 仍存在；
  - `memory.getContextVersion(initiatorCharacterId) === expectedContextVersion`；不为“旧 identity 未新增条目”而已，用户以新 identity 重学造成的 contextVersion 变化同样使 proof 失效。
  - 任一不满足即 `false`；发现目标 identity 多出新条目或发起角色有新记忆变动也返回 `false`，阶段 2 不继续清理候选。
- correct 的 proof 核对继续使用 `chat.cjs` 现有 `proofMatches`，不 retrofit 到新接口。
- `chat-memory-verification.cjs` 增加 forget 模式捕获：目标快照/成员证据与候选捕获；`verify()` 的关系请求与 pair 映射不变。不新增导出给工具层使用。
- `chat.cjs` 增加 forget 分支、proof 写入、阶段 2 分支与 action-aware 文案；cancel/close/dispose/recover 从 `operation_proof.action` 还原动作，重启后仍能输出删除文案。旧数据 proof 缺 `action` 时按 correct 兼容，保持 2a 与旧库行为。
- `chat-store.cjs`、`main.cjs`、`preload.cjs`、`renderer/chat-panel.js` 预期零改动：字段与 `bayper:memory-changed`/`chat-updated` 事件沿用 2a。

### 10.4 阶段 1 来源控制增量

设发起角色 A、目标 identity T、scope s、命令来源 `userSourceId=<当前 user message.sourceId>`；`D_s` 为阶段 1 实际删除条目（all=T 全部成员；self=T 中 `characterId===A` 的成员）。

- 对每个持有者 h：`sourceControls[h]` 是本次操作覆盖的 `sha256(entry.sourceId)` 集合（entry∈D_s、entry.characterId===h）；仅 A 额外覆盖 `sha256(userSourceId)`。这些键可能阶段 1 前已存在，记录的是本次覆盖集合而不是“新插入差量”；与阶段 0 捕获集比较时取并集。
- `identityControls[h] = T.identityId`；`deletedFingerprints[h] = { strictFactFingerprint(entry) | entry∈D_s, entry.characterId===h }`；重复键按集合去重。
- `retainedEntries` 为 T 中未删除成员；self 才可能非空。
- 候选证据的允许增量直接取阶段 1 实际 `controlProof.sourceControls[h]`（覆盖集合，可能含预存键），与阶段 0 捕获集合取并集后精确比较；不自行推测。
- 阶段 2 的 forget 调用仅在调用角色为 A 时传 `sourceIdsToExclude:[userSourceId]`；B 自己持有的候选不把 A 的聊天来源写进 B 的来源控制。重复调用由 `INSERT OR IGNORE` 保持集合并集语义。

### 10.5 阶段 2 步骤、self/all 与原子性

1. 仅当 proof 存在且 `verification_status==="pending"` 才进入阶段 2。凭据读取前先读 proof，`verifyOperationProof`（含发起角色 contextVersion）通过；目标旧快照走 `isEvidenceCurrent`，只允许 10.4 的覆盖集合并集。
2. 候选全部在第一笔删除前复核：identity 成员 id 集合/version/sourceId 完全一致；可解析的成员快照仍核验，派生成员无快照不单独拒绝；成员来源控制精确等于阶段 0 捕获集合与阶段 1 覆盖集合的并集。任一变化该候选未确认；全部失效则不删候选。
3. 凭据返回后、发送核验前再次核对 proof/contextVersion/目标证据与候选；任一失效则剔除或停止，不把旧结果用于删除。
4. 删除代表选择：候选 identity 中优先取 A 持有的成员，否则取阶段 0 的代表；用该成员的 `entryId+expectedVersion` 调 `memory.forget({ inTransaction:true })`。
5. self：只处理 A 持有的候选 identity，`scope:"self"`，只删 A 条目；identity 中的 B 成员必须保留。all：每个候选 identity 只处理一次，`scope:"all"`，清除全部已有持有者。
6. 同一第二事务首删前再次核对 proof/contextVersion、目标证据与全部候选；通过后按稳定顺序逐个删除。所有候选复核在首删之前完成，事务同步执行，后删不会因本阶段自增的来源控制误拒前面的候选。任一执行失败整笔回滚阶段 2，不保留任何候选删除；阶段 1 不回滚。
7. 成功或失败只原位更新同一 assistant 消息并写 proof/状态；不追加第二条。关系核验仍最多 1 次、15s、无重试、不占自动活动预算。
8. 用户以新来源+明确同意新建新的 identity 时，A 的 contextVersion 递增；即使旧 identity 没有新增条目，旧核验也在下一次检查时 `stale`，不删除候选。其他无关角色的上下文变化不纳入该判断。

### 10.6 删除锚后旧消息证据

- 阶段 1 删除锚条目后，不再用 `getHeldEntry`/`isCurrent` 要求锚存在；使用阶段 0 捕获的 `snapshot` 调 `isEvidenceCurrent(snapshot, { holderCharacterId, expectedExcludedHashes, allowedSourceHashes })`。
- 该检查核对原 user 消息正文/时间/seq/conversation/`chat:<id>` 来源归属、有限前文、corrected_v2 segments、digest，以及来源控制精确集合；不查询已删条目，因此适用于 forget。
- 若目标快照是跨角色传播的 `corrected_v2` 且原消息不属于 A，`isEvidenceCurrent` 不通过；降级为本地已完成，不启动阶段 2。这是如实边界，不声称覆盖所有跨角色 `corrected_v2` 或所有传播来源；无法证明时只保留本地删除。
- 原消息被改/删/搬会话、来源控制出现阶段 1 覆盖集合之外的变化、目标 identity 多出新条目，或发起角色 contextVersion 变化（含新来源+明确同意新建新 identity）→ stale，候选一条不删。

### 10.7 取消、重启与文案

- 阶段 1 前取消：零写，不生成 assistant 消息。
- 阶段 1 后 cancel/close/dispose/系统暂停/重启：只停阶段 2，本地删除与 proof 保留，无重试；同一 assistant 原位更新。
- pending 提示沿用：`其他相近内容我正在核对，完成后会在同一条消息里更新。`
- forget 本地收口：`其他相近内容未继续核对，本地这次删除已完成。`
- forget 成功有删除：`另外把 N 条确认属于同一件事的内容一并删除了。`
- forget 成功无删除：`其他相近内容没有确认到可以一起删除的部分，我没有改动。`
- 有未确认或截断时追加：`如果也要一起处理，请直接说出那条内容。`
- correct 既有“一并更正了/本地这次更正已完成”等文案逐字保留；不得让 forget 复述“更正”。不出现“全部”、retrieved/truncated 或技术计数。

### 10.8 生产改动文件与规模信号

| 文件 | 职责 | 预计净增 |
|---|---|---|
| `app/chat-memory-verification.cjs` | forget 模式目标/候选捕获，成员证据放宽仅限 forget | +60～90 |
| `app/chat.cjs` | 阶段 1 proof、阶段 2 删除、action-aware 文案与生命周期 | +70～110 |
| `app/memory.cjs` | `forget` 返回无正文 `controlProof`；`verifyOperationProof` forget 分支 | +30～50 |
| `app/memory-store.cjs` | 预计零改动；若补只读存在性 helper 不超过 +10 | 0～10 |
| `app/chat-store.cjs` / `main.cjs` / `preload.cjs` / `renderer/chat-panel.js` | 复用既有字段/事件 | 0 |

合计约 160～250 行，落在 150～300 信号内。测试只扩展 `tests/acceptance/memory-semantic-operations.spec.cjs`，复用 `setupContext`、`memorySnapshot`、`waitFor`、`verificationRequests` 等既有设施，新增约 400～650 行、12 项；不新建重复 Runner，不复制 2a 的 27 例生命周期。GUI 本批不实施：复用既有事件即可，后续另加 forget 真实 GUI 文案验证，不能把 correct GUI 结果算作 forget 通过。若实现明显超出，先向 master 说明拆分，不以压缩语句或删断言降数。临时纠正不计入本切片。

### 10.9 业务 Case 映射（12 项，复用 POL-SEMOP 既有父 Case）

| 编号 | 父 Case | Given → When / Expected |
|---|---|---|
| F01 | 002a | A 删除锚，B 独立持有同义候选 → all 阶段 2 删 B；C 不变；单条 assistant；一次核验 |
| F02 | 002a | 候选 identity 同时有 A/B 成员（如 A 原始、B 派生）→ all 一次删除全部持有者，不重复处理 |
| F03 | 002b | 同一多持有者候选 + B 独有候选 → self 只删 A 成员；B 成员/B 独有候选正文、版本、来源、context 不变 |
| F04 | 002c | 关系 different/uncertain、候选截断 → 不删候选；文案说具体未确认，不称“全部”，本地删除保留 |
| F05 | 003a | 有候选时 sendMessage 阶段 1 后返回；阶段 2 完成后同一 assistant id 原位更新，不新增第二条 |
| F06 | 003b | 阶段 1 前取消零写；阶段 1 后取消只停阶段 2，本地删除/proof 保留，文案为“本地这次删除已完成” |
| F07 | 003c | dispose/closeConversation/重启的 pending forget → 不删候选、不重试、同一消息删除收口；重开控制仍有效 |
| F08 | 004b | 阶段 1 自增来源控制不误拒候选；等待期间 B 新增来源限制/成员版本或来源变化 → 该候选未确认，A 成员也不因 self 被误删 |
| F09 | 004c | 第二个候选删除故障 → 阶段 2 逐表全回滚（候选 1 正文/FTS/控制/版本恢复），阶段 1 删除与 proof 保留，消息失败收口 |
| F10 | 004a/007c | 锚已删后改原 user 消息/搬会话/新增外部控制 → stale，候选不删；用户以新来源+明确同意新建**新 identity** 使 A contextVersion 变化 → 旧核验同样 stale，新条目保留、候选不删；proof 仍无正文，重启可核验 |
| F11 | 006a/b | 有 forget 候选恰好 1 次核验、无重试、15s；无候选/普通聊天 0 次；automatic_budget 不变；超时/网络失败不删候选 |
| F12 | 007a/b/c | 正例：新来源+明确同意可新建新 identity，且旧 forget 核验失败、不删候选；反例：复用旧来源即使明确同意仍阻断。阶段 2 删除后 FTS/别名/relay/share 旧来源不回流；控制表无正文；重启仍阻断 |

### 10.10 测试先失败基线与断言重点

- 先扩展同一 Runner 并运行，保留实现前失败 attempt：2a 既有 28 项应仍 PASS；新增 forget 项因“未触发阶段 2/未写 pending proof/文案仍为更正”等业务断言失败，不得是缺表或 fixture ERROR。
- F01/F02/F03/F12 逐行比较 `memory_entries`、FTS、source/identity/deleted 控制、derivations、aliases、contextVersions；self 额外断言 B 成员版本与正文不变。
- F05/F06/F07 断言 assistant 数量、同一消息 id/内容、request 状态、无 pending、无第二次 HTTP；F09 用 trigger 注入第二候选删除失败，逐表快照只允许 request 状态与同一 assistant 文案变化。
- F10/F12 断言新来源+明确同意后 A contextVersion 变化、旧核验为 stale、候选未删、新 identity 条目存在；旧来源复用仍阻断。无候选 forget 断言 `operation_proof` 为空且 0 次核验。
- F10/F12 断言 proof 序列化文本不含被删正文/原始 sourceId；控制表扫描无正文；`rebuildSearchIndex`、重开、旧 source 重导入、relay/share 均不能恢复。
- 所有 Expected 仍以 [cases.md](cases.md) 的 POL-SEMOP 父 Case 为准；本轮不预填 PASS，未运行不写结果。

### 10.11 master 受托决定（2026-10-27）

以下为 master 审核 §10 后的受托决定，不是用户亲自确认：

1. **proof 最小持久化**：只有候选存在、`verification_status` 进入 `pending` 时才持久化 proof；不为无阶段 2 工作写持久 proof。`memory.forget` 仍返回内存 `controlProof` 供阶段 1 计算与测试使用。
2. **候选成员证据**：允许 forget 派生成员没有来源快照，但每个成员的 version/sourceId 与来源控制都必须捕获并重核；可解析的成员快照仍要核验。correct 不放宽。
3. **代表与命令来源**：阶段 2 优先取 A 持有的成员作代表；`sourceIdsToExclude:[userSourceId]` 仅对 A 传递，B 独有候选不写 A 的聊天来源。
4. **测试范围**：12 项业务映射进入既有 `memory-semantic-operations.spec.cjs`；GUI 本批不实施，后续另加 forget 真实 GUI 文案验证；correct GUI 结果不得算作 forget 通过。
5. **temporary 顺序**：temporary 仍紧随 forget、沿用本计划；其 proof 按当前事实条目/版本/`expiresAt` 设计，不直接套用删除 proof。
6. **版本与基线**：`evaluation.md` 当前基线更新为 `88ff9c7` / VERSION `0.1.189`，历史行不改；本批文档/版本从 `0.1.189` 升至 `0.1.190` 待 master snap。
7. **新身份失效（新增关键约束）**：proof 记录阶段 1 结束时发起角色 A 的 contextVersion；阶段 2 在发送核验前、凭据返回后、事务首删前分别核对一致。用户以新来源+明确同意新建**新 identity** 会递增 A 的 contextVersion，旧 forget 必须 stale，不能继续删除候选；不是只检查旧 identity 是否新增条目。可保守地把 A 的其他新记忆变动判为 stale，但不扩大到无关角色的全部上下文。
8. **来源控制集合语义**：阶段 1 的实际 sources 是本次操作覆盖的控制键集合（可能预存），按并集语义记录与比较，不表述为必然新插入。
9. **跨角色边界**：§10.6 的 `corrected_v2` 跨角色降级是如实边界，不声称覆盖全部传播来源。

本批只改文档与版本，不写代码/测试、不 Git/API/GUI/子代理；下一次才实施 forget 切片。

## 11. 2b forget 收口与下一批 temporary（2026-10-27）

- master 独立运行 20 个相关套件 **235/235 PASS、0 skipped、exit 0**，before/after SHA 一致，证据 [master-forget-core-QlvxfnTU](evidence/master-forget-core-QlvxfnTU/stdout.log)；命令、真实退出码与前后 SHA 见同目录。受托接受 2b forget 确定性后端的**已测有限能力**，不是用户亲自确认，不是真实模型语义，也不是人类体验。
- 接受范围：002a/b/c、003a/b/c、004a 的删除锚证据、004b、004c 的删除回滚、006a/b、007a/b/c 的 forget 分支；包括 self/all、单条 assistant 原位更新、取消/重启/超时文案、新来源+明确同意建立新 identity 使旧核验 stale、FTS/旧来源/relay/share 防回流。该范围只限已运行分支：002c 实际覆盖 different/截断，未单独覆盖 uncertain；网络失败只由共享 correct 回归间接覆盖，不称 forget 网络失败独立通过。
- 未覆盖：temporary（001d）、真实模型 L1/L2、跨角色临时传播、忘记专属 GUI 与完整产品级 GUI 生命周期。现有 correct GUI 4/4 对应旧源码时点，本批未重跑，不能算 forget GUI 通过。
- 聚合 POL-SEMOP-001～008 仍 NOT_COVERED，不得由 2b 后端有限接受自动升级为整组 PASS；不宣称 S03m/S03/Goal 完成。
- 生产净增约 356 行已由 master 评估为职责必要；correct/forget 共用请求/凭据/取消/候选/异常编排，仅动作 proof、候选资格与第二事务分支不同，不构成通用策略框架。
- 下一批 temporary：以 §12 r3 为准（随机 T/copy/relay/edit 来源、self/all/restrict/exclusive、阶段 2 contextVersion/原子回滚）；继续不增加 GUI/main/preload 范围，除非 master 另行派发。
- 本批仅文档与版本收口：VERSION `0.1.190` -> `0.1.191`（同一 10 文件 11 处字面量，无依赖变化），不改源码/测试，不重跑测试/API/GUI，不 Git/子代理。初版中止、夹具错误、FAIL 与部分通过记录保留，不覆盖。

## 12. 2c temporary 实施基线与收口（2026-10-27）

master 2026-10-27 受托批准本方向，**不是用户亲自确认**。C2 旧 Expected 更新的业务理由：用户明确说“今天…”时，今日 current 与长期偏好含义不同；长期记录保留为长期，但不得在聊天上下文冒充今日状态，因此有效 current 优先、旧长期不并列注入。r4 时点 2c-1/2c-2 均未实施；后续 2c-1a/1b 与 r2 返修已由 Claude Code 实施，master 独立复跑 20 套件 **295 tests / 295 pass / 0 fail / 0 skipped、exit 0**、before/after 摘要一致且当前 after 清单复验一致（`evidence/master-temporary-final-gmf6gukR/`），据此受托接受 **2c-1 已测领域与真实 chat/构造 HTTP 范围**。该接受不是用户亲自确认、不是真实模型语义、不是真实 GUI/UI IPC，也不接受 S03 或完整 Goal；POL-SEMOP-001～008 聚合仍 **NOT_COVERED**，2c-2 未实施。r2 退回原因（历史）：固定“日期+长期 identity”的 T 无法满足全删后同日新陈述与第二持有人发起；sourceAnchor=A 长期使 B 依赖 A 存活；拒绝 temporary share/relay 与通用编辑不符合 PRD。r4 已按最终 diff 审查补入最小无正文同锚防回流控制，删除“正文不同即新事实/换 T 绕过”边界；以下保留已批准的最小设计，实施细节以 §12.4～§12.8 为准。

### 12.1 Part A：最小设计

**A1 随机 T、无正文关联元数据、查找与控制**
- 新建时 `T=crypto.randomUUID()` 并 `store.insertFactIdentity(T)`；initiator current 与所有 copy/relay/edit 共用 `factIdentityId=T`。不按正文、日期或长期 identity 归组。
- 为每个临时条目记录无正文关联元数据：可复用现有表，或由 `memory-store` 新增窄表 `memory_temporary_links(temp_identity_id, long_identity_id, holder_character_id, expires_at)`；只存 id/时间，不存 body、excerpt 或 source 正文。`long_identity_id` 是该 temp 依附的长期 fact identity（origin、已核实候选或既有 link），不要求 holder 自身有 long 条目；`holder_character_id` 区分控制作用域。holder 自己的 long anchor 仅在 source/derivation/T 已证明同一事实时写入；收件人恰好有任意 long 不自动挂靠。该关系只用于查旧控制，不抑制长期、不建 overlay。
- 查找：选中项本身是 temp → 直接 `T=entry.factIdentityId`。长期目标：优先自身唯一有效 current 所属 T；否则只接受同 holder、同 `long_identity_id`、同一有效时段且 source/derivation/link 可唯一证明的 T；出现多个仍无法唯一证明 → 沿既有最小澄清，零修改、零传播（S12）。不按 updatedAt/正文/角色猜组。
- 查询必须覆盖 `chat-current:`、`chat-current-copy:`、`temporary-edit:`、既有临时 `relay:`/`share:`（后者限 `expires_at` 非空）及 `memory_temporary_links`；不能漏 copy 导致第二持有人新建 T。direct 不需要 derivation；copy/relay 必须有 derivation；source control 按 holder 作用域核对，A self 控制不得全局取消 B。
- 防回流：同一有效时段且明确关联同一 `long_identity_id` 的重建，先查旧 T 的 forget/share/exclusive 控制。新的明确陈述只授权**发起人**建立新 T；其他 holder 是否获得 copy 由旧 link 控制决定：旧 forget 按 holder 保持、旧 share/exclusive 不自动解除；旧源始终阻断。同 body 与不同措辞都按可证明 link/long_identity 执行，不以正文相同归组或放行。不能证明的独立语义不宣称已解决，保留真实模型/召回门禁。
- 全删后无 active 条但保留 link/control：同一有效时段+明确同 `long_identity_id` 的新明确陈述先查旧控制，再建**新 T**；新 T 只能由本轮发起人建立，其他 holder 不因 A 的新陈述获得建 T 授权，是否获得 copy 由旧 forget/share/exclusive 控制决定并保持；旧源仍阻断。过期后跨日新事实与旧临时状态分开，旧临时禁令不升级为长期禁令；无存活副本时不存正文/overlay。

**A2 来源、快照与自删除验证**
| 类型 | sourceId | 关键语义 |
|---|---|---|
| direct | `chat-current:<origin long>:<now>:chat:<msg>` | `direct=true`、`via=current_temporary`；`sourceAnchor=holderAnchor=origin long` |
| copy/sync/relay | `chat-current-copy:<origin long>:<ov>:<origin current>:<cv>:<holder long 或 ->:<hv 或 0>:chat:<msg>` | `sourceCharacterId=origin`、`holderCharacterId=holder`、`direct=false`；**holder long 仅在该 holder 与 origin/long_identity 有明确事实关联（同 identity、已核实候选或既有 temp link）时写入，否则写 `-`**；identity copy/sync 用 `via=temporary_propagation`，显式 relay/share 即使有 holder long 也用 `via=temporary_relay`、`relayFrom=derivation.narrator`；收件人恰好有任意 long 不自动挂靠 |
| edit | `temporary-edit:<origin long>:<ov>:<origin current>:<cv>:<holder long 或 ->:<hv 或 0>:chat:<msg>` | `via=temporary_edit`、`edited=true`；body 不要求与 msg segments 一致，不冒充聊天原话 |

- 快照新增：`sourceAnchor*=origin long`（可 removed，仅溯源）；`temporarySource*=origin current`（可 removed）；`holderAnchor*=holder long`（仅明确事实关联时存在，否则 null）；`sourceAnchorStatus/temporarySourceStatus: live|removed`、`edited`、`relayFrom`。旧 direct/corrected 摘要不变，新字段只在临时来源进入 digest/isCurrent。
- 每个 temp 条目（direct/copy/relay/edit）在同一事务写 `memory_temporary_links`；其 T/long_identity/holder/expires 必须与条目一致。删除正文不清 link/control，link 只存 ids/时间；link 缺失的旧临时条目保守处理，不凭收件人任意 long 补挂。
- 验证始终核：holder long（若有）存在且版本匹配；T 共享；**direct 只核 origin current/消息，不要求 derivation；copy/relay 必须有 derivation**（identity copy parent=origin current、narrator=origin；relay/edit parent=immediate parent、narrator=`relayFrom`）；origin 消息存在且属于 origin；copy/relay 的 segments 按生产 join 逐字重建 body；edit 只核锚/消息归属，不核 body；expiry；source controls **逐 holder 作用域**核对，A 的 self/source 控制不能取消或阻断 B。
- origin current 存在时要求版本**精确相等**且正文/trust/expiry 一致；不存在 → `removed` 仍有效；存在但版本/正文不符 → stale/unavailable。origin long 仅可选溯源，**不因 A 删除 current 或 long 使 B 失效**；holder long 版本变化才使该 copy stale。T 不重算，证明依赖 derivation、真实消息、holder long 与上述锚关系；接受本地 DB 可信边界，不做密码学签名。
- 自删除：A `forget self` 删除 T 中所有 A 持有的临时条目（不仅选中 current）；B/C copy 继续用 holderAnchor+derivation+origin 消息验证。A 的 current/long **缺失**、或 A **long 版本变化**，不连带使 B 失效；仅当 origin current 仍存在且版本不等于副本记录时判 stale。removed 与 stale 的判别对所有 holder 一致。

**A3 阶段 1 与真实调用**
- 触发 target 为长期或临时；initiator 需持有有效长期 anchor（只有 relay 临时副本、无长期 anchor 时支持转告/删除/编辑，不造直接 current）。
- 同一事务：长期不动；建/更新 initiator current（direct）；逐个更新 T 已有成员：**仅当该 holder 与 origin/long_identity 有明确事实关联时用 copy（写 holder long），否则用 relay/sync copy（写 `-`）**；再对 L 中尚未在 T 的已知 holder 按同一规则建 copy；跳过 T 控制/新 source 控制/该 body 删除指纹；所有 current 共用 T、`expiresAt`，derivation 指向 origin current，写 link，被替换 source 加控制。未知角色零新增。返回 versions/sourceControls/contextVersions。
- 聊天：`chat-memory-operations.cjs:835` 的 temporary 改为调 memory narrow，`chat.cjs:1356` 的 applyChatOperation 仍处阶段 1；2c-1 不进入阶段 2。UI：`memory-panel.js:422 → preload.cjs:48 → main.cjs:1623 → memory.correct`（`memory.cjs:716`），`memory.correct` 检测 temp 后调 `correctTemporaryUnderstanding`，不新增 IPC。转告：`memory-panel.js:499 → main.cjs:1690 → memory.relay`（`memory.cjs:1132`）；分享/限制/独占沿用既有入口（`memory.cjs:1013` 等）。
- 共享来源与 `memorySourceContext` 的 copy/relay/edit 分支同批接入；旧 direct/corrected/`POLICY_VERSION` 不变。2c-1 生产规模超 500 行先停报拆分。
- UI 编辑：任一 holder 在面板保存临时条目均走同一窄路径；同一事务更新 T 内所有成员 body/version（含 B 编辑共享副本后 A/B 一致），保留 expiry/T/anchors，source 改 `temporary-edit`（origin 消息仅溯源，不声称 body 来自该消息），旧 source 加控制；不改长期、不调模型。编辑后的 temp 可检索、可转告，但不作为关系核验候选。

**A4 操作兼容（D1/D2/D3/D4 已裁决）**
- self：删 T 中所有 A 持有临时条目，B/C 副本保留并继续可验证；长期不动。all：删 T 中全部临时条目与 derivation，按 holder 写 source/identity/deleted 最小控制；长期不动；物理删除正文，不隐藏。两者都保留 `memory_temporary_links` 与既有控制行（只 ids/时间），供同长期锚重建查旧 forget/share/exclusive。
- restrictSharing：只给 T 加 share control；A/B/C current 保留；share/relay 按既有 `isShareRestricted` 拒绝。控制跨重启；同一有效时段、明确同一 `long_identity_id` 的新 T 通过旧 link 查到旧 T share control，不自动解除，重试/换 source/换措辞均拒绝。不宣称 T 过期后对长期下禁令。
- keepExclusive：保留选中 holder 的 current（版本+1），删 T 其他 holder 临时副本并写控制；长期不动。旧 T 的独占/share control 通过 link 对同锚重建继续生效；不升级为长期禁令。
- share/relay：不为临时条目新增拒绝；share 仍按既有派生/权限与自动共享预算，不得把私聊偏好默认自动分享；relay 只在用户本轮明确授权转告时执行，不得误称“默认自动分享”。临时条目复制 `expiresAt`、T、derivation；**holder long 只在明确事实关联时写入，否则 `-`；不因收件人恰好有任意 long 自动挂靠**；identity copy/sync 用 propagation，显式 relay/share 用 `temporary_relay`（即使有 holder long），`direct=false`、`relayFrom` 真实；若父为 edit，目标用 `temporary-edit` 源且 `edited=true`，不声称 body 来自原聊天；已禁止分享/冲突按既有规则拒绝；父临时删除后下游 relay 仍用 origin 信息+derivation 验证，不依赖父行存活。
- 重建控制：同一有效时段且明确同一 `long_identity_id` 的新 T，先按 holder 查旧 link 对应的 forget/share/exclusive 控制；initiator 可用本轮新 source+明确重新告知建新 T，其他 holder 的旧 forget 不解除、旧 share/exclusive 不自动解除；**旧 share/exclusive 存在时，新 T 不向其他 holder 建 copy、不 share/relay**；旧 source control 始终阻断。不能证明同锚的独立语义不虚称已解决。
- 以长期条目为目标的现有 2b cancel/correct/forget 语义不变；temporary 操作不扩大到长期 identity。构造模型/GUI/live 仍另列，不把本轮当完成。

**A5 检索与管理可见**
- `searchMemories`/`buildContext`：active + 本地临时结构校验（T/anchors/derivation/expiry/source control；copy/relay segments；edit 的 edited 标记）。失效 current 不进入上下文或聊天候选；`listMemories` 不变，管理可见。chat 深校验用 `memorySourceContext.resolve`，edit 仅按本地规则接受。
- 仅有效 current 抑制对应 holder 的长期 anchor；失效/移除后不设今日抑制墓碑，长期按长期恢复，不重建今日。`memory_temporary_links` 只用于控制查询，不参与抑制、不进入检索/上下文、不把临时禁令升级为长期禁令。同一 holder 多 current 同文同到期只注入一条，但保留全部行供 all/exclusive。
- 标签：direct“用户今天明确说明”；copy/relay“经 origin 的今日说明同步/听 relayFrom 说，不是直接告知”；edit“用户在面板修改”。临时段注明优先于长期偏好。

**A6 两批实现（每批接真实入口，不以拒绝 guard 收口）**
| 批 | 允许文件 | 内容 | 生产规模 |
|---|---|---|---|
| 2c-1 | `memory-temporary-source.cjs`（新）、`memory.cjs`、`memory-store.cjs`（可新增 `memory_temporary_links` 窄表/迁移）、`memory-source-context.cjs`、`chat-memory-operations.cjs`、`chat.cjs`（仅阶段 1 接线）、测试 semantic/corrected-source | 随机 T/查找、link/控制查询、阶段 1 已知 holder、检索、self/all/restrict/exclusive、share/relay、UI 编辑、来源验证 | 350～500 |
| 2c-2 | `chat.cjs`、`chat-memory-verification.cjs`、`memory.cjs`（proof/confirmed）、`memory-relation-protocol.cjs`、同 Runner | 独立同义候选一次核验、contextVersion 精确放行、原子回滚、第二候选 | 150～250 |

- link 窄表只存 `temp_identity_id/long_identity_id/holder_character_id/expires_at`，不存 body；`CREATE TABLE IF NOT EXISTS` 旧库迁移，无 FK 级联删除；link 与临时条目同事务写入，失败整笔回滚；删除正文后 link/控制保留，重开验证仍能查旧 forget/share/exclusive。若现有表可满足同等无正文查询，可不建新表，但迁移/重开/回滚验收不变。

2c-1 先做来源/操作/检索的业务路径与失败用例，必须是真实 chat 入口 + memory 管理领域；若本批未运行真实 UI IPC，只能记领域验证，**不得标 UI IPC 已验**。GUI/live 为后续门禁。2c-2 才接模型候选，不提前写 proof/UI。2c-1 的 temporary 仍不宣称独立同义完成；2c-2 完成后父合同才可能闭环。350～500/150～250 是审查信号而非硬上限；超出需说明职责必要性并由 master 审查，不为凑数压缩代码或断言。

### 12.2 Part B：验收计划（真实 SQLite/chat/UI IPC + 构造模型）

| ID | 批 | Given → When | Expected / 禁止 | Oracle |
|---|---|---|---|---|
| S1 self | 2c-1 | A/B 同 T；分别执行 A 删临时 current、A 删自己的长期 anchor | S1a：A 临时条目删、B copy 仍 resolve ok 且用 B long；S1b：A 长期删后 B copy 仍有效，不因 A 缺失失效；A/B 其他长期按实际保留；单消息 | entries/derivations/controls/source snapshot；两次独立 runner |
| S2 all | 2c-1 | A/B 同 T；A `forget all` | A/B 临时行与 derivation 全删；控制保留；长期保留；旧源重扫不恢复 | 逐表快照、FTS、controls、重开 |
| S3 restrict | 2c-1 | A/B 同 T | T 有 share control；current 全留；share/relay 被既有规则拒；重启仍拒；不删长期 | controls、share/relay 返回、重开 |
| S4 exclusive | 2c-1 | A/B 同 T；A `keepExclusive` | A current 保留+1；B 临时删除并控制；长期不动 | entries/derivations/controls |
| S5 同日改 | 2c-1 | A current+B copy | 再改口复用 T；A/B current 原地更新；旧 snapshot stale；无 `corrected:`；长期不变 | versions/sourceId/derivation；单 assistant |
| S6 第二发起 | 2c-1 | B 的临时 copy 在 T；B 发起新陈述 | 复用 B 的 T，更新 A/B 已有关联副本，不另造组；A 若已 self 删除则不复活 | T 分组、entries/derivation、controls |
| S7 share/relay | 2c-1 | 用户明确授权 A 转告 C；另测自动分享路径 | 显式 relay 继承 expiry/T、`direct=false`、relayFrom 真实；禁止分享时既有错误；**不得把私聊偏好误称默认自动分享**；share 资格/预算不变；父删后仍可用 origin 验证 | C entry/source snapshot/expiry、返回码、预算 |
| S8 UI 编辑 | 2c-1 | 面板由 B 保存共享临时副本，A/B 同 T | 窄更新 T 全部 body，A/B 一致；expiry/T 不变；source 为 temporary-edit、edited=true，不冒充聊天原话；可检索/转告 | IPC 返回、entries/source snapshot、context |
| S9 unknown | 2c-1 | C 未结识 | 不创建 C/关系/T copy；候选只已知 holder | relationships/entries |
| S10 过期 | 2c-1 | current 接近到期 | 到期不进入 search/context；长期恢复；次日新 T；同 T 重试不复活 | 时钟、entries、context |
| S11 同锚防回流 | 2c-1 | 同一有效时段、明确同一 `long_identity_id`；旧 T 已有 A/B 的 forget/share/exclusive；A 同日重新明确告知同 body，再用不同措辞；另重试旧 source | 新建 T 仅 A 获 current；旧 link 查到旧控制：B 的旧 forget 不解除、不被重建；旧 share/exclusive 不自动解除，B 不获 copy/不转告；旧 source 重试被 source control 阻断；body 不同但同锚同样执行；link 只存 ids/时间；重开仍阻断 | entries/identities/links/controls/source snapshot、旧库升级/重开、事务前后逐表与 link 写入失败回滚 |
| S12 歧义 | 2c-1 | 长期目标存在多个无法唯一证明的 T | 沿既有最小澄清；零修改、零传播；不按 updatedAt/正文猜组 | entries/derivations/controls 前后完全一致、assistant 澄清 |
| D1 独立同义 | 2c-2 | B 独立同义长事实 | 一次核验后建/更新 B current；不合并长期；单消息原位更新 | pair/HTTP、entries/identities |
| D2 多锚 | 2c-2 | B 同 identity 多长条目+另一独立 identity | 阶段 1 每个 holder+identity 一条 current；阶段 2 不跳过另一 identity；无重复 | T 计数、pair、context |
| D3 context | 2c-2 | 阶段 1 触碰 B，B 另有独立候选 | 只放行记录的 contextVersionsAfterLocal；额外变化 stale；候选证据仍 current 时完成 | contextVersions、proof |
| D4 回滚 | 2c-2 | 第二候选写入失败 | 全部 stage2 current/derivation/source/context 回滚；阶段 1 保留；单条本地完成 | 逐表前后快照、trigger |
| D5 未知 | 2c-2 | 候选检索含未结识角色 | 不新增关系/角色/T copy；pair 只含已知 holder | relationships、entries、HTTP |

- 2c-1 不含独立同义阶段 2；2c-2 不重做 2c-1。**S11 为 2c-1 必需 Case，不得后移**；2c-1 必须经真实 chat 入口与 memory 管理领域；本批若未运行真实 UI IPC，不得标 UI IPC 已验，只记领域与既有 IPC 代码路径。关系模型为构造 HTTP；GUI/live 为后续门禁。真实模型 L1/L2、GUI 生命周期与 live 仍 NOT_COVERED，未运行不填 PASS。

### 12.3 明确边界（本批不扩范围）
- 多个 T 无法唯一证明时沿既有最小澄清：零修改、零传播，不按 updatedAt/正文/角色猜组，也不合并两组。选中 temporary 时直接用其 T；长期目标优先唯一有效 current，其次唯一可证明关联 T。
- holder long 只在明确事实关联时存在；relay/edit 无关联时为 null，其验证依赖 origin 消息、derivation、T 与 expiry，不冒充直接告知。
- 长期操作仍按 2b；temporary 的 restrict/exclusive 不扩大到长期 identity，也不声称 T 过期后长期受限。
- `memory_temporary_links` 只用于查旧 forget/share/exclusive，不存正文、不抑制长期、不建 overlay；同一有效时段且明确同 `long_identity_id` 的新 T 不得通过换 source/措辞解除旧控制，旧源始终阻断。过期后跨日新事实与旧临时状态分开，旧临时禁令不升级为长期禁令。
- 同锚关系无法证明的独立语义不虚称防回流已解决，保留真实模型与召回门禁；本批只落实可证明的同锚控制。

### 12.4 2c-1a/2c-1b 分步执行依据（2026-10-27 r33，master 授权）

- master 要求 2c-1 不再单批实现：本轮只做 **2c-1a**（随机 T/link、阶段 1 同长期 identity 同步、copy 来源可解析、`buildContext` 今日优先、self/all/restrict/exclusive 与同锚无正文控制），覆盖 S1-S6、S9-S12；**S7 显式转告与 S8 面板编辑专属来源留 2c-1b**，本轮不实现、不宣称通过。
- `searchMemories` 与 `buildContext` 职责区分：search 是管理定位入口，合法长期偏好仍可被检索/编辑；只有 `buildContext` 在有效今日 current 存在时抑制同一长期 identity 的长期锚。到期/失效后不设墓碑，长期恢复。
- S11 拆成 forget-only、restrict-only、exclusive-only 三组同锚重建；同义改写使用等价语句，另测不同今日选项复用同一有效时段 T。S12 冲突存量改为两个来源、holder、正文、到期均合法且明确同锚的 current；A 的 link 行只代表 self 删除后保留的无正文控制，不使用伪造 direct 来源。
- 实现复用既有 forget/restrict/keepExclusive 对 T 的控制流程；新增 `app/memory-temporary.cjs` 领域模块与纯来源 helper，source-context 保留 copy 来源核验。2c-1b/2c-2、真实模型、GUI/live 仍未完成。

### 12.5 2c-1a 返修：唯一权威来源校验（2026-10-27 r34，master 退回后）

- master 退回原因：`memory-temporary` 的 `temporaryInfo` 只查来源自身控制与部分 holder anchor，未验证 origin current 版本/正文、消息 segments、holder 消息控制与完整 derivation；`buildContext` 因此仍可能把 resolve 已 unavailable 的临时正文送入聊天并抑制合法长期。copy resolve 也只看任意 derivation/derived_from，link 用 LIMIT 1 且可能以临时 T 冒充长期 L。
- 修正方向：`memorySourceContext.resolve` 成为唯一权威临时来源校验。store 组装后通过 `memory.setTemporaryValidator` 注入；`searchMemories`、`buildContext` 与聊天操作候选共用同一规则。校验器缺失时临时项保守剔除，不放行。search 保留合法长期；hybrid 回退按“过滤后结果”判断，避免失效 strict 命中阻止 expanded/broad。
- copy 来源严格核对：derivation parent/narrator/origin/source 与 entry 一致；link 必须存在且 T 下 long identity/expiry 唯一一致、holder link 唯一；origin current 存在时必须是同 origin 的 direct、相同消息、版本/正文/trust/到期一致；origin current 不存在时按持久 derivation/link 与真实消息验证（A self 删除不误伤 B）；holder anchor 必须匹配 link 的长期 identity。来源控制按 holder 作用域，B 嵌入消息控制生效，A 的 self 控制不阻断 B。
- 新增 S13 业务测试：真实 chat 建 A/B current 后分别篡改消息内容/role/来源归属、origin current 版本/正文、B 嵌入消息来源控制、derivation parent 删除/替换、link 冲突；每组核对 resolve unavailable、search 不含失效临时、真实 B 聊天上下文不含旧今日正文且长期恢复、resolve 前后状态不变；直接临时来源同样覆盖消息变化，并保留 A self 删除/A 长期删除后 B 仍有效的正对照。S7/S8 仍留 2c-1b，不修改其 Expected。

### 12.6 2c-1b 返修：来源归属与关系边生命周期（2026-10-27 r36，master 退回后）

- 真实缺口：`applyUnderstanding` 只改内存对象，`store.updateEntry` 不写 `origin_character_id`/`derived_from_entry_id`。B 从 copy 成为第二发起者后数据库仍把 origin 记为 A；A 从 direct 转为 copy 后同样失配，resolve/search/context/真实聊天会把合法新状态判失效。
- 最小写入口：仅临时 direct/copy 转换使用 `memory-store` 窄语句，在同一事务更新 `origin_character_id`/`derived_from_entry_id`，不泛改 `updateEntry` 的旧行为。initiator 转 direct 时 `derived_from` 置 NULL；其他 holder 同步 copy 时指向新的 origin current。
- 关系边生命周期：身份同步替换 immediate parent 时，删除指向该临时条目的旧 share/relay 边，避免旧边与新 derivation 矛盾；显式 relay/share 新建的边保持真实 immediate parent。resolve 只把与当前 parent 一致的边当作 relay，其余矛盾边 unavailable；父条目删除后持久 derivation 仍是证据。
- 编辑来源：copy/edit 共用关系核验；非 origin 必须父条目非空，父 ID 等于 origin current（同步）或关系边来源（显式 relay）；`derived_from` 在父行存活时必须等于 parent，父行删除后必须为 NULL。真实父删除（持久 derivation 仍在）后仍有效。
- 验证：S14 覆盖 B 第二发起、A/C 持久来源、resolve/search/context/真实 A/B 聊天、C 已有 relay 边以及 A 再发起回改；S15 覆盖 parent/derived/edge 变异 unavailable、search/context 恢复长期与真实父删除正对照；S16 覆盖编辑后再次改口、A self 删除 current 后 B 连续编辑与转告。无 origin 时两次编辑来源相同且未被旧 source control 阻断（实测），因此不增加额外放行分支。

### 12.7 2c-1 收口（2026-10-27 r37，master 独立复验后）

- 实现由 Claude Code CLI 完成（2c-1a、2c-1b、r2 返修）；独立复验与接受决定由 Codex master 完成。master 对当前工作区实际复跑 20 个相关套件：**295/295 pass、0 fail、0 skipped、exit 0**，前后摘要一致，`shasum -c` 当前 after 清单一致，证据 `evidence/master-temporary-final-gmf6gukR/`。
- 受托接受的是 **2c-1 已测领域与真实 chat/构造 HTTP 范围**：S1～S6、S7/S7b/S8、S9～S16 的本地存储/chat/memory/source-context 行为，以及合法多 T 澄清、self 删除、同锚防回流、来源归属和编辑关系核验。不是用户亲自确认、不是真实模型语义、不是真实 GUI/UI IPC 或 live，也不接受 S03 或完整 Goal。
- `POL-SEMOP-001～008` 聚合仍 **NOT_COVERED**；2c-2、真实模型 L1/L2、GUI/UI IPC/live、跨角色独立同义及其它产品缺口保留。旧 285/295 开发记录与原始 attempt 保留为历史时点。
- 本批只做文档与版本元数据；VERSION `0.1.192` → `0.1.193`（10 文件 11 处字面量），不 commit，待 master snap。此轮是实现/验收缺陷经返修闭环，现行 skill 已支持发现与返修，无新 skill 缺陷。

### 12.8 2c-2 待审技术矛盾（只登记，不解决）

- 现有 `temporaryLinkInfo` 及 T 的 link/控制/lookup 路径假定一个临时身份 T 只对应一个 `long_identity_id`；2c-1 的 holder 同步也以“同一长期 identity”为前提。
- D1/D2 明确独立同义候选不能在核验前合并长期 identity L。进入 2c-2 后，一个 T 可能在阶段 2 关联多个已核实的独立 L，同一 holder 也可能存在多个锚条目；这与当前“T → 单一 L”的校验/控制查找粒度冲突。
- 2c-2 实施前必须先设计清楚 holder+long 粒度、权威来源、对账、控制与临时抑制关联；不得用“合并长期 identity”或“跳过已触碰 holder”绕过。
- 本节仅登记待审事实，不把该矛盾写成 2c-1/1b 的产品失败，也不新增业务限制或预设方案。

## 13. 2c-2 多 L 粒度最小方案（r40 定稿 + r41 收口修正；Codex 受托批准，不是用户亲自确认）

Codex 2026-10-27 受托批准本节方案与 D1～D16（不是用户亲自确认）。**2c-2a 已由 master 独立复跑 20 套件 335/335、exit 0、before/after SHA 一致后受托接受为“已测存储/来源/操作有限能力”**；**2c-2b 已由 master 独立复跑 20 相关套件 358/358、exit 0、before/after SHA 一致后受托接受为“已测真实 chat/SQLite + 构造 HTTP 有限能力”**（`master-temporary-chat-OKCwajaU`）。两者都不是用户亲自确认、不是真实模型/GUI、不是完整 S03。D1/D2/D3/D4/D5/D10/D11 及审查反例已测；temporary 专属 cancel/close/dispose/recover、真实模型 L1/L2、UI IPC/GUI/live、完整 S03 与 POL-SEMOP 聚合仍 NOT_COVERED。批准的是计划与验收口径，不是产品通过；以下 r38/r39 退回依据与 r43/r44/r49 记录保留为历史。

r38 退回依据保留：旧表 PK `(T,L,holder,expiry)` 无法容纳同元组多个 entry 历史；“按 entry_id 删旧行又保留历史”矛盾；阶段 0 把今日 body 当 left；§13.4 只更新选中 L 会使其他 L 成员 stale。
r39 退回依据保留：holder long 删除仍判 ok 与 §12 A2 的“已声明 holder 锚必须存在且版本匹配”冲突；`verifyOperationProof` 只核发起人 contextVersion；keepExclusive 保留自身 current 时未同事务修正 root 引用；`root_identity_id/own L` 未与 source 锚及持久证明交叉校验。本节只给一套首选方案；本轮不实施，待 master snap 后另派。

### 13.1 不变量与两表分工

- T 是“当前理解组”，L 是长期 fact identity；同一 T 可关联多个已核验 L，禁止合并/改写长期 identity。
- 现有 `memory_temporary_links` 原样保留：它是无正文控制关系，PK 与含义不变，记录 T 与哪些 holder+L 发生过控制关系，用于继承 forget/share/exclusive 和查找，不承载 entry 历史。
- 新窄表 `memory_temporary_entry_links(entry_id PRIMARY KEY, temp_identity_id, holder_character_id, expires_at, long_identity_id, root_identity_id)`：只存 id/时间。`long_identity_id`=本条依附 L（B 的 L2，entry 生命周期内不可变）；`root_identity_id`=本条当前来源链的根长期 L（copy 的 B 条目为 A 的 L1，direct 的 B 条目为 B 的 L2）。relay 无自身 long 时首次创建 own=root；root 轮换后 own L 保留、root 随本轮来源更新（见 13.4）。
- 每条 temp entry 恰一行；同一 `(T,L,holder,expiry)` 可有多个历史 entry 行，各保留自己的 entry_id。正文删除时保留 entry 关联行与旧 `memory_temporary_links`，用于根证明与查证。无正文、无通用图、不合并长期。
- 阶段 2 只在既有 T 内新增/更新 current 与 entry 关联，不新建 T、不 `associateFacts`、不改长期条目/identity。

### 13.2 表、迁移与旧 2c-1 兼容

- DDL 放在既有 `FACT_IDENTITY_MIGRATION_SAVEPOINT` 内 `CREATE TABLE IF NOT EXISTS`；建表/回填/写入失败随保存点整笔回滚。
- **初始化迁移**（打开库时、同保存点内）：仅当旧 T 的 `long_identity_id` 唯一、该 entry 的 holder 在该 T 恰一行且 `expires_at` 一致时，为 entry 回填 `long_identity_id=该 L, root_identity_id=该 L`；缺证、多 L 歧义不猜、不回填。旧 origin current/root entry 已删不影响回填：root L 只取旧 T 的唯一 L；无法唯一则不迁移，读取按旧规则需 holder/expiry 唯一。
- 未能回填的旧 entry：读取只回退旧表，且必须整 T 唯一 L、同 expiry、该 holder 恰一行（等价 2c-1 规则）；source-context 只构造内存结果，读取永不补齐。首选初始化迁移；写入前补齐仅用于未回填旧行的下一次合法写入（edit/再发起/relay/share/阶段 2），与写入同事务且按同一可证明条件补齐；不能证明 → `TEMPORARY_SOURCE_UNAVAILABLE`，零写。
- 新写入与条目/derivation 同事务写 entry 行与旧 `memory_temporary_links` 控制关系行。更新同一 entry 时 `long_identity_id` 不得变；`root_identity_id` 只在本次明确陈述使该 entry 的 direct origin 轮换时随 source 同事务更新，不由第一条 link 推断。发起角色轮换（B 从 copy 转 direct、A 再发起）由各自 entry 明确记录 own L/root L，不互相覆盖。
- 同一 `(T,L,holder,expiry)` 新 entry 保留旧 entry 行与历史根证明，不覆盖。可执行顺序：建表 → 单 L 回填 → 重开幂等 → 失败注入全量回滚 → 既有 2c-1 套件重放。

### 13.3 source 快照：根 L 与本条 L 分离

- `sourceAnchorEntryId/Version/IdentityId` 必须真实指向 origin 长期（A 的 L1）及来源消息；IdentityId 取 entry 关联的 `root_identity_id`，即使 origin current/root entry 已删仍可证明。不得把 B 的 L2 冒充 A 的 L1。
- 新增 `holderLongIdentityId`（必填，取 entry 关联 `long_identity_id`）：本条依附 L，用于抑制、查找和 holder 锚核对；可与 `sourceAnchorIdentityId` 不同。copy/edit 的 B 条目：`sourceAnchor*=A L1`、`holderLongIdentityId=L2`；direct 条目（含 B 再发起）：`sourceAnchor*=own L`，此时可与 `holderLongIdentityId` 相同。copy/edit 分别核 source 内 originLong 与 holderLongEntryId；relay 无自身 long 时 `holderLongIdentityId=root L`、`holderLongEntryId='-'`。
- 删除与变化分开：root long 已删 → `sourceAnchorStatus="removed"`，仍靠 `root_identity_id` 与持久 entry 关联核，ok；origin current 已删 → `temporarySourceStatus="removed"`，仍靠持久 derivation/link/消息核，ok；root current 存在但版本/正文/trust/expiry 变 → `temporary_source_changed`；已声明 holder long 锚删除或版本/身份变化 → `holder_anchor_changed`（与 §12 A2 一致，恢复旧 Expected）；relay 从始无 holder 锚的合法分支保持（`holderLongEntryId='-'` 且无 held 锚可核）；无 entry 关联且旧回退不成立 → `link_missing/link_conflict`；控制排除 → `source_excluded`。**origin current 已删除时必须复用 `originCurrentEntryId` 对应的历史 entry 关联行（T/holder/expiry/own/root）与持久 derivation/消息链；历史行缺失时只允许旧单 L 合法回退，多 L 或任一字段矛盾一律 unavailable，不能只凭本条 root_identity_id 自证。**
- entry 关联字段不能单独作证：`root_identity_id/long_identity_id` 必须与 source 内嵌 origin/holder 锚、仍存活的根/own 长期条目、已持久 origin entry/current/derivation/消息相互一致；任一矛盾 → unavailable，不取字段或第一条 link。root 与 origin current 都删除时，仅当 entry 关联、source 锚 id、derivation/关系边与消息仍形成同一条无正文证明链才继续；证明不足不猜。
- sourceId 格式与长度不变（上限 200），不嵌入 L2 或 token，不按任意现存 long/第一条 link 推断。
- digest 与 isCurrent 纳入 `holderLongIdentityId`（及 entry 关联根/own L 的必要字段）；旧单 L 快照无该字段时按 `sourceAnchorIdentityId` 兼容读取，仍以 digest 自校验，旧 direct/corrected 形状不变。

### 13.4 阶段 1 / edit / exclusive（多 L 同组）

- 选中临时条目：由 entry 关联得所选 L；发起人 origin current 必须是该 holder+L 下的 T 成员。选中长期条目仍按 2c-1 的唯一可证明 T 查找。
- 新明确今日陈述更新 T 中已有且未被控制阻断的**全部成员**（含不同 L），每条保留自身 holder+L 与 holderLong 锚，body/expiry 同步；source 的 origin current id 统一为 T 本轮根 direct、`originCurrentVersion` 取更新后根版本，derivation parent 同步同一 id；holderLong 锚各按自身 L 不变。再为所选 L 的已有长期 holder 补 copy。B 的其他 L 成员也被更新正文，但其 entry 关联 own L 与 holderLong 锚不被改写。
- 每 holder+L 一条 current：已有成员原地更新；无成员时按该 holder+L 选锚新建；同 holder+L 多锚确定性取一条（优先既有成员，否则最早 `created_at/id`）。
- 无 holder 锚的既有成员（含 relay）在 root 轮换时必须继续同步：own L 保留、root 更新到本轮 direct，不得因 own≠root 回滚整组，也不得凭收件人恰有一条任意 long 挂锚；明确声明过的 holder 锚删除/版本/身份变化仍拒绝。
- T 旧 forget/share/exclusive 与旧 source 控制先查，不因换 L、换措辞或换 T 绕过；未知角色不创建。
- `editUnderstanding` 对 T 内全部有效成员按各自 entry 关联选择 holderLong/锚，统一更新 body/expiry，origin/消息沿用 T 的 direct origin；不把 L2 改写成 L1。
- `keepExclusive`（memory.cjs）保留选中 holder 在 T 的全部 L current（逐条 version+1）；若 root current 也 version+1，必须在同一事务重写其他保留条目的 source `originCurrentVersion` 与 derivation，使 root 引用一致，不能出现保留后自身 copy 已失效；删除其他 holder 在 T 的全部副本并写 T share control 与其 source/forget 控制；`self/all` 仍按 T 覆盖全部 L。exclusive 后保留者的 resolve/search/context/再次编辑合法，但 share/relay 仍被 T share control 拒绝且零写；只有先经既有明确 `allowSharing` 流程解除限制后才可转告，另列对照，不自动解除。
- `applyUnderstanding` 返回 `entries[{entryId,holder,longIdentityId,version,sourceIdHash}]`（不含正文）与 `contextVersions/sourceControls`，供阶段 2 proof。

### 13.5 阶段 0 / 阶段 2（真实 chat）

- 阶段 0 选中临时条目时，沿 entry 关联的 L 取该 holder 的有效长期锚，用该锚 `captureTargetEvidence`；left/right 始终是“A 旧长期事实 vs B 旧长期事实”，不得用今日 body。无有效长期锚的 relay 条目按现行合法编辑/转告范围处理，不造长期、不进入两阶段核验。
- `captureCandidates` 以该长期锚作为 targetEntry 调用，不再因临时目标 `expiresAt` 直接返回空；候选仍按 identity 去重，排除同 identity/派生/受限/过期，未结识不进入。
- 阶段 1 后写 temporary proof（无正文）：version 3、`temporaryIdentityId`、`expiresAt`、root entry/identity、发起人、T 成员集合（entryId/holder/longIdentityId/version/sourceIdHash）、候选旧事实快照标识、`contextVersionsAfterLocal`、`sourceControls`。
- `verifyOperationProof` 增 temporary 分支：T 成员集合/版本/来源/entry 关联与 proof 完全一致，root/own L 与记录一致；对本轮所有有关 holder（T 成员、候选及 approved 成员）按捕获的 contextVersion 与阶段 1 确切已知增量逐一重核，非发起者额外变化同样 stale；首写前统一检查，任一外部新增/删除/改版本/无关 context 变化 → stale。
- 阶段 2 仍一次 `verification.verify`（15s、无重试、无自动预算）；候选资格复用 `correctCandidateEligible`；`proof.sourceControls` 同时作为 targetEvidence 与候选/成员的允许增量，阶段 1 已触碰 holder 不跳过。
- 事务内首写前重核 proof 与全部 approved（`candidateMembersMatch`+`candidateEvidenceCurrent`），按 approved identity 去重；每个候选为每个已知成员 holder 在 T 内建“该 holder+该候选 L”一条 current（已有原地更新，无则 copy），多锚取一条；已有 T forget 控制/删除指纹的 holder 跳过且不解除；T 已 share/exclusive 时只更新 T 内已有 holder，不向 T 外新增。
- 窄接口 `memory.applyConfirmedTemporaryCorrectionToHolders({temporaryIdentityId,expiresAt,originCurrentEntryId,originCurrentVersion,approved,nowMs,inTransaction:true})`；内部重读 origin/成员/entry 关联，任一失败抛错。阶段 2（currents/derivations/entry links/source controls/context/FTS/assistant）单一事务，失败整笔回滚、保留阶段 1、同一 assistant 原位更新为本地完成；成功不追加第二条。
- 取消/关闭/dispose/recover 沿用现有 `verifications`/request 状态；重启 pending→`interrupted`，不重试、不回滚阶段 1。

### 13.6 控制、防回流、上下文

- self 删该 holder 在 T 的全部 L 条目；all 删 T 全部条目；正文/derivation 删，entry 关联、旧 T-L links 与控制保留。
- restrict 仍写 T share control；allow 只解 T；不升级为长期禁令。
- 新 T 查找覆盖旧 T-L links 的全部 L；新 T 继承旧 T share 与各 holder forget 控制（跨 L），旧 source 始终阻断；新明确陈述只授权发起人建 direct，其他 holder 仅在旧控制允许且 T 未 share/exclusive 时 copy，旧 forget 不解除。
- `buildContext` 去重键=`holder + tempIdentityId + body + expiresAt`（含 T，不能把无关 T 仅因同文合并）：同 T 同 holder 同正文同到期只注入一次，同时抑制这些条目明确关联的全部 L（`holderLongIdentityId` 集合）；不同 T 即使同文也不合并，并分别抑制各自 L；不同正文/到期分别注入。search/list 不变。

### 13.7 反例（真实 store/chat/memory/source-context；聊天 HTTP 与关系 HTTP 均构造，核心存储与业务逻辑真实）

| ID | Given → When | Expected / 禁止 | Oracle |
|---|---|---|---|
| D1 | A L1 current；B 仅独立 L2 长期同义 | 一次 HTTP 合格后 B 在 T 内建 L2 current；approved L 的全部已知 holder 按控制更新；长期 identity/正文不动；同一 assistant 原位更新 | T/entry links/entries/identities、HTTP 计数、消息 id |
| D2 | B 有 L1（阶段 1 已同步）+ L2 同 identity 两锚 + L3 独立 identity | 阶段 2 不跳过 B；B 的 L2/L3 各一条 current，多锚不重复；上下文不重复注入；self/all/exclusive 覆盖 T 全部条目；exclusive 后保留者 resolve/search/context/再次编辑合法，但 share/relay 仍被 T share control 拒绝且零写；若另测转告成功，必须先经既有明确 `allowSharing` 解除限制，作为独立对照且不自动解除；覆盖 root 为自身 current 与 root 在其他角色已被删除两种 | entries/entry links/derivations/controls、context、source-context、edit/share/relay 返回与零写快照 |
| D3 | 阶段 1 触碰 B 后 B（非发起者）又有无关 contextVersion 变化 | 按 B 捕获版本+阶段 1 已知增量重核；额外变化 stale、阶段 2 零写；A 或候选成员额外变化同样不放行；无额外变化时完成 | proof、context_versions、逐表快照 |
| D4 | 两个 approved 候选，第二个写 current 触发失败 | 阶段 2 全部回滚；阶段 1 current/link/控制保留；同一 assistant 本地完成、无 pending | 全表前后快照、trigger、request/message |
| D5 | 候选检索含未结识角色/holder | 不新增关系/角色/T copy；HTTP pair 只含已知 holder | relationships、entries、HTTP 请求 |
| D6 | 阶段 2 后 A 删除根 L1 long 或 origin current；对照 B 已声明 holder 锚删除/版本变 | 正：B 快照 `sourceAnchorIdentityId=L1`、`holderLongIdentityId=L2`，root `removed` 仍 resolve ok；负：holder 锚删除或变化 → `holder_anchor_changed`，不得沿用 root 删除即 ok；relay 从始无 holder 锚的正例仍有效 | source-context/entry links/entries |
| D7 | 旧多 L T 已 restrict/exclusive/他人 forget 且无 active current，再建新 T | 旧 share/exclusive 不解除、他人 forget 不解除、旧 source 仍阻断；新 T 只给发起人 current | controls/links/entries、重开 |
| D8 | A self 删除 T 全部 L current | B 的 L2 current 保留且可验证、可检索；长期不动 | entries/entry links/source-context |
| D9 | 旧 2c-1 单 L 库重开/迁移；迁移失败注入 | 合法单 L 回填；旧行按唯一 L 回退可解析；缺证多 L 不猜；建表/回填失败全量回滚、重开一致 | 旧库 fixture、全表快照 |
| D10 | 同一 approved identity 重复出现/重复执行 | 同一 holder+L 只一条 current；只发一次 HTTP；同一 assistant 不追加第二条 | entries 计数、HTTP、消息计数 |
| D11 | 多 L 阶段 2 成功后 B 再次明确改口 | 同 T 多 L 持有者全部得到新正文；各 L 不改、来源可解析；不把其他 L 写成 B 当前 L | entries/entry links/source-context、assistant |
| D12 | 多 L T 上编辑后再转告 | 全部有效成员同步编辑正文/expiry，各自 holder+L/锚保留；转告继承 T/expiry/root，`holderLongIdentityId` 按真实情况，不冒充直接告知 | entries/entry links/derivation、relay 返回 |
| D13 | 同 T/同 holder/同 L 旧 entry 删除后新建 entry | 新 entry 与旧 entry 各一行历史；根长期证明不丢；不覆盖旧行 | entry links 行数、root/own L、source-context |
| D14 | 原 S1～S16 与单 L 旧路径 | Expected 不变、不 skip、不削弱；多 L 新行为不反向改写旧断言 | 既有套件、逐表快照 |
| D15 | 篡改 D6 的 `root_identity_id/long_identity_id`/source 内嵌锚，或删除持久 origin entry 使证明链不足 | 字段与 source 锚/存活根/持久 origin/derivation/消息任一矛盾 → unavailable；不取字段或第一条 link 猜根；无正文证明不足不继续 | entry links/source-context/derivation |
| D16 | 篡改 D13 的旧 entry 关联 root/own L，或删除历史根证明 | 新 entry 不因旧行篡改改变；旧历史不覆盖不丢；矛盾条目 unavailable；不按字段猜根 | entry links 行数/root/own L/source-context |

Mock 只替换聊天与关系模型 HTTP；不 mock 核心 store/chat/memory/source-context。Oracle 独立断言业务状态，不以 HTTP 200 或 exit 0 代替。

### 13.8 分步、文件、接口与规模

| 批 | 允许文件 | 内容 | 生产规模 |
|---|---|---|---|
| 2c-2a | `memory-store.cjs`、`memory-temporary.cjs`、`memory-source-context.cjs`、`memory.cjs`（keepExclusive）、同 Runner | entry 关联表/迁移/回填、单 L 回退、root+own L、多 L 有效性与 stage1/edit/exclusive 领域切片 | 170～230 |
| 2c-2b | `chat.cjs`、`chat-memory-verification.cjs`、`memory.cjs`、`memory-temporary.cjs`、同 Runner | 阶段 0 长期锚、temporary proof、阶段 2、context 精确放行、整笔回滚、单 assistant | 110～160 |

- store：`insertTemporaryEntryLink`、`getTemporaryEntryLink`、`listTemporaryEntryLinksByIdentity`、迁移回填函数；旧 `insertTemporaryLink`/查询保持。
- temporary：`linkOfEntry(entry)`、`holderLong(holder,L,now)`、`applyUnderstanding`、`editUnderstanding`、`propagationSource`；`memory`：`applyConfirmedTemporaryCorrectionToHolders`、`verifyOperationProof` temporary 分支、多 L `keepExclusive`。
- chat：`twoPhaseTemporary`、temporary proof 构造/`proofCurrent`、阶段 0 `captureTemporaryTargetEvidence`；候选去重复用 identity 规则。
- 先写失败基线；S1～S16 不重写 Expected。规模按最小职责估算，不是机械上限；超出先报告职责与拆分，不靠压行/删断言。

### 13.9 局限

- 2c-2a 与 2c-2b 已分别由 master 独立复验并受托接受为已测有限能力；temporary 专属 cancel/close/dispose/recover、真实模型 L1/L2、GUI/UI IPC/live 仍未覆盖。2c-1 的 295/295 与 S1～S16 只证明单 T 单 L 已测路径，不据此判其失败。
- 真实模型 L1/L2、GUI/UI IPC/live、完整 S03 与 `POL-SEMOP-001～008` 聚合仍 NOT_COVERED；本方案不改变这些边界。

### 13.10 2c-2a 实施记录（r43，历史；master 已退回，不接受）

- 范围：只实现 §13 的 2c-2a 领域与迁移，改 `memory-store.cjs`、`memory-source-context.cjs`、`memory-temporary.cjs`、`memory.cjs` 临时相关部分；未改 chat 阶段 2、proof、关系协议、GUI、版本或 Git。
- 实际净增 **520 行**（允许 450，超出 70）：store +114、source +128、temporary +188、memory +90。超出集中在多 L 写入/操作：stage1 逐成员保留 own L、edit 全成员、relay/share 写 entry 关联、exclusive root 版本同步与父删除后的持久 derivation、以及 source 对新旧快照/旧单 L 回退的交叉核验；未压行或删断言。
- 测试证据：聚焦两套件 **97/97、0 fail、0 skipped、exit 0**（`evidence/s03m-2c2/attempt-20261027-192333-2c2a-focus-final2/`）；既有 20 相关套件 **324/324、0 fail、0 skipped、exit 0、before/after SHA 一致**（`evidence/s03m-2c2/attempt-20261027-192339-2c2a-regression20-final2/`）。
- 覆盖：D2（多 L 全成员同步、双锚不重复、exclusive 自身 root 与 root 在他人处被删）、D6（root/own 分离、root long 与 origin current 同时删除仍凭持久 entry/derivation/消息证明、holder 锚删除/版本变化）、D7（forget-only/restrict-only/exclusive/no-control 独立对照）、D8（本人全部 L self 删除）、D9（单 L 回填、缺证多 L 不猜、读取回退、失败整笔回滚）、D11/D12（多 L 再次改口、编辑、转告、失效后长期恢复）、D13/D16（entry 历史、own L 计数、另一 L 不动、篡改）、D15（root/own/source 锚与 derivation 矛盾）、新旧临时快照 digest/isCurrent 兼容、D14 既有 S1～S16 回归。
- r44 已按 master 受托澄清移除上述保守拒绝：无 holder 锚的 relay 成员在 root 轮换时保留 own L、root 随本轮来源更新，可继续解析/编辑/转告；历史 origin 关联校验见 13.3。
- 仍未覆盖：D1/D3/D4/D5/D10 的阶段 2 行为、2c-2b（proof/原子回滚/单 assistant/contextVersion 精确放行）、真实模型 L1/L2、GUI/UI IPC/live、完整 S03；`POL-SEMOP-001～008` 聚合仍 NOT_COVERED。本记录只说明实现与测试结果，不构成 master 验收或产品通过。

### 13.11 2c-2a r44 返修记录（历史；master 已复验并接受有限能力）

- master 退回三点：①root long 与 origin current 均删除时 copy/edit 只凭本条 root 字段自证；②relay 无锚成员在 root 轮换时被 own≠root 粗暴回滚；③isCurrent 对无 temporaryKind 的旧 direct current 快照不兼容（digest 纳入 holderLongIdentityId 后失效）。
- 反例先行：`evidence/s03m-2c2/attempt-20261027-192748-r44-reverse-baseline/`，14 tests / 4 pass / 10 fail，真实失败为旧 direct 快照、5 个历史关联负例、无锚 C 轮换；旧 r43 证据保留。
- 修正：copy/edit 在 origin current 删除时读取并校验 `originCurrentEntryId` 的历史 entry 关联行（T/holder/expiry/own/root 六字段）+ 持久 derivation/消息链；无历史行仅兼容旧单 L。无锚成员 root 轮换时保留 own L、更新 root，不再回滚；首次创建仍 own=root。isCurrent 对旧 direct current 按 `corrected_v2 + direct + 缺 holderLongIdentityId` 回填摘要，copy/edit 旧形状同样兼容，旧普通 direct/corrected 不变。
- 结果：反例 14/14；聚焦两套件 **108/108、exit 0**（`attempt-20261027-192857-r44-focus/`）；20 相关套件 **335/335、exit 0、before/after SHA 一致**（`attempt-20261027-192907-r44-regression20-final/`）。生产净增 **505**（store +114、source +125、temporary +176、memory +90），高于 450 共 55，低于本次允许上限 650。
- 仍未覆盖：2c-2b、阶段 2 proof/原子回滚/单 assistant/contextVersion 精确放行、真实模型、GUI/UI IPC/live、完整 S03；`POL-SEMOP-001～008` 聚合仍 NOT_COVERED。

### 13.12 2c-2a 有限能力受托接受与当前口径（2026-10-27 r45）

- master 证据：[master-multil-final-ZLv9fbBn](evidence/master-multil-final-ZLv9fbBn/stdout.log)。master 对最终工作区独立运行 20 相关套件：**335 tests / 335 pass / 0 fail / 0 skipped、真实 exit 0**，before/after SHA 相等，当前 after 清单 `shasum -c` 通过。
- 受托接受范围：**2c-2a 已测存储/来源/操作有限能力**，即 D2、D6、D7、D8、D9、D11、D12、D13、D15、D16 的本地存储、来源认证与 memory 管理操作部分，以及 D14 的既有 S1～S16 回归。不是用户亲自确认，不是真实模型语义，不是 GUI/UI IPC/live，也不接受完整 S03。
- 生产净增 **505 行**（store +114、source +125、temporary +176、memory +90）已由 master 审阅 diff 后认可为必要职责与可读性；不做压行。
- **仍未实现/NOT_COVERED**：2c-2b（真实 chat 两阶段、temporary proof、contextVersion 精确放行、阶段 2 原子回滚、单 assistant、候选去重/HTTP 预算）；D1/D3/D4/D5/D10 的阶段 2 行为；真实模型 L1/L2；GUI/UI IPC/live；完整 S03 与 `POL-SEMOP-001～008` 聚合。
- Polaris 复盘：本批真实使用了 Case/失败基线/独立复验机制，捕获了测试夹具错误、origin 双删自证、isCurrent 旧 direct 兼容与 relay 无锚 root 轮换的计划歧义；后者由 master 受托决定澄清（relay 无锚 own=root 仅首次创建，轮换后保留 own L、root 随来源更新）。现行 skill 能支持这些发现与返修，无新 skill 缺陷，故不修改 skill。
- 历史记录：r43 整体被退回、r44 三处反例返修；旧 attempt 与失败全部保留，不覆盖、不补造 PASS。

### 13.13 2c-2b 有限能力受托接受与当前口径（2026-10-27 r50）

- master 证据：[master-temporary-chat-OKCwajaU](evidence/master-temporary-chat-OKCwajaU/stdout.log)。master 独立复跑 20 相关套件：**358 tests / 358 pass / 0 fail / 0 skipped、真实 exit 0**，before/after SHA 相等，当前源码对照 after 清单一致。
- 受托接受范围：**2c-2b 已测真实 chat/SQLite + 构造 HTTP 有限能力**。已实际执行 D1（临时阶段2 left 用旧长期）、D2/D10（已触碰 B、同 L 双锚、不同 L、同 L 的 C、同 L 未知 holder 过滤）、D3（阶段1已触碰 B 的额外 context stale、无额外变化对照、无关角色变化对照）、D4（第二候选 trigger 实际命中、阶段2全回滚、阶段1保留）、D5（未结识角色/同 L 未知 holder）、D11（阶段2后再次改口用 own L 长期锚、多 L 同步、来源有效），以及审查反例：corrected_v2/传播锚、派生链 narrator/parent/source 篡改、T 受限既有 holder 另一 L、全部控制跳过 applied=0、proof holder 集合/root/expiry/来源/候选标识、D4 UDF 命中。
- 共用机制与专属 Case：chat 请求取消、close/dispose、旧 pending 恢复等既有共用机制由 20 相关套件回归覆盖；**temporary 专属 cancel/close/dispose/recover 组合未单独执行，仍 NOT_COVERED**，不因共用机制回归而视为通过。
- 生产净增 **748 行**（chat +237、verification +127、temporary +206、memory +178）经 master 职责审查认可为必要的来源/证明/事务/流程职责；本批**不再代码重构**，原超规模迟报保留，master 已裁决接受该规模。
- 未覆盖：temporary 专属取消/恢复 GUI 真实链、真实模型 L1/L2、UI IPC/GUI/live、跨角色独立同义、完整 S03 与 `POL-SEMOP-001～008` 聚合。
- Polaris 复盘：本批问题属于实现资格、测试夹具与规模迟报；master 的实际退回与独立复验证据保留。现行 skill 能处理这些发现，无新 skill 缺陷，故不改 skill；不将任何自动/Agent 结果记为用户人工确认。
