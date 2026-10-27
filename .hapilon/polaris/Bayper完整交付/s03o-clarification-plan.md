# S03o r2 记忆操作澄清承接修订方案（S03o-A 已获有限接受，其余未批准）

## A. master 受托决定：S03o-A 垂直可验切片（2026-10-27）

- 整体 r2 不批准；仅批准 S03o-A：**单轮明确 correct 在模型显式 `memoryOperation:null` 时复用本地核验补全**，重点 C03。不实现 pending/多轮/source 拆分/forget 自动补全/renderer。
- 仅当本轮唯一 correct 意图、唯一 target、唯一完整新内容、无歧义时生成本地建议；仍走既有候选、`resolveTarget`、`correctionAnchor`、`correctionBody`、主体/时间/否定/来源/版本约束与两阶段核验。非法 operation 不兜底，模型正常 operation 不变。
- 模型 reply 不参与授权或判真；null 时只看本地输入是否足够。最终 reply 来自本地事务结果；未经执行不得透传成功。
- Case：`POL-CHATMEM-CLARIFY-002` 及子项 002a～002h；不改 C02/C03/C07 原数据与 Expected。生产预计 60～120 行、测试 150～260 行；超出先报告。
- 实施结果：生产净增约 150 行（`chat-memory-operations.cjs` +192/−46、`chat.cjs` +4），超出 120；新增内容为共用 `correctionPlan`、显式 null 补全和问句/时间守卫，未建立通用框架、未压行。测试净增 608 行（chat 128、semantic 480），因 002g 拆为独立 setup/全库断言及非饮料正例，未压断言。
- 证据：原始生产反向 patch 基线目录 `attempt-20261027-225117-baseline-headprod/` **被跨次复用**，混合历史与可证实/丢失项见 `evidence/s03o-a/provenance-review-20261027-231443/README.md`，不得当单次基线引用（生产文件 SHA 仍与只读 `git show cec2498:file` 一致）；问句守卫变异基线 `attempt-20261027-230629-mut-question-guard-off/`、模糊时间顺序变异基线 `attempt-20261027-230637-mut-vague-before-local/`；实现后 `attempt-20261027-230842-final6-bounded/`（五套 277/277、均 exit 0、before/after SHA 一致）。
- **master 有限接受（2026-10-27）**：独立最终 `evidence/master-s03o-a-final-O584PFa8/` 五套 **277/277、0 skip、exit 0、before/after 一致**；live `evidence/master-s03o-a-live-Z7Y05M66/` **10 REVIEW / 1 FAIL（C07）**，44 chat + 10 relation + 1 models，模型为 `/models` 验证的 `deepseek-flash`；C03 原始 `memoryOperation=null` 后 actual/effective correct，A/B 长期 body/version 不变、两条当日 temporary `expires=1793116799999`，单 assistant 如实说明、关系 equivalent；falseMerge/wrongDelete/wrongSync/leak 均 0，11 临时目录无残留。接受仅限已测单轮明确 correct 本地补全，不是完整澄清/语义/S03；C02 本次成功不代表多轮澄清已修好，旧 C02/C03/C07 FAIL/Expected 保留。
- 未覆盖：GUI/live 泛化、多轮澄清/pending、自然指代、C07 分类、完整 S03 与 `POL-SEMOP-001～008` 聚合。版本 `0.1.200 → 0.1.201`（10 文件 11 处）待 snap；生产 150 行/测试 608 行经 master 审查为必要规模，本批不再重构。证据偏差见 `evidence/s03o-a/provenance-review-20261027-231443/README.md`。其余 r2 内容及第 9 节未解问题保留待后续。

## 0. r1 被拒原因与修订

