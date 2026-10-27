# 正式 Acceptance Cases

正式入口，2026-10-27 流程补建。已有完整 Expected 以本文件内条目为准；外部完整 Contract 只登记引用，不复制第二份 Expected。Case 版本与确认依据逐组注明，未独立执行的不得写 PASS。本文件不记录会过期的测试通过数或批次状态；结果统一见 [evaluation.md](evaluation.md) 及对应 review。

适用元数据：POL-ONBOARD-001～006 为 v1，Codex 依据完整交付授权受托确认，2026-10-25，依据 [s01-design.md](s01-design.md)；该组全部 P0/必需。其余内联分节标题已注明各自 v1 与 Codex 受托确认；以下是 Expected，不是执行结果；确认日期只采用源文档明确写出的日期，不补猜。

本文件覆盖现行 plan/review 中实际已定义的业务 Case。研究/探针子样本若没有独立业务 Contract，只映射父级并标内部证据，不伪造业务 ID。未找到完整 Contract 的组列入文末缺口，不从实现输出反推 Expected。

| ID | 来源与场景 | Given → When | Expected（包括禁止副作用） | Oracle / Execution Boundary |
| --- | --- | --- | --- | --- |
| POL-ONBOARD-001 | REQ-05 首次配置 | 空独立数据目录、兼容服务 → 从实际窗口提交配置 | 验证一次真实 HTTP 请求得到有效文本后进入许愿；空Key/模型不发请求；DB无明文Key，renderer快照无Key | UI步骤+独立服务请求日志+SQLite只读查询；实际Electron/SQLite/safeStorage，仅模型端允许本机受控HTTP服务 |
| POL-ONBOARD-002 | REQ-05 验证失败 | 未配置 → 服务401、超时、非助手文本后再修正重试 | 显示可修复错误，失败不完成配置、不创建角色；成功后可继续，无重复请求风暴 | 预设服务结果断言和持久化记录；同001，不Mock核心服务 |
| POL-ONBOARD-003 | REQ-55 愿望和接纳 | 已配置无角色 → 输入安静愿望/换候选/确认前退出，再重启并确认两次 | 推荐稳定真实目录角色，确认前零关系；确认后恰好1关系/固定/名单/当前角色，数值10/100/0 | 独立预期目录身份+UI+重开SQLite计数；实际窗口和存储，不靠内部排名函数算Expected |
| POL-ONBOARD-004 | REQ-09/21/45 重启恢复 | 已接纳 → 退出/重开且服务不可达 | 保留同一角色身份/数值/安排，显示小窝，不请求重新接纳，不依赖Herdr | 记录首次ID、实际进程重开、数据库和UI比较；实际Electron，模型关闭 |
| POL-ONBOARD-005 | 配置与隔离边界 | 首次窗口 → 提交远端HTTP、含凭据URL、非法模型输入；页面尝试外部导航 | 拒绝不安全配置，无Key外发/日志泄漏；无任意IPC/文件访问/新外部页面 | 独立请求收集+IPC表面/安全配置审查；真实应用和服务，不用安全配置函数单测代替 |
| POL-ONBOARD-006 | 真实服务核实 | 获授权服务配置 → 实际窗口验证一次，接纳并重启 | 真实服务有效应答，Key安全保存且重启可读取；不输出凭据或私人内容 | 真实兼容服务无Mock，脱敏记录和Codex受托体验；配置尚需确定，此项不允许Mock结果覆盖 |

Runner 映射见 [acceptance-plan.md](acceptance-plan.md)；实际结果见 evaluation.md 与相应 review，本文件不预填 PASS/FAIL。

## S02a 陪伴安排与数值（v1，Codex受托确认）

依据companionship-rules.md及state-and-rhythm.md。该批首先通过实际业务服务入口＋真实SQLite验证规则，再检查UI安排操作；桌面原生画布在S02b，聊天模型在S03，不能把此批当整个S02通过。

| ID | Given → When | Expected / 独立Oracle | Execution Boundary / Priority |
| --- | --- | --- | --- |
| POL-COMPANION-001 | 已结识6位、固定凛 → 首次生成、同日重开、本地跨日 | 当日最多5个唯一ID含凛；同日完全复用；跨日保留固定、余者优先较少参与；旧同屏不在新名单时等待聊天/短节点后交接，不因精力高永久滞留；新接纳不重抽当日；检查SQLite日期、名单与ID集合 | 真实业务服务/SQLite，时钟和随机值为可控外部依赖；初始角色用构造内容；P0必需 |
| POL-COMPANION-002 | 已有固定＋4随机 → 固定改为现有随机者、改昵称 | 仅补原随机空位；其他随机不重抽，不重复；昵称不改ID/数值/关系；不存在角色的操作不写入；比对操作前后集合和行 | 服务/存储真实，UI还须实际操作改昵称/固定；P0必需 |
| POL-COMPANION-003 | 当前角色与名单明确 → 临时互动名单外角色、结束返回、跨日互动 | 同屏只有1个ID，名单/自动资格不因临时互动改变；结束优先返回原合资格且精力/冷却适合者，否则选择候场或安静休息；同一持续在屏者聊天结束不套用重新候场60阈值，仍按≤30交接；跨日可更新资格但不打断聊天状态；当前对话归原ID | 服务/真实存储；模型尚不发送，验证互动生命周期边界；P0必需 |
| POL-COMPANION-004 | 初值100/10/0、可控时间 → 陪伴1小时、候场1小时、休息1小时、离线/恢复、时钟回拨 | 陪伴100→94；候场40→50，休息40→60；离线40经2小时→60且亲密不下降；不同段不重复结算、clamp0..100；回拨不负恢复，重开不再算同段 | 真实业务结算/SQLite，按手算值断言，不调用被测公式生成Expected；P0必需 |
| POL-COMPANION-005 | 当前精力≤30、另有候选≥60 → 自动轮换请求/短节点完成/聊天结束 | 节点前和聊天中不换；符合条件后仅换1次；无候选则当前休息；上次自动退场不足30分钟者不候场；重复完成信号幂等 | 真实服务，播放器完成信号暂作为外部边界驱动；S02b必须接真实播放器；P0必需 |
| POL-COMPANION-006 | 已有S01真实schema数据库 → 升级启动、操作安排、退出重开 | 不丢模型密文、关系ID、初值、已接受时间；名单迁移支持随机位且唯一；迁移可重复启动；不存在记录不被编造；离线不补活动 | 旧schema构造文件→实际新应用/真实SQLite；禁止只测新建库；P0必需 |

