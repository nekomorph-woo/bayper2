# polaris skill 规则执行与真实缺陷审计

> 时间基线：2026-10-27。此为历史审计发现；master 已审查问题清单，后续纠正与决定以 [process-audit.md](process-audit.md) 为准。

2026-10-27。审计者：Claude Code CLI（单一执行者；本轮未使用子代理）。master 曾误派 3 个 Codex 审计代理，用户纠正后已中断，其报告未用于本审计结论。只读审计仓库内现行 polaris skill、未提交改动、归档快照与迭代记录；未修改 skill 有效内容，未自行 Git 提交。

## 范围与完成度

- 现行 skill：`.agents/skills/polaris/SKILL.md` + `references/` 10 个文件，共 11 个。全部读取，未把 `archived/` 当现行规则。
- 归档：`.agents/skills/polaris/archived/20261027-115231-parent-slice-continuity/`，11 个文件。
- 清单：`.hapilon/polaris/北极星迭代/parent-slice-archive-manifest.json`。
- 校验：`skill-creator` 的 `quick_validate.py` 返回 `Skill is valid!`，退出 0；`git diff --check` 通过。
- 未做：未修改 skill，未运行 skill 行为评测，未验证 marketplace 的其他版本。

## 判定标准

本审计把问题分成三类，避免把“执行没做到”误写成“skill 有缺陷”：

1. **规则已写、执行未做**：能在现行 SKILL/references 找到明确要求，项目有真实产物证明没做到。处理是补录/重做，不是改规则。
2. **规则歧义/缺口**：规则没有给出唯一做法，导致同类事情出现两种合理解释；需要真实影响证据，才考虑最小修订。
3. **规则已覆盖、后由修订补齐**：历史上是缺口，但当前未提交修订已经处理；master 已审查并保留，不能再当未解决缺陷。

判定真实缺陷的最低证据：至少两份实际文档/执行出现不一致，且不一致会影响 Case、验收、证据追溯或职责边界；仅措辞偏好、单个案例、可自行澄清的表述不算。

## 未提交改动

`git status` 显示 5 个现行文件被修改，归档目录与 manifest 未跟踪：

| 文件 | 改动性质 | 审计结论 |
|---|---|---|
| SKILL.md | 接续步骤增加“恢复父级切片/未闭环路径；技术批次不等于父级完成” | 与 slices/work-records 一致，补充而非冲突 |
| references/slices.md | 增加“模块/探针是实施批次，必须指向父级用户结果” | 针对真实的“技术切片冒充交付”问题 |
| references/cases.md | 增加“编号是组内稳定标识，不是进度；内部探针不替代父级 Case” | 补充可追溯性，未改 Expected 规则 |
| references/execution.md | 增加“批次结束回父级核对；不把使用方法当流程有效” | 补充父级闭环与复盘 |
| references/work-records.md | 扩展当前进度字段；新增长任务接续与汇总 | 与 state 冲突修正需求直接对应 |

这些改动是**同一目的**（parent-slice-continuity）的修订批次，没有删减独立 Oracle、真实执行、失败保留、体验归属等底线。未发现改动之间互相矛盾。按用户当前指令，未提交内容保留，由 master 后续决定是否 snap。

## 修订批次自洽性检查

- **目的单一**：5 个文件都围绕“恢复父级切片、技术批次不等于父级交付、接续冲突以真实产物为准”，没有夹带无关规则。
- **入口一致**：SKILL 第 4 步要求恢复父级；references/slices 要求实施批次指向父级；execution 要求批次结束回父级；work-records 要求 state 记录父级与技术批次。四处指向同一动作。
- **不降标准**：没有删除“Expected 确认”“独立 Oracle”“失败保留”“人工体验不得冒充”“归档后再修改”等约束。
- **可执行性**：新增要求都能落到已有 state/review/证据结构，没有要求新数据库、通用工作流或额外工具。
- **与 AGENTS 一致**：AGENTS 原本要求“强制持续使用”“阶段转换留下依据”“每个修订批次先归档”，修订只是把执行细节写清。
- **未解决**：修订没有规定“父级闭环表”放在哪个文件、由谁维护频率；项目需要用 state 或 scope 的现有入口承接，不能因此另造大型流程系统。
- **风险**：新增“父级未闭不得升级”可能被误读为“所有父级都必须先完成才能做任何技术切片”。实际应理解为“技术切片可以继续，但不得宣称父级交付”；恢复时需 master 明确。

