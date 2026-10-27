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
- 审计状态：**分册已完成，master 已审查问题清单；流程补齐未完成，产品开发未恢复。**
- 父级结论：**0/8 个父级按全套 REQ 闭合**；仅 S01 首次相遇切片闭合；其余为部分接受。
- 正式 Case 入口：`cases.md` 21 个能力组，plan/review 出现 49 组；约 28 组无正式入口。
- 中心验收记录：`evaluation.md` 只覆盖 S01/S02a/S02b/S03a/S03b 与 S07 素材；S03c～S03l、S04～S08 结果散在 review。
- 冻结证据：5 个源码/测试 SHA 在审计前后逐项一致，未改动；见 `evidence/process-freeze.json`。
- 开发报告事实：4 套件 35 项为 29 PASS / 6 FAIL，来自开发执行者，master 尚未独立验收；exec57057 已结束。来源身份 v2 是冻结时未完成的产品任务：先登记未验收、v2 使 POL-FACTID-002 旧机制 PASS 失效、6 个旧机制 FAIL 与存量误合组未迁移；不要求先改产品代码/测试修绿才恢复，产品补验/修复可在流程补齐后另行派发。
- 以上“已接受”均指 review 中的切片级受托接受，不等于父级或全 PRD 通过。

## 稳定缺口（GAP-01～GAP-14）

统一门槛：证据缺失可以**撤销原通过结论、降级为未验证、标明不可恢复的历史证据、建立后续验证条件**来纠正流程；不得把尚未验证标成通过，也不得要求先补造证据或先把产品修绿才允许恢复。GAP 的“恢复门处理”只说明流程补齐前要做的事；产品恢复由 master 在流程验收后决定，产品补验可另行派发。

