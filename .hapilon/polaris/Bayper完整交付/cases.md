# 正式 Acceptance Cases

当前批次 S01，版本 v1。由 Codex 依据用户完整交付授权受托确认，2026-10-25。以下是 Expected，不是执行结果。所有列出的 Case 均 P0/必需。

| ID | 来源与场景 | Given → When | Expected（包括禁止副作用） | Oracle / Execution Boundary |
| --- | --- | --- | --- | --- |
| POL-ONBOARD-001 | REQ-05 首次配置 | 空独立数据目录、兼容服务 → 从实际窗口提交配置 | 验证一次真实 HTTP 请求得到有效文本后进入许愿；空Key/模型不发请求；DB无明文Key，renderer快照无Key | UI步骤+独立服务请求日志+SQLite只读查询；实际Electron/SQLite/safeStorage，仅模型端允许本机受控HTTP服务 |
| POL-ONBOARD-002 | REQ-05 验证失败 | 未配置 → 服务401、超时、非助手文本后再修正重试 | 显示可修复错误，失败不完成配置、不创建角色；成功后可继续，无重复请求风暴 | 预设服务结果断言和持久化记录；同001，不Mock核心服务 |
| POL-ONBOARD-003 | REQ-55 愿望和接纳 | 已配置无角色 → 输入安静愿望/换候选/确认前退出，再重启并确认两次 | 推荐稳定真实目录角色，确认前零关系；确认后恰好1关系/固定/名单/当前角色，数值10/100/0 | 独立预期目录身份+UI+重开SQLite计数；实际窗口和存储，不靠内部排名函数算Expected |
| POL-ONBOARD-004 | REQ-09/21/45 重启恢复 | 已接纳 → 退出/重开且服务不可达 | 保留同一角色身份/数值/安排，显示小窝，不请求重新接纳，不依赖Herdr | 记录首次ID、实际进程重开、数据库和UI比较；实际Electron，模型关闭 |
| POL-ONBOARD-005 | 配置与隔离边界 | 首次窗口 → 提交远端HTTP、含凭据URL、非法模型输入；页面尝试外部导航 | 拒绝不安全配置，无Key外发/日志泄漏；无任意IPC/文件访问/新外部页面 | 独立请求收集+IPC表面/安全配置审查；真实应用和服务，不用安全配置函数单测代替 |
| POL-ONBOARD-006 | 真实服务核实 | 获授权服务配置 → 实际窗口验证一次，接纳并重启 | 真实服务有效应答，Key安全保存且重启可读取；不输出凭据或私人内容 | 真实兼容服务无Mock，脱敏记录和Codex受托体验；配置尚需确定，此项不允许Mock结果覆盖 |

后续切片在实现前扩展此唯一Case文件，维持稳定ID；Runner映射和实际结果另记 evaluation.md，不预填PASS。

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

依据memory-and-sharing.md、companionship-rules.md与s03b-plan.md。以下Case尚未实施，默认NOT_COVERED；受控HTTP仅控制服务响应，不替代真实记忆、SQLite、请求协调和GUI逻辑。

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
- Runner：tests/acceptance/desktop.spec.cjs及tests/unit/desktop-assets.test.cjs；Codex独立执行11/11通过，见desktop-pixel-review.md。POL-DESKTOP-007本体/素材接线自动化子项PASS；原生鼠标与桌面合成另验，不能据此标整个桌面体验通过。

## POL-SOURCE-001～005：外部来源权限基础

完整Given/When/Expected/Oracle及真实执行边界见[s04a-plan.md](s04a-plan.md) Acceptance Contract，Codex受托确认。对应REQ-13的候选发现、默认关闭、目录明确授权、撤销后旧许可失效、重启与路径边界。Runner为tests/acceptance/external-sources.spec.cjs，权限基础已独立执行，结果见下文；不是完整会话分析、UI授权或预算验收。

POL-SOURCE-006补充授权许可释放与事务失败保持，完整Contract见s04a-plan.md末段。Codex独立external-sources.spec.cjs共6/6通过（s04a-codex-r2.log），仅模块权限基础PASS；设置页、解析、实际模型在途撤销仍NOT_COVERED。

## 后续契约：记忆管理与会话读取

POL-MEMUI-001～004的完整Contract见[s03c-memory-ui-plan.md](s03c-memory-ui-plan.md)，POL-SOURCE-007～011见[s04b-reader-plan.md](s04b-reader-plan.md)。Codex受托确认；尚未独立执行，均NOT_COVERED。各规格明确真实业务入口、构造数据边界及独立Oracle，不用读取适配器替代完整来源分析。

