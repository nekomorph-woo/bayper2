# Bayper 完整交付范围与切片

2026-10-25，Codex 受托决定 v1。用户最新指令授权开始正式开发并持续至 Goal 完成；产品依据为 [PRD](../Bayper桌面陪伴/prd.md) 及其详细规则。不是缩小版 MVP，不以研究或原型通过替代产品通过。

Codex 是唯一 master，负责业务、Case、技术计划、独立验证和受托体验；Claude Code CLI 实现代码；Codex imagegen 制作角色位图。接受记录明确实际操作者，不记成人类亲自体验。

## Goal执行与终止约束（2026-10-27用户补充）

完成现行PRD及全部引用规则，交付可运行Electron应用的范围保持不变。整个Goal必须持续执行仓库内北极星skill，Codex为唯一master；每次接续恢复阶段、父级切片、业务Case和证据，再派发Claude Code。局部模块或探针PASS不得代替父级业务闭环。

持续真实使用并优化北极星是重要过程目标：在阶段转换、重要返修及发现记录矛盾时审查流程，发现实际问题先完整归档再修订，并验证新版是否改善接续/决策/验收。终止审计除逐项PRD实现、正式素材、真实集成/体验与交付证据外，也须覆盖已发现的北极星流程问题及修订依据；没有问题无需为凑数修改。

此处保存用户对active Goal的当前执行约束；系统Goal工具仅能更新状态，不能改写仍进行中的objective原文，因此不把本文同步冒称系统Goal字段已修改。原系统Goal本已包含Polaris master与流程迭代要求，本条将其持续执行方式明确化。

## 当前接续（r190，S06m自动告知窗口独立验收）

POL-OUTFIT-001～007在计划隔离边界内聚合PASS，逐项见s06l-master-review.md r179。真实Electron/SQLite、构造时间/系统事件和候选素材限制明确；正式assetAvailable=false、全角色/服装24+12及父级S06/S07/Goal未完成。S06m Part A共享额度/原子确认已master独立78/78接受并snap a8b8d80；B真实窗口/点击跳转/抢占已由单Claude CLI实现，方案c0b7aa6；master复验发现迟到初始快照覆盖点击目标，已保留FAIL并定向修复，独立40项通过，旧通知/工作反应14项通过加UI-010修正后独立通过，已受托接受B窗口阶段，重启与真实时限已独立008/009通过，邀请拒绝/接纳联动也已独立UI-010通过，完整Case尚待探索/切换门禁变体收口。A不替代整体自动告知验收，状态及证据见s06m-master-review.md。

## 历史阶段（2026-10-28，S07/S05工作结束短反应已有限接受）

凛的真实 Herdr finished→必达文字→一次欣喜→恢复待机路径，已由 master 独立13/13 GUI及11/11领域/单测受托接受，边界与原始证据见 [s07-work-reaction-review.md](s07-work-reaction-review.md) r160。旧返修记录保留追溯；不代表全量角色动画或最终人类体验通过。

S03s Part F分层接线已独立202/202通过，固定两批真实模型未复现角色场景混入住址或无授权披露承诺；f2/005的“没记过”历史推断仍FAIL，父级S03未完成。详 [s03s-master-review.md](s03s-master-review.md)。Part G三角色U/K有限样本通过，未修改生产或撤销旧失败。S06k自动服装归属已独立37/37通过，见[s06k-master-review.md](s06k-master-review.md)；当前推进[s06l-outfit-wear-plan.md](s06l-outfit-wear-plan.md)主动换装完整路径，自动提示预算另批；正式角色/服装配方、其余动画及父级交付路径仍待完成，完整Goal不变。

## 按可用路径推进

