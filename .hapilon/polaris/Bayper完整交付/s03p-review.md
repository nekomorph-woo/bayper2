# S03p 中期审查：规模与整改报告（只读，未继续实施）

状态：2026-10-28。master 已对上一实现会话 34869 SIGINT 终态（不是观察超时）；全部改动与失败基线保留。本报告保留中期审查；**收口实施结果见第 0 节**。中期审查时只做只读检查，未改代码/测试/版本/Git/skill/state/.env，未运行 GUI/API，未用子代理，未移动正在使用的证据。收口批次已完成批准范围内修改与回归，仍**不构成验收**，等待 master 独立复验。

> master 证据归位记录：Claude 55369 已终态后，将原根目录 evidence/s03p-temporal-clarification 三批原件迁至本工作 evidence/s03p-temporal-clarification；10个文件 SHA-256 全部一致。下文历史根目录描述仅说明原执行位置，现按迁入路径读取。master 独立五套复验已完成：evidence/master-s03p-core-JfUqOFGB，353/353、0 skipped、exit0，before/after SHA一致；尚需Case覆盖审查与GUI验证，未作整体接受决定。

## 0. 收口实施结果（2026-10-28，待 master 独立复验）

- **三处缺陷已修**：`conversationOf` 拆行；删除 `correctedSnapshot` 内引用未定义 `parsed` 的时间块（保留显式 `timeAuthorization` 参数）；`resolveEdit` 补 `timeAuthorizationOf` 定义与失败返回。逐作用域核对：current temporary、copy、edit 各自定义 `timeAuth`，`correctedSnapshot` 不再引用。
- **授权文案已接**：`temporaryInfo.timeAuthorizedToday`；`memoryEntryLine` 对 direct/copy/edit 输出“只授权今天/原授权只到今天”，正文不改写。
- **来源/copy/edit 读门**：两条消息的真实语义、同会话同角色、时间回答在后、同日、到期等于当日结束、holder 未排除；损坏/任意消息 ID/跨会话/错误到期均 unavailable。旧 4 段与 edit 空时间来源兼容。
- **生命周期**：pending/回答/执行/取消/关闭/dispose/retry 接线完成；失败选择保留 operationProof 标记，重启后 retry 返回 expired；成功无 verification proof 时保留标记，有 proof 时写入 `timeAuthorization`。
- **最小去重**：只合并 `invalidateFailedSelections`、`selectionMarkerOf`、`completeSelectionReply`、`clearSelectionsForConversation`、`disposeSelections`；`runForgetSelection`/`runCorrectTimeSelection` 与两份 changed 重验保持独立。TTL、重试、双来源重验、proof 未删除。
- **依赖**：保留 source→operations 的既有方向；已加注释说明仅复用纯校验/本地日计算，不形成反向依赖。未发现循环。
- **面板**：`app/renderer/memory-panel.js` 的 `entryMeta` 增加 `effective === false` 的“已失效（来源已变化）”标签；删除/编辑/转告业务未改。**GUI 未运行**（睡眠会话 58616 独占，待 master 安排）。
- **最终规模**：生产净增 **630**（chat 382、operations 127、source-context 80、temporary 17、memory 12、temporary-source 11、renderer 1）；测试净增 816。低于“预计超过 650 先报告”的阈值，但高于约 560～600；去重以可追踪性为主，未为行数删除守卫。
- **证据**：
  - 旧生产基线（根目录，未搬）：`evidence/s03p-temporal-clarification/attempt-20261028-010348-baseline-headprod/`，chat 8/18、semantic 0/12，均 exit 1。
  - focused chat：`.hapilon/polaris/Bayper完整交付/evidence/s03p-temporal-clarification/attempt-20261028-011400-close1-chat/`，26/26、exit 0。
  - focused semantic：`.../attempt-20261028-011415-close2-semantic/`，12/12、exit 0。
  - 回归：`.../attempt-20261028-011426-close3-regression/`，chat-full 100/100、semantic-full 138/138、corrected-source 99/99、source-context 6/6、relation-protocol 10/10，全部 exit 0、0 skip。
  - 最终全量 `node --check`（含 renderer 与两个 spec）exit 0；回归后仅加依赖注释，随后 `node --check app/memory-source-context.cjs` exit 0，逻辑未变。
