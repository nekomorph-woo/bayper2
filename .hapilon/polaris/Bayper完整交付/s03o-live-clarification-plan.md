# S03o 真实删除目标澄清两轮链验证方案（r3，master 退回规模后精简）

## 0. 本轮状态与退回记录

- 基线 HEAD `0eb6d8a`、VERSION `0.1.202`；S03o-B 已 snap。正式验收 ID：**POL-LIVE-CLARIFY-001**；工具数据 ID：`C12`。
- 上一进程由 master 明确 SIGINT 停止，不是超时；12284 已终态。实际 probe 净增 **359**、dataset **46**，超过原 170/220 上限且未先报告，本批不接受。
- 退回时工作区、SHA、diff、行数、node check 结果与失败状态已保存到
  `evidence/s03o-live-clarification/attempt-20261028-002148-review-reject-size/`；改前 L1/L2 dry 仍保存在
  `attempt-20261028-001640-prechange-baseline/`，均不覆盖。
- master 修订批准：probe 净增 **≤280**、dataset **≤50**、README **≤25**，三文件合计 **≤355**。若按实际所需观测预计仍不能满足，先报告理由并停止，不写过线后再解释。
- 允许文件：本计划、state、`tools/memory-tuning/chat-operation-probe.cjs`、`chat-operation-cases.json`、`README.md`。禁止生产/测试/版本/Git/skill/.env/API/子代理；只跑 dry，不跑 live。

## 1. 精简原则

1. **证据只保留原件**：完整请求已在 `record.requests.chat/relation`，完整 DB 已在
   `snapshots.before/firstTurnAfter/after`。每个 turn 只存 `requestId`、`turn`、索引、证明和变化表摘要，不复制 request 数组或 DB 快照。
2. **绑定唯一**：`chatEnvelope` 必须同时匹配 `caseId + turn + holder`；首回合只读 `turn="operation"`，回答只读 `turn="followup"`，不得读其他 Case 或其他 turn。
3. **复用**：`assistantState`、`readProof`、`settleRequest`、`snapshot`、`changedTables`、`relationFromCall`、`markFlags`、`checkLeak`、`waitUntil`。不建通用 Runner/状态机/多层 trace。
4. **旧 11 不动**：C01～C11 原话、Expected、评分路径与输出字段逐字/逐义保持；旧记录不新增 `turn`、`clarification`。
5. **不压行**：通过删除重复证据和重复读取实现精简，不删必要断言、不合并晦涩语句。

## 2. Part A：技术设计

### 2.1 参数、数据与预算

- `parseArgs` 增加 `--case <ID>`；非法格式或未知 ID 明确失败。
- `readDataset` 为 C12 单独校验 `expected`（首回合）与 `followup.expected`（回答回合）；C01～C11 走原校验。
- `buildPlan(cases, mode)` 按实际选中的 Case 列表计算：
  - `seedTurns.a = prelude + 1`，`seedTurns.b = prelude + 2`，`operationTurns = 1`，回答聊天 0；
  - L2 live chat 上界 = 各 Case 的 `seedTurns + operationTurns` 之和；L1 live chat 0；
  - relation 上界 = 选中 Case 数；models 每次运行 1 次；
  - 不硬编码 48/61，结果以 `plan` 输出为准。
- C12 数据沿用 C02 的 A/B 原话与删除命令，新增：
  - `operation.l1ModelOperation: "null"`、独特假成功 `l1Reply: "MODEL-FAKE-SUCCESS-C12-已删除"`；
  - `followup.text: "加糖那条"`、`followup.expected`（A/B 删除、C 无新增、回答聊天 0、relation 恰好一次、双 source）。
- L1：聊天 fixture 明确 null，relation 真实；L2：聊天与 relation 全真实；dry：两者都是本机 fixture。
- Expected、match 等只做本地评分，不进入聊天/关系消息；L2 只发送 prelude/utterance/operation.text/followup.text/privateMarkerUtterance。

### 2.2 两轮流程与绑定

1. 种子写入后保存 `snapshots.before`；首操作前显式给 `chatFixture.trace` 与 `spy.trace` 同时设置
   `holder="a"`、`turn="operation"`。
2. 首回合 `sendMessage` 后先 `settleRequest`，再保存 `snapshots.firstTurnAfter`、首回合
   `readProof`、`assistantState`。未提问、直执行、失败分支都先等待已启动核验，不能提前 dispose 取消。
