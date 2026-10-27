# S01～S08 父级流程链审计

> 时间基线：2026-10-27。此为历史审计发现；master 已审查问题清单，后续纠正与决定以 [process-audit.md](process-audit.md) 为准。

2026-10-27。审计者：Claude Code CLI（单一执行者；本轮未使用子代理）。master 曾误派 3 个 Codex 审计代理，用户纠正后已中断，其报告未用于本审计结论。对象：`Bayper完整交付` 下 138 份现行流程文档（不含 `process-audit.md`）、PRD 与 7 份业务规则、`cases.md`、`evaluation.md`、`acceptance-plan.md`、各 review 引用的证据。`archived/` 只作追溯，未当现行规则。

方法：逐份读取；对照“需求→切片/业务模型→Case→技术验收计划→真实执行证据→体验/受托接受”；只读核查路径、SHA 与归档；不重跑产品测试、GUI、真实 API。判定描述的是“当前证据能支持到哪”，不是产品完成度评分。

## 总览

| 父级 | 业务设计与切片 | Case 入口 | 技术/验收计划 | 真实执行证据 | 体验/接受 | 父级结论 |
|---|---|---|---|---|---|---|
| S01 | s01-design | ONBOARD-001～006 已登记 | acceptance-plan 仅此片 | 6+6+1 日志，evaluation 矩阵 | Codex 受托，Accept 当前范围 | 切片闭合，REQ 未全闭 |
| S02 | s02/s02b/s02c | COMPANION/DESKTOP 已登记；RELATION 未登记 | 各 plan 分散 | 陪伴、桌面、关系日志 | 多次受托接受，原生体验缺 | 部分 |
| S03 | s03-design + s03a～l | 多组已登记；d/e/f/g/h/i/j 组缺入口 | 各 plan 分散 | 领域/GUI/真实模型日志密集 | 多次受托接受；语义未闭 | 部分，核心未闭 |
| S04 | S04a～e | SOURCE/ANALYSIS 部分登记；UI/AUTO 未登记 | 各 plan 分散 | 25/25、32/32 等 | 授予设置受托；原生对话框未体验 | 部分 |
| S05 | S05a～j | CONNECTOR/TRANSPORT 已登记；ADAPTER/HERDR/NOTIFY 未登记 | 各 plan 分散 | 真实隔离 Herdr + GUI 通知 | 通知切片受托；物理体验缺 | 部分 |
| S06 | S06a～j | BUDGET 已登记；ACTIVITY/STORY/DISCOVERY/CONTENT 未登记 | 各 plan 分散 | 活动、故事、作者内容日志 | 领域/GUI 切片受托；正式内容门 false | 部分 |
| S07 | animation-plan + s07/07b/07c | ASSET/ASSET3/RESTUI/HIT 均未登记 | 各 plan 分散 | 播放器、桌面、原生输入日志 | 受托；非人类连续体验 | 部分 |
| S08 | s08a + native-rework | NATIVE-001～003 未登记 | s08a plan | native 3、桌面 11、修复 14 | 受托；全页面/Spaces/Retina 未验 | 部分 |

结论：**0 个父级按现行全套 REQ 闭合；S01 仅“首次相遇”切片闭合。** 其余父级均有已接受切片，但父级业务路径、正式素材、真实依赖或体验仍缺。以下逐级说明。

## 判定口径

本审计不把“存在 plan/review 文件”当完成，也不把“review 写了 PASS”直接当父级通过。每级按六项核对：

1. **业务依据**：该父级对应的 REQ、业务规则文件是否明确；未编号要求是否被显式识别，而不是被切片名掩盖。
2. **Contract 入口**：Expected 是否进入正式 `cases.md`；若只在 plan/review，是否至少有稳定 ID、Given/When/Expected/Oracle/Execution Boundary，并能在恢复时被找到。
3. **技术/验收计划**：是否有 Driver、Boundary、Observation、Oracle、Evidence；是否说明真实依赖与 Mock 边界；是否给出 Case→Runner 映射。
4. **真实执行**：是否有实际执行的日志/数据库/截图/请求记录；日志是否对应同一源码版本；失败是否保留；是否只是构造 fixture 或静态截图。
5. **接受归属**：是用户亲自接受、Codex 受托接受，还是仅开发者自述；接受范围是否写明“不是父级/不是全 PRD”。
6. **父级闭环**：切片接受后，是否回到父级用户结果核对“还缺哪段真实路径”；是否有父级验收表与下一动作。