- **Case 覆盖**：CT-001/004/004b/005/006/007/010/010b 由 chat focused+full 覆盖；CT-002/002b/003/008（删除/面板更正/删长期锚）/009/011（新/旧/损坏/copy/edit）由 semantic focused+full 覆盖；均为 PASS（本批自动化范围）。**未覆盖**：GUI 实际运行、真实模型 live、人类体验、自然语言泛化、经历/身份/detail、完整 S03、关系协议显式时间授权；GUI `effective` 标签仅代码与 API 断言，未做渲染验证。
- 未改 `state.md`、VERSION、Git、skill、`.env`，未调用 API/子代理；旧根证据未移动，证据目录按本轮要求写 `.hapilon/.../evidence/s03p-temporal-clarification/`。

## 0.1 审查补测（2026-10-28，test-only）

- **范围**：只改测试/报告，生产净增保持 **630** 不变；未改 Expected，未缩小 all 语义，未重新从头实现。
- **测试新增**：chat spec +45（CT-010c）、semantic spec +84（CT-003 参数化、CT-008 B/重启、CT-011 同会话无效/空段/重开）、GUI spec +87（新最小两轮用例），合计 **+216**，在 150～280 预期内。
- **CT-003**：`different` 与 `uncertain` 均独立执行；B 同 identity 阶段 1 同步、C 长期/临时不变、D 未知无新增、关系恰 1 次；子项均 PASS。
- **CT-008**：panel correct 子例新增 B 有效检索、B 真实 chat 系统记忆段不含旧正文、重启后 A/B 均为新正文；public delete temp 重启后补查 B 检索与系统记忆段；long anchor 子例保留 A/B 检索。子项均 PASS。
- **CT-010c**：失败后推进跨本地日，同 request retry 返回 `stale/CORRECT_TIME_SELECTION_EXPIRED`，零写、不追加 user/assistant、授权标记清除；PASS。
- **CT-011**：新增同会话但 `就今天？`、`明天吧` 的时间来源，空时间段，损坏来源后重开；有效检索/上下文/列表均不再返回旧临时，`effective:false`；恢复来源后有效。该子例是**协议防御 fixture**，未声称存在公开聊天撤权入口；PASS。
- **证据**：`.hapilon/polaris/Bayper完整交付/evidence/s03p-temporal-clarification/attempt-20261028-012111-coverage/`，含 `shas.txt`、`chat-full.log`、`semantic-full.log` 与各自 exit；chat **101/101**、semantic **141/141**，均 exit 0、0 skip。`node --check` 三个修改测试文件 exit 0；同目录 `final-shas.txt` 与 `gui-node-check.log/exit` 记录 GUI 测试最后编辑后的 SHA 与语法检查（exit 0）。`shas.txt` 中 GUI 测试 SHA 是运行前版本，GUI 未执行，故不影响两套后端结果。
- **GUI**：已写 `POL-CHATMEM-CORRECT-TIME-GUI-001`（真实 Electron/SQLite/构造 HTTP，两轮提问/就今天/长期不改+今日临时/面板截图；失效标签用协议 fixture），仅 `node --check`，**本轮未运行**，记 **NOT_COVERED**，待 master 接管后独立跑；截图路径将由测试写入 `.../evidence/s03p-temporal-clarification/gui-shots/`。
- 本轮未重跑 corrected-source/source-context/relation-protocol（生产未改；master 353/353 与上批 630 证据保留）。

## 1. 实际规模（相对 HEAD `5f03cdf`）