3. `chatEnvelopeForTurn` 只匹配 `caseId + turn + holder`，返回 `{ status, raw, modelOperation, reply }`：
   - `status="missing"`：没有对应请求；
   - `status="invalid"`：响应不可解析，或 `memoryOperation` 字段缺失；
   - `status="ok"`：字段存在；`modelOperation === null` 是显式 null，非 null 是模型直执行。
   - 禁止 `?? null` 把缺字段/解析失败吞成 null。
4. 首回合显式 null 且无问题：
   - 记录实际请求中的候选文本（system 消息中的 `[M…]` 行）、seed A/B 事实、`expected.candidates`、模型 null、回复；
   - 使用 C12 已批准 Given/Expected 判定前提：seed A 成功、请求候选含预期咖啡候选、命令为 forget、候选数 1；
   - 前提齐全却无问题 → **FAIL**；
   - 前提证据不足 → **INCONCLUSIVE**，列出缺口；
   - 若已观察 memory 写、relation 调用、首回合 proof、assistant 越界或 L1 假成功泄漏，**任何一项都直接 FAIL**，不得降为 INCONCLUSIVE/NOT_COVERED。
   - 不 import `detectOperationIntent`/`forgetTargetClarification` 充当期望判定器。
5. 回答前再次显式设置两套 trace 的 `holder="a"`、`turn="followup"`；发送 `followup.text`，等待核验收束，再保存 `snapshots.after`、回答 proof、assistant。
6. 最终 assistant 内容不得仍含“正在核对”；followup 核验状态不是 `completed`（独立身份场景）必须 FAIL。核验等待由 `settleRequest` 完成，不取消、不提前快照。
7. B 为独立身份：relation 必须恰好一次。零 relation 且 B 被删除 → `wrongDelete`；零 relation 且 B 保留 → 失败；不得把 `not_exercised` 当成功。
8. 来源：`sha256(actual sourceId)` 与生产 `sourceHash` 算法一致；proof 的 `commandSourceId/Hash` 必须对应原命令；`sourceControls.a` 缺失或未包含原命令/回答两个哈希均失败；`excluded` 必须包含两者。

### 2.3 输出（不复制原件）

C12 增加 `clarification`，只含摘要与索引：

```text
clarification.path, facts, outcome {aDeleted,bDeleted,cEntries,relationActual}
clarification.firstTurn:
  requestId, turn, chatRequestIndex, relationRequestIndexes,
  status, verificationStatus, memoryApplied, reply,
  modelOperation {status, source, raw, operation}, proof,
  assistant {before, after}, dbChangedTables
clarification.followup:
  requestId, turn, chatRequestIndex, relationRequestIndexes,
  status, verificationStatus, reply, proof,
  assistant {before, phase1, final}, dbChangedTables,
  relation {expected,actual,raw,pairs},
  sources {commandSourceHash,commandSourceId,answerSourceHash,excluded,sourceControls}
```

- 完整 chat/relation 请求仍只在 `record.requests.chat/relation`；完整 DB 仍只在三个顶层 snapshot。
- `chatRequestIndex`/`relationRequestIndexes` 在 finally 的 `attachRequests` 之后按 requestId/内容绑定，唯一指向原件。
- 旧 C01～C11 不出现 `clarification`、不增加 `turn`。

### 2.4 状态与覆盖矩阵

- 正式矩阵只用五种状态：`PASS`、`FAIL`、`ERROR`、`INCONCLUSIVE`、`NOT_COVERED`。
- 模型直执行：`path="model-direct-operation"`，澄清正式状态 `NOT_COVERED`；工具可计 `metrics.notTriggered`，但不设 `not_triggered` 正式状态。
- 前提齐全无提问：FAIL；证据不足：INCONCLUSIVE；已观察越界写：FAIL。
- 种子提炼失败：L2 FAIL，不重试、不改种子。
- C12 dry 为 `DRY-RUN`；L2 完整两轮为 `REVIEW`（交 master 语义审查）；L1 live 完整两轮才可能 `PASS`。本轮不跑 live。
- 工具退出码：PASS/REVIEW/DRY-RUN 为 0；FAIL/ERROR/INCONCLUSIVE/NOT_COVERED 为 1。退出码不代表业务验收。

### 2.5 文件与规模

| 文件 | 预计净增 | 实际净增 |
| --- | --- | --- |
| `chat-operation-probe.cjs` | ≤280 | 280（867→1147） |
| `chat-operation-cases.json` | ≤50 | 46（292→338） |
| `README.md` | ≤25 | 20（217→237） |
| 合计 | ≤355 | 346 |