证据强度只作阅读辅助：
- **强**：正式业务入口 + 真实 SQLite/真实依赖 + 独立 Codex 执行 + 失败保留 + 明确边界。
- **中**：真实入口但依赖构造 HTTP/构造时钟/隔离 fixture；或只有开发者报告，master 尚未独立。
- **弱**：只有计划、源码阅读、静态截图、单测或“文件存在”。弱证据不计 PASS。

本审计把“产品未开发”与“流程缺失”分开：前者是尚未实现/未发布，不应补造成已执行；后者是本应留下而缺失的 Contract、计划、证据、索引或接受记录。

## S01 首次相遇

- 业务依据：REQ-05、REQ-55；REQ-21/45 只取首次阶段需要的部分。s01-design 冻结了配置、许愿、接纳、重启与安全边界。
- Contract：`cases.md` 已登记 POL-ONBOARD-001～006，Expected 与 s01-design 一致；acceptance-plan 的 Part A/B 只覆盖本片，Runner 为 onboarding/live-onboarding。
- 证据：s01-review 记录真实 DeepSeek 短请求、重定向拒绝与日志数组返修；evaluation 的 Coverage Matrix 为 unit 6/6、acceptance 6/6、live 1/1。日志文件存在，路径核对通过。
- 接受：Codex 明确写“Accept（S01 当前首次相遇范围）”，同时声明不是人类体验、不覆盖角色资源/桌面/聊天。
- 结论：当前切片闭合；父级 S01 不能代表 REQ-21/45 的后续部分。流程缺口：GAP-02、GAP-03、GAP-04、GAP-05。

## S02 桌面陪伴

- 业务依据：REQ-01/03/44/47/48/50/56/57；companionship-rules、state-and-rhythm。
- Contract：COMPANION-001～006 与 DESKTOP-001～007 已在 `cases.md` 登记；S02c 的 RELATION-001～004 只存在于 s02c-relationship-effects-plan，未进正式 Case 入口。
- 计划/证据：s02-plan、s02b-plan、s02c-plan 分别给出范围与 Oracle；s02-review、s02b-review、s02c-review 有独立执行记录。S02b 的 P0L 桌面日志与环境证据存在；S02c 23/23。
- 接受：S02a、S02c、S02b 的“可运行阶段实现”分别受托；S02b 明确“不标整体 PASS”。原生点击、Spaces/全屏、合成、真实锁屏、Retina 仍未取得。
- 结论：数值/名单/画布基础部分接受；父级 S02 未闭。`evaluation.md` 的 DESKTOP 表与 `cases.md` 语义错位（见 GAP-03）。缺口：GAP-01、GAP-03、GAP-05、GAP-07、GAP-13。

## S03 有记忆的对话

- 业务依据：REQ-09/18/49/51/60/61；memory-and-sharing、state-and-rhythm、s03-design。
- Contract：已登记 ONBOARD-004、MEMORY-001～007、CHAT-001～008、MEMUI-001～006、SHARESETTING-001～005、SEM、FACTID、ASSOC、REL、SOURCECTX、SOURCE-REL、SOURCE-LIVE、SOURCE-ID。S03d SHARING、S03e SHAREUI、S03f CHATMEM、S03g CHATRELAY、S03h EXCLUSIVE 系列、S03i AUTOSHARE-CONTROL、S03j THEME-SHARE 只在 plan/review，不在正式 Case 入口。
- 计划/证据：s03a～s03l 每片有 plan、review、专属 Runner；S03b 的 POL-CHAT-008 经历首轮 FAIL、四轮真实 DeepSeek；S03f 有真实模型六场与正式 GUI；S03g/h 有真实转告/独属对照；S03j/k 有主题共享与全局开关；S03l 有基线 7 FAIL、探针、留出、关联、来源协议、真实来源对照。
- 接受：多片由 Codex 受托接受，但均声明“不等于完整 S03”。原 SEM-001/002/005/006/007 仍 FAIL；异 factKey 语义关联未通过。来源身份 v2 已由开发实现并写 4 个新 Case，首轮 001/002 红、修复后开发报告 35 项 29 PASS/6 FAIL；**无 Codex 独立 review/log，6 个旧机制 FAIL 未获授权适配，存量误合组未迁移**。
- 业务设计冲突：s03-design 第 11 行仍写“需要共同事实键”与“模型提议语义键”，与 s03l-source-identity-plan 的“factKey 不是跨角色身份、正文相同也不自动同组”冲突；v1 的历史 PASS 不能作为 v2 依据。
- 结论：服务/管理/GUI 多条纵向链已接受；父级 S03 未闭。缺口：GAP-01、GAP-02、GAP-05、GAP-06、GAP-07、GAP-11、GAP-12。