| 文件 | + | − | 净增 | 行数 |
|---|---:|---:|---:|---:|
| `app/chat.cjs` | 378 | 6 | **372** | 2404→2776 |
| `app/chat-memory-operations.cjs` | 130 | 3 | **127** | 1387→1514 |
| `app/memory.cjs` | 15 | 3 | **12** | 2026→2038 |
| `app/memory-temporary-source.cjs` | 17 | 6 | **11** | 102→113 |
| `app/memory-temporary.cjs` | 17 | 1 | **16** | 1095→1111 |
| `app/memory-source-context.cjs` | 82 | 4 | **78** | 1049→1127 |
| **生产合计** | | | **616** | |
| `tests/.../chat-memory-operations.spec.cjs` | 390 | 0 | 390 | 3889→4279 |
| `tests/.../memory-semantic-operations.spec.cjs` | 426 | 0 | 426 | 4464→4890 |
| **测试合计** | | | **816** | |

- 批准规模为生产 290～420；实际 **616**，超出约 196 以上。超出部分不是压行造成的，但**未在触及 400 时先报告**，这是执行偏差。
- master 提到的 operations 约 118 为口头估计；实际净增 **127**。chat 实际 **372**。
- 不再提出“新上限”；是否按重新界定的职责继续同一批、或拆成两个批次，由 master 决定。

## 2. 必要职责与超规模来源

| 职责 | 主要位置 | 约净增 | 判断 |
|---|---|---|---:|
| B1 触发、pending、回答语法、两类 correct 路径接线 | `chat-memory-operations` 的 `parseCorrectTimeAnswer`/`todayAuthorizationEligible`/`planOperation`；`chat.sendMessage` 的 pending/answer 块、`registerCorrectTimeClarification` | 约 210 | 业务必需；无可删除的 TTL/语法/多锚守卫 |
| B2 双来源协议与有效读门 | `memory-temporary-source`、`memory-temporary`、`memory-source-context`、`memory.cjs` 的 `sourceId:320`/`effective`、temporary proof 时间授权 | 约 145 | 业务必需；直接决定 FTS/上下文/副本不回流 |
| B3 生命周期、重试、在途、授权标记 | `correctTimeSelectionChanged`、`runCorrectTimeSelection`、retry/cancel/close/dispose、proof 写入 | 约 230 | 业务必需；TTL/重验/标记不能删 |
| 共用 TTL helper、import/常量/proof 接线 | `clarificationAlive`、顶部常量、临时 proof | 约 20 | 必要接线 |

超规模的主因是：原计划低估了“双来源校验 + 同 identity/独立关系 + 在途/重启 + 公开删除后 B 副本失效”的实际代码量；B3 不是可选的审计装饰，而是本切片防回流的核心。**不建议**用删守卫、合并业务校验或压行来回到 400。

## 3. 与既有 forget 承接的重复点与最小收口

| 重复点 | forget | correct-time | 收口建议 |
|---|---|---|---|
| peek/clear pending | `chat.cjs:212-227` | `:381-396` | 参数化 map + key；保留 correct-time 的“过期仍返回 pending 以本地回复”语义 |
| register pending | `:229-253` | `:398-421` | 字段差异较大，可只抽 key/基础字段，业务字段保留 |
| 失败选择失效 | `:255-274` | `:423-442` | 合并为 `invalidateFailedSelections({selections,errorCode,...})` |
| marker 解析 | `:276-282` | `:444-450` | 合并为 `selectionMarkerOf(request, kind)` |
| 本地 respond 收口 | `:329-345` | `:518-524` | 合并为 `completeSelectionReply({clearMarker})` |
| cancel/close/dispose 清理循环 | `:2573-2584`、`:2652-2657`、`:2699-2711` | `:2592-2604`、`:2659-2665`、`:2712-2723` | 抽 `clearSelectionMapForConversation`/`disposeSelectionMap` |
| 业务执行/重验 | `runForgetSelection`/`forgetSelectionChanged` | `runCorrectTimeSelection`/`correctTimeSelectionChanged` | **不合并**；目标选择与时间授权是不同业务，避免造统一状态机 |

