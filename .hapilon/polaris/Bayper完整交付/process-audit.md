# Bayper 北极星流程审计补齐总索引

2026-10-27。当前模式：**流程审计补齐**。产品开发暂停；执行者本轮不修改代码/测试、不运行产品验收/真实 API/GUI。该边界只是本次派发限制，不是用户对 master 的全局禁令；Git/snap/版本由 master 管理。

本文件是本次流程审计补齐的唯一总索引，只维护恢复门、分册索引、稳定缺口与总体状态。三个分册由 **Claude Code CLI 单一执行者**完成并维护，本文件不复制其内容，也不覆盖分册。

## 恢复门（master 决定）

1. 执行者本轮不修产品代码/测试，不运行产品验收，不调用真实 API、不启动 GUI；master 的 Git/snap/版本管理与独立补验不受此限。
2. 所有已发现未遵守北极星流程的缺口，必须由执行者补录或重做，并由 Codex master 基于真实证据独立审查、验收流程补齐后恢复开发。
3. 补录/重做只记录真实发生的执行、证据与结果；不得把产品尚未开发的功能补造成“过去已执行”或“已经验收”。
4. 不得倒填历史确认、用户确认、人工体验或 master 验收。
5. 流程补齐未完成、未经 master 最终验收前，不得宣称流程补齐完成，也不得恢复产品开发。
6. 恢复开发由 master 基于流程补齐的真实证据决定，不需要再次询问用户恢复许可；独立证据补验可由 master 另行派发，不能形成“禁止补验却又要求补验”的循环。

## master 审查决定（2026-10-27）

- master 已审查三份审计分册、AGENTS 与现行 5 文件 skill diff；**接受问题清单作为补齐依据，不接受任何产品完成结论**。
- 保留现行 parent-slice-continuity 修订；S-01/S-02 暂在项目统一入口落实，本轮不扩 skill；S-03 不新增规则，原有“全部必需项通过才 PASS”已足够，不采用整体取最差或未定义状态序关系。
- 下一顺序：1）先统一 Case/计划入口并修正设计冲突；2）再处理验收矩阵、证据保留、父级闭环与未编号约束；3）最终由 master 验收流程补齐并决定恢复。
- 本轮不关闭任何未完成 GAP；三册保留为审计发现，后续纠正以本索引为准。

## 分册索引（历史审计发现，master 已审查）

- [process-audit-chain.md](process-audit-chain.md)：S01～S08 父级阶段、业务模型、Case、计划、证据、体验/受托接受矩阵。
- [process-audit-trace.md](process-audit-trace.md)：31 个现行 REQ 与明确未编号要求到 Contract 的覆盖/缺口。
- [process-audit-skill.md](process-audit-skill.md)：已有规则未执行与 skill 真实缺陷/歧义；未提交改动与归档 SHA。

三份分册记录的是 **2026-10-27 时间基线**；master 已审查问题清单，但不接受产品完成结论。后续已纠正点以本索引为准，分册不追写为“最终状态”。

## 当前状态