POL-COMPANION-004/006同时验证事务失败不留下精力已改但结算时间未改、名单与固定位不一致等半更新；重复start不能吞掉尚未结算的在线时段。

数值中的活动一次扣除、模型互动有效时长、故事亲密及情绪事件将在S03/S06加入完整业务Case，本批不虚构已完成聊天或活动。

## S03a 本地独属记忆与检索（v1，Codex受托确认）

依据memory-and-sharing.md、s03-design.md。本批用构造事实及真实SQLite业务入口；不Mock记忆服务，不用模型返回作为Expected。模型语义定位与真实聊天在S03b另验。

| ID | Given → When | Expected / 独立Oracle | Execution Boundary / Priority |
| --- | --- | --- | --- |
| POL-MEMORY-001 | A获知偏好、B未知 → A/B分别搜索，重启后复查 | A命中且来源/推测标识准确，B为零；昵称/服装变化不改变角色ID归属；重复来源不重复存入 | 真实记忆入口/SQLite/FTS；仅时间可控；P0 |
| POL-MEMORY-002 | 中文短词、同义、中英和相似无关构造集 → 基线与候选策略查询 | 报告每个查询实际命中/漏召回，不硬编码答案；角色隔离和有效性违规为0；独立人工标注Expected，不把总分通过代替逐项记录 | 生产检索入口＋tools/memory-tuning固定集/留出集；P0 |
| POL-MEMORY-003 | A偏好及共享给B的派生内容，C未知 → 明确纠正A | A/B旧理解与派生不可再检索/分享；C仍未知；真正过去经历不被误删；停用旧理解事务完成后才确认；断网亦可执行已定位操作 | 真实服务/DB重开，构造独立同事实键来源与派生；P0 |
| POL-MEMORY-004 | A→B→相关摘要，有源原聊天 → 默认删除，重导入旧源，重建FTS/重启 | 所有已知持有者相关正文及派生清除，索引无旧内容，控制记录无正文；旧源不能恢复，核心上下文/历史拼接不可带回；无关经历与进度保留 | 实际存储与来源写入入口，不读取用户真实会话；P0 |
| POL-MEMORY-005 | A/B都持有 → 只A忘记、试图B再转给A；随后用户明确新许可 | A先不可用且不回流，B保持；用户新许可后可新建理解，旧文件本身不能解除限制 | 真业务定向操作与持有关系；P0 |
| POL-MEMORY-006 | 重要长期、普通细节、临时偏好 → 前进时间/查询 | 重要内容不因久未使用消失；临时到期不能覆盖长期；普通细节可降权，不能利用时间衰减放开权限或删除门禁 | 可控时钟、手写不同期限Expected；P0 |
| POL-MEMORY-007 | A用户私聊与主题见闻 → 定向分享指定片段给B、尝试自动转发给C | 只有B获得指定片段且标明听A说；无多余私聊/工作内容；自动二次转发拒绝；接收不触发API、不改名单 | 真实共享入口，自动频率待S06；P0 |

本批“不在途发布旧理解”的版本令牌需通过业务入口测试，但完整真实模型请求中的取消与丢弃必须在S03b追加Case，不提前记PASS。

## S02b 原生桌面陪伴（v1，Codex受托确认）

依据companionship-rules.md与s02b-plan.md；真实macOS窗口证据不可由DOM测试替代。

| ID | Given → When | Expected与独立Oracle |
| --- | --- | --- |
| POL-DESKTOP-001 | 已接纳凛、模型服务关闭 → 独立启动 | 管理页与真实透明角色可用；不请求模型；画布只有1个角色，实际PNG显示，无方块占位；检查窗口、实际截图和服务计数 |
| POL-DESKTOP-002 | 文本编辑前台 → 真实点击画布/穿透开关 | 普通点击不夺键盘；开启穿透后底层收到，关闭后角色收到；分别原生点击与日志，不用DOM点击替代；透明边缘实际合成无白底 |
| POL-DESKTOP-003 | 普通桌面/全屏窗口 → 切换Spaces与全屏 | 角色可见且不激活；普通管理窗口可输入；不改Dock系统设置；Codex实际操作/可见证据 |
| POL-DESKTOP-004 | 管理窗关闭 → 托盘重开、重复启动、完全退出 | 关闭管理窗继续陪伴；重开保留身份与设置；重复启动不重复画布；退出无本轮子进程残留；崩溃父进程后画布自行结束 |
| POL-DESKTOP-005 | 低精力/跨日待交接 → 真实播放器循环收束 | 节点前不换，完成后只换一次；聊天边界仍遵守S03接入契约；损坏资源失败可收束，不无限等待 |
| POL-DESKTOP-006 | 已运行 → 锁屏/休眠/恢复/重启 | 休眠区间按离线恢复、不重复结算、不补调用；数据与日名单连续；服务可控时钟与实际系统事件接入证据分别记录 |