## S04 外部来源

- 业务依据：REQ-13；memory-and-sharing 的来源停用/撤权；state-and-rhythm 的共享预算。
- Contract：SOURCE-001～013 与 ANALYSIS-001～011 已在 `cases.md` 登记；SOURCE-UI-001～003、SOURCE-AUTO-001～005 只在 s04d/s04e plan/review。
- 计划/证据：S04a 权限 6/6；S04b 读取 12/12（含 012）；S04c 分析 32/32（含 provenance、预算收尾）；S04d 设置 16/16；S04e 生产 25/25。日志与批次路径存在。
- 接受：权限、reader、分析链、设置页、生产心跳分析分别受托；均限定模块/构造模型/临时目录。原生目录对话框、真实用户会话、真实模型提炼语义仍未被人类验证。
- 结论：REQ-13 的“发现、默认关闭、逐目录授权、撤销、有限分析”有较强证据；父级未闭。缺口：GAP-01、GAP-05、GAP-07、GAP-14。

## S05 工作陪伴

- 业务依据：REQ-06/21/28/35/58；PRD 连接器/通知规则；state-and-rhythm 七种工作状态。
- Contract：CONNECTOR-001～007、TRANSPORT-001～004 已登记；ADAPTER-001～008、HERDR-LIVE-001～003、HERDR-ID-001～003、REGISTER-001～004、HERDR-RUNTIME-001～012、NOTIFY-001～009、CONNECTOR-UI-001～006、NOTIFY-UI-001～011 只在各 plan/review。
- 计划/证据：S05a 账本 7/7；S05b 传输 4/4 + 真实 Herdr 3/3；S05c 身份探针 3 项；S05d 登记 4/4；S05e 适配 19/19；S05f 通知 9 项；S05g 运行 23/23；S05h 停止证据 27/27；S05i 连接 UI 26/26；S05j 通知 GUI 11 项分两批 5+6，另有桌面 11/连接 6。
- 接受：各切片受托；真实 Herdr 使用隔离自建 server，通知为自动化窗口/构造事件。真实用户 Herdr 工作流、物理屏幕阅读、真实锁屏与长期稳定性未验。
- 结论：REQ-06/28/35 的当前实现边界有证据；REQ-21/58 的端到端未闭。缺口：GAP-01、GAP-05、GAP-07、GAP-13。

## S06 低频故事

- 业务依据：REQ-46/48/52/53/54/59；clues-and-discovery、state-and-rhythm。
- Contract：BUDGET-001～008 已登记；OPPORTUNITY-001～007、ACTIVITY-001～008、ACTIVITY-RUNTIME-001～004、STORY-001～005、DISCOVERY-001～006、CONTENT-001～003、STORYRUN-001～005/004B/UI、STORYUI-001～005 不在正式 Case 入口。
- 计划/证据：S06a 预算 8/8；S06b 机会 7/7；S06c 活动 33/33；S06d 26 项；S06e 5/5；S06f 27/27；S06g 3/3；S06h 日常 6/6 + 桌面 11/11 + 单元；S06i 54 Node + 7 GUI；S06j 25 领域 + 18 unit + 7 GUI。
- 接受：预算、机会、活动领域、作者目录、日常动作、故事运行时、故事窗口分别受托。S06d 的 daily 正式播放当时 NOT_COVERED，S06h 才补凛 stretch；探索出发/返回动画、其他角色 daily、正式素材发布、自动邀请/服装窗口仍缺。
- 内容门：`maid-stories.json` 四条 assetAvailable 均 false；测试内发布只证明可达性，不证明正式内容可用。
- 结论：领域链较强，父级 S06 未闭。缺口：GAP-01、GAP-05、GAP-07、GAP-14。