结论：本批修订适合保留，但“父级闭环表放哪里/多久更新”仍需 master 在项目层决定，不宜再靠 skill 增加抽象。

## 归档与 SHA

归档目录按“改动前快照”命名：11 个文件全部存在；与现行文件比较，5 个不同、6 个相同，差异对应上表 5 个修订文件。逐文件 SHA-256 与 manifest 全部一致（11/11），manifest 的 `verified:true` 经独立复算成立。差异数量只说明版本不同，不能单独证明先后，见下文。

| 归档文件 | SHA-256（前 16 位） | 与现行 |
|---|---|---|
| SKILL.md | e5893f796f32756a | 不同 |
| references/prd.md | 9c6a21317bbbd273 | 相同 |
| references/acceptance-plan.md | 210cf2672ab68c1e | 相同 |
| references/slices.md | d5b38afd676349fb | 不同 |
| references/execution.md | 7751a9582dd62e8a | 不同 |
| references/work-records.md | c7fb93a33ec0183b | 不同 |
| references/business-design.md | 1ead4df62f7c04a4 | 相同 |
| references/scenario_acceptance_spec.md | 672104b304a98cdc | 相同 |
| references/cases.md | f60bd25c9cdfae8d | 不同 |
| references/experience.md | 42fd25b8e6e95779 | 相同 |
| references/modes.md | 810ae900a879a5cf | 相同 |

归档路径、时间戳和排除 `archived/` 的做法符合 AGENTS 的归档规则。归档目录与 manifest 尚未跟踪，属于待 master 提交的状态，不是内容缺失。

## 归档验证过程

- 先列归档目录全部文件：11 个，含 SKILL 与 10 个 references，无 scripts/config/隐藏文件；未发现遗漏的入口文件。
- 以 manifest 的 `files` 为清单，逐文件读取并计算 SHA-256；11/11 与 manifest 完全一致，无缺失、无多出。
- 再与现行 11 个文件逐字节比较：5 个不同、6 个相同；差异与未提交改动的 5 个一致。这只能支持“归档与现行版本不同、且差异对应同一修订”，**不能单凭 5/6 数量证明归档先后时间**；先后需归档创建记录、批次记录或原快照证据，本次未取得独立时间证据。
- 检查归档是否包含 `archived/` 自身：没有；不存在递归快照。
- 检查目录名：`20261027-115231-parent-slice-continuity`，时间与原因明确，未与旧归档重名。
- manifest 的 `verified:true` 是项目自述；本次独立复算确认成立，但仍需 master 最终认可。
- 未验证归档文件在 Git 历史中的来源；当前归档目录本身未被跟踪，不能在提交前称为“已入库基线”。

## 已有规则但没有执行

以下问题不是“skill 没写”，而是项目执行未落实现行规则。每条都能在 138 份文档或索引中找到证据。