| 切片 | 用户结果与覆盖来源 | 当前结果 |
| --- | --- | --- |
| S01 首次相遇 | 独立启动、配置模型、表达愿望、接纳首位、重启保持关系；REQ-05/21/45/55 | 当前切片6项Case PASS，受托接受；不覆盖这些REQ在后续切片的其余部分 |
| S02 桌面陪伴 | 小窝、每日名单、固定安排、临时聊天、自然轮换、数值恢复；REQ-01/03/44/47/48/50/56/57 | S02a安排/轮换、S02b凛画布、S02c关系数值基础已接受；正式活动接线见S06d。数值基础不等于所有有效互动/共同故事触发均完成，完整成长路径与最终原生体验仍需逐项闭环 |
| S03 有记忆的对话 | 模型回应、人格、独属记忆、定向共享、纠正删除防回流；REQ-09/18/49/51/60/61 | 对话、条目式纠正删除与防回流已部分接受（969c391/e87d332/9c8e505）；真实模型构造链路见state.md；明确转告/禁分享本地领域已独立58/58接受（s03d-review.md）；S03e正式共享入口独立23项GUI与41项领域通过（s03e-review.md）；S03f聊天纠正/忘记/禁分享及正式GUI已通过（s03f-review.md），明确聊天转告与独属控制的领域/正式GUI/真实模型已在各自边界接受（s03g/s03h-review.md）；S03i持久自动共享开关已独立65领域、19unit、14GUI通过（s03i-review.md）。S03j主题新活动→定向记忆共享链与来源归因已在构造发布目录的领域链、正式记忆UI和正式未发布门中接受（s03j-review.md）；S03k聊天全局关闭/恢复及失败GUI重试已独立94领域、19unit、1专属GUI和12邻接检查接受（s03k-review.md）；来源身份 v2 有限能力（17套件163/163）与 POL-MIG v1 迁移有限能力（18套件170/170，真实SQLite/构造旧库）已由 master 受托接受；S03m 显式纠正/忘记语义核验 POL-SEMOP-001～008 v1 已受托确认计划（两阶段/来源追溯/临时纠正），008 已测有限能力经 master 19 套件 185/185 受托接受，但 008 聚合仍 NOT_COVERED（部分已验）；001～007 聚合仍 NOT_COVERED（002 部分分支、003 生命周期/单消息 GUI、006 uncertain/网络已测并随本批接受）；S03m temporary 2c-1 的已测领域与真实 chat/构造 HTTP 范围已由 master 独立复跑 20 套件 295/295、exit 0、摘要一致后受托接受（`master-temporary-final-gmf6gukR`；不是用户亲自确认、不是真实模型/GUI/UI IPC）；2c-2 §13 方案/D1～D16 已由 Codex 受托批准（非用户亲自确认）；2c-2a 与 2c-2b 已分别由 master 独立 20 套件 335/335、358/358、exit 0、before/after SHA 一致后受托接受为已测存储/来源/操作与真实 chat/SQLite+构造 HTTP 有限能力（`master-multil-final-ZLv9fbBn`、`master-temporary-chat-OKCwajaU`）；temporary 专属取消/恢复组合已由 master r54 三套件 111/111 + cleanup 1/1 接受（temporary cancel/close/dispose、构造 pending 恢复、真实 SIGKILL 重开 GUI），并接受 temporary/forget 阶段1/2 单消息 GUI 与 forget uncertain/network；模拟 suspend 仅为 correct 的模拟事件，不代表 temporary 专属真实系统锁屏/休眠通过；POL-SEMOP-001～008 聚合仍 NOT_COVERED；S03o-B forget 目标澄清已测有限接受（master 2026-10-28；后端 `master-s03o-b-core-HAu7KrCs` 313/313、GUI `master-s03o-b-gui-M3KWYxVe` 9/9，均 0 skip/exit 0/SHA 一致；不是完整 S03；未覆盖真实模型/自然泛化、临时跨持有者/回答前到期、GUI 多候选/同 identity/临时/self、correct 时间）；异 factKey 语义纠正/删除/共享生产入口、语义模型闭环/GUI/正式资源仍未完成 |
| S04 外部来源 | 发现 Coding Agent，默认不分析、逐目录授权与撤销，来源分析与预算；REQ-13 | 权限/reader/提炼防回流、S04d正式授权设置及S04e生产心跳分析已接受；S04e独立25/25（含来源12、设置3、聊天UI10），见s04e-review.md。本地HTTP与构造目录不证明全部真实来源语义效果；原生目录对话框人工体验尚未取得 |
| S05 工作陪伴 | Herdr 插件、双向启动、独立 Agent、重连对账、普通和加急通知；REQ-06/21/28/35/58 | 正式插件登记/发现、adapter恢复、stop证据及S05i连接设置已接受，见s05h/s05i-review.md。S05j正式气泡已受托接受：当前11项通知GUI分两批独立通过，桌面/连接设置17项回归通过，见s05j-review.md；超量延迟如实审计，自动化窗口不替代最终原生体验 |
| S06 低频故事 | 自动机会、并发预算、探索退出/接替、连续线索、邀请与服装解锁；REQ-46/48/52/53/54/59 | S06a/b预算与机会、S06c活动领域、S06d生产用途路由/暂停及探索接替已接受相应边界；S06h凛真实日常已独立活动6/6、桌面11/11接受，Hu/Cheng日常候选接线见S07b，透明输入S07c已独立验收，探索缺出发/返回动画。S06e/f/g故事/发现领域及4故事8节点作者目录已验，正式assetAvailable均false，S06i main活动→故事运行接线已独立54项Node/7项GUI通过，正式目录仍false；故事回看/可见手动邀请及接纳窗口已在S06j接受（s06j-review.md），自动邀请与服装窗口仍待闭环；见s06i/s06j-review.md |
| S07 角色表现 | 统一形象/性格/服装，36动作语义的资源制作、真实播放及一致性；REQ-03/39/40/45/49/58 | 凛idle/wave/stretch/sit正式，休息静坐保持与起身衔接见s07-rest-runtime-review.md；sleep已有有限运行时验收（bb72ed0），listen仍是播放器候选；happy-v4切帧/播放器已审，工作结束短反应已有限受托接受（review r160）。S07b三角色基础候选已接线并独立验证，Hu/Cheng仍保留候选，透明输入S07c已独立验收（s07c-review.md）。参考assets/characters/STYLE.md及s07b-review.md；全部正式角色/服装/动作语义与连续体验未完成 |
| S08 整体交付 | 所有窗口与设置、生命周期、无焦点打扰、真实模型/Herdr集成、完整回归和体验 | 正式原生三页与崩溃有界恢复593304c已接受，独立14/14及受影响GUI28/28；完整业务页面、所有设置、最终原生输入/Spaces/全屏与端到端交付仍未完成 |