## S03b 对话与记忆实际生效（v1，Codex受托确认）

依据memory-and-sharing.md、companionship-rules.md与s03b-plan.md。Contract 见本表；执行结果见 evaluation/review，不预填状态；受控HTTP仅控制服务响应，不替代真实记忆、SQLite、请求协调和GUI逻辑。

| ID | Given → When | Expected与独立Oracle |
| --- | --- | --- |
| POL-CHAT-001 | A/B已结识、B不在当日名单 → 主动与B对话 | 消息持久化在B，真实请求使用B设定和有效记忆，A私聊不进入请求；名单不改；聊天中不自动切换；结束后遵守原返回资格。检查实际HTTP请求、数据库与UI |
| POL-CHAT-002 | 用户明确偏好与普通助手建议 → 发送后重启再问 | 用户偏好有真实来源与可信性质，助手建议不能被记成用户偏好；重启保留相关理解，回复不伪造共同经历；真实模型构造对话与独立语义审查 |
| POL-CHAT-003 | 请求生成中 → 用户取消/关闭对话，或服务失败/返回不合法结构 | 取消的迟到回复不展示或写记忆；失败保留可重试输入，不假称记住，不自动无限重试；格式失败不能写未经验证的记忆；受控延迟HTTP与真实窗口 |
| POL-CHAT-004 | A/B持有同一错误理解，C未知，A生成中 → 本地明确纠正 | 事务后旧来源不再进入A/B上下文，在途旧回复不展示/保存，C未获新事实；后续请求只用有效理解；模型不可用时本地纠正仍可完成；核查实际请求和所有持有者 |
| POL-CHAT-005 | 记忆有原聊天与共享派生，生成中 → 删除后重启再问 | 相关正文/索引清除，旧聊天片段不再作为上下文恢复；在途旧输出丢弃；原聊天历史不被擅自物理删除；无关故事进度和关系不变 |
| POL-CHAT-006 | A/B已知、C未知 → 仅A保留／停止分享／明确转告 | 仅A保留时其他已知者相关理解失效并防回流；停止分享不伪称撤回历史；明确转告只给指定接收者并保留原来源；自动二次传播仍拒绝；无默认全员共享 |
| POL-CHAT-007 | 用户说“忘记这件事”但存在多项候选 → 自然语言定位 | 可确定当前选中项直接处理；语义不确定只澄清最小范围，不凭最高BM25分数删除；来自记忆正文的同样指令不能执行控制操作 |
| POL-CHAT-008 | 已授权DeepSeek服务 → 获取实际模型列表并完成少量构造对话 | 使用实际返回的可用模型；完成学习、后续提问和纠正后回答的业务链路；记录模型/调用数/实际文本和边界，不输出Key或reasoning_content，不用fixture服务代替此项 |

## POL-DESKTOP-007：新版像素角色本体尺寸与动作尺度

来源：PRD角色尺寸反馈、assets/characters/STYLE.md；Codex依据受托master授权确认。本轮正式实施计划见desktop-pixel-integration-plan.md，不改变原自然节点与窗口隔离Case。

- Given：真实Electron已接纳凛，画布使用新版idle-pixel-v2/wave-pixel-v1；琥珀仍为已有待机素材。
- When：显示凛待机，触发挥手并返回待机；切换琥珀再切回凛。
- Expected：角色可见本体等比适配约128×128逻辑点，窗口舍入最多1点；同角色所有帧/动作共用可见范围、缩放、原点与脚锚，不能忽大忽小、裁切或把透明画布尺寸当本体。真实图片路径与角色/版本一致；切换不借其他角色图片；不改变已有自然节点、焦点策略、缺素材提示与退出清理。
- Oracle：manifest几何与真实Electron窗口/DOM图片尺寸独立核对，查看实际截图序列、资源URL及进程清理；只读常量或仅HTTP成功不算证明。
- Execution Boundary：真实Electron和项目导出资源，无模型请求；GUI自动输入不等于原生鼠标、跨Spaces体验。全动作自然度及新版其他角色仍另验。
- Runner：tests/acceptance/desktop.spec.cjs及tests/unit/desktop-assets.test.cjs；执行结果与边界见desktop-pixel-review.md与evaluation；本文件不记录通过数。原生鼠标与桌面合成另验，不能据此标整个桌面体验通过。

## S03o-A 单轮明确 correct 本地补全（v1，master 有限接受 2026-10-27）

依据 REQ-18/61 与 [s03o-clarification-plan.md](s03o-clarification-plan.md) A 节。仅当模型显式 `memoryOperation:null`、本轮唯一 correct、唯一 target、唯一完整新内容时本地补全；仍复用既有候选、主体/时间/否定/来源/版本约束与两阶段核验。C02/C03/C07 原真实 FAIL 与 Expected 不变。