- 实施前若按实际观测预计超限，先报告并停止。
- 删除退回版本中的每 turn request 数组、重复 top-level effects、重复 operation proof/modelOperation，以及重复的请求/关系过滤函数。
- 不新增测试文件；验证用 dry 与命令行错误路径。

## 3. Part B：验收计划

### 3.1 正式 Case POL-LIVE-CLARIFY-001

| 子契约 | Given / When | Expected | Oracle | Boundary |
| --- | --- | --- | --- | --- |
| 001-first | C12 A/B 事实；L1 首操作 fixture 显式 null；L2 真实模型；用户发删除命令 | 本地单候选问题；memory 零写；relation 0；assistant +1；L1 假成功不泄漏 | 首回合 reply 含“我只找到一条…”与 `[第 1 条]`/“加糖”；`memory_*` 不变；proof null；请求候选文本含预期候选；L1 断言假成功不在回复 | 真实 SQLite/chat/store；L1 chat 构造、relation 真实；L2 全真实 |
| 001-followup | 首回合出现本地问题；发送“加糖那条” | A 删除；B 独立身份 relation 恰好一次且 equivalent 时删除；C 无新增；回答聊天 0；assistant 再 +1 原位；双 source 受控 | 最终快照 A/B/C；relation 调用 1；proof 字段与 sourceControls；assistant id；回答 chat 0；最终内容不含“正在核对” | 同上；dry relation 为 fixture |
| 001-direct | L2 模型直执行 | 不发回答；等待核验收束；记录真实路径 | `path="model-direct-operation"`、正式 `NOT_COVERED`、`metrics.notTriggered`；不得标两轮通过 | L2 全真实 |
| 001-no-prompt | 显式 null 但无问题 | 不发送选择；先判前提 | 前提齐全 → FAIL；证据不足 → INCONCLUSIVE + 缺口；观察越界写 → FAIL | L2 全真实；不重试 |
| 001-seed-fail | 种子提炼失败/歧义 | 停止，不发送操作/回答 | 保留种子 flags/reasons；L2 FAIL | 真实 SQLite/chat；无重试 |

补充：

- C 无新增：`entriesOf(after,"c").length === 0`。
- 独立身份 B：relation 0 且 B 删除是 `wrongDelete`；relation 0 且 B 保留失败；relation 1 时 different/uncertain 不得传播。
- 模型直执行只表示澄清路径未覆盖，不代表删除能力通过/失败。
- 发现生产缺陷只报告，不改生产。

### 3.2 执行与验证

1. `node --check tools/memory-tuning/chat-operation-probe.cjs`；JSON 解析。
2. 非法 `--case`：格式非法/未知 ID → 非零退出，不创建输出。
3. 输出拒覆：指向已有文件 → 非零退出，原文件 SHA 不变。
4. C12 dry L1/L2：预期 `DRY-RUN`、`path="clarify"`、首回合零 memory 写、followup 执行、relation fixture 1、回答 chat 0、清理 1 个临时目录。
5. 全 12 dry L1/L2：C01～C11 归一化后逐 Case 与改前基线对照（排除 generatedAt、临时路径、输入 SHA/版本、plan/metrics 总量）；旧记录无 `clarification`/`turn`；任何差异解释并保留。
6. `--case C12` 只执行 1 个 Case，plan/cleanup 与 selected 一致；不带过滤执行 12 个。
7. 所有失败保留 stdout/stderr、退出码、结果 JSON、临时路径；不覆盖、不补造、不重试改绿；不跑 live。

### 3.3 清理与证据

- 每个执行 Case 一个临时库；C12 两轮共用一个；`finally` 中 dispose/close/删除并记录 `path/closed/removed/existsAfter`。
- 未提问/直执行先 settle 再快照、再统一清理；不提前 dispose。
- dry 关闭 relation fixture server 并记录；`--out` 必须新文件；新 attempt 保留原始退出码与日志。
- 证据位置：`evidence/s03o-live-clarification/<attempt>/`。

### 3.4 不宣称

- 本轮只跑 dry，不跑 live；正式 Case 的真实 PASS/FAIL 由 master 在真实 L1/L2 后判定。
- 不证明自然语义泛化、人类体验、GUI、完整 S03；旧 C02/C03/C07 Expected 与失败记录原样保留。

## 4. 批准状态

master 已受托批准本 r3 的修订方向与规模上限；实施前若预计超限先报告停止。批准不覆盖 live 执行。