切片可交错补齐依赖，但每次代码派发保持可检查规模。角色与主题内容采用少量完整作品验证多角色、多衣服路径，不以大量未完工角色凑数量；具体内容包制作前冻结配方。REQ-41 贯穿数据和工具组织。已有310维度资料工具保留，正式内容引用它。

## 父级追溯表（2026-10-27）

本表补 GAP-05：从父级路径追到正式入口、历史已验范围和未闭路径。它不计算完成率，也不把技术批次或局部 PASS 升级为父级接受。逐 Case 结果见 [evaluation.md](evaluation.md)。

| 父级路径 | REQ / Case 入口 | 历史已验范围（仅切片） | 未闭路径 / 下一阶段 |
| --- | --- | --- | --- |
| S01 首次相遇 | REQ-05/21/45/55；[cases.md](cases.md) ONBOARD-001～006 | 6 项当前切片 PASS 并受托接受；首次配置/愿望/接纳/重启/真实服务核实 | S01 切片接受有效；这些 REQ 在桌面、聊天、Herdr、最终体验中的剩余义务由相应父级承担，不要求重做 S01 |
| S02 桌面陪伴 | REQ-01/03/44/47/48/50/56/57；COMPANION、DESKTOP、RELATION | 安排/轮换/数值、关系事件、Rin 画布与生命周期基础已接受 | DESKTOP-002 已由 S07c 1 test/3 Case 覆盖真实点击；003 Spaces/全屏、006 真实锁屏、004 托盘点击未闭；正式活动接线在 S06 |
| S03 有记忆的对话 | REQ-09/18/49/51/60/61；MEMORY/CHAT/MEMUI/SHARING/SHAREUI/CHATMEM/CHATRELAY/EXCLUSIVE/AUTOSHARE/THEME/SHARESETTING/SEM/FACTID/ASSOC/SOURCE-*/SEMOP | 基础记忆、聊天、条目管理、转告、独属、自动共享开关、主题定向共享、正式 GUI 与部分真实模型构造链已按切片接受；来源身份 v2 与 POL-MIG v1 迁移有限能力已受托接受；SEMOP-001～008 v1 计划已受托确认；2c-2 §13 方案/D1～D16 已批准，2c-2a/2c-2b 已分别获有限接受 | 来源身份 v2（17套件163/163）与迁移 v1（18套件170/170）已接受有限能力；POL-SEMOP-008 已测有限能力经 master 19 套件 185/185 受托接受，但 008 聚合仍 NOT_COVERED（部分已验）；001～007 聚合仍 NOT_COVERED（002 部分分支、003 生命周期/单消息 GUI、006 uncertain/网络已测并随本批接受）；FACTID-002 v1 机制 PASS 仍失效；缺失历史边不恢复、孤儿旧键兼容、非拆分身份保守检查；SEM 5 FAIL、holdout 2 FAIL、source-live 2 FAIL 未重跑；2c-2b 已获有限接受；master r54 另以三套件 111/111 + cleanup 1/1 受托接受本批 temporary/forget 生命周期与 Electron GUI 有限能力（temporary cancel/close/dispose、构造 pending 恢复、真实 SIGKILL 重开 GUI、阶段1/2 单消息 GUI、forget uncertain/network），模拟 suspend 仅为 correct 模拟事件；真实模型 L1/L2、正式资源与完整 S03 仍未覆盖；异 factKey 语义闭环、正式主题自动分享 GUI 未闭 |
| S04 外部来源 | REQ-13；SOURCE/ANALYSIS/SOURCE-UI/SOURCE-AUTO | 权限/读取/分析、设置、正式心跳自动分析已接受 | 真实来源语义质量、跨文件同义防回流、原生目录 dialog 人工体验未验证；上游记忆改动待回归 |
| S05 工作陪伴 | REQ-06/21/28/35/58；CONNECTOR/TRANSPORT/HERDR-LIVE/HERDR-ID/REGISTER/ADAPTER/RUNTIME/NOTIFY/UI | 账本/传输、真实隔离 Herdr、登记、适配、运行、停止证据、通知队列与正式气泡/连接设置已按切片接受 | 最终真实模型＋隔离 Herdr 端到端、插件安装入口与跨重启恢复仍需整体复验；不得读取用户真实工作会话 |
| S06 低频故事 | REQ-46/48/52/53/54/59；BUDGET/OPPORTUNITY/ACTIVITY/STORY/DISCOVERY/CONTENT/STORYRUN/STORYUI | 预算/机会、活动生命周期、探索、故事/发现/作者目录领域、main 消费与故事窗口已接受相应边界 | 正式四故事 assetAvailable=false；自动邀请、正式活动→相遇、服装 72h 解锁/穿用、发布后 GUI 全链未闭 |
| S07 角色表现 | REQ-03/39/40/45/49/58；ASSET/ASSET3/RESTUI/HIT | Rin/Hu/Cheng 基础待机/招呼/日常、休息、透明输入与真实点击已按切片接受；素材候选与透明命中边界已记录 | 36 动作语义/正式素材/服装/过渡中断未完成；其他角色日常与探索离场/返回未闭；透明命中 ASSET3-001 子项 NOT_COVERED |
| S08 整体交付 | PRD 原生单屏、设置、Spaces/Retina、最终集成；NATIVE-001～003 | 正式三页、两尺寸、崩溃有界恢复和凛主窗口母版已接受 | 其余设置页、Spaces/fullscreen/Retina 原生证据、真实模型＋隔离 Herdr 端到端、交付文档与临时环境清理未完成 |

