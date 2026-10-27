# S03m 显式纠正/忘记的语义核验最小纵向切片（v1）

2026-10-27，master 受托确认 POL-SEMOP-001～008 v1 及 Part A/B（不是用户亲自确认）。两阶段：阶段 1 本地已完成；阶段 2 系统核验独立候选，合格关联/操作在第二事务原子。阶段 2 失败不回滚阶段 1；只更新同一条 assistant 消息，不追加第二条。自动整理/定向共享/完整召回仍后续承接。本文件已并入 r3 审查的三处接口修正：关联后事务内版本重读、correct temporary 路径、corrected_v2 来源归属与 isCurrent。首批已按 §8 收口：master 19 套件 185/185 受托接受来源追溯与协议的已测有限能力；2a 长期 correct 两阶段的确定性业务流程亦已由 master 独立 28/28、0 skipped、exit 0 与 GUI 14/14 受托接受为**已测有限能力**。008 聚合仍 NOT_COVERED（部分已验），下一批 2b。

## 1. 实际契约与调查事实

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
- **correct temporary**：不得走长期 correct 的传播/合并路径，不得永久覆盖长期偏好。阶段 1 保留长期条目并创建/更新当前角色的有到期当前理解（现有 `.current` 行为）；阶段 2 只对已证明持有同一原事实的候选持有者创建/更新有到期的当前理解，不合并长期与临时 identity，不新增未知角色。临时来源使用真实的 `chat-current:` 带时效格式，来源快照可核验；到期后 `isCurrent=false`，长期条目与历史经历保留。
- **forget 阶段 2**：不关联已删锚；对每个去重后的合格候选 identity 直接执行 `forget`。self 只处理原角色自己持有的候选（`scope='self'`，不跨角色删除）；默认 all 才处理其他持有者（`scope='all'`）。多个候选同一第二事务，任一失败整笔回滚阶段 2。
- 候选版本/来源/成员变化 → 该候选未确认；不报告全局成功。阶段 2 失败/取消/重启 → 只把同一 assistant 消息原位更新为“本地已完成；其他相近内容未继续核验”，阶段 1 数据保留。阶段 2 成功同样只原位更新该消息，不追加第二条。
- 最小澄清直接说明具体事实，例如“如果你也想把另一条关于咖啡的内容一起处理，请直接告诉我它的说法”，不加按钮、不加待办。

### 2.3 来源追溯（008 必需）

- 保留 `chat-correct:` 前缀与旧测试；解析内嵌 `chat:<messageId>`，核对角色、会话、消息 source_id、role=user、来源版本与正文证据。**不改 correct 既有正文/分句行为**。
- 纠正正文可能由规范化分句拼接，不要求连续子串；来源证据用有限 `segments/offsets`（复用现有纠正提取逻辑重算），每段必须是原话实际片段，按生产 join("，") 逐字重建 `memory.body`（不删除 C++/C、小数、负号等词内符号）。不得假称拼接内容是连续原话，也不额外持久化正文；segments 只是内存证据，含原话。
- `corrected_v2` 明确区分：`sourceAnchorEntryId`/`sourceAnchorVersion`/`sourceAnchorIdentityId`（来源锚）、`sourceCharacterId`（说出原话的角色）、`holderCharacterId`（持有条目的角色）、`entryId`（被核验条目）。`isCurrent` 必须以 `holderCharacterId + entryId` 定位并重解析，不能用来源角色去读持有者条目；digest 覆盖锚 identity/版本/segments/消息内容/持有者/条目版本。
- 传播副本沿 identity/关系**实际核验**到当前 `chat-correct:` 锚；可由 derivation 或 relation edge/同一已证明 identity 证明，不能仅凭 sourceCharacterId≠holderCharacterId 推断派生。`direct=false`、`via="identity_correction"`；来源角色与持有角色相同也可为派生，需按关系判断，不冒充直接告知。
- `chat-current:` 是本片临时纠正所需的真实带时效来源格式：解析内嵌 chat 消息、当前事实条目/版本、`expiresAt` 与 segments；到期后 unavailable，长期条目不受影响。外部来源仍 unsupported 边界。
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
- 传播副本通过 `factIdentityId` 找唯一当前 `chat-correct:` 锚，并核验 derivation/relation edge 或同一 identity；多个/缺失/关系不成立 → unavailable。`chat-current:` 支持带 `expiresAt` 的临时来源，到期 unavailable；外部来源仍 unsupported。

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
- `applyConfirmedTemporaryCorrectionToHolders({sourceCurrentEntryId, targetEntryIds, nowMs, inTransaction})`：临时纠正专用；重读来源当前事实（body/trust/expiresAt/来源消息），为每个已证明持有同一原事实的持有者创建/更新 `.current` 事实；不合并长期 identity，不新增未知角色；sourceId=`chat-current:<targetEntryId>:<nowMs>:chat:<messageId>`，带 `expiresAt`；返回 finalVersions。
- `forget` 继续用现有接口；阶段 2 按候选 identity 去重后调用，self/all 由操作 scope 决定。
- `verifyOperationProof` 对 temporary 使用当前事实条目/版本与 `expiresAt`，不把长期锚当临时证明。

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