预计可减 **35～50 行**，仍不能回到 400；收益是可读性与维护性，不是凑数。`clarificationAlive` 已共用，不重复。

## 4. 逐作用域缺陷（只读发现，未代改）

1. **`chat.cjs:580`**：`function conversationOf(...) {    const conversationId = ...` 函数头与 const 被挤同一行；需拆行。
2. **`memory-source-context.cjs:296-305`（`correctedSnapshot` 内）**：引用未定义的 `parsed.timeSourceId`。`correctedSnapshot` 被 chat-correct（`:377`）、current temporary（`:426`）、propagated（`:462`）调用，会直接抛 ReferenceError。修复：删除该块；current temporary 分支（`:409`）已自行计算 `timeAuth` 并通过参数传入，其他分支没有时间来源。**不能**在 `correctedSnapshot` 内新增时间判定。
3. **`memory-source-context.cjs:863`（`resolveEdit`）**：使用 `timeAuth.timeAuthorization`，但 `resolveEdit`（`:741` 起）没有 `const timeAuth`。修复：在 `messageBelongsTo` 后定义 `timeAuth = timeAuthorizationOf({entry, holderCharacterId: characterId, sourceCharacterId, contentMessage: message, timeSourceId: parsed.timeSourceId})`，失败返回 unavailable；旧 edit 来源 `timeSourceId=null` 仍通过。
4. 逐作用域核对结论：`correctedSnapshot` 不应有 `timeAuth`；`resolveCorrected` current（`:409`）、`resolveTemporaryCopy`（`:637`）、`resolveEdit`（待补）各自定义；`timeAuth` 仅在这三个作用域内使用。
5. **依赖方向**：`memory-source-context.cjs:13` 直接 require `chat-memory-operations.cjs`。未发现循环：`chat-memory-operations` 只 require `memory-retrieval`；既有 `memory-source-context → memory-correction-evidence → chat-memory-operations` 的传递依赖本已存在。但这是 source 层依赖 chat 层的倒置。最小收口建议：把纯函数 `parseCorrectTimeAnswer`/`isTodayAuthorizationAnswer`/`endOfLocalDay` 移到低层协议模块（如 `memory-temporary-source.cjs` 的纯解析区）并双端复用；若 master 不接受移动，则保留直连并加注释说明既有传递依赖。**本报告不声称已修复。**

## 5. 尚未接线的必要路径

- **聊天记忆行的“只授权今天”**：`temporaryInfo`（`memory-temporary.cjs:1013`）没有返回 `timeAuthorizedToday`；`memoryEntryLine`（`chat.cjs:628`）仍只说“用户今天明确说明”。CT-002/CT-011 对用户可见授权说明的断言尚不可满足。最小补法：`temporaryInfo` 返回 `timeAuthorizedToday: result.timeAuthorization === "today"`；`memoryEntryLine` 对 direct/copy/edit 追加“只授权今天/原授权只到今天”，正文不改写。约 10 行，属于 B2/B3 必需路径。
- **`effective`**：`listMemories`/`listMemoriesPage` 已返回标记；面板标签未接（GUI 由另一任务独占），当前只有 API。
- **语义执行/关系**：CT-002/002b/003 尚未运行；`correctedSnapshot` 缺陷会先阻断 `snapshotOf`/`temporaryInfo`。
- **公开删除/更正/在途**：CT-008/009 尚未运行。
- **来源协议新旧/损坏/copy/edit**：CT-011 尚未运行；`resolveEdit` 缺陷会阻断 edit 快照。
- **GUI、真实模型 live、人类体验、完整 S03、经历/身份/detail、关系协议显式时间授权**：未覆盖，另批。

## 6. 中期审查时点的检查（历史；收口结果见第 0 节）