补充口径：

- S01 首次相遇切片接受有效，不因后续父级未闭而失效；跨 REQ 的剩余义务由相应父级承担，不用 0/8、百分比或“最差状态”概括。
- Codex 已有真实体验授权；已注明实际操作者、方法与局限的受托体验不构成冒充人类，也不要求真人重新批准。没有人工体验的部分继续保持未验证。
- 最终 Herdr 验证可使用真实隔离 server 与构造会话，不要求读取用户真实工作会话。未取得的真实硬件证据（Retina、物理锁屏/睡眠、Spaces/全屏）如实保持未验证，不用测试截图冒充物理操作。

## Goal 终止条件

所有 PRD 要求和链接规则有 Case/实现/证据映射；全部必需 Case 实际通过；正式 macOS Electron 应用可启动并走通实际业务，具备可用角色与服装动画，不显示未完资源为可用；真实模型和隔离 Herdr 集成有记录；异常、重启、授权撤销、记忆修正、消息突发有验证；Codex 完成受托视觉及互动体验并解决阻断问题；启动/配置/数据说明与 snap 完整，清理本次临时环境。

未覆盖、模型语义不确定、仅 Mock 或无法取得的原生桌面证据明确保留，不能为了结束 Goal 降低承诺。北极星实际问题按完整归档→修订→验证→后续采用新版处理，记录在北极星迭代目录。