1. r1 把“B 不变”写成 Expected，违背 REQ-61 与 SEMOP 的全持有者同事实核验传播。r2 改为复用既有两阶段 correct/forget/temporary：relation equivalent 且 B 已持有→按原规则同步；different/uncertain→不传播；未知 C→无新增。
2. r1 以问号+成功词黑名单证明“纯提问安全”，并可能透传模型 reply。r2 删除任意 reply 透传：澄清问题由本地依据真实缺失字段与候选生成，显示文本也由本地组织。
3. r1 默认 C03 必须多问。r2 明确 C03 单轮完成：模型 null 后，本地只对“明确、完整、可唯一解析”的指令执行确定性补全，仍走既有操作与两阶段核验；澄清仅用于真实歧义。
4. r1 复用原始 clauses 承接“最近→就今天”。r2 规定新回答必须参与目标/范围/时间；内容来源与回答控制来源分开记录，不把旧文本伪装成本轮来源，并对齐 corrected_v2。
5. r1 用候选 token 命中当确认。r2 改为封闭回答语法；新明确操作优先；含否定、第三人称、引用、假设或新事实的回答一律不执行旧 pending。
6. r1 lifecycle 不完整。r2 覆盖 cancel/close/dispose/retry/重启/超时/跨日/外部记忆变更/来源撤销/角色与会话隔离，复用既有版本与来源控制。
7. r1 的 <180 行约束可能牺牲需求。r2 拆成可独立验证批次，但每批必须返回父级完整业务链，不以局部测试替代。

## 1. 定位与不变量

- 父级 S03 未闭环。S03n 仅接受已测主体绑定防护与 source Case v2；C02/C03/C07 原真实 FAIL 与 Expected 全部保留。
- 本轮仅修订本方案与 `state.md` 顶部；不改代码/测试/工具/版本/Git/API/.env/skill，不用子代理。
- 不变量：模型建议不等于执行；只有本地事务结果能确认；不借澄清跳过关系核验，不从旧文本伪造新来源，不跨角色执行。

## 2. Case→现有真实执行链→需修改处

| 场景 / Case | 现有真实链路（复用） | 需修改处 |
|---|---|---|
| C03 明确临时更正（单轮） | `sendMessage`→`detectOperationIntent`→候选→模型 null→`planOperation` | 在 `planOperation` 前增加“明确完整指令本地补全”：唯一 target、唯一新内容分句、无不确定/假设/引用→构造 operation，后续完全复用 `applyChatOperation`+`twoPhaseTemporary` |
| C02 指代歧义（先问后接） | 同上；原本直接 `notProcessed` | 本地生成目标澄清并登记 pending；回答选择候选后本地构造 forget operation；证据用原命令，回答仅作控制 |
| 目标/范围澄清 | `planOperation` 的 `ambiguous`/scope 分支 | 改为结构化 pending：`missingFields: target/scope`；本地列出 M 编号或唯一候选；回答按封闭语法解析 |
| 时间澄清 | `planOperation` 的 `temporalClarification` | 仅当原内容无冲突时间词时接受纯时间回答；内容与回答时间冲突（最近→就今天）不得拼接正文，改为请求完整重述 |
| 两阶段正确/忘记/临时 | `twoPhaseCorrect/Forget/Temporary`→`captureTargetEvidence`/`captureCandidates`→`verification.verify`→阶段 2 传播 | 不改传播规则；新 Case 的 Expected 按 equivalent/different/uncertain 三态断言 |
| 生命周期 | `cancelRequest`/`closeConversation`/`dispose`/`retryRequest`/`recoverInterrupted` | pending 在对应入口清理或保持一致；复用 `contextVersion`、`listExcludedSources`、entry version |

## 3. 结构化承接契约

### 3.1 单轮明确指令（C03）

模型返回 null 时，本地按以下条件补全，不提问、不增加模型调用：

- `detectOperationIntent` 已给出唯一 action；`resolveTarget` 对原话只命中唯一候选；
- correct 时存在唯一“新内容分句”：剔除命令分句后，positive tokens 不全属于旧正文的分句；`correctionAnchor`+`correctionBody` 能生成合法正文；
- 无不确定词、假设、引用、否定操作或主体不明；forget/restrict/keep 无需正文。
- 生成与模型建议同形的 operation，交给既有 `applyChatOperation`；correct 仍经 `captureTargetEvidence` 的 corrected_v2 与两阶段核验。任一条件不满足则进入真实歧义澄清或如实未改动。

C03 因此单轮达到原 Expected：`不是咖啡，我今天想喝茶，请帮我改过来` → 唯一 M1、唯一新内容 `我今天想喝茶` → temporary，长期不动，按关系结果同步 B。

### 3.2 真实歧义的本地提问

只有本地能指出具体缺失字段时才提问；问题文本由本地模板和真实候选生成，例如：

- 目标：`“喜欢咖啡”我只找到一条：[M1] 我平时喝咖啡一定要加糖。要忘记第 1 条吗？回复“第 1 条”或“加糖那条”。`
- 范围：`这次只让你自己忘记，还是所有已持有的角色一起？`