| ID | Given → When | Expected / 独立 Oracle | Execution Boundary |
| --- | --- | --- | --- |
| POL-CHATMEM-CLARIFY-002a | A 咖啡加糖、B 咖啡甜、C 无关；模型 `memoryOperation:null` → 用户“不是咖啡，我今天想喝茶，请帮我改过来。”；关系 equivalent | 单轮 A 产生今日临时“茶”，A 长期 body/version 不变；B 长期不变且同步今日临时；C 无新增；模型 reply 不显示/不授权；reply 来自本地结果；关系请求恰好 1 次；模型 candidate 不落库 | 真实 chat.sendMessage/store/SQLite；构造 HTTP chat 与关系响应；无 GUI/真实模型 |
| POL-CHATMEM-CLARIFY-002b | 同上；关系 different | A 临时“茶”，B 长期/临时均不变；C 无新增；关系 1 次 | 同上 |
| POL-CHATMEM-CLARIFY-002c | 同上；关系 uncertain | A 临时“茶”，B 长期/临时均不变；C 无新增；关系 1 次 | 同上 |
| POL-CHATMEM-CLARIFY-002d | 模型 null → “不是咖啡，我更喜欢茶，请帮我改过来。” | 走 replace；关系 equivalent 时 A/B 长期更新到新正文，无今日临时；不同/不确定仅 A 更新 | 同上 |
| POL-CHATMEM-CLARIFY-002e | 模型返回合法 correct operation | 正常执行，不被本地补全替代或重复；结果与既有 correct 一致 | 同上 |
| POL-CHATMEM-CLARIFY-002f | 模型返回非法 operation（如 clearAll、M99） | 不兜底；零写；回复“我这次没有改动任何记忆。”；不发关系请求 | 同上 |
| POL-CHATMEM-CLARIFY-002g | 模型 null 的负例：多候选、多个新内容、缺目标、否定/假设/引用、不确定、第三方经历、未来/最近、纯提问 | 零写或现行澄清；无临时/长期变化；不发关系请求 | 同上 |
| POL-CHATMEM-CLARIFY-002h | 002a 的附加观察 | assistant 消息与请求结果均为本地 operationReply/状态；无模型成功文案；无新增闲聊记忆批次 | 同上 |

本组为 master 受托批准的垂直切片。2026-10-27 master 独立最终五套 **277/277 pass、0 skip、exit 0、before/after 一致**（`evidence/master-s03o-a-final-O584PFa8/`），**受托接受 S03o-A 已测单轮明确 correct 本地补全有限能力**（非用户亲自确认）；live `evidence/master-s03o-a-live-Z7Y05M66/` 10 REVIEW/1 FAIL（C07），C03 原始 `memoryOperation=null` 后 actual/effective correct，A/B 长期不变、两条当日 temporary，`expires=1793116799999`。接受仅限已测单轮 null 补全，不等于完整澄清、多轮/pending、forget 补全、自然指代、C07 或 S03；旧 C02/C03/C07 FAIL 与 Expected 保留。

## 外部 Contract 登记（唯一入口引用）

以下条目只登记指向，不复制 plan 中的完整 Expected。ID 集合按实际 Contract 展开；范围有例外时已单列。Runner 映射见 [acceptance-plan.md](acceptance-plan.md)，执行结果见 evaluation.md 或对应 review。