- 旧生产基线：`evidence/s03p-temporal-clarification/attempt-20261028-010348-baseline-headprod/`；chat 26 tests / 8 pass / 18 fail / exit 1；semantic 12 / 0 pass / 12 fail / exit 1；6 个生产文件 SHA 与 HEAD 一致（master 已独立核对）。目录位置按 master 意见待统一归位，**本报告不移动**。
- 实现后 chat 聚焦：`evidence/s03p-temporal-clarification/attempt-20261028-010801-impl2-chat/chat.log`，26 tests / 26 pass / 0 fail / exit 0。**仅覆盖 chat 侧聚焦子集**，不覆盖 source-context、semantic、公开删除/在途/来源协议，不构成验收。
- **未执行**：semantic 聚焦（上次运行请求被中断，未产生结果）、任何完整旧套件、`memory-corrected-source`、`memory-source-context`、`memory-relation-protocol`、GUI、真实模型。最后一次独立 `node --check` 之后还改过 `chat-memory-operations`；之后只由 chat 聚焦测试实际加载，未再单独重跑静态检查，**不等于全量静态检查通过**。
- 因此不得写 PASS；当前结论是“半成品 + 已发现阻断缺陷”。

## 7. 中期 Case 映射（历史；收口结果见第 0 节）

| Case | 测试位置 | 状态 |
|---|---|---|
| CT-001 | `chat-memory-operations` | chat 聚焦通过；仅限本地提问/零写 |
| CT-002 | `memory-semantic-operations` | 未运行；需要 source-context 修复 + 授权行接线 |
| CT-002b | 同上 | 未运行；验证无跨独立身份 verification 但保留 operationProof |
| CT-003 | 同上 | 未运行；同 identity B 同步、独立 C 不同、未知 D 不新增 |
| CT-004 | `chat-memory-operations` | chat 聚焦通过；invalid/普通分支 |
| CT-004b | 同上 | chat 聚焦通过；普通聊天 grounded 提炼 |
| CT-005 | 同上 | chat 聚焦通过；边界守卫（基线也通过） |
| CT-006 | 同上 | chat 聚焦通过；TTL/跨日 |
| CT-007 | 同上 | chat 聚焦通过；公开目标变化 |
| CT-008 | `memory-semantic-operations` | 未运行；A/B 有效读、公开删除/面板更正/长期锚删除 |
| CT-009 | 同上 | 未运行；在途 stale、不写回 |
| CT-010 | `chat-memory-operations` | chat 聚焦通过；失败标记与重试 |
| CT-010b | 同上 | chat 聚焦通过；目标变化/重启 expired |
| CT-011 | `memory-semantic-operations` | 未运行；新旧/损坏/copy/edit |

## 8. 最小收口顺序与后续最少检查集

1. 先修三处缺陷：`conversationOf` 拆行；删除 `correctedSnapshot` 的 `parsed` 块；补 `resolveEdit` 的 `timeAuth`。
2. 接 `temporaryInfo.timeAuthorizedToday` 与 `memoryEntryLine` 授权文案。
3. 再做最小去重：marker/invalidate/complete/cancel-close-dispose 的通用 helper；**保留** TTL、重试、双来源重验、proof 标记、业务 `run*Selection`。
4. 依赖收口：选择“移动纯解析到低层模块”或“保留直连并注释”；不建通用框架。
5. 检查集（按顺序，独立 attempt，保留退出码/SHA）：
   - `node --check` 全部修改生产文件与测试；
   - `node --test --test-name-pattern "POL-CHATMEM-CORRECT-TIME" tests/acceptance/chat-memory-operations.spec.cjs`；
   - 同 pattern 的 `memory-semantic-operations.spec.cjs`；
   - `node --test --test-concurrency=1 --test-timeout=90000 tests/acceptance/memory-corrected-source.spec.cjs`（覆盖 `correctedSnapshot` 回归）；
   - `node --test --test-concurrency=1 --test-timeout=90000 tests/acceptance/memory-source-context.spec.cjs`（direct/copy/edit）；
   - `node --test tests/acceptance/memory-relation-protocol.spec.cjs`；
   - 完整 `chat-memory-operations` 与完整 `memory-semantic-operations`；
   - GUI 待面板 owner 接入 `effective` 标签后另行运行。