- 审计执行者：Claude Code CLI（唯一补齐执行者；**本轮 Claude 审计未使用子代理**）。master 曾误派 3 个 Codex 审计代理，用户纠正后已中断，其报告未作为完成依据，不能据此宣称“从未有过 Codex 子代理”。
- 阅读范围：138 份现行流程文档（不含本索引）、PRD 及 7 份业务规则、cases/evaluation/acceptance-plan、各 review 引用证据；`archived/` 只作追溯。
- 审计状态：**master 已接受 r2 预算/通知/连接器补充引用、授权状态与 DESKTOP Runner 边界修正；r3 更正 ANALYSIS-007/009/010 映射后，GAP-01/02/04/11 已接受，GAP-06 流程部分可关闭（产品修复未完成）。master 已独立核对 r4 的冻结 5 SHA、部分原日志、Expected 与 r2 差异：GAP-05/07/08/12 接受整改记录（不等于产品验收），GAP-03/13 以本轮细修后待最终复验；GAP-14 下批。产品仍冻结。**
- 父级状态：**S01 首次相遇切片已受托接受；其跨 REQ 后续义务仍在相应父级待办。其余父级为部分接受或未闭合。** 不使用父级完成率分数；切片接受与父级待办分别记录。
- 正式 Case 入口：r2 修正预算/通知/连接器扩展 ID 来源；r3 由 master 核实 POL-ANALYSIS-007/009/010 的原规则到 ID 映射并恢复登记；其余 numbered 组按既有小节规范化映射，不再以 321 总数或手工清单自证。见 `evidence/process-registry-20261027-r3/`。
- 中心验收记录：`evaluation.md` 已增 S01～S08 统一矩阵与当前失败/未验证清单；历史节保留，S03c～S08 不再只散在 review。
- 冻结证据：5 个源码/测试 SHA 在审计前后逐项一致，未改动；见 `evidence/process-freeze.json`。
- 开发报告事实：4 套件 35 项为 29 PASS / 6 FAIL，来自开发执行者，master 尚未独立验收；exec57057 已结束。来源身份 v2 是冻结时未完成的产品任务：先登记未验收、v2 使 POL-FACTID-002 旧机制 PASS 失效、6 个旧机制 FAIL 与存量误合组未迁移；不要求先改产品代码/测试修绿才恢复，产品补验/修复可在流程补齐后另行派发。
- 以上“已接受”均指 review 中的切片级受托接受，不等于父级或全 PRD 通过。

## r4 入口与证据保留盘点（2026-10-27）

- 已提交基线：`a880937`，当时 VERSION `0.1.180`；本批按 master 派发拟提交 `0.1.181`，尚未产生新提交，不写假 hash。主仓库工作区另有 5 个未提交 memory 文件；SHA 前后一致，见 `evidence/process-freeze.json`。
- master 已独立核对冻结 5 SHA、部分原始日志、Expected 与 r2 差异；GAP-05/07/08/12 接受整改记录（不等于产品验收），GAP-03/13 待本轮细修后最终复验，GAP-14 下批，产品冻结。
- 本轮仅改 `evaluation.md`、`process-audit.md`、`state.md`、`scope.md` 与 `evidence/process-evaluation-20261027/`；未跑产品测试/GUI/API，未改代码/测试/skill/版本，未 Git 写入，未用子代理。`cases.md` 与 `acceptance-plan.md` 只读。
- master 复审后 r2 仅修 7 项反馈：CHAT 逐项重汇、EXCLUSIVE 拆行、Runner 模板、FACTID 机制/业务分离、GAP-08 措辞、DESKTOP-006 子断言归属、语义工具分层；新增 `evidence/process-evaluation-20261027-r2/`。GAP-14 仍不做。
- 统一矩阵、父级追溯与当前失败清单分别见 [evaluation.md](evaluation.md) 与 [scope.md](scope.md)；本文只保留审计入口和证据缺口。

### 证据保留/丢失