## 难点的研究与调优

用户追加要求：记忆策略、检索等难点在设计和开发调优期间阅读优秀开源项目源码，建立参数/策略调整入口，由Codex持续对照迭代。S03实施前将已有记忆研究与具体仓库版本、代码机制对应，再制定基线与候选策略。每轮在相同构造场景核对中文短词、同义表达、重要偏好、独属归属、纠正/删除与防回流，同时记录延迟与调用成本；改进方案不能越过产品不变量。规则已纳入AGENTS.md及CLAUDE.md，工具自包含，避免大而泛的调优平台。

## 窗口体验更新（2026-10-26）

用户要求native、主要内容单屏、减少滚动。S08采用 [原生窗口返工](../Bayper窗口原型/native-rework.md) 的固定应用框架与局部滚动约束；先通过三个代表页的实际审查再延展，不能把旧原型视觉接受沿用到正式产品。业务范围和已实现服务不因布局返工削减。

## 接续覆盖审计（2026-10-26）

上表为已提交、已独立验收的子项索引，不是整条REQ的PASS；具体Expected仍在cases.md及各切片计划，执行边界见各review与state.md。本次只纠正过时NOT_COVERED，不改变PRD范围或验收标准。

接下来必须跨越的生产闭环：

1. **设置→获准来源→低频机会→真实分析→角色记忆**：S04d与S06b之后统一接main生命周期、聊天优先、共享预算及撤权/暂停取消，不能留下仅测试组合可运行的服务。
2. **Herdr插件→稳定登记→晚启动发现→事件/快照对账→独立Agent通知**：身份验证只是决定正式实现的依据；已观察往返变化、恢复缺口、三普通位＋独立加急位都要实际产品验收。
3. **陪伴状态→日常/探索→版本内容→线索/相遇/衣服**：使用真实持久化进度和已发布素材，探索退出桌面并可暂停恢复，不能以随机文本或未完成图集替代内容流程。
4. **真实互动→关系数值/独属记忆→定向共享→纠正删除**：数值事件基础不等于已接有效互动；共享入口及自然语言操作仍需场景验收。
5. **正式内容与最终体验**：角色尺寸/画风已确认，候选资产必须逐项通过真实播放、衔接和服装一致性审查；最终桌面体验与交付文档不可由上述模块测试替代。

工具组织REQ-41贯穿所有切片：现有SQLite/造型目录工具是已存在能力，新增项目工具仍须自包含审查，不将此横向约束标作一次性完成。

## 历史阶段：S03o-B forget 目标澄清已测有限接受；不是完整 S03（2026-10-28 r79）

master 2026-10-28 **受托有限接受 S03o-B 本批已测删除目标澄清能力**（非用户亲自确认，不是完整 S03）。独立后端 `evidence/master-s03o-b-core-HAu7KrCs` **313/313、0 skip、exit 0、before/after 一致**；独立 GUI `evidence/master-s03o-b-gui-M3KWYxVe` **9/9、0 skip、exit 0、before/after 一致**；当前 SHA 均核对 OK。master 实际查看截图 `evidence/s03m-lifecycle/gui-shots/2026-10-27T16-01-26-121Z-30808` 的 clarify-question/phase1-pending/phase2-final：真实候选问题、输入、单 assistant 原位更新与输入恢复可读；真实 Electron/SQLite + 构造 HTTP，不是人类体验或真实模型。