| 父级/业务能力 | 正式 ID（版本/例外） | 唯一 Contract | 需求来源 | 验收边界 | 确认依据 |
|---|---|---|---|---|---|
| S02 关系数值事件 | POL-RELATION-001～004（v1） | [s02c-relationship-effects-plan.md](s02c-relationship-effects-plan.md) | REQ-50 | 真实 SQLite/companion；有效互动接线另验 | Codex 受托 v1（plan 首段） |
| S03 记忆管理 UI | POL-MEMUI-001～006（v1） | [s03c-memory-ui-plan.md](s03c-memory-ui-plan.md) | REQ-18/51/61 | 真实 Electron/SQLite；自然语言另验 | Codex 受托 v1（plan 首段） |
| S03 明确转告 | POL-SHARING-001～006（v1） | [s03d-explicit-sharing-plan.md](s03d-explicit-sharing-plan.md) | REQ-60/61 | 真实 memory/SQLite；GUI 另验 | Codex 受托 v1（plan 首段） |
| S03 分享窗口 | POL-SHAREUI-001～006（v1） | [s03e-sharing-window-plan.md](s03e-sharing-window-plan.md) | REQ-60/61 | 真实 Electron/SQLite；自然语言另验 | Codex 受托 v1（plan 首段） |
| S03 聊天记忆操作 | POL-CHATMEM-001～006；POL-CHATMEM-UI-001（v1） | [s03f-chat-memory-operations-plan.md](s03f-chat-memory-operations-plan.md)；[s03f-gui-plan.md](s03f-gui-plan.md) | REQ-18/51/61 | 正式 chat/memory；构造 HTTP/GUI | Codex 受托 v1（plans） |
| S03 聊天明确转告 | POL-CHATRELAY-001～006；POL-CHATRELAY-UI-001（v1） | [s03g-chat-relay-plan.md](s03g-chat-relay-plan.md)；[s03g-review.md](s03g-review.md) | REQ-60/61 | 正式 chat/memory；真实模型/GUI 分别 | Codex 受托 v1（plan/review） |
| S03 独属保留 | POL-EXCLUSIVE-001～005；POL-EXCLUSIVECHAT-001～005；POL-EXCLUSIVEUI-001～003；POL-EXCLUSIVE-LIVE-001～003（v1） | [s03h-exclusive-memory-plan.md](s03h-exclusive-memory-plan.md)；[s03h-live-exclusive-plan.md](s03h-live-exclusive-plan.md) | REQ-18/51/60/61 | service/chat/GUI/live 四层 | Codex 受托 v1（plans/review） |
| S03 自动共享控制 | POL-AUTOSHARE-CONTROL-001～004（v1） | [s03i-plan.md](s03i-plan.md) | REQ-60 | 正式设置/SQLite；主题调度另验 | Codex 受托 v1（plan 首段） |
| S03 主题定向共享 | POL-THEME-SHARE-001～005；POL-THEME-SHARE-004B、POL-THEME-SHARE-004C、POL-THEME-SHARE-004D、POL-THEME-SHARE-004E、POL-THEME-SHARE-006（v1） | [s03j-plan.md](s03j-plan.md)；[s03j-review.md](s03j-review.md) | REQ-51/54/60 | 正式 story/memory；正式素材门 false | Codex 受托 v1（plan/review） |
| S03 全局分享开关 | POL-SHARESETTING-001～005（v1） | [s03k-plan.md](s03k-plan.md) | REQ-60 | 正式 chat/设置/GUI | Codex 受托 v1（plan 首段） |
| S03 语义基线 | SEM-001～008（v1） | [s03l-plan.md](s03l-plan.md) | REQ-18/51/61 | 真实 SQLite/正式 memory；无模型 | Codex 受托 v1 2026-10-27 |
| S03 事实身份 | POL-FACTID-001、POL-FACTID-003、POL-FACTID-004、POL-FACTID-005、POL-FACTID-006（v1）；POL-FACTID-002（v2，替代 v1 002） | [s03l-identity-plan.md](s03l-identity-plan.md)；[s03l-source-identity-plan.md](s03l-source-identity-plan.md) | REQ-09/18/51/60/61 | 真实 SQLite；FACTID-002 v2 实现已由 master 17 套件批次独立验收为有限能力；旧 v1 002 机制 PASS 失效 | v1/v2 计划均 Codex 受托确认 2026-10-27；v2 实现 master 受托接受 2026-10-27；真实模型语义未覆盖 |
| S03 语义留出 | POL-SEM-HOLD-001（子项 01～16，v1） | [s03l-holdout-plan.md](s03l-holdout-plan.md) | REQ-18/51 | 真实模型/构造数据 | Codex 受托 v1 2026-10-27 |
| S03 原子关联 | POL-ASSOC-001～005（v1） | [s03l-association-plan.md](s03l-association-plan.md) | REQ-18/51/61 | 真实事务；等价 Fixture | Codex 受托 v1 2026-10-27 |
| S03 关系协议 | POL-REL-001～004（v1） | [s03l-grounding-plan.md](s03l-grounding-plan.md) | REQ-18/51 | 构造模型输出 | Codex 受托 v1 2026-10-27 |
| S03 模型对照 | POL-MODEL-COMP-001（v1） | [s03l-model-comparison-plan.md](s03l-model-comparison-plan.md) | REQ-18/51 | 真实模型/构造数据 | Codex 受托 v1 2026-10-27 |
| S03 来源上下文 | POL-SOURCECTX-001～006（v1） | [s03l-source-context-plan.md](s03l-source-context-plan.md) | REQ-18/51/61 | 真实 store/chat/source | Codex 受托 v1 2026-10-27 |
| S03 来源关系协议 | POL-SOURCE-REL-001～004（v1） | [s03l-source-grounding-plan.md](s03l-source-grounding-plan.md) | REQ-18/51 | 构造模型响应 | Codex 受托 v1 2026-10-27 |
| S03 真实来源对照 | POL-SOURCE-LIVE-001（子项 01～12，v1） | [s03l-source-live-plan.md](s03l-source-live-plan.md) | REQ-18/51 | 正式聊天/真实模型 | Codex 受托 v1 2026-10-27 |
| S03 显式纠正/忘记语义核验 | POL-SEMOP-001～008（v1，含 001a～d、004a～d、008a～c 等子项） | [s03m-semantic-operations-plan.md](s03m-semantic-operations-plan.md) | REQ-18/51/60/61 | 真实 SQLite/chat；构造 HTTP；L1/L2 真实模型与专属 GUI | master 受托 v1 2026-10-27（不是用户亲自确认）；008 已测有限能力经 master 19 套件 185/185 受托接受，但 008 聚合仍 NOT_COVERED（部分已验）；2a 长期 correct 确定性业务流程已由 master 独立 28/28、GUI14/14 受托接受为已测有限能力（非真实模型语义/人类体验）；2b forget 确定性后端已由 master 独立 20 相关套件 235/235、exit 0、before/after SHA 一致受托接受为已测有限能力（`master-forget-core-QlvxfnTU`），接受范围限已运行分支：002c 只运行 different/截断、未单独运行 uncertain，网络失败仅共享 correct 回归；聚合仍 NOT_COVERED，当时 temporary、真实模型 L1/L2、忘记专属 GUI 未验（temporary 后由 2c-1 独立验收获有限接受，见本行后段）；现有 correct GUI 证据为旧源码时点，本批未重跑；master 2026-10-27 受托批准 §12 r3 的 2c-1/2c-2 实现与验收方向（不是用户亲自确认）；temporary 的 2c-1 已由 master 独立复跑 20 套件 **295/295、0 skipped、exit 0**、before/after SHA 一致受托接受为**已测领域/真实 chat 构造 HTTP 有限能力**（`master-temporary-final-gmf6gukR`），不是用户亲自确认、不是真实模型/GUI/UI IPC；2c-2 §13 多 L 方案与 D1～D16 已由 Codex 2026-10-27 受托批准（不是用户亲自确认）；其中 **2c-2a 已实现并由 master 独立复跑 20 套件 335/335、exit 0、before/after SHA 一致后受托接受为已测存储/来源/操作有限能力**（`master-multil-final-ZLv9fbBn`；不是用户亲自确认、不是 GUI/真实模型/完整 S03）；**2c-2b 已由 master 独立复跑 20 套件 358/358、exit 0、before/after SHA 一致后受托接受为已测真实 chat/SQLite+构造 HTTP 有限能力**（`master-temporary-chat-OKCwajaU`；不是用户亲自确认、不是真实模型/GUI/完整 S03）；D1/D2/D3/D4/D5/D10/D11 及审查反例已测，共用 chat 取消/close/dispose/recover 由回归覆盖；master r54 以三套件 **111/111 PASS、0 skip、exit 0、before/after 一致**（`master-chat-lifecycle-EDScQrNM`）并通过实际截图审查，另以 cleanup 复验 **1/1 PASS、exit 0、无 Electron 残留**（`master-lifecycle-cleanup-fpxOn887`），**受托接受本批已测 temporary/forget 生命周期与 Electron GUI 有限能力**：temporary cancel/close/dispose 与构造 pending 恢复后端、真实 SIGKILL 重开 GUI、temporary/forget 阶段 1/阶段 2 单消息 GUI、forget uncertain/network 分支；模拟 suspend 原 Case 为 correct 的 `powerMonitor.emit` 模拟事件，不代表 temporary 专属真实系统锁屏/休眠通过；111/111 覆盖未变业务断言，cleanup 复验覆盖最终清理 helper；开发首次清理遗漏、master 退回与精确匹配修正历史保留。S03m B2 C10 事件时间/主体授权有限修复与 B2 工具 dry 能力已由 master 2026-10-27 独立稳定复验 **130/130 PASS、0 skip、exit 0**、L1/L2 dry 各 11 DRY-RUN、22 临时路径无残留后受托接受（`master-c10-stable-oC19XDFt`；不是用户亲自确认、不是真实模型/完整 S03）；上一 `master-c10-final-tBIvlAZo` 因 before/after 变动不作最终验收；真实模型 L1/L2、正式资源、UI IPC/live、跨角色独立同义、完整 S03 与聚合 POL-SEMOP-001～008 仍 NOT_COVERED |
| S03n 主体绑定门 | POL-SUBJ-BIND-001～018；POL-SOURCE-REL-001/002 v2 | [s03n-subject-binding-plan.md](s03n-subject-binding-plan.md) | REQ-18/51/60/61 | 真实 chat/SQLite + 构造模型响应；五套 248/248；live L1/L2、holdout | master 2026-10-27 最终五套 **248/248 pass、0 skip、tests.exit 0、before/after 一致**，查看 live 请求/DB 后**受托接受 S03n 已测主体绑定反证防护与 source Case v2**（非用户确认）。live L2 8 REVIEW/3 FAIL（C02/C03/C07），C02/C03 为模型 `memoryOperation:null` 并澄清、产品未改记忆，非绑定门错误；L1 10/11（C07）；holdout 15/16，falseMerge 0、missedEquivalent 0，仅 15 分类 FAIL。**自然姓名/弱指代、C07/15、完整主体识别/S03 未完成**，保守拦截不等于全面支持 |
| S03 来源身份 | POL-SOURCE-ID-001～004（v1） | [s03l-source-identity-plan.md](s03l-source-identity-plan.md) | REQ-09/18/51/60/61 | 真实 store/chat；模型 HTTP 构造；master 17 套件批次独立验收（有限能力） | 计划 Codex 受托确认 2026-10-27；实现 master 受托接受 2026-10-27；存量误合组迁移 v1 已另有限接受；UI/真实模型未验 |
| S03 存量误合组迁移 | POL-MIG-001～006（v1） | [s03l-identity-migration-plan.md](s03l-identity-migration-plan.md) | REQ-09/18/51/60/61 | 真实 SQLite/构造旧库；master 独立 18 套件 170/170 验收为有限能力（2026-10-27） | master 已受托接受 v1 有限能力，不是用户亲自确认；无 GUI/API/真实模型；缺失历史边/孤儿旧键等边界保留 |
| S04 来源权限基础 | POL-SOURCE-001～006（v1） | [s04a-plan.md](s04a-plan.md) | REQ-13 | 真实 SQLite/临时目录 | Codex 受托 v1（plan 首段） |
| S04 会话读取 | POL-SOURCE-007～012（v1） | [s04b-reader-plan.md](s04b-reader-plan.md)；[s04b-review.md](s04b-review.md) | REQ-13 | 真实临时文件/SQLite | Codex 受托 v1（plan/review） |
| S04 来源分析 | POL-ANALYSIS-001～011；POL-SOURCE-013（v1） | [s04c-analysis-plan.md](s04c-analysis-plan.md)（001～005）；[s04c-provenance-plan.md](s04c-provenance-plan.md)（006、008；009 见「方案」第3/7条及「验收」在途改写条；010 见「方案」第6条）；[s04c-review.md](s04c-review.md)（007 复现与补核、011、SOURCE-013）；[s03l-association-review.md](s03l-association-review.md)（010 业务 Expected 保留） | REQ-13 | 真实临时文件/SQLite/本机 HTTP | Codex 受托 v1（plans/review）；007/009/010 为 master 2026-10-27 核实的原规则到 ID 映射，不伪称历史编号确认时间 |
| S04 来源设置 | POL-SOURCE-UI-001～003（v1） | [s04d-source-settings-plan.md](s04d-source-settings-plan.md) | REQ-13 | 真实 Electron；原生 dialog fixture | Codex 受托 v1（plan 首段） |
| S04 生产自动分析 | POL-SOURCE-AUTO-001～005；POL-SOURCE-AUTO-002b、POL-SOURCE-AUTO-002c、POL-SOURCE-AUTO-004a、POL-SOURCE-AUTO-004a2、POL-SOURCE-AUTO-004b、POL-SOURCE-AUTO-004c、POL-SOURCE-AUTO-004d、POL-SOURCE-AUTO-004e（v1） | [s04e-production-analysis-plan.md](s04e-production-analysis-plan.md)；[s04e-review.md](s04e-review.md) | REQ-13 | 真实主进程/心跳/SQLite | Codex 受托 v1（plan/review） |
| S05 连接器账本与传输 | POL-CONNECTOR-001～007；POL-TRANSPORT-001～004；POL-HERDR-LIVE-001～003（v1） | [s05a-connector-ledger-plan.md](s05a-connector-ledger-plan.md)（CONNECTOR-001～006）；[s05a-review.md](s05a-review.md)（CONNECTOR-007 见「r2独立验收」前的业务契约补充段）；[s05b-transport-plan.md](s05b-transport-plan.md)（TRANSPORT-001～003）；[s05b-review.md](s05b-review.md)（TRANSPORT-004）；[s05b-live-plan.md](s05b-live-plan.md) | REQ-06/21/28 | SQLite/真实 Unix socket/隔离 Herdr | Codex 受托 v1（plans/reviews） |
| S05 运行身份与登记 | POL-HERDR-ID-001～003；POL-REGISTER-001～004（v1） | [s05c-identity-plan.md](s05c-identity-plan.md)；[s05d-registration-plan.md](s05d-registration-plan.md)（REGISTER-001～003）；[s05d-review.md](s05d-review.md)（REGISTER-004） | REQ-21 | 隔离 Herdr/正式插件登记 | Codex 受托 v1（plans/reviews） |
| S05 适配与运行管理 | POL-ADAPTER-001～008；POL-HERDR-RUNTIME-001～012（v1） | [s05e-adapter-plan.md](s05e-adapter-plan.md)（ADAPTER-001～006）；[s05e-review.md](s05e-review.md)（ADAPTER-007～008）；[s05g-runtime-plan.md](s05g-runtime-plan.md)（RUNTIME-001～005）；[s05g-review.md](s05g-review.md)（RUNTIME-006～007）；[s05h-stop-evidence-plan.md](s05h-stop-evidence-plan.md)（RUNTIME-008～011）；[s05h-review.md](s05h-review.md)（RUNTIME-012） | REQ-06/21/28/58 | 正式 adapter/ledger；隔离 Herdr | Codex 受托 v1（plans/reviews） |
| S05 通知队列 | POL-NOTIFY-001～009（v1） | [s05f-notification-plan.md](s05f-notification-plan.md)（001～005）；[s05f-review.md](s05f-review.md)（006「写入失败跨重启的持久性」、007「终态独立检查与返修」、008「第二轮独立结果与跨页截止点排序」、009「最终积压上限检查」） | REQ-06/35/58 | ledger/真实 Electron 通知 | Codex 受托 v1（plan/review） |
| S05 连接设置 UI | POL-CONNECTOR-UI-001～006（v1） | [s05i-production-connections-plan.md](s05i-production-connections-plan.md)（001）；[s05i-review.md](s05i-review.md)（002～006 见「最终独立验收与受托决定」UI002～UI006 表） | REQ-06/21/28 | 真实 Electron/隔离 Herdr | Codex 受托 v1（plan/review） |
| S05 桌面通知 UI | POL-NOTIFY-UI-001～011（v1） | [s05j-desktop-notifications-plan.md](s05j-desktop-notifications-plan.md)（001）；[s05j-review.md](s05j-review.md)（002～011 分节与最终结果） | REQ-35/58 | 真实 Electron 通知窗口 | Codex 受托 v1（plan/review） |
| S06 预算与机会 | POL-BUDGET-001～008；POL-OPPORTUNITY-001～007（v1） | [s06a-budget-plan.md](s06a-budget-plan.md)（001～004）；[s06a-review.md](s06a-review.md)（005 见「005补充Contract」，006～008 见「S04集成发现的预算收尾恢复」）；[s06b-opportunities-plan.md](s06b-opportunities-plan.md) | REQ-48/53 | 真实 SQLite/构造时钟 | Codex 受托 v1（plans/review） |
| S06 日常与探索 | POL-ACTIVITY-001～008；POL-ACTIVITY-RUNTIME-001～004（v1） | [s06c-activity-lifecycle-plan.md](s06c-activity-lifecycle-plan.md)（ACTIVITY-001～005）；[s06c-review.md](s06c-review.md)（ACTIVITY-006～008）；[s06d-runtime-activities-plan.md](s06d-runtime-activities-plan.md) | REQ-48/53/56 | 真实 SQLite/Electron 桌面 | Codex 受托 v1（plans/review） |
| S06 故事/发现/内容 | POL-STORY-001～005；POL-DISCOVERY-001～006；POL-CONTENT-001～003；POL-STORYRUN-001～005、POL-STORYRUN-004B、POL-STORYRUN-UI-001；POL-STORYUI-001～005（v1） | [s06e-story-progress-plan.md](s06e-story-progress-plan.md)（STORY-001～004）；[s06e-review.md](s06e-review.md)（STORY-005）；[s06f-discovery-outcomes-plan.md](s06f-discovery-outcomes-plan.md)（DISCOVERY-001～005）；[s06f-review.md](s06f-review.md)（DISCOVERY-006）；[s06g-authored-content-plan.md](s06g-authored-content-plan.md)；[s06i-story-runtime-plan.md](s06i-story-runtime-plan.md)（STORYRUN-001～005）；[s06i-review.md](s06i-review.md)（STORYRUN-004B、STORYRUN-UI-001）；[s06j-story-window-plan.md](s06j-story-window-plan.md) | REQ-46/52/54/59 | 真实活动/story/SQLite/GUI | Codex 受托 v1（plans/review） |
| S07 角色素材与输入 | POL-ASSET-001～002；POL-ASSET3-001～005；POL-RESTUI-001～003；POL-HIT-001～003（v1） | [asset-pilot.md](asset-pilot.md)；[s07b-three-character-runtime-plan.md](s07b-three-character-runtime-plan.md)；[s07-rest-runtime-plan.md](s07-rest-runtime-plan.md)；[s07c-transparent-input-plan.md](s07c-transparent-input-plan.md) | REQ-03/39/45/49/58 | 真实播放器/Electron/原生输入 | Codex 受托 v1（plans/review） |
| S08 原生窗口 | POL-NATIVE-001～003（v1） | [s08a-native-shell-plan.md](s08a-native-shell-plan.md) | PRD 原生单屏/设置 | 真实 Electron/两尺寸 | Codex 受托 v1 2026-10-26 |
| S08 最终验收入口（GAP-14；跨链 S02/S03/S04/S05/S06/S07） | POL-FINAL-CATALOG-001、POL-FINAL-ANIM-001、POL-FINAL-STORY-001、POL-FINAL-NATIVE-001、POL-FINAL-DESKTOP-001、POL-FINAL-E2E-001、POL-FINAL-DELIVERY-001（v1） | [final-acceptance-contract.md](final-acceptance-contract.md) | REQ-40/41、03/39/49/58、45/46/52/54/59、原生单屏、13/21/35、01/44/56、06/09/18/28/51/60/61、Goal 终止 | 最终全链；未执行 | master 已受托验收 v1/Part A-B；GAP-14 流程补齐通过；产品实现未执行 |