## S07 角色表现

- 业务依据：REQ-03/39/40/45/49/58；animation-plan（现行规划，范围由 master 按用户授权决策）；STYLE.md。
- Contract：ASSET-001/002 在 asset-pilot；ASSET3-001～005、RESTUI-001～003、HIT-001～003 只在 plan/review；均未在 `cases.md` 登记。
- 计划/证据：切帧/播放器/像素尺寸有工具与 Codex 视觉审查；凛 idle/wave/stretch/sit 正式接入；Hu/Cheng idle/wave/stretch 基础接入；S07c 原生透明命中 3 项 + 桌面 11/11 + unit 18/18。
- 接受：各切片受托，明确“非人类连续观看”“Retina 未覆盖”“Spaces/全屏未覆盖”。36 动作、服装、睡眠/倾听正式接线、D03/D04、其他角色休息均未完成。
- 结论：REQ-39 的基础画风/动作接线有证据；REQ-40/45/49/58 的完整表现未闭。缺口：GAP-01、GAP-05、GAP-07、GAP-14。

## S08 整体交付

- 业务依据：PRD 原生窗口/单屏/设置/生命周期；S08a plan。
- Contract：NATIVE-001～003 只存在于 s08a-native-shell-plan；`cases.md` 未登记。POL-DESKTOP-007 已登记，但只覆盖本体尺寸/资源接线。
- 计划/证据：S08a 独立 28/28，修复后 desktop 11 + native 3 = 14/14；凛主窗口母版 1 个 Case；S08 其余页面/设置/原生 Spaces/全屏/Retina/最终端到端没有 Contract 与证据。
- 接受：S08a 的“三页真实能力整合与崩溃恢复”受托；明确不代表全 S08。
- 结论：父级 S08 未闭，且大部分是产品尚未开发，不是旧流程 PASS 被误记。缺口：GAP-01、GAP-05、GAP-07、GAP-14。

## 跨父级断点

父级内部的切片接受不能自动接成产品纵向链。按真实业务路径核对，当前断点如下：

| 路径 | 已接通的片段 | 断点 | 影响父级 |
|---|---|---|---|
| 首次配置→接纳→小窝 | S01 配置/许愿/接纳；S02 名单/数值 | 正式素材、注册/存储迁移之外的长期数据兼容未全验；S01 不覆盖后续 | S01/S02 |
| 聊天→记忆→纠正/删除 | S03b 窗口、S03c 管理、S03f 三动作、S03g/h 转告/独属 | 异 factKey 语义同义未通过；来源身份 v2 未独立验收；存量误合组未迁移 | S03 |
| 来源授权→分析→角色记忆 | S04a 权限、S04b 读取、S04c 分析、S04d 设置、S04e 心跳 | 真实原生目录对话框、真实用户会话、真实模型提炼语义未验；撤销在途的长期运行未验 | S04/S06 |
| 低频机会→活动→故事/线索 | S06b 机会、S06c 活动、S06d 运行时、S06e/f 故事/发现 | 正式 daily 仅凛 stretch；探索出发/返回动画缺；正式内容 assetAvailable=false | S06 |
| 故事成熟→邀请→服装 | S06f 领域、S06i 运行时、S06j 窗口 | 自动邀请气泡、服装解锁提示/穿用、正式发布后全链未验收 | S06 |
| Herdr→Agent→通知→气泡 | S05a–e 连接/适配、S05f 队列、S05g/h 运行/停止、S05i/j UI | 真实用户 Herdr 工作流、物理屏阅读、真实锁屏/Spaces/Retina 未验 | S05 |
| 角色素材→动画→活动场景 | S07 资产/播放器/桌面、S06h daily、S07b/c 输入 | 36 动作、服装、睡眠/倾听正式接线、其他角色 daily/休息未做 | S06/S07 |
| 全部能力→原生窗口/设置/交付 | S08a 三页、各面板自身尺寸 | 全部设置页、Spaces/全屏/Retina、最终真实模型+隔离 Herdr 端到端、交付文档未完成 | S08 |