1. 阶段 1 已创建/更新当前角色的 `.current` 事实并保留长期条目；proof 记录当前事实 entry/version、长期条目、`expiresAt`、来源消息。
2. 阶段 2 只对已证明持有同一原事实的候选持有者调用 `applyConfirmedTemporaryCorrectionToHolders`；不关联长期 identity，不改长期条目，不新增未知角色。
3. 同一事务更新 assistant 消息与 verification_status；失败回滚阶段 2。到期后来源/当前理解不可用，长期偏好恢复为唯一有效长期内容。

## 5. Part B：验收计划

- **B1 确定性**：真实 `createStore`/`chat.sendMessage`/SQLite + 本机 HTTP；覆盖 001～008 全部子项，含 001d 临时到期/隔日、004d 多候选连合、008 连续原话与多分句；003 走最小 renderer/IPC + 专属 GUI（阶段 1 先显示、阶段 2 原位刷新、取消/关闭/重启）。所有 request/proof/status/消息/逐表断言独立。
- **B2 L1**：构造聊天 envelope，关系真实 DeepSeek；**B2 L2**：真实 chat + 真实 DeepSeek 全链。两者都执行，凭据已有授权，master 安排；1 次/操作、无重试、15s。负例含 A/B 同一句“我”、旧 06/11、同主体不同时间、否定、参与者不完整；正例含不同 factKey 同义。Expected 不发送、不修改。
- L2 falseMerge 必须 0；未匹配正例如实 FAIL。最多两轮有依据调整（候选/证据/门），无收益保留失败并换方案，不无限调 prompt。构造数据全绿也不称语义完成；候选召回提升另列后续。

## 6. 三个最小实施批次（每批独立验收，不冒充父级完成）

1. **来源追溯与协议兼容（首批）**：source-context corrected_v2/segments/传播追溯/`chat-current`、关系协议兼容分支、`locateCorrectionSegments` 与只读来源核验；先写失败测试，覆盖 008a/b/c 全部子项及旧 direct 兼容；不先造未使用的 request 状态字段。已有来源问题具备真实入口，可独立验证。
2. **真实两阶段 correct+forget（含 temporary）**：request 字段/迁移、消息原地更新、阶段 1/2、proof、scope self/all、cancel/dispose/close/recover、sendMessage 提前返回、main/preload/renderer 最小事件；覆盖 001/002/003/004/005d/006/007 与专属 GUI；本批才接入状态字段。
3. **真实模型 + GUI 联合**：L1/L2、正负对照、falseMerge 门禁、真实窗口阶段 1 显示与阶段 2 原位刷新；005/008 P0 纳入；不宣称 S03/语义完成。

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
- **2b（下一批）**：`forget` 的候选自身 identity 删除、`temporary` 的到期当前理解传播、对应来源/权限/版本语义、真实模型 L1/L2 与 GUI 全链；不在 2a 提前铺字段或实现。
- **2a Case 映射**：001a correct 正链路、001b 隔离、001c 传播来源；003a 提前返回/单消息、003b 提交前取消/阶段 1 后取消、003c dispose/close/暂停/重启；004a correct 锚失效、004b 候选变化、004c 阶段 2 故障回滚、004d 多候选连合；005a/b/c/d 主体/时间/权限正负；006a/b 请求频率/超时/取消；008 同角色派生实际路径与真实 association 后来源重解析。002、001d、004a 的 forget 部分留给 2b。Case 聚合不因 2a 子项通过而标整组 PASS。

### 9.1 2a 旧事实证据复核（master 中途审查修正）

- 阶段 2 的模型输入必须是阶段 0 捕获的 A 旧事实 snapshot 与 B 旧事实 snapshot；阶段 1 的新正文只用于 proof 核对当前纠正结果，不能冒充旧事实。
- 旧 target snapshot 在阶段 1 correct 后 entry version/source 必然变化，不能直接要求 `isCurrent`。新增窄检查只核对不应由本操作改变的证据：原 chat 消息与有限前文内容/归属/时间未变、segments 仍逐字可重算、来源控制集合等于阶段 0 捕获集合加上本操作新增的旧 source 哈希；不提供通用“忽略权限”开关。无法证明则本地完成并标注未核验。
- 候选证据捕获整组成员 entryId/version/sourceId、每成员 source snapshot 与来源控制集合，并记录阶段 1 对每个 holder 的确切旧 source 增量；重核时只容许该增量，其他后续控制变化拒绝。第一关联前重核代表、全部成员、消息/context 与权限；凭据返回后、发送核验前再次复核并剔除失效候选，全部失效则不发 HTTP。网络等待期间任一变化 → 该候选未确认，不应用旧结果。
- 同角色 identity 的非锚成员来源必须是 `corrected:`、`direct=false`、`via=identity_correction`，sourceAnchor 指向发起条目的 chat-correct 锚；仅选中 held 条目为直接来源。旧版 `chat-correct` 指向其他 id 时按同身份同正文、旧锚存在/stated/user/未过期/实际 source 一致兼容，不再冒充直接告知。
- 证据复核同时核对原 chat 消息的 conversationId 与 `chat:<id>` 来源归属；候选仍 fresh 时优先用 `isCurrent`，只有阶段 1 造成的必要变化才走窄证据检查。
