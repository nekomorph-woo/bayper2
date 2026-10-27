# REQ 与未编号要求到 Contract 的覆盖追踪

> 时间基线：2026-10-27。此为历史审计发现；master 已审查问题清单，后续纠正与决定以 [process-audit.md](process-audit.md) 为准。

2026-10-27。范围：PRD 现行 31 个 REQ（REQ-01～61 的现行编号集合）与 PRD/业务规则中明确但未编号的要求。只读追踪，不修改 Expected，不把产品未开发补造成已验收。

状态标记：
- **A**：有明确受托接受的切片证据，且 review 写清边界；不等于父级 REQ 全面通过。
- **P**：部分 Contract/模块接受，REQ 的完整路径未闭。
- **N**：产品尚未开发或正式素材/内容未发布；本身不是流程缺失。
- **G**：流程缺失（Case 未登记、计划/验收记录缺失、索引过期等）。
- **U**：真实依赖或人类体验未验证。

## 读法与计数

- “直接 Contract”只列能追到 Expected 的正式 Case 或唯一 plan；review 里的复述不算第二份 Contract。
- “A”表示该切片有独立执行证据并被 master 受托接受；同一 REQ 的其余路径仍可能是 P/N。
- “P”不表示失败，只表示当前证据不足以按完整 REQ 判定。
- “N”不进入流程缺口计数，但会阻塞对应父级的 Goal 终止。
- “G”是本次审计要补录/重做的流程问题，不等于产品功能失败。
- 31 个 REQ 按 PRD 现行编号集合统计；REQ-02/04/07/08/10/11/12/14/15/16/17/19/20/22～27/29～34/36～38/42/43 等不在现行 PRD 编号中，未虚构成需求。
- 本表不把“研究探针 PASS”“单元测试通过”“HTTP 200”“进程 exit 0”当作 REQ 通过。

## 31 个 REQ