| 编号 | 未执行的规则 | 实际表现 |
|---|---|---|
| E-01 | 正式 Case 唯一版本、确认后原地登记（cases.md） | 21 个能力组进入 `cases.md`，plan/review 出现 49 组；S03d/e/f/g/h/i/j、S05 适配/通知、S06 活动/故事、S07 素材/输入、S08 native 多组无正式入口 |
| E-02 | Case 状态必须反映实际执行（execution.md） | `cases.md` 头部仍是“当前批次 S01”；MEMUI 001～004、BUDGET 001～004 等 NOT_COVERED 已被后续 PASS 取代；FACTID-002 v1 PASS 与 v2 未独立执行并存 |
| E-03 | Evaluation Report 逐 Case 记录并更新 evaluation.md（execution.md） | `evaluation.md` 只覆盖 S01/S02a/S02b/S03a/S03b 与 S07 素材；S03c～S03l、S04～S08 的矩阵散在各 review |
| E-04 | 技术设计与验收计划要有 Case→实现→Runner 映射（acceptance-plan.md） | 中心 `acceptance-plan.md` 只有 S01；后续 50 余份 plan 分散，未汇总入口 |
| E-05 | 技术批次完成不能替代父级切片（slices/execution） | 多篇 review 明确“接受切片、不代表 S03/S05/S06/S07/S08”，但 scope/state 没有父级闭环表，容易把切片接受读成父级通过 |
| E-06 | 保留原始失败与唯一批次，不覆盖（execution/work-records） | s03j 覆盖 s03c 固定截图后恢复；s06g 重用 001/002/003 日志名；s04d 一次测试失败被后续成功覆盖；s05f 开发删除中间调试批次；s03f/s03e/s07b 有固定证据目录/复用旧 final 的审查记录 |
| E-08 | 每个 skill 修订批次留下迭代记录（AGENTS） | `scope.md` 引用 `../北极星迭代/parent-slice-continuity.md`，该文件不存在；manifest 只有归档与 SHA，没有问题位置、影响、理由、验证与未解决事项 |
| E-09 | 状态只作接续索引，冲突时核对真实产物（work-records） | 审计发现时 state 仍写“3 个审计执行者并行”“正在执行 exec57057”，而 process-audit 与真实报告显示 exec57057 已结束、来源身份待独立验收；scope 与 state 对同一批次表述不一致 |
| E-10 | 使用固定状态枚举，不造新状态（execution） | s07b 曾用 `PARTIAL`（非五状态），后改 `INCONCLUSIVE`；多篇用“PASS（子项）”混合整体结论，未逐子项列全 |

E-07 不计入执行遗漏：现有接受记录已明确标注 Codex 受托/自动化/截图审查及局限，**不构成冒充违规**；但没有人类亲自体验记录，原生对话框、物理屏、真实锁屏/Spaces/Retina 属于未验证，不能写成人类体验通过。编号保留以避免与已有引用错位。

## skill 真实缺陷/歧义

以下不是“没执行”，而是规则本身不足以防止上述问题；是否修订由 master 决定。本轮不修改。

| 编号 | 缺陷/歧义 | 证据 | 影响 |
|---|---|---|---|
| S-01 | `cases.md` 要求“唯一版本”，但未明确要求**每个 Contract 组/每个 ID 都在正式 Case 文件登记**，也未禁止用“001～006”区间代替逐 ID 版本；当一个成员（FACTID-002）改 v2 时，区间无法表达单成员失效 | 21 vs 49 组；FACTID-002 v1/v2；`cases.md` 第 121/153 行 | 正式入口与计划/审查分叉，恢复时无法只读一个文件判断当前 Contract |
| S-02 | `execution.md` 说“按需更新 evaluation.md”，没有明确**唯一权威矩阵**是 evaluation 还是各 review；也没有要求父级汇总入口 | `evaluation.md` 只到 S03b；S04～S08 矩阵在 review | 中心验收记录长期过期，仍可能被当作全量状态 |
| S-03 | 五状态未规定**子项聚合**：一个 Case 多个子项时，何时记“PASS（子项）”、何时整体 INCONCLUSIVE/NOT_COVERED，规则只写“全部通过才 PASS” | s07b 的 PARTIAL→INCONCLUSIVE；NOTIFY/ASSET3 的子项写法 | **master 决定：不新增规则**；原有“全部必需项通过才 PASS”已足够，不采用整体取最差或未定义状态序关系 |
| S-04 | 父级闭环曾缺少明确规则，导致大量技术批次被接受而父级未闭 | 本次未提交的 5 文件修订正是补此点 | **master 已审查并保留**；不算未解决缺陷 |