S08 是最终验收入口，不新增 S09 父级；7 个 `POL-FINAL` ID 是既有范围的最终门，不是新产品概念。本批 snap 前暂不改产品，提交后接回 S03；Contract 结果仍未执行。

登记口径（2026-10-27 r2，r3 更正）：只有能在所引 Contract 中逐项定位定义的 ID 才计 Contract 索引覆盖；文件存在与定义覆盖分开记录，逐组结果见 [coverage-recheck.txt](evidence/process-registry-20261027-r2/coverage-recheck.txt) 与 [r3 核对](evidence/process-registry-20261027-r3/analysis-id-mapping.txt)。以下为仅有编号小节定义、无完整字面 ID 的项（r2 旧表述）：POL-NOTIFY-007～009、POL-NOTIFY-UI-002～011、POL-CONNECTOR-UI-002～006、POL-HERDR-RUNTIME-006～007 与 009～011、POL-SOURCE-012、POL-DISCOVERY-006、POL-THEME-SHARE-004B～004E 与 006、POL-SOURCE-AUTO-002b/004a2/004b～004e。**当前注记：master 已接受按既有小节规范映射，不因缺完整字面 ID 判缺 Contract，本轮不重新全量审核。** 其余登记 ID 在所引 plan/review 有完整字面定义（POL-FACTID-002 v2 与 POL-ANALYSIS-007/009/010 例外，均见缺口）；不据范围写法或手工清单宣称“全量已证明”。