POL-SOURCE-007～012读取适配：完整Contract见s04b-reader-plan.md与s04b-review.md的012补充。Codex独立权限+读取12/12通过（evidence/s04b-codex-r2.log），当前模块边界PASS；设置、自动分析预算与实际记忆发布仍NOT_COVERED。旧初版结果不能替代r2。

POL-BUDGET-001～004正式Contract见[s06a-budget-plan.md](s06a-budget-plan.md)，Codex受托确认，共用自动请求滚动额度、发送尝试幂等、重启/时钟及事务边界。尚未实现验收，NOT_COVERED；不以预算模块替代自动活动调度。

POL-BUDGET-001～005：Codex独立automatic-budget.spec.cjs 5/5通过；005补充Contract与覆盖矩阵见s06a-review.md，证据evidence/s06a-codex-first.log。003真正in_flight重启分支尚需补测，当前不标完整预算契约PASS；真实调度/HTTP集成未覆盖。

预算r2补测真正未finish的in_flight重启，Codex独立5/5通过，POL-BUDGET-003模块分支补齐；当前001～005模块契约PASS，详见s06a-review.md与s06a-codex-r2.log。

POL-MEMUI-001～006当前模块PASS：Codex独立真实Electron/SQLite/受控HTTP验收6/6，相关聊天UI10/10、聊天及记忆服务32/32通过。005/006完整Contract补入s03c-memory-ui-plan.md；矩阵、失败→修复及边界见s03c-review.md。当前用户可按角色分页查看并本地纠正/删除，旧显示与在途隔离；自然语言定位、主动共享和全页native未覆盖。

POL-BUDGET-006～008收尾存储故障/精确恢复/事务回滚契约与Oracle见s06a-review.md末节；Codex独立预算8/8通过（s04c-codex-budget-r3.log同批还含6项来源回归）。仅已失败token可恢复，内存记录提交后清除。来源006未通过，不将本次预算结果冒充来源分析全部完成。

POL-CONNECTOR-001～007：Contract见s05a-connector-ledger-plan.md及s05a-review.md补充，Codex独立7/7通过（s05a-codex-r2.log）。当前只接受SQLite事实账本；真实Herdr插件/订阅身份/重连适配与可见气泡仍未覆盖，不能把本地fixture序列当Herdr事件字段。

S04c受托接受：POL-ANALYSIS-001～011、POL-SOURCE-013由tests/acceptance/source-analysis.spec.cjs与session-sources.spec.cjs执行，契约见s04c-analysis-plan.md、s04c-provenance-plan.md、s04c-review.md。与权限/预算共同独立32/32，evidence/s04c-codex-index-final.log。PASS仅限真实临时文件/SQLite/本机HTTP模型fixture服务链，正式GUI/自动调度/真实提炼语义仍NOT_COVERED。

S05b传输模块：POL-TRANSPORT-001～004由tests/acceptance/herdr-transport.spec.cjs执行，契约见s05b-transport-plan.md与s05b-review.md。r2 Codex独立4/4，evidence/s05b-codex-r2.log；真实临时Unix socket，Herdr响应为schema核对fixture，真实Herdr与正式插件/通知仍NOT_COVERED。

## 2026-10-27 接续索引：聊天分享设置与事实关联

- POL-SHARESETTING-001～005：唯一Contract在[s03k-plan.md](s03k-plan.md)，Runner为tests/acceptance/chat-sharing-setting.spec.cjs和chat-sharing-setting-ui.spec.cjs；版本、独立结果及边界见[s03k-review.md](s03k-review.md)，已按其范围受托接受。
- SEM-001～008：唯一Contract在[s03l-plan.md](s03l-plan.md)，此批为存量记忆事实范围的补建基线，全部P0/必需，2026-10-27 v1由Codex依用户master授权确认。来源为PRD引用memory-and-sharing.md“同步纠正”“怎样同步生效”“删除边界”；真实SQLite+正式memory业务服务，构造数据、无模型/无GUI。Runner tools/memory-tuning/semantic-baseline.cjs，入口node tools/memory-tuning/semantic-baseline.cjs --out <结果路径>；业务Expected由计划定义，工具只评分，不能把当前行为当正确答案。Codex已独立执行v1：SEM-001～007 FAIL、SEM-008 PASS，0ERROR；实际结果与后续修复顺序见s03l-review.md。补建工具已接受，产品关联能力未通过。