- 接受范围仅本批已测删除目标澄清；不笼统称所有 Case 完整 PASS。保留先前失败、越规模与返修事实。
- 未覆盖：真实模型/自然泛化、临时跨持有者/回答前到期独立 Case、GUI 多候选/同 identity/临时/self、correct 时间、完整 S03。
- 版本 `0.1.201 → 0.1.202`（10 文件 11 处仅字面量，不升级依赖/不重生成 lock）待 master snap。生产 561/测试 1219 经 master 依据职责与独立场景审查允许作为本片成果；未提前报告为执行偏差（skill 已有要求，本批不改 skill）。
- 下一步：先真实聊天两轮选择验证与缺失边界；全 Goal 素材/其他切片不缩小。

## 历史阶段：S03o-A 单轮明确 correct 本地补全获有限接受；不是完整澄清/语义/S03（2026-10-27 r74，已 snap 4ce18ea）

master 独立最终五套 **277/277 pass、0 skip、exit 0、before/after 一致**（`evidence/master-s03o-a-final-O584PFa8/`），据此**受托接受 S03o-A 已测单轮明确 correct 本地补全有限能力**（非用户亲自确认）。live `evidence/master-s03o-a-live-Z7Y05M66/` **10 REVIEW / 1 FAIL（C07）**，44 chat + 10 relation + 1 models，模型为 `/models` 验证的 `deepseek-flash`；C03 原始 `memoryOperation=null`，actual/effective correct，A/B 长期 body/version 不变，两条当日 temporary，`expires=1793116799999`，单 assistant 如实说明、关系 equivalent；falseMerge 0、wrongDelete 0、wrongSync 0、leak 0，11 临时目录无残留。C07 different vs uncertain 仍 FAIL。

- **C02 本次成功不代表多轮澄清已修好**；旧 C02/C03/C07 FAIL 与 Expected 保留。未覆盖：GUI/live 泛化、多轮澄清/pending、自然指代、C07 分类、完整 S03 与 `POL-SEMOP-001～008` 聚合。
- 版本 `0.1.200 → 0.1.201`（10 文件 11 处，不升级依赖）已由 master snap `4ce18ea`；生产净增 150 行/测试 608 行经 master 审查属必要规模，本批不再重构。
- 证据偏差：`attempt-20261027-225117-baseline-headprod/` 跨次复用，混合结果见 [provenance-review](evidence/s03o-a/provenance-review-20261027-231443/README.md)，不得当单次基线引用。
- 下一步：登记 S03 多轮最小澄清接续仍待完善；正式资源与 GUI 整体路径保持。

## 历史阶段：S03n 已测主体绑定反证防护与 source Case v2 获有限接受；不是完整主体识别/自然指代/S03（2026-10-27 r70）

master 最终五套 **248/248 pass、0 skip、tests.exit 0、before/after 一致**（`evidence/master-s03n-final-NSKiCUx4`）；实际查看请求/响应/DB 前后后，**受托接受 S03n 已测主体绑定反证防护与 source Case v2**（不是用户亲自确认）。live L2 8 REVIEW / 3 FAIL（C02/C03/C07），DB falseMerge 0，44 chat + 8 relation + 1 models；L1 10/11（C07）；grounded holdout 15/16，falseMerge 0、missedEquivalent 0，仅 pair 15 分类 FAIL；11 目录均核无残留。**C02/C03 是模型 `memoryOperation: null` 并澄清、产品如实显示未改记忆，不是绑定门错误；不得改 Expected 抹掉。**

- 生产约 256 行职责可理解，本批不再重构或加新门；版本 `0.1.199 → 0.1.200`（10 文件 11 处，不升级依赖），待 master snap。
- **能力缺口保留**：自然姓名/弱指代支持、C07/15 分类、真实模型语义总体、完整 S03 与 `POL-SEMOP-001～008` 聚合均未完成；保守拦截不等于全面支持。
- 下一步仅登记“操作识别与澄清反馈闭环”建议，本轮禁止实现/第三轮 prompt。正式方案 [s03n-subject-binding-plan.md](s03n-subject-binding-plan.md)；未改 Git/API/.env/prompt/skill、未用子代理。