| 项 | 现有已查来源 | 状态与可信边界 | 对通过结论的影响 |
|---|---|---|---|
| S04d openHome 超时原日志被成功运行覆盖 | [test-hang-investigation.log](evidence/s04d-source-settings/test-hang-investigation.log)、各 run 的 [historical-failure-excerpt.log](evidence/s04d-source-settings/run-20261025203252667-0267a1/historical-failure-excerpt.log)、[s04d-hung-test-stop.json](evidence/s04d-hung-test-stop.json) | 现有摘录明确是转录，不是原始失败文件；在已查本项目证据与 CLI 报告中未找回原文件，不断言绝对不可恢复 | 该次是测试挂起/布局失败，不是被覆盖的业务 PASS；S04d 最终通过来自独立 `s04d-codex-final.log` 与唯一批次，不依赖缺失原件。后续 Runner 必须每批唯一目录，失败不得同名覆盖 |
| S05f 中间调试批次被开发执行者删除 | [s05f-review.md](s05f-review.md) 明文记录；首批失败与终批仍在 `evidence/s05f-notification/`（如 case-005-failure-006）；独立 `s05f-codex-first.log`、`s05f-codex-repair.log` | 被删中间批次在现有已查来源中未找回；首批/终批和独立批次可复核，不能补造中间日志 | S05f 接受依据是独立 27/27 与保留的首/终批，不依赖被删中间产物。后续明确不得删除失败/调试证据 |
| S06g 单 Case 日志复用同名，原始单 Case 文件被覆盖 | `evidence/s06g-authored-content/01-first-run.log`～`06-final-coverage-counts.log`、case-001～003；独立 `s06g-codex-first.log`、`s06g-codex-final.log` | 总批次日志与独立结果仍在；被复用的单 Case 早期内容不再是不可变原件 | 最终 PASS 来自独立 `s06g-codex-final.log` 3/3，不依赖被复用文件；历史单 Case 原件缺口保留 |
| S03j/S03i 截图固定目录重叠 | `evidence/s03c-memory-ui/` 已恢复保留；S03j 另存 `s03j-memory-ui-codex-20261027/`、`s03j-theme-ui-codex-20261027-r2/`；S03k 另移 `s03k-chat-history-neighbor-codex-20261027/` | 有预先保存/恢复记录，现有目录内容在；不是丢失，但固定目录写入仍是风险 | 不影响已接受结论；后续 Runner 继续使用唯一批次，避免覆盖旧图 |
| S03e 固定 `EVIDENCE_DIR` 覆盖风险 | `evidence/s03e-sharing-ui/batch-20261027-040235/`、`040503-s03e-final/`、`040847-evidence-fix/`、`040922-evidence-fix2/`、`codex-20261027-s03e-r1/` | 开发中间批与独立批均保留；未发现已接受结论依赖缺失文件 | 不影响 S03e 接受；最终以 `s03e-codex-gui-r1.log` 23/23 与独立批次为准 |
| S03f 真实模型失败批次 | `evidence/s03f-live-chat-memory/claude-20261027-live-r1/`、`claude-20261027-s03f-r4/pre-fix-failure.log` 等 | R1 两 FAIL、R4 两反例修前失败均保留；R3 六场 PASS 为历史基线，R4 未冒称重跑 | 服务/GUI 接受不依赖重写失败；R4 真实模型语义仍为 NOT_COVERED |
| S07b 共用源码目录导致 Electron 语法错误 | [s07b-codex-gui-r2.log](evidence/s07b-codex-gui-r2.log)、`s07b-r2-manual-cleanup.log`、最终隔离批 `codex-20261027-isolated-r3/` | 该次是源码半编辑导致的 ERROR，不是产品动作失败；旧 `044500-final` 截图不作为最终同批证据 | S07b 接受依据是固定副本的独立 r3；污染批保留但不计入 PASS |

## 已接受候选与 r3 修正

- GAP-01 已接受：`cases.md` 保留内联完整 Expected；外部 Contract 按组补入实际定义所在的 plan/review 与明确小节。BUDGET-005～008、NOTIFY-006～009、CONNECTOR-007 已改链 review；ANALYSIS 恢复 001～011。
- GAP-02 已接受：S01 ONBOARD 组恢复 v1/2026-10-25 受托确认与 P0 元数据；FACTID-002 v2 与 SOURCE-ID 计划按“计划已受托确认、实现未独立验收”表述。
- GAP-04 已接受：`acceptance-plan.md` 改为全局标题，S01 明确列为历史切片；DESKTOP-001～007 按真实测试名拆分 001/004/005/007 与 002/003/006 未覆盖边界；详细材料为准确文件链接。
- GAP-11 已接受：`s03-design.md` 已改为当前身份模型，并记录 2026-10-27 受托修订与 plan 引用。
- GAP-06 流程部分关闭：已诚实登记 v2 未验收、旧机制 PASS 失效、6 个 FAIL 与存量误合组未迁移；产品修复/补验仍未完成，另行派发。
- r3 更正：POL-ANALYSIS-007/009/010 规则来源见 `s04c-review.md`（007）、`s04c-provenance-plan.md` 方案第3/7条与第6条及验收（009/010）、`s03l-association-review.md`（010）；测试名称仅是映射证据，不是 Expected 来源。
- GAP-09 已闭合：master 接受 3e2a64d；`北极星迭代/parent-slice-continuity.md`、归档与 manifest 已入库。
- GAP-10 已闭合：master 接受 3e2a64d；5 个 skill 文件、归档目录、manifest 与 VERSION 0.1.179 已提交。
- 未关闭：GAP-05/07/08/12 的整改记录已由 master 接受（不等于产品验收）；GAP-03/13 本轮细修后待 master 最终复验；GAP-14（未编号约束/完整最终 Contract）仍下批；GAP-06 仅流程部分关闭，来源身份产品修复未完成。产品仍冻结。