| GAP | 缺口 | 必须补录/重做的操作 | 依据 | 恢复门处理（统一） |
|---|---|---|---|---|
| GAP-01 | 正式 Case 入口不完整 | 由 master 决定按父级/能力组补入 `cases.md`：登记字段、Contract 链接、父级归属、验证边界；不得复制 plan 全文或补造未执行结果 | cases.md 唯一版本要求；分册 trace 的 21 vs 49 组对比 | 先补录入口 |
| GAP-02 | Case 状态/版本过期 | 逐条对照 review/evaluation，修正 `cases.md` 头部“当前批次 S01”、MEMUI/BUDGET/SOURCE 等过期 NOT_COVERED；明确 FACTID-002 v1 失效与 v2 未独立执行；保留历史修订 | cases.md 第 3/64/96/100/121/153 行 | 撤销/修正过期结论 |
| GAP-03 | `evaluation.md` 不完整且 DESKTOP 语义错位 | 从各 review 汇总 S03c～S08 的逐 Case 矩阵；按真实 Case 修正 DESKTOP-002/003/004/006 标签；历史失败不覆盖 | evaluation 只到 S03b；cases 与 evaluation 的 DESKTOP 对照 | 补录/降级缺证结论 |
| GAP-04 | 中心技术/验收计划仅 S01 | 为后续 plan 建总索引（Case→实现→Runner→证据），或明确由 evaluation 承担唯一矩阵；不造第二真相 | acceptance-plan.md 仅 3 节 | 先补索引 |
| GAP-05 | 父级闭环缺失、切片接受易混为父级通过 | 建立 S01～S08 父级闭环表：REQ、切片、Contract、真实证据、接受、剩余路径；显式标 0/8；技术批次不升级为父级 | scope 自述、各 review 边界、slices/execution 规则 | 先建闭环表；不要求产品父级全完成 |
| GAP-06 | 来源身份批次未独立验收 | 诚实登记 v2 未验收、POL-FACTID-002 旧机制 PASS 失效、6 个旧机制 FAIL、存量误合组未迁移；不要求先改产品代码/测试修绿；补验/修复在流程补齐后另行派发 | s03l-source-identity-plan；claude 报告 29/6；scope 第 62 行；无 codex 独立日志 | 登记未验收并失效旧结论；产品补验另派 |
| GAP-07 | 体验/人工证据未验证或缺失 | 对已有结论缺证据的撤回或降级；未开发范围的未来体验列入后续验收，不追溯为过去流程违规。已有受托/自动化记录若标明操作者、方法与局限，不构成冒充人类 | 全部分册的体验列；S04d/S05j/S07b/S07c/S08a 边界 | 撤回/降级缺证结论；未来体验列后续 |
| GAP-08 | 失败证据覆盖/保留违规 | 盘点被覆盖或删除的失败批次；能找回的标明来源，不能找回的明确标为不可恢复；后续唯一批次、先失败后修复、不覆盖 | execution 证据保留规则；s03j/s06g/s04d/s05f/s03e 等记录 | 标不可恢复/建后续验证条件 |
| GAP-09 | skill 修订迭代记录缺失 | 由 master 审核后补 `北极星迭代/parent-slice-continuity.md`：问题位置、触发、影响、理由、归档路径、验证、未解决；manifest 补同类字段或引用 | AGENTS 迭代记录要求；scope 第 66 行引用但文件不存在 | 先补记录（不阻塞产品本身） |
| GAP-10 | skill 改动/归档未提交 | master 决定是否按 snap 提交；本派发不禁止 master 的 Git/版本操作，执行者不自行提交 | AGENTS 归档/提交规则；执行者派发边界 | master 决定 Git/snap |
| GAP-11 | s03-design 与新身份决策冲突 | 在 s03-design 保留历史并加修订记录，指向 s03l-source-identity-plan；更新受影响 Case/plan 引用；不保留两套事实键真相 | s03-design 第 11 行 vs source-identity 决定 | 先加修订记录 |
| GAP-12 | state/scope/process-audit 当前状态冲突 | state 已改为单一 Claude CLI 执行者/流程补建验收；scope 已更新当前阶段；历史保留；不得把执行者报告当 master 决定 | state 旧第 8/82 行；process-audit 旧“3 代理”；scope 旧第 58～64 行 | 先修正当前状态 |
| GAP-13 | 状态枚举/子项聚合不规范 | 统一使用 PASS/FAIL/ERROR/INCONCLUSIVE/NOT_COVERED；逐子项列出；把 PARTIAL 等归入现有状态并说明聚合规则 | execution 五状态；s07b 的 PARTIAL→INCONCLUSIVE | 统一记录；不阻塞产品 |
| GAP-14 | 未编号要求无 Contract | 对已授权范围补 Contract/Case（原生单屏、Spaces/Retina、最终端到端、造型维度等）；36 动作等范围以用户明确授权 master 决策为准，不因未逐项确认判无效，本轮不自行扩缩；未授权项不新增 | PRD 未编号段落；animation-plan；trace 表 | 按 master 授权范围补 Contract |

## 审计覆盖声明

- 已覆盖：138 份现行流程文档逐份读取；31 个 REQ 与明确未编号要求追踪；`cases.md` 与 plan/review Case 组对比；`evaluation.md`/`acceptance-plan.md` 覆盖检查；240 个文件型引用存在性核查（9 个为缩写/可选模块/多路径拼接，无真实缺失）；归档 11/11 SHA 与 manifest 核对；`quick_validate`；5 个冻结源码前后 SHA。
- 未覆盖：未重跑产品测试、GUI、真实 API；未逐条复算证据日志内部断言；未验证 5097 个证据文件全部内容；未验证历史 Git/线上状态；未取得任何新的人类体验；执行者本轮未修改产品代码/测试/PRD/skill 有效内容/版本，未自行 Git 提交；master 的 Git/补验不受此限。
- 本索引不判定任何 GAP 已闭合，也不宣称流程补齐完成。下一步：master 审查三份分册与本 GAP 表，决定补录顺序、独立补验与流程验收；执行者按派发继续，不自行恢复开发。