不得读取或转述模型 reply 作为问题。pending 记录：`{characterId, conversationId, originalRequestId, originalUserMessageId, originalSourceId, action, authorizedText, clauses, missingFields, candidates:[{target,entryId,version}], createdAt, answerTurns}`。不新增公共 API 字段，不做 DB 迁移；pending 为 chat service 内存状态。

### 3.3 回答语法与来源

- 只接受封闭回答：M 编号/`第1条`；唯一候选下的`对/是/就这条`；纯时间`今天/今晚/就今天`（仅当 pending 问时间且原内容无冲突时间词）；取消词。
- 描述式选择仅接受整句形如`<唯一候选短语>那条/这条（吧/就行）`，且不得含操作动词、否定、第三人称/归属、引用、假设或新事实。`加糖那条不要删`、`加糖那条是我朋友的`、`“加糖那条”`、`如果加糖那条` 均不执行。
- 新明确操作优先：回答若被 `detectOperationIntent` 识别出 action，先清 pending，按新命令处理；不得把新事实并入旧授权。
- 不唯一、含新事实或超出封闭语法：清 pending，按普通回合处理或一次如实未改动，不猜选。
- 来源拆分：`contentSourceId`（正文来源）与 `controlSourceId`（回答选择/时间/范围）分开。forget 用原命令作 `commandSourceId`；correct 正文来自原命令时 sourceId 保持原命令，corrected_v2 仍从原消息分句重算，回答不得冒充正文来源；若回答提供完整新正文，则按新命令用回答 sourceId。
- `最近→就今天`：原正文含“最近”，纯时间回答不足以改写正文；不得拼出“我今天想喝茶”。要么请求完整重述（新命令），要么保持 pending。原正文时间中性（如“我想喝茶”）时，可保留正文并用回答时间计算 `expiresAt`。

### 3.4 防虚称

- 模型 null 时只判断**本地输入是否足够执行**；模型 reply 不参与授权、判真或是否本地执行，也不得展示为已执行。
- 本地补全、执行确认均由本地生成；执行确认必须来自 `operationReply` 与真实事务结果。未经本地执行，不得透传任何“已完成”文本。
- 澄清本身不写 proof、不改 verification 状态；只有正常 operation 路径才进入两阶段。

## 4. 两阶段核验与传播（必须复用）

| 动作 | equivalent 且 B 已持有 | different / uncertain | 未知 C |
|---|---|---|---|
| correct replace | A、B 同事实更新到新正文；旧来源控制保留 | 仅 A 更新，B 整行不变 | 无新增 |
| forget | A、B 同事实删除并加防回流控制 | 仅 A 删除，B 不变 | 无新增 |
| temporary | A 长期不变、产生今日临时；B 长期不变、同步今日临时 | 仅 A 产生临时，B 不变 | 无新增 |

- 复用 `captureTargetEvidence`/`captureForgetTargetEvidence`/`captureTemporaryTargetEvidence`、`captureCandidates`、`verification.verify`、`applyApprovedCorrection`/`deleteApprovedCandidates`/`applyApprovedTemporary`；不新增传播引擎。
- 关系核验失败/超时：阶段 1 结果保留，verification 如实 failed/stale，不显示“全部完成”，不向 B 传播。
- C 不在 `knownCharacters()` 内，不建关系、不建记忆、不通知。

## 5. 生命周期

- pending 按 `characterId+conversationId` 隔离，每会话最多一条；新明确操作、关闭会话、dispose、取消对应请求、超时（建议 10 分钟）、跨本地日即清除。
- `cancelRequest`：保持现有 completed 消息/请求生命周期，不旁路入库；若取消的是澄清请求或其在途回答，清 pending。`closeConversation`、`dispose` 沿用既有取消逻辑并清 pending。重启后 pending 丢失，因未执行任何操作，失败方向安全。
- `retryRequest`：失败的回答重试沿用 pending 快照并重新校验 target version/source；成功或取消后清 pending。
- 外部记忆变更/来源撤销：回答承接前用 `getHeldEntry` 复核 entryId、version、sourceId，并检查 `listExcludedSources`；变化/撤销则零写、如实提示、清 pending。跨日不得沿用昨日“今天”范围。

## 6. 验收 Case（2 阶段正反例）