## 历史阶段：S03m B2 R1/R2 已测参数与聊天证据契约改进获有限接受；语义总体不接受（2026-10-27 r66）

master 独立五套件 **242/242 pass、0 skip、exit 0、before/after 一致**，L1 **10/11**，L2 十项实际操作审查可接受；据此接受 R1/R2 **已测参数与聊天证据契约改进**（不是用户亲自确认、不是真实模型语义/人类体验，不接受完整 S03/Goal）。**语义总体验收明确不接受**：holdout 12 未绑定“她”的既有 false merge、C07/holdout 15 的 different vs Expected uncertain 均保留，不改 Expected/数据/评分。

- 已验边界：关系请求 temperature 0 生效；聊天候选 body 逐字、操作 evidence 命令分句、新告知经历提炼、第三人/“我们”原话保存口径在 L2 十项操作中可接受。
- 未覆盖：真实模型语义总体、holdout 12 安全缺口、C07/15 分类边界、完整 S03 与 `POL-SEMOP-001～008` 聚合；父级 S03 与 36 动画等待办全部保留。
- 本轮只改文档/版本 `0.1.198 → 0.1.199`（10 文件 11 处），待 master snap；工作区代码/测试/工具保持 master-r2 SHA，未再改。第三人称绑定门方案 [third-person-binding-gate-plan.md](evidence/s03m-b2/third-person-binding-gate-plan.md) 待 master 审核，未实施。


## 历史阶段：S03m temporary/forget 生命周期与 Electron GUI 有限能力已受托接受（2026-10-27 r54）

master 独立三套件 **111/111 PASS、0 skip、exit 0、before/after 一致**（[master-chat-lifecycle-EDScQrNM](evidence/master-chat-lifecycle-EDScQrNM/)）并实际查看 temporary/forget/recovery 截图；异常退出清理复验 **1/1 PASS、exit 0、无 Electron 残留**（[master-lifecycle-cleanup-fpxOn887](evidence/master-lifecycle-cleanup-fpxOn887/)）。据此**受托接受本批已测 temporary/forget 生命周期与 Electron GUI 有限能力**（不是用户亲自确认、不是人类体验、不是真实模型语义，也不接受 S03/完整 Goal）。2c-1 的 295/295、2c-2a 的 335/335、2c-2b 的 358/358 有限接受历史保留。

- 已验（有限范围）：temporary cancel/close/dispose 与构造 pending 恢复后端；真实 SIGKILL 重开 GUI 的 `interrupted`、不重试、阶段 1 保留；temporary/forget 阶段 1/阶段 2 单 assistant 原位更新 GUI；forget uncertain/网络失败分支。真实 Electron/main/preload/renderer/SQLite；聊天与关系模型 HTTP 构造。模拟 suspend 原 Case 为 correct 的 `powerMonitor.emit` 模拟事件，**不代表 temporary 专属真实系统锁屏/休眠通过**。
- 覆盖关系：三套件 111/111 覆盖未变业务断言；cleanup 复验覆盖最终进程清理 helper。开发首次清理遗漏、master 退回与精确 token 修正历史保留。
- 未覆盖：真实模型 L1/L2、正式资源、UI IPC/live、跨角色独立同义、完整 S03 与 `POL-SEMOP-001～008` 聚合；不得把 Agent 自动验收或模拟事件记为用户人工体验。
- 版本：`0.1.196 → 0.1.197`（既有 10 文件 11 处字面量）待 master snap；本批只做文档与版本，未改生产/测试代码、未跑新测试/API/GUI、未 Git/skill。下一步直接接已批准的真实模型 L1/L2 效果验证，不另起大型规划或内部探针。

## 历史阶段：POL-MIG v1 迁移有限能力已受托接受（2026-10-27 r10）

S03 仍在实施与验收。master 独立运行 **18 套件 170/170 PASS、0 skipped、exit 0**，受托接受 POL-MIG-001～006 v1 的真实 SQLite/构造旧库**有限能力**（不是用户亲自确认，非 S03 完成或人工体验）；独立验收运行前后代码 SHA 一致，证据 `evidence/master-migration-YKY21Zj2/`。