判断：**E-01～E-10 是执行问题；S-01/S-02 暂由项目统一入口落实；S-03 按 master 决定不新增规则；S-04 已在本批修订中处理。** 不能把执行问题写成“skill 已缺陷”，也不能用修订 skill 代替补录真实 Case、证据和体验。

## 修订候选与不修改理由

S-01 的最小候选是两句话：正式 Case 文件必须为每个 Contract 组提供入口，组内成员单列版本；区间写法只作索引，任一成员改版必须展开。它不改变 Expected 规则，只补可追溯性。

S-02 的最小候选是把“按需更新 evaluation.md”改成“每个父级至少有一个权威矩阵；review 可保留细节，但 evaluation 或显式索引必须能定位”。它不要求复制 review，也不增加新文件类型。

S-03 不修订：master 决定原有“全部必需项通过才 PASS”已足够；不采用“整体取最差”或任何未定义的状态序关系，也不增加子项聚合规则。

本轮不修改的理由：
- master 决定本轮不扩 skill；S-01/S-02 暂在项目统一入口落实，S-03 不新增规则。
- 当前已有 5 文件未提交修订；再改会形成未归档的第二批，违反“先归档再修改”。
- 任何后续修订都必须重新归档当前版本，并补 `parent-slice-continuity.md`；不能沿用本批归档冒充新批。

## 归档完整性结论

- 原样归档位置：`.agents/skills/polaris/archived/20261027-115231-parent-slice-continuity/`。
- 11/11 文件 SHA 与 manifest 一致；5 个修订文件与现行差异对应同一修订，6 个未改文件逐字节相同；先后时间未被独立证明。
- 归档未包含 `archived/` 自身，无递归；未发现隐藏文件遗漏（该 skill 无 scripts/config）。
- `quick_validate` 通过，只证明结构有效，不证明行为有效；未做跨会话行为评测。

## master 审核清单

1. 是否认可 5 个未提交修订属于同一批次，并保留其未提交状态？
2. 是否认可归档 11/11 SHA；归档先后时间证据是否充分（本次未单凭 5/6 判定）；是否要求把归档与 manifest 纳入 master 的提交？
3. 是否要求补写 `parent-slice-continuity.md`；若要求，由谁写、写在哪、是否与 manifest 合并？
4. S-01/S-02 项目入口落实、S-03 不新增规则的决定是否保留；若另开 skill 修订，是否必须另行归档？
5. E-01～E-10 中哪些由项目文档补录解决，哪些需要重跑/重做证据？
6. 是否接受“本轮不修改 skill”的边界，且不把本报告当作 master 已决定？
7. 是否允许继续使用当前未提交 skill 推进流程补齐；若不允许，先恢复到归档版本还是保持工作区？
8. 是否要求对归档中的 6 个未改文件也做行为核对；本审计只做了结构/字节一致。

## 审计未覆盖

- 未修改 skill，未补写 `parent-slice-continuity.md`；该记录应由 master 审核后落盘。
- 未验证尚未提交的 skill 改动在真实接续中的行为效果；需要后续实际使用复盘。
- 未审计 `archived/20261025-delegated-acceptance-221621` 之外的旧快照；未审计 marketplace 缓存中的其他 skill 版本。
- 未把本审计当作 master 已决定；master 已审查问题清单，是否提交/进一步修订仍由 master 决定。

## 结论

- 当前 skill 结构有效，未提交修订目的单一、与归档差异一致，master 已审查并保留。
- 大多数流程问题是“已有规则没执行”，核心在 Case 入口、状态索引、证据保留和父级闭环；不能靠改 skill 掩盖。
- S-01/S-02 暂由项目统一入口落实；S-03 按 master 决定不新增规则；S-04 已由修订覆盖。
- 归档 11/11 SHA 成立；差异与未提交改动一致，但归档先后时间未被独立证明；归档与 manifest 未跟踪；迭代记录缺失仍是 GAP-09。
- 本分册与另外两份一样，只提供事实和缺口，不宣称流程补齐完成。