这些断点不是“某个 review 写错了”，而是父级没有闭环表时，局部 PASS 很容易被读成整体可交付。GAP-05 要求先建表，再由 master 验收流程补齐；不要求所有父级产品完成。

## 产品未开发与流程缺失对照

| 事项 | 产品状态 | 流程状态 | 处理方向 |
|---|---|---|---|
| 36 项动作语义 | 仅少量动作正式；其余未制作 | animation-plan 是现行规划，未形成逐项 Contract；范围以用户明确授权 master 决策为准，不因未逐项确认判无效 | 不补造假 PASS；按 master 决策范围补 Contract/制作，本轮不自行扩缩 |
| 多套服装/换装 | 未开发/未发布 | 无正式 Case | 作为产品后续切片，不写成流程已通过 |
| 正式故事/服装素材 | 四条 assetAvailable=false | 测试内发布只证明可达性，正式门保持关闭 | 发布后重走全链，不提前打开 |
| Spaces/全屏/Retina | 未取得真实系统证据 | DESKTOP-003/006、HIT-002 已写边界，但无正式 Case 入口 | 补 Contract/体验，不能用 DOM 或 scaleFactor=1 代替 |
| 最终真实模型+Herdr 端到端 | 未完成 | 无单条最终链 Contract | 作为 S08/Goal 终止条件补计划 |
| 正式 Case 入口 | 已有多组 Contract | 约 28 组未进 `cases.md` | 补录索引，不改 Expected |
| 中心验收记录 | 多组 review 有矩阵 | `evaluation.md` 未覆盖 S04～S08 | 汇总真实结果，保留失败 |
| 人工体验 | 无人类亲自记录 | 受托接受标注了自动化边界 | 补任务卡与真实体验，不冒称 |

判断原则：**产品没做，不补造成“做过”；流程没留，必须补录或重做；两者都不能用“文件存在”替代。**

## 横向矩阵

| 检查项 | 结果 | 依据/说明 |
|---|---|---|
| 138 份文档逐份读取 | 完成 | 含 S01～S08、跨切片材料；`archived/` 未作现行 |
| 正式 Case 入口 | 不完整 | `cases.md` 21 个能力组；plan/review 出现 49 组；约 28 组无正式入口 |
| Case 状态准确 | 不准确 | 头部仍写“当前批次 S01”；多处 NOT_COVERED 已被后续 PASS 取代；FACTID-002 v1/v2 并存 |
| 中心验收记录 | 不完整 | `evaluation.md` 只到 S03b（加 S01/S02/S07）；S04～S08 的结果散在 review |
| 中心技术计划 | 过期 | `acceptance-plan.md` 只有 S01；后续计划分散且未回索引 |
| 真实执行证据 | 大量存在 | 240 个文件型引用；9 个为“json/.log”缩写、可选模块或多路径拼接，无真实缺失 |
| 体验/人工证据 | 缺失 | 无人类亲自体验记录；受托决定均标注自动化/截图审查；原生对话框、物理屏、真实锁屏/Spaces/Retina 未验 |
| 父级闭环 | 0/8 | 仅 S01 首次相遇切片闭合；其余为部分接受 |

## 审计未覆盖

- 未重跑任何产品测试、GUI、真实模型/API；未独立复算日志中的每个断言，只核对路径、评论中的 Coverage 与关键失败证据。
- 未逐句审计 PRD 全文与全部研究材料；只审计 PRD 明确 REQ、被引用的 7 份业务规则及其 Contract 链。
- 未验证 5097 个证据文件的全部内容与 215MB 证据的完整性；未验证历史 Git 提交与线上状态。
- 未取得的真实人类体验、真实用户 Herdr 会话、原生系统对话框、Retina/Spaces/全屏、长期运行与最终交付文档，均保持未验证，不因本审计补造。

## 后续顺序（master 已决定）

1. 先统一 Case/计划入口并修正设计冲突。
2. 再处理验收矩阵、证据保留、父级闭环与未编号约束。
3. 最终由 master 验收流程补齐并决定恢复。

本分册只提供 2026-10-27 审计事实；未完成 GAP 不在本轮关闭，纠正以 [process-audit.md](process-audit.md) 为准。