## 内部证据与子样本

| 编号/来源 | 归属 | 证据性质 |
|---|---|---|
| 语义探针 baseline 01～16 | SEM 组、S03l 语义核验 | 研究/支撑证据；无独立业务 Case ID，不替代 SEM |
| POL-SEM-HOLD-001 的 01～16 | 同上 | 同一业务 Case 的必需子项，不另立业务能力 |
| `POL-FACTID001`（review 中写法） | POL-FACTID-001 | 笔误，不新增 ID |
| POL-SOURCE-AUTO、POL-THEME-SHARE、POL-STORYRUN 的字母子项 | 对应父 Case | 版本/时序例外，已在表中展开，不另造范围 |

## 版本与缺口

- POL-FACTID-002：v1 的“严格同文可复用身份”机制 PASS 已失效；v2 计划已由 Codex 于 2026-10-27 受托确认。v2 实现已由 master 17 套件批次独立验收为**有限能力**（2026-10-27）；真实模型语义与存量已有误合组迁移仍未覆盖。不得把 POL-FACTID-001～006 全写成 v1 或据旧 PASS 代表当前。
- POL-SOURCE-ID-001～004：计划已由 Codex 于 2026-10-27 受托确认；实现已由 master 17 套件批次独立验收为**有限能力**（2026-10-27，真实 SQLite/chat 核心、模型 HTTP 构造）。存量误合组迁移 v1 已另由 master 18 套件 170/170 有限接受；UI/真实模型未验；不得据其宣称 S03 或产品已交付。
- POL-MIG-001～006：迁移 v1 已由 master 独立 18 套件 170/170 验收为**有限能力**（2026-10-27，真实 SQLite/构造旧库，无 GUI/API/模型）。缺失历史关系边不恢复、孤儿旧键保持兼容边界、非拆分身份保守检查；不得据此宣称 S03/Goal 或语义策略完成。
- POL-ANALYSIS-007/009/010：master 已核实原规则到 ID 的映射（007 预算收尾失败与补核；009 在途改写不发布与映射发布回滚；010 8 区段/4MiB 验证上限），现正式登记；不伪称历史编号确认时间，不新增或削弱 Expected。此前 r2 的“查无定义”判断据此更正。
- GAP-14 最终范围已登记为 POL-FINAL-001 系列（7 组，见 [final-acceptance-contract.md](final-acceptance-contract.md)），归 S08 最终验收入口；master 已受托验收 v1/Part A-B，流程补齐通过。造型资料、正式动画覆盖、故事/服装、全页面单屏、原生证据门、真实模型＋隔离 Herdr、交付纪律均未执行，evaluation 记 NOT_COVERED；动画采用 24＋12 语义覆盖，不要求 36 张或 36 fps；本轮不新增其他业务概念或 Case。snap 后接回 S03。