## 稳定缺口（GAP-01～GAP-14）

统一门槛：证据缺失可以**撤销原通过结论、降级为未验证、标明现有已查来源中未找回的历史证据、建立后续验证条件**来纠正流程；不得把尚未验证标成通过，也不得要求先补造证据或先把产品修绿才允许恢复。GAP 的“恢复门处理”只说明流程补齐前要做的事；产品恢复由 master 在流程验收后决定，产品补验可另行派发。

| GAP | 缺口 | 必须补录/重做的操作 | 依据 | 恢复门处理（统一） |
|---|---|---|---|---|
| GAP-01 | 正式 Case 入口不完整 | 由 master 决定按父级/能力组补入 `cases.md`：登记字段、Contract 链接、父级归属、验证边界；不得复制 plan 全文或补造未执行结果 | cases.md 唯一版本要求；分册 trace 的 21 vs 49 组对比 | **已接受（r2+r3）** |
| GAP-02 | Case 状态/版本过期 | 逐条对照 review/evaluation，修正 `cases.md` 头部“当前批次 S01”、MEMUI/BUDGET/SOURCE 等过期 NOT_COVERED；明确 FACTID-002 v1 失效与 v2 未独立执行；保留历史修订 | cases.md 旧头部与旧状态段 | **已接受（r2）** |
| GAP-03 | `evaluation.md` 不完整且 DESKTOP 语义错位 | 从各 review 汇总 S03c～S08 的逐 Case 矩阵；按真实 Case 修正 DESKTOP-002/003/004/006 标签；历史失败不覆盖 | evaluation 只到 S03b；cases 与 evaluation 的 DESKTOP 对照 | **本轮细修后待 master 最终复验**：已增统一矩阵、DESKTOP 修正、S03c～S08 引用；历史节保留 |
| GAP-04 | 中心技术/验收计划仅 S01 | 为后续 plan 建总索引（Case→实现→Runner→证据），或明确由 evaluation 承担唯一矩阵；不造第二真相 | acceptance-plan.md 仅 3 节 | **已接受（r2）** |
| GAP-05 | 父级闭环缺失、切片接受易混为父级通过 | 建立 S01～S08 父级闭环表：REQ、切片、Contract、真实证据、接受、剩余路径；显式区分切片接受与父级待办，不使用完成率分数；技术批次不升级为父级 | scope 自述、各 review 边界、slices/execution 规则 | **master 已接受整改记录（不等于产品验收）**：scope 已增父级追溯表，不计算完成率 |
| GAP-06 | 来源身份批次未独立验收 | 诚实登记 v2 未验收、POL-FACTID-002 旧机制 PASS 失效、6 个旧机制 FAIL、存量误合组未迁移；不要求先改产品代码/测试修绿；补验/修复在流程补齐后另行派发 | s03l-source-identity-plan；claude 报告 29/6；scope 第 62 行；无 codex 独立日志 | **流程部分已关闭；产品修复/补验未完成** |
| GAP-07 | 体验/人工证据未验证或缺失 | 对已有结论缺证据的撤回或降级；未开发范围的未来体验列入后续验收，不追溯为过去流程违规。已有受托/自动化记录若标明操作者、方法与局限，不构成冒充人类 | 全部分册的体验列；S04d/S05j/S07b/S07c/S08a 边界 | **master 已接受整改记录（不等于产品验收）**：evaluation 已逐项保留缺证/未验边界，未补造人工体验 |
| GAP-08 | 失败证据覆盖/保留违规 | 盘点被覆盖或删除的失败批次；能找回的标明来源，现有已查来源中未找回的标明查询范围与可信边界，不断言绝对不可恢复；后续唯一批次、先失败后修复、不覆盖 | execution 证据保留规则；s03j/s06g/s04d/s05f/s03e 等记录 | **master 已接受整改记录（不等于产品验收）**：r4 盘点已记录现有来源、转录边界与影响，未把追述当原件 |
| GAP-09 | skill 修订迭代记录缺失 | 由 master 审核后补 `北极星迭代/parent-slice-continuity.md`：问题位置、触发、影响、理由、归档路径、验证、未解决；manifest 补同类字段或引用 | AGENTS 迭代记录要求；scope 第 66 行引用但文件不存在 | **已闭合：3e2a64d 已提交迭代记录、归档与 manifest** |
| GAP-10 | skill 改动/归档未提交 | master 决定是否按 snap 提交；本派发不禁止 master 的 Git/版本操作，执行者不自行提交 | AGENTS 归档/提交规则；执行者派发边界 | **已闭合：3e2a64d 已提交 5 文件、归档/manifest 与版本 0.1.179** |
| GAP-11 | s03-design 与新身份决策冲突 | 在 s03-design 保留历史并加修订记录，指向 s03l-source-identity-plan；更新受影响 Case/plan 引用；不保留两套事实键真相 | s03-design 第 11 行 vs source-identity 决定 | **已接受（r2）** |
| GAP-12 | state/scope/process-audit 当前状态冲突 | state 已改为单一 Claude CLI 执行者/流程补建验收；scope 已更新当前阶段；历史保留；不得把执行者报告当 master 决定 | state 旧第 8/82 行；process-audit 旧“3 代理”；scope 旧第 58～64 行 | **master 已接受整改记录（不等于产品验收）**：已同步 `a880937` 与本批拟提交 `0.1.181`（未产生新 hash） |
| GAP-13 | 状态枚举/子项聚合不规范 | 统一使用 PASS/FAIL/ERROR/INCONCLUSIVE/NOT_COVERED；逐子项列出；把 PARTIAL 等归入现有状态并说明聚合规则 | execution 五状态；s07b 的 PARTIAL→INCONCLUSIVE | **本轮细修后待 master 最终复验**：矩阵只使用五状态，DESKTOP/ASSET3 等差异已拆子项 |
| GAP-14 | 未编号要求无 Contract | 对已授权范围补 Contract/Case（原生单屏、Spaces/Retina、最终端到端、造型维度等）；36 动作等范围以用户明确授权 master 决策为准，不因未逐项确认判无效，本轮不自行扩缩；未授权项不新增 | PRD 未编号段落；animation-plan；trace 表 | **下一批处理**：完整最终 Contract 与未编号要求；本轮不新增业务概念/Case |