- 逐 Case 映射与边界见 [evaluation.md](evaluation.md)；真实依赖为真实 SQLite/构造旧库，无 GUI/API/真实模型。
- 保留边界：缺失历史关系边不恢复；无映射孤儿的 identity/控制/alias 原样保留；孤儿旧键保持兼容、不按当前 factKey 重新归因；非拆分身份保留同指纹整组保守检查；迁移身份相关 DDL/控制/alias 同一保存点回滚已验证。
- after4 空原型比较夹具错误、after5 旧 fixture 缺现有 index 与派生来源回填导致快照差异，均为测试夹具旧 schema 形状补充，不是迁移实现改变；不宣称所有更早 schema 升级全部原子。
- 下一步接 S03 真实语义纠正/删除/共享生产入口；异 factKey 语义策略仍未完成。完整 Goal 与 S01～S08 待办保持；本轮无 skill 新缺陷。

## 历史阶段：流程补齐已受托验收（2026-10-27 时点，保留）

GAP-01～14 流程处置均已完成（GAP-06 仅流程记录、产品修复未完成；GAP-08 原证据未找回限制保留）。本批 snap 前暂不改产品，提交后接回原父级 S03 来源身份工作；产品未交付。

- master 已受托验收 7 个最终 Contract v1 与 Part A/B（[final-acceptance-contract.md](final-acceptance-contract.md)），GAP-14 流程补齐通过；Contract 执行结果仍未产生，归 S08 最终验收入口、跨链既有父级。已提交快照 fdf7144（当时 VERSION 0.1.181，领先 origin/main 133，未推送）；本批拟 snap VERSION 0.1.182，未产生新 hash。
- 完整 Goal 与 S01～S08 全部产品待办保持，不因流程补齐缩小或改写 PRD/Expected；上表切片范围仍是产品依据。
- S03 暂不改产品（待 snap）：来源身份 v2 尚未独立验收（时点记录；后由 r8 接受有限能力），POL-FACTID-002 旧机制 PASS 失效，6 个旧机制 FAIL 与存量误合组未迁移（时点记录；迁移后由 r11 有限接受）；snap 后按顺序接回，不要求先修产品代码/测试才允许流程恢复。
- [s03l-source-identity-plan.md](s03l-source-identity-plan.md) 与 [s03l-identity-plan.md](s03l-identity-plan.md) 的既有修订已获 master 批准，作为当前设计依据随本次流程文档提交；产品源码/测试不提交，实现未独立验收（时点记录；后由 r8 接受有限能力）。
- 下一最小切片（只记录、不实施）：来源身份 v2 的 6 处旧同文 fixture 适配及独立回归；随后立即处理存量错误身份组迁移，并接回 S03 语义纠正/删除/共享闭环。
- 剩余产品路径不缩小：S03 异 factKey 语义闭环与正式主题自动分享 GUI；S06 自动邀请、正式活动→相遇、服装解锁/穿用；S07 36 动作/服装/过渡中断；S08 其余设置、Spaces/fullscreen/Retina、真实模型+隔离 Herdr 端到端与交付文档。
- 本轮补记待办、不实现：POL-MEMORY-001 的“服装切换后记忆条目归属”联动（现有 PASS 仅证明衣装不改变身份/名单/当前位，未直接断言记忆归属）；POL-MEMORY-006 的“普通细节降权/整理”（现有用例只验到期与门禁）。
- skill 修订记录见 [../北极星迭代/parent-slice-continuity.md](../北极星迭代/parent-slice-continuity.md)；真实归档 3e2a64d 已保存，当前问题是执行记录/派工遵循不足，新版已用于补齐，无理由增加 skill 规则。


### S07当前运行切片补充（2026-10-28）

凛睡眠运行已测有限能力由master独立GUI10/10、边界9/9、公开活动16/16后受托接受，见[s07-sleep-master-review.md](s07-sleep-master-review.md)。正式美术仍candidate，其他角色/服装与24＋12动作整体未完成；S05通知010偶发裁切继续独立调查，不由本次接受覆盖。