| ID | Given / When | Expected（Oracle） | Execution Boundary |
|---|---|---|---|
| POL-CHATMEM-CLARIFY-001 | C02 原话→本地目标提问→“加糖那条”；关系 fixture equivalent | A、B 咖啡事实均删除，旧来源控制生效，C 无新增；两阶段各 1 次关系核验 | 真实 SQLite/chat；脚本 HTTP 模型 |
| CLARIFY-001b | 同上；关系 different/uncertain | 仅 A 删除，B 整行与版本不变；verification 如实完成但未传播 | 同上 |
| CLARIFY-002 | C03 原话；模型 null | 无澄清气泡；单轮 A 产生今日临时“茶”，长期行不变；关系 equivalent 时 B 同步临时，different/uncertain 时 B 不变；无 C | 同上 |
| CLARIFY-003 | 目标澄清后回答“加糖那条不要删”/“是我朋友的”/引用/假设 | 零写，不执行旧 pending；按新回合处理；B 不变 | 同上 |
| CLARIFY-004 | pending 存在时用户发出新明确操作 | 旧 pending 清除，只执行新命令；旧目标不被误改 | 同上 |
| CLARIFY-005 | 澄清后目标被其他会话更正/删除，或来源被撤销 | 零写、不显示成功、清 pending；stale/failed 如实记录 | 同上 |
| CLARIFY-006 | A 会话澄清后到 B 会话回答，或回答试图带上 B | 无 pending 承接；A/B 均不变；B 不进入候选 | 同上 |
| CLARIFY-007 | 时间澄清：原“我想喝茶”+“就今天” | 保留原文正文，expires=当日 23:59:59.999；长期不变；按关系传播 | 同上 |
| CLARIFY-008 | 时间澄清：原“我最近想喝茶”+“就今天” | 不拼造正文；请求完整重述或保持 pending；零写 | 同上 |

C02/C03 原单轮 Case 不改；CLARIFY-002 证明 C03 单轮，CLARIFY-001 证明真实歧义的一次承接。

## 7. 实施批次、允许文件、规模

- B1 结构化 pending、本地提问、封闭回答语法、生命周期清理（不执行操作）。生产约 100～140 行，测试约 150～220 行。
- B2 明确指令本地补全（C03）+ pending 承接执行 + content/control source 拆分。生产约 120～180 行，测试约 200～300 行。
- B3 两阶段三态传播、来源追溯、取消/重试/跨日/外部变更回归。生产约 20～40 行，测试约 200～300 行。
- B4 GUI/live 为独立批准批次，不计入本次实现。
- 允许文件：`app/chat.cjs`、`app/chat-memory-operations.cjs`、`tests/acceptance/chat-memory-operations.spec.cjs`；确需时再申请 `app/chat-memory-verification.cjs` 的只读 wiring。每批超过上限先报告，不以压行达标。
- 禁止：改 C02/C03/C07 原 Case/Expected、改评分工具、跳过两阶段、伪造 corrected_v2 来源、改版本/Git/skill。

## 8. 后续 GUI/live 证据

- GUI：真实 Electron/SQLite + 脚本模型，显示本地澄清、回答、最终确认与两阶段更新；不称人类体验。
- live：另行扩展 `tools/memory-tuning/chat-operation-cases.json` 与探针，增加 C12/C13 两轮回答和 relation equivalent/different/uncertain 对照；每 Case 记录实际 chat/relation 调用、DB 版本、B 同步与 C 无新增。
- 证据由 master 独立运行并落 `evidence/master-s03o-*`；本方案不自证 PASS。

## 9. 未覆盖与待审

- C02/C03/C07 原真实 FAIL 保留；C07 分类、自然姓名/弱指代、完整 S03 与 `POL-SEMOP-001～008` 聚合仍缺口。
- S03o-A 仅证明“显式 null + 本地完整明确 correct”单轮可执行；不证明 pending、多轮、forget 自动补全或自然低负担全部达成。
- r2 后续必须保留的未解问题：`最近→就今天`不能永远以要求用户重述冒充自然承接；scope 默认 all，不新增无谓范围问询；两阶段关系只发一次，不是每阶段各一次；B 未知与已知但不知道都不得新增；pending 语法不得仅 token 匹配；旧原件与时间回答的来源防回流仍需设计。
- 待 master 审核：S03o-A 实现证据与是否 snap；其余 r2 契约与批次仍未批准。