| REQ | 父级 | 直接 Contract / Case | 主要证据与接受边界 | 状态 |
|---|---|---|---|---|
| REQ-01 | S02/S05 | COMPANION、DESKTOP、CONNECTOR、NOTIFY、UI | 陪伴与通知切片分别接受；无父级整体接受 | P |
| REQ-03 | S02/S05/S06/S07 | DESKTOP、NOTIFY-UI、ACTIVITY、ASSET3、HIT | 不抢焦点/透明命中/低频有模块证据；完整互动与体验未闭 | P |
| REQ-05 | S01 | ONBOARD-001/002/005/006 | S01 6/6 + live 1/1，真实 DeepSeek 短请求 | A |
| REQ-06 | S05 | CONNECTOR、ADAPTER、NOTIFY、NOTIFY-UI | 账本/适配/通知/真实隔离 Herdr 有证据；真实用户端到端未验 | P |
| REQ-09 | S01/S03 | ONBOARD-004、MEMORY、CHAT、SEM | 重启连续、本地记忆接受；SEM 001/002/005/006/007 仍 FAIL | P |
| REQ-13 | S04 | SOURCE-001～013、ANALYSIS、SOURCE-UI/AUTO | 权限/reader/分析/设置/生产心跳接受；原生对话框与真实会话未验 | P |
| REQ-18 | S03 | CHATMEM、EXCLUSIVE、SHARESETTING、SEM | 同 factKey 纠正/删除/禁分享接受；异 factKey 语义未闭 | P |
| REQ-21 | S05 | CONNECTOR、HERDR-RUNTIME、CONNECTOR-UI | 双向启动/重连/停止证据；真实用户 Herdr 端到端未验 | P |
| REQ-28 | S05 | CONNECTOR、ADAPTER、CONNECTOR-UI | 逐 Agent 身份与状态隔离接受 | A（切片） |
| REQ-35 | S05 | NOTIFY-001～009、NOTIFY-UI-001～011 | 3 普通+1 加急、4/6 秒、分页/恢复接受；物理屏/人工阅读未验 | P |
| REQ-39 | S07 | ASSET、ASSET3、RESTUI、STYLE | 凛与 Hu/Cheng 基础动作、像素画风接线；完整动作/服装未做 | P |
| REQ-40 | S07/tools | 造型资料工具、animation-plan | 310 维工具与配方存在；无产品 Case/验收；36 动作范围由 master 按用户授权决策，不因未逐项确认判无效 | N/G |
| REQ-41 | 全局 | tools/*、SQLite 模块 | 结构约束有实现；无专门 Case，属横向审查 | P/G |
| REQ-44 | S02 | COMPANION、DESKTOP、ACTIVITY | 小窝/单一同屏/休息基础接受；完整小窝体验未闭 | P |
| REQ-45 | S01/S02/S07 | ONBOARD、COMPANION、ASSET3 | 稳定身份/昵称接受；多套服装与换穿未开发 | P/N |
| REQ-46 | S06 | CONTENT、DISCOVERY、STORYRUN | 三角色 4 故事 8 节点可达；正式资产门 false | P/N |
| REQ-47 | S02 | COMPANION-001/002 | 1 固定+4 随机、去重/换固定接受 | A（切片） |
| REQ-48 | S06 | BUDGET、OPPORTUNITY、ACTIVITY | 预算/机会/活动领域接受；正式 daily/探索全路径未闭 | P |
| REQ-49 | S07 | ASSET、ASSET3 | 形象/动作基础一致；完整表情、服装与 36 动作未做 | P/N |
| REQ-50 | S02 | COMPANION-004、RELATION-001～004 | 三项数值基础 23/23；有效互动/共同活动接线未全 | P |
| REQ-51 | S03 | MEMORY、SHARING、THEME-SHARE、CHAT | 独属/定向共享/转述接受；语义关联与正式主题投递未闭 | P |
| REQ-52 | S06 | STORY、DISCOVERY、CONTENT、STORYRUN | 线索/邀请/服装领域接受；正式发布、自动邀请/服装窗口未闭 | P/N |
| REQ-53 | S06 | BUDGET、OPPORTUNITY、ACTIVITY-RUNTIME | 低频/预算/并发接受；探索动画与全角色活动未闭 | P |
| REQ-54 | S06/S03 | CONTENT、THEME-SHARE | 主题/故事目录存在；四条正式内容 assetAvailable=false | P/N |
| REQ-55 | S01 | ONBOARD-003 | 愿望排序/确认前零关系/接纳 1 关系接受 | A（切片） |
| REQ-56 | S02/S06 | COMPANION、DESKTOP、ACTIVITY | 精力轮换/自然节点/聊天不切换接受；原生连续体验未验 | P |
| REQ-57 | S03 | CHAT-001、CHAT-UI | 名单外临时聊天、名单不变接受 | A（切片） |
| REQ-58 | S05/S07 | ADAPTER、NOTIFY、ASSET3、HIT | 7 工作状态映射/通知/动作接线；语义与完整动画未全 | P |
| REQ-59 | S06 | STORY、DISCOVERY、CONTENT | 低频/去重/7 天/72 小时领域接受；正式内容体验未闭 | P |
| REQ-60 | S03 | SHARING、THEME-SHARE、CHATMEM | 来源/接收者/默认不共享接受；异 factKey 与正式主题 GUI 未闭 | P |
| REQ-61 | S03 | CHATMEM、EXCLUSIVE、SHARESETTING | 同 factKey 同步/防回流/全局开关接受；语义同义事实未闭 | P |

## 按父级的 Contract 缺口

| 父级 | 已进正式 Case 入口 | 只在 plan/review | 追踪结论 |
|---|---|---|---|
| S01 | ONBOARD-001～006 | 无 | 入口最完整；仍缺父级 REQ 全路径 |
| S02 | COMPANION-001～006、DESKTOP-001～007 | RELATION-001～004 | 数值/桌面入口有；关系事件未进 |
| S03 | MEMORY、CHAT、MEMUI、SHARESETTING、SEM、FACTID、ASSOC、REL、SOURCECTX、SOURCE-REL/LIVE/ID | SHARING、SHAREUI、CHATMEM、CHATRELAY、EXCLUSIVE 系列、AUTOSHARE-CONTROL、THEME-SHARE | 入口最多但仍缺 7 组；FACTID v2 状态未清 |
| S04 | SOURCE-001～008、ANALYSIS-001～011、SOURCE-013 | SOURCE-009～012、SOURCE-UI、SOURCE-AUTO | 权限/分析有；UI 与生产自动入口未进 |
| S05 | CONNECTOR-001～007、TRANSPORT-001～004 | ADAPTER、HERDR-LIVE/ID、REGISTER、HERDR-RUNTIME、NOTIFY、NOTIFY-UI、CONNECTOR-UI | 大量已接受切片无正式入口 |
| S06 | BUDGET-001～008 | OPPORTUNITY、ACTIVITY、ACTIVITY-RUNTIME、STORY、DISCOVERY、CONTENT、STORYRUN、STORYUI | 预算外基本未进 |
| S07 | 无（ASSET 在 asset-pilot） | ASSET-001/002、ASSET3、RESTUI、HIT | 入口最弱，需优先补 |
| S08 | 无（DESKTOP-007 属 S02 桌面） | NATIVE-001～003 | 入口缺失，且产品未完成 |

说明：上表按能力组统计，不按“文档提到过 ID”统计；同一组内的子项版本差异（如 FACTID-002）另见 GAP-02。正式入口缺失不等于该切片没有执行证据，只表示恢复时无法从唯一 Case 文件找到 Expected 与映射。

## REQ 证据强度分布

- **强证据集中区**：S01 配置/接纳、S02a 名单/数值、S03b/c/f 的聊天与本地管理、S05 账本/传输/适配/通知、S06 预算/活动/故事领域、S07 基础动作/输入。共同点是真实 SQLite/正式业务入口/独立执行。
- **中证据集中区**：真实模型语义对照、来源身份 v2、S04 生产分析、S05 真实隔离 Herdr、S06 运行时故事、S07 三角色动作。共同点是构造 HTTP/构造目录/隔离 server 或仅开发者报告。
- **弱证据/未验证区**：人工体验、原生目录对话框、物理屏阅读、真实锁屏/Spaces/Retina、正式素材发布后的全链、最终端到端交付。
- 这张分布图用于决定“恢复后先补哪条链”，不是给 REQ 打分；强证据也不能跨 REQ 借用。

## 明确未编号要求

| 要求 | 来源 | Contract / 证据 | 状态 |
|---|---|---|---|
| 首次配置失败可修复、Key 不泄漏 | PRD 模型配置；S01 design | ONBOARD-001/002/005 | A |
| 自动行为不抢焦点、普通输入窗可输入 | PRD 核心约束；S02b/S08a | DESKTOP-002、NATIVE-002、HIT | P（原生 Spaces/全屏 U） |
| 3 普通位+1 独立加急位；4/6 秒；1/4/8 秒目标 | PRD 通知数值；state-and-rhythm | NOTIFY-001～009、NOTIFY-UI-001～011 | A（自动化）；人工/物理屏 U |
| 30 分钟评估、25% 抽签 | state-and-rhythm | OPPORTUNITY-001～007 | A（模块/构造时钟） |
| 全局 1/h、4/8h、6/24h、角色 2h、1 在途 | state-and-rhythm | BUDGET-001～008 | A（模块；真实 HTTP 另验） |
| 探索 4h/24h、并发 1、15～30 分钟 | state-and-rhythm | ACTIVITY-001～008、RUNTIME | P（真实探索动画 N） |
| 线索 24h 1 段、邀请 7 天 1 次、服装 72h 1 套 | clues-and-discovery | STORY、DISCOVERY | A（领域）；正式内容 N |
| 6 行为状态、7 工作状态、5 类短反应 | PRD/state-and-rhythm | CONNECTOR、ADAPTER、ASSET、RESTUI | P（动画覆盖不全） |
| 36 项动作语义 | animation-plan（现行规划；范围由 master 按用户授权决策） | 仅 ASSET/ASSET3/RESTUI 的部分动作 | N（未开发，不是无效） |
| 原生单屏、1200×800/960×680 无整页滚动 | PRD/S08a | NATIVE-001～003；各面板自身尺寸 | A（三页及已接面板）；全页面未验 |
| Spaces/全屏/Retina/真实锁屏 | PRD/S02b/S07c | DESKTOP-003/006、HIT-002 | U/N |
| 真实模型+隔离 Herdr 最终端到端 | Goal 终止条件 | 分散于 S03/S05/S06 | U（无单条最终链） |
| 模型不可用时本地陪伴与如实报错 | PRD 独立运行 | CHAT-008、S03b live | P（构造链路 A） |
| 最终交付文档、snap、清理、体验 | Goal 终止条件 | 无最终汇总 | G/N |

## 未编号要求补充说明

- 非焦点与原生输入：S02b/S07c 有真实系统输入与透明命中证据；但 Spaces/全屏/Retina 仍未取得，不能把“不抢焦点”扩写成“所有原生场景通过”。
- 通知时效：S05j 对 1/4/8 秒目标使用自动化采样，且明确“物理容量不足时如实记录超期”；这不是人类阅读通过，也不是任何突发规模都一秒可见。
- 自动预算：S06a/b 用构造时钟验证窗口与并发；真实网络延迟、长时间运行、系统睡眠后的额度恢复未验。
- 探索：S06c/d 对暂停/恢复/同 ID 有强证据；探索离桌的正式出发/返回动画仍是候选，不能用“状态标签”冒充动作。
- 线索/邀请/服装：S06e/f 的领域额度与去重通过；正式内容未发布，自动邀请与服装窗口未闭环，不能据测试内发布目录判定产品可用。
- 状态/动画：7 工作状态到通知映射有证据；6 行为状态到 36 动作的覆盖远未完成；animation-plan 是现行规划，范围由 master 按用户授权决策。
- 原生单屏：S08a 三页与后续若干面板各自通过；全页面、全设置、长内容和最终窗口仍未统一验收。
- 最终端到端：真实模型 + 隔离 Herdr + 正式素材 + 角色活动 + 通知 + 记忆修正没有单条链同时跑通；现有证据是分段拼接。
- 交付：最终安装/启动/配置/数据说明、snap、清理与人类接受未完成；Goal 终止条件未满足。

## REQ → GAP 映射

| GAP | 主要影响 REQ/要求 | 说明 |
|---|---|---|
| GAP-01 | 全部有 Contract 的 REQ | 正式 Case 入口缺 28 组，恢复时找不到唯一 Expected |
| GAP-02 | 09/18/51/60/61；MEMUI/BUDGET/SOURCE | 过期 NOT_COVERED 与 v1/v2 并存，状态不可信 |
| GAP-03 | 01/03/44/56/58；S02b/S04～S08 | evaluation 缺段与 DESKTOP 错位，无法按 REQ 汇总 |
| GAP-04 | 全部 | 中心计划只有 S01，Runner/证据映射分散 |
| GAP-05 | 全部 | 切片接受未回到父级闭环，0/8 |
| GAP-06 | 09/18/51/60/61 | 来源身份 v2 未独立验收，SEM 仍 FAIL |
| GAP-07 | 01/03/06/13/21/35/44/49/58 | 人工体验与真实原生/物理环境未验 |
| GAP-08 | 证据可信度（全 REQ） | 失败批次被覆盖/删除，影响可复查性 |
| GAP-09 | 流程迭代 | 迭代记录缺失，无法追溯 skill 修订依据 |
| GAP-10 | 流程迭代 | 未提交改动待 master 决定，不阻塞产品 |
| GAP-11 | 09/18/51/60/61 | s03-design 与来源身份决策冲突 |
| GAP-12 | 接续状态（全 REQ） | state/scope 旧在途与当前事实冲突 |
| GAP-13 | 全 REQ 的记录 | 状态枚举/子项聚合不规范 |
| GAP-14 | 39/40/41/45/46/49/52/54/58/59 | 未编号要求无 Contract 或产品未开发；范围由 master 按用户授权决策 |

## 不可宣称清单

以下说法在当前证据下不成立，恢复前不得写入总结或交付：

- “全部 PRD 需求已实现/已验收。”
- “S03 记忆语义已完成”，因为 SEM-001/002/005/006/007 仍 FAIL，异 factKey 未闭。
- “来源身份问题已修复”，因为只有开发实现/4 个新 Case，6 个旧机制 FAIL 未处理，存量误合组未迁移，master 未独立验收。
- “S06 故事/服装已交付”，因为正式 assetAvailable=false，自动邀请/服装窗口未闭环。
- “S07 36 动作已完成”，因为只接了少量动作，且 36 项未全部制作/验收；范围由 master 按授权决策。
- “S08 全页面/原生体验已通过”，因为只验了三页与部分面板，Spaces/全屏/Retina 未测。
- “人类体验已通过”，因为现有记录均为 Codex 受托/自动化/截图审查。
- “所有失败证据均已保留”，因为存在覆盖/删除记录。
- “流程补齐完成”，因为 master 已审查问题清单但 GAP 未闭合、最终验收未完成。

## 覆盖结论

- 31 个 REQ 中，**没有一条能按“PRD 全部引用规则+完整链路+体验”判为闭合**。REQ-05/28/47/55/57 有较强切片接受；其余均有明确未闭路径。
- 约 9 条可标“当前范围接受”（05、28、47、55、57，以及 06/35/50/58 的特定切片），但接受范围都写在 review 边界里，不能上推为 REQ 全通过。
- 产品未开发与流程缺失必须分开：36 动作、服装、正式故事素材、Spaces/Retina、完整原生体验属于 **N**；这些没有 Contract 或未发布，不等于“曾经 PASS 被误记”。
- 流程缺失集中在：后续 Contract 未进 `cases.md`、`evaluation.md` 未覆盖 S04～S08、`acceptance-plan.md` 只有 S01、父级闭环未建、来源身份批次未独立验收、人工体验与失败证据记录不足。对应 GAP-01～GAP-14。
- 未编号要求中，造型维度（REQ-40）、36 动作、最终端到端、最终交付文档没有单一可执行 Contract；需在对应范围恢复前由 master 决定补 Contract 或明确排除，不因此阻塞其他范围。

## 审计未覆盖

- 未重跑测试/真实模型/GUI；上述“A”只表示 review 中存在独立执行证据与接受记录，不表示本次审计复算通过。
- 未把 `cases.md` 的区间写法（如 FACTID-001～006）逐 ID 展开为独立登记；这正是 GAP-02 的一部分。
- 未验证所有证据文件的内部断言；未验证历史提交是否与当前工作区一致。
- 未审计 PRD 之外的营销/研究材料作为产品依据；研究 PASS 未被当作产品验收。