## 审计覆盖声明

- 已覆盖：138 份现行流程文档逐份读取；31 个 REQ 与明确未编号要求追踪；`cases.md` 与 plan/review Case 组对比；`evaluation.md`/`acceptance-plan.md` 覆盖检查；240 个文件型引用存在性核查（9 个为缩写/可选模块/多路径拼接，无真实缺失）；归档 11/11 SHA 与 manifest 核对；`quick_validate`；5 个冻结源码前后 SHA。
- r3 更正：master 已核实 POL-ANALYSIS-007/009/010 的原规则到 ID 映射并恢复登记；此前把“无完整字面 ID”当作 Contract 不存在不成立。其他 numbered 组按既有小节定义规范映射，不再全量重审；测试名称仅为映射证据，不是 Expected 来源。见 `evidence/process-registry-20261027-r3/analysis-id-mapping.txt`。
- 未覆盖：未重跑产品测试、GUI、真实 API；未逐条复算证据日志内部断言；未验证 5097 个证据文件全部内容；未验证历史 Git/线上状态；未取得任何新的人类体验；执行者本轮未修改产品代码/测试/PRD/skill 有效内容，仅按 master 派发同步版本字面量，未自行 Git 提交；master 的 Git/补验不受此限。
- 已接受 GAP-01/02/04/11；GAP-06 流程部分关闭；GAP-09/10 已于 3e2a64d 关闭。master 已接受 GAP-05/07/08/12 的整改记录（不等于产品验收）；GAP-03/13 待本轮细修后最终复验；GAP-14 下批。产品仍冻结；本阶段不宣称产品完成或流程补齐已验收。
- r4 未新增业务概念/Case，未重跑产品测试/GUI/API；只核对文档、引用、代表原始日志内容和 5 文件 SHA，未验证 5097 个证据文件全部内容，未取得新的人类体验。