6. GUI 接回计划：API 已返回 `effective`；由 GUI 任务在 `memory-panel.js` 显示“已失效（来源已变化）”，编辑/转告可禁用、删除保留；本任务不修改 renderer/desktop，不声称 GUI 已验证。
7. 证据：新 attempt 写到指定目录；不覆盖基线；master 归位后再统一索引。

## 9. 中期待决事项（历史；收口选择见第 0 节）

1. 是否接受“先修缺陷 + 授权行接线 + 最小去重”后继续同一批；去重后生产仍约 560～580，是否需要拆分 B3/在途与重试另批。
2. 是否接受把纯时间回答解析/`endOfLocalDay` 移到低层协议模块，消除 source→chat 的直连倒置；或保留直连并登记为已知层向问题。
3. 面板 `effective` 标签由 GUI 任务接入的时间点；本任务只保留 API 契约。

## S03p 时间澄清后端阶段接受（2026-10-28，Codex 受托）

master基于实际diff、真实chat/SQLite业务Case与独立执行结果，有限接受 preference 模糊时间→“就今天”的后端承接、双来源有效读、更正删除防回流与重试生命周期；不接受完整S03或整个产品。生产630行增量按必要职责审查保留，未预先报告超规模的执行偏差保留，后续不机械照搬。

证据：`evidence/master-s03p-core-JfUqOFGB` 五套353/353、0skip、exit0、前后SHA一致；补齐后 `evidence/master-s03p-coverage-c10d1Wal` 两套242/242、0skip、exit0、前后SHA一致，其他三套生产未变。模型为构造HTTP，非真实模型体验。该后端快照时GUI尚未执行；后续GUI结果见本文末“S03p GUI与失效投影有限接受”，历史边界保留。

本阶段按snap保存实现、Case、Runner及记录；快照不代表GUI或父级通过，不推送。

## 历史：master GUI首轮及修后复验（2026-10-28）

完整chat-verification-ui套件两次均9/10，不能接受新增GUI。第一轮`evidence/master-s03p-gui-yqiBxr5F`在最后来源失效fixture处因SELECT漏id导致SQLite绑定undefined，属Runner ERROR；Claude补id和断言后第二轮`evidence/master-s03p-gui-saNPuBEE`等待失效标签超时，随后确认为IPC丢字段，修复与接受见下节。两轮各before/after一致，9项旧GUI通过。新Case前面的两轮澄清、今日临时、长期保留、B同步及面板正文均通过，不代表最后标签完成。master查看首次三个实际截图，澄清与结果文字可读；未取得人类体验。当时退回Claude调查，未据前半段通过接受整条GUI；既有后端有限验收结论保留。

## S03p GUI与失效投影有限接受（2026-10-28，Codex受托）

master独立完整GUI10/10、0skip、exit0，证据`evidence/master-s03p-gui-LJcNfoKf`，before/after SHA一致；文案同步后专属Case1/1、0skip、exit0，`evidence/master-s03p-label-44AoRgY3`，before/after一致。实际查看澄清问题、今日结果、长期与临时并列及失效标签截图，文字可读且无裁切。本轮接受POL-CHATMEM-CORRECT-TIME-GUI-001及已跑旧GUI回归，不代表真实模型、人类体验、全部S03或Goal。

修复经过：第一次Runner漏SELECT id是ERROR；第二次暴露真实main memoryEntryForRenderer漏effective布尔，导致后端无效状态未到renderer。Claude补1行布尔投影，并把“只显示当前有效记忆”的矛盾文案改为来源失效会标注；不暴露sourceId等内部字段。测试补ID/更新命中和失败诊断。原两次失败保留；失效来源仍为协议夹具，不冒充公开撤权入口。

受托决定：此记忆修复自洽且已独立验证，可单独snap；main仅暂存effective投影一行，睡眠/通知改动不混入。后端已有有限接受保持，真实模型语义及父级待办继续。
