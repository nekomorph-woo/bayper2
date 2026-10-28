# 最终验收 Contract（GAP-14，v1，流程补齐已受托验收）

2026-10-27批准的7个最终Contract v1继续有效，GAP-14流程补齐已受托验收；原冻结已随a68d03f解除。**当前产品尚未交付**，本文件定义终止验收要求，不用历史计划时态表示当前执行状态。逐项实际结果以[evaluation.md](evaluation.md)及[scope.md](scope.md)为准；CATALOG有限独立验收见[final-catalog-review.md](final-catalog-review.md)，不能扩写为整组通过。

共同规则：每个 Contract 为稳定 ID/v1、P0 最终必需；Expected 同时列禁止副作用；Oracle 不调用被测实现生成答案；真实/Mock 边界随条目写明。6 至 8 组有限 Contract 复用既有 Case，不另建一套；全部归 **S08 最终验收入口**并跨链 S02/S03/S04/S05/S06/S07，不新增 S09 父级或产品概念。`animation-plan.md` 的 24 基础＋12 特色语义由 master 按完整交付授权采用，不作为 36 张图、36 fps 或全部四方向要求。未取得的外部硬件证据保持 NOT_COVERED，不因此降低 Goal，也不要求用户重新批准。

## 1. POL-FINAL-CATALOG-001（v1）：造型资料与可重建配方

来源 REQ-40/41、[PRD 造型元数据库](../Bayper桌面陪伴/prd.md)、[animation-plan](../Bayper桌面陪伴/animation-plan.md)；既有基础为 [appearance-catalog](../../../tools/appearance-catalog/README.md) 的 8 CSV、`build.py`、SQLite 快照与共享角色母版引用。确认：master 已受托验收 v1 2026-10-27；P0。

| 子项 | Given → When | Expected（含禁止副作用） | 独立 Oracle / 真实-Mock 边界 |
|---|---|---|---|
| 01 独立重建 | 工具目录复制到独立 cwd，只保留文档化相对结构；共享外部母版仅引用 | 从任意 cwd 以工具入口路径运行 `python3 <独立副本>/build.py --output <临时路径>/catalog.sqlite`（入口即 appearance-catalog 目录下 build.py；不裸写 `python3 build.py`）；8 份 CSV 为唯一编辑源，SQLite 为派生快照；记录数、引用与 SQLite `integrity_check`/外键一致；重建副本与留存库一致。禁止依赖 PRD 工作目录、复制第二份母版或另建编辑源 | 独立副本真实构建＋SQLite 查询＋`cmp`；不运行产品、不调用模型 |
| 02 层次与配方 | 读取角色、服装、主题、配方与设计指导记录 | 角色固定项、服装可变部分、主题语境层次清楚；重点/协调/待标定可追溯到配方与约束（含 C17、C24～C26）；未标定像素/视角保持未知而非 0。禁止声称 310 项均为独立滑条或已自动审美求解 | 人工核对 CSV/SQLite 行与约束；真实文件，无 Mock |
| 03 发布边界 | 检查素材状态与对外能力 | 只提供字典、候选、配方与重建；正式可发布角色/服装素材仍以实际制作审查为准。禁止把参考图、候选或工具通过写成正式素材或运行时捏人 | 对照素材状态与 README 声明；不以构建成功代替美术验收 |

## 2. POL-FINAL-ANIM-001（v1）：正式角色动画完整覆盖

来源 REQ-03/39/40/49/58、animation-plan 24＋12 语义、[STYLE.md](../../../assets/characters/STYLE.md)；复用 POL-ASSET、ASSET3、RESTUI、HIT、DESKTOP、ACTIVITY-RUNTIME，最终追加覆盖与身份一致性项。确认同前；P0。

| 子项 | Given → When | Expected（含禁止副作用） | 独立 Oracle / 真实-Mock 边界 |
|---|---|---|---|
| 01 覆盖记录 | 已发布角色与每套可穿服装，按 24 基础＋12 特色语义逐项记录 | 每角色/每套服装有基础动作覆盖、复用理由与替代表现；独特片段全部实际播放审查，复用项逐一核对映射与同服装语义适配，不能只抽几个动作证明全覆盖；特色缺失可用同服装已批准且语义适合的动作，不得换回基础衣服冒充；无耳尾结构的角色用设定内等价动作，不新增部件。禁止把同一眨眼/静态图重复计为多项完成，禁止要求 36 张或 36 fps | 覆盖矩阵＋逐项实际播放；真实资源/Electron/SQLite；时钟 fixture 仅控活动 |
| 02 身份与尺度 | 真实桌面播放代表性动作、连续动作与服装切换 | 本体约 128×128 pt 等比，不拉伸成方形、不逐动作 fit、不裁切；像素簇/阶梯轮廓/色块在实际尺寸可辨；脸、体型、耳尾与关键标记稳定；脚锚、首尾接缝、过渡与中断恢复正确。禁止借用其他角色图片或把透明画布当本体 | 实际尺寸帧序列、alpha/脚锚、深浅背景与截图；不靠内部函数或仅 metadata 生成 Expected |
| 03 行为接线 | 探索离桌、合资格接替、工作通知到达 | 探索者完成短节点后离桌并由合资格名单成员接替；工作通知始终独立可见，不被动画、休息或聊天压制。禁止瞬移回屏、强叫醒或用通知换角 | 真实 Electron/SQLite/通知窗口；模型不可用时仍成立 |
| 04 发布证据 | 候选动作转为正式可用 | 保留源素材、提示词、参考、导出与真实播放证据，审查通过后才发布；未审查动作明确不可用，无静默 fallback。禁止以工具通过、编译成功或静态图代替连续体验 | 素材来源与 manifest＋实际播放；自动化/Codex 审查须标操作者与局限，不冒称人类体验 |

不新增候选角色/衣装清单；沿现有 scope 的少量完整内容包实施，覆盖记录随实际发布内容展开。

## 3. POL-FINAL-STORY-001（v1）：故事与服装最终正式流程

来源 REQ-45/46/52/54/59、[clues-and-discovery](../Bayper桌面陪伴/clues-and-discovery.md)；复用 POL-STORY、DISCOVERY、STORYRUN、STORYUI，不复制其 Expected。确认同前；P0。

| 子项 | Given → When | Expected（含禁止副作用） | 独立 Oracle / 真实-Mock 边界 |
|---|---|---|---|
| 01 发布→邀请 | 正式资源已发布且素材可用；合资格低频活动产生线索 | 仅已发布资源可推进；线索连续、重复合并；邀请在实际可见展示后才 ACK；接纳/稍后持久且只有一个待决定邀请。禁止隐藏预取、快照或后台计时消耗额度，禁止未发布资源邀请 | 真实活动/SQLite＋实际窗口可见与 ACK；构造作者目录只作可达性，正式发布状态另测 |
| 02 服装 72h | 成熟服装故事、owner 已结识、素材可用；跨 72h 边界与时钟回拨 | 滚动 72 小时最多解锁一套；到期一次告知，积压不批量补；解锁即安全保存；用户自选现在/以后/不穿，默认保留原衣。禁止自动穿用、重复告知或把查看当新解锁 | 真实 SQLite/通知窗口＋可控时钟；不直接 SQL 伪造成熟 |
| 03 重启与门禁 | 接纳/稍后/拒绝/穿用后重启或素材下架 | 身份、记忆、名单、已解锁所有权与待决定邀请保持；重复操作幂等；未发布或下架资源不可解锁/穿用。禁止重启重置、重复计数、换脸或撤回历史 | 关库/真实进程重开＋SQLite 前后事实；Mock 不替代持久化 |
| 04 负担与通知 | 线索、邀请、解锁与工作通知交错 | 不新增任务、领取、连续登录或额外模型调用；工作通知优先且独立；展示失败延后汇总。禁止以刷任务/额外调用弥补进度 | 调用计数、通知队列与真实窗口；人工负担由操作记录判断 |

既有额度与邀请规则不变：滚动 24h 最多 1 段线索、自动邀请 7 天最多 1 次、最多 1 个待决定邀请、拒绝后不反复自动邀请。换穿等待当前聊天/动作短节点收束，不改数值。

## 4. POL-FINAL-NATIVE-001（v1）：全部正式窗口与设置单屏

来源 PRD 原生单屏/设置、窗口尺寸补充；复用 POL-NATIVE-001～003 并扩展到最终全页面，结合 SOURCE-UI、CONNECTOR-UI、NOTIFY-UI、STORYUI、MEMUI。确认同前；P0。

| 子项 | Given → When | Expected（含禁止副作用） | 独立 Oracle / 真实-Mock 边界 |
|---|---|---|---|
| 01 全页面布局 | 1200×800 与 960×680（含原生窗框），遍历小窝/角色/故事/记忆/连接/设置 | 主要内容和操作直接可达，仅长聊天、记忆、故事、通知历史局部滚动；不缩小正文字号、不裁切、不移除功能、不整页 `overflow:hidden` 遮内容；辅助文字不小于 12px | 真实 Electron 两尺寸、DOM 滚动/可见性度量与截图；不用静态原型 |
| 02 真实数据与恢复 | 模型 Key 无效/超时/非助手文本；连接掉线；通知展示异常 | 显示真实 snapshot 与可修复错误，不假成功；模型修复、连接状态与通知相关操作可用；不新增 PRD 外设置 | 真实 Electron/SQLite＋本机受控 HTTP；断网/故障可构造，核心服务不 Mock |
| 03 原生授权 | 来源目录授权与取消 | 使用真实原生目录授权流程，取消不产生授权或分析；权限页与已授权状态一致。禁止用 fixture 对话框或任意路径 IPC 代替最终证据 | 真实 macOS 对话框＋实际授权记录；不得读取用户私人目录 |
| 04 焦点与入口 | 导航、关闭面板、错误恢复、隐藏页面 | 聊天不意外关闭、草稿不丢；焦点返回真实发起按钮；不抢焦点、不聚焦隐藏元素；入口均可达真实业务 | 真实窗口键盘/焦点与 IPC；不以 `evaluate` 改状态替代用户路径 |

## 5. POL-FINAL-DESKTOP-001（v1）：原生实际体验证据门

来源 REQ-01/03/44/56/58、DESKTOP-003/004/006、HIT；复用既有 Case，只补缺失 Runner 映射与最终证据门，不重复新 Case。确认同前；P0。

| 子项 | Given → When | Expected（含禁止副作用） | 独立 Oracle / 真实-Mock 边界 |
|---|---|---|---|
| 01 点击与 Retina | 真实桌面点击角色/透明区；Retina 或物理多屏可用时 | 身体接收、透明区穿透、文字输入焦点保持；命中随帧/角色/位置更新。已有 002 由 S07c 真实点击覆盖（1 个测试覆盖 HIT-001/002/003）；禁止用 DOM 注入代替 | 真实系统事件、alpha/坐标与双方计数；scaleFactor=1 以外的 Retina 未取得即 NOT_COVERED |
| 02 Spaces/全屏 | 实际切换 Spaces 与全屏 | 角色可见且不激活，普通管理窗可输入；不改 Dock/全局设置；有实际可见证据 | 真实 macOS 操作＋截图/日志；无硬件即 NOT_COVERED |
| 03 锁屏/休眠/托盘 | 真实锁屏、睡眠、恢复、重启；托盘逐项点击 | 离线恢复不重复结算、不补调用；数据与日名单连续；托盘关闭/重开/退出逐项正确。现有 006 仅为 `desktop.spec` 内受控 `powerMonitor` 子断言，不是真实睡眠；禁止据此写原生通过 | 真实系统事件与进程/数据库观测；受控事件只能证明对应子断言 |
| 04 证据门 | 汇总最终桌面证据 | 缺失项如实 NOT_COVERED，不用截图、合成事件或自动化窗口冒充；清理本轮自建窗口/进程 | 证据清单逐项对 Case 与执行边界；无 Mock 替代物理证据 |

## 6. POL-FINAL-E2E-001（v1）：真实模型＋隔离 Herdr 端到端

来源 REQ-06/09/18/21/28/35/51/58/60/61 与 Goal 终止条件；复用 ONBOARD-006、CHAT-008、SOURCE-LIVE、HERDR-LIVE、CONNECTOR/ADAPTER/RUNTIME、NOTIFY/UI、MEMORY/CHAT 既有内层 Case，原样引用。确认同前；P0。

| 子项 | Given → When | Expected（含禁止副作用） | 独立 Oracle / 真实-Mock 边界 |
|---|---|---|---|
| 01 Herdr 实链 | 独立启动；Herdr 先/后启动；隔离 server 构造会话；突发普通 3＋加急 1；重连 | 双向发现，每 Agent 来源与状态独立，普通与加急不互相覆盖；重连不重复上线/通知；server stop 不伪造完成。禁止读取用户私有会话或直接写 DB 制造在线 | 真实隔离 Herdr/生产 transport/实际通知窗口＋SQLite；构造会话合法 |
| 02 模型断线 | 已配置模型服务不可用 | 本地陪伴、已有内容与连接器事实通知继续；聊天如实不可用，不伪造回复或清空记忆；恢复后不补造积压调用 | 真实 app＋可控网络故障；不调用未授权服务，不记录凭据 |
| 03 聊天记忆链 | 真实/构造对话学习事实，随后纠正、删除、重启、重问 | 学习有来源；纠正同步生效，删除防回流；跨重启与在途结果不复活旧理解；无关经历保留。禁止用 fixture 模型或直接改写 DB 冒称成功 | 真实模型/正式 chat/memory/SQLite＋独立语义审查；构造内容可复现 |
| 04 撤权与在途 | 撤销某来源目录授权时，该来源存在分析在途；随后重启 | 只阻断对应来源的新读取/分析和尚未生效的分析发布，不是阻断所有分享在途；既有合法记忆保留来源标识、默认不删除也不传播，直接聊天与 Herdr 事实通知不受影响；用户另行删除才按防回流清除，重新授权不解除已有删除限制。禁止把撤销扩成自动清空既有记忆或所有在途 | 真实授权/SQLite/进程重开＋该来源请求与分析记录；不读取用户真实来源正文 |

## 7. POL-FINAL-DELIVERY-001（v1）：交付与横向工具纪律

来源 Goal 终止条件、REQ-41、AGENTS 工具自包含与版本规则。确认同前；P0。

| 子项 | Given → When | Expected（含禁止副作用） | 独立 Oracle / 真实-Mock 边界 |
|---|---|---|---|
| 01 文档与映射 | 完成产品候选后整理交付 | 启动/配置/数据说明、依赖环境与已验证边界、全部 REQ→Case→证据映射齐全；未验证项明确保留。禁止把分段证据拼成整体通过 | 文档审阅＋链接/路径核对；不预填结果 |
| 02 版本与环境 | snap 前检查 | VERSION/snap 由 master 管理且符合规则；仅清理本轮自建临时环境、进程与隔离目录；不清理他人/历史内容；不推送发布合并 | 版本与 Git 只读核对；清理前后进程/目录记录 |
| 03 工具与凭据 | 抽查 tools 自包含能力 | 工具从独立副本可运行（允许 README 明确声明的运行依赖与稳定共享资源引用），入口/数据/说明聚合；无凭据、令牌或私人数据进入产物或日志。禁止要求所有工具无依赖可移植，或引入打包商店、签名等新目标 | 独立副本抽查＋密钥形态扫描；不执行产品验收 |

## Part A：现有模块与缺失接入

| Contract | 现有模块/资产 | 缺失接入（不虚构文件） |
|---|---|---|
| CATALOG | `tools/appearance-catalog/build.py`、`tools/appearance-catalog/data/*.csv`、`tools/appearance-catalog/data/catalog.sqlite`、`references/` | 产品运行时无造型编辑器；正式角色/服装配方与素材未发布 |
| ANIM | `app/desktop-assets.cjs`、`app/desktop/renderer/canvas-app.js`、`app/desktop/main.cjs`、`tools/sprite-pipeline/` | 24＋12 逐角色/服装覆盖记录、正式素材、过渡/中断与探索离桌表现未完成 |
| STORY | `app/story-progress.cjs`、`app/discovery-outcomes.cjs`、`app/story-runtime.cjs`、`app/story-window.cjs`、`app/renderer/story-panel.js` | 正式内容 `assetAvailable=true`、自动邀请、服装告知/穿用入口与重启幂等未闭环 |
| NATIVE | `app/renderer/index.html`、`app.js`、`styles.css`、`window-navigation.js` 及各面板 | 全页面/全设置、原生目录授权、模型修复与最终两尺寸统一验收未完成 |
| DESKTOP | `app/desktop/`、`app/app-tray.cjs`、`tests/acceptance/desktop.spec.cjs`、`s07c-transparent-input.spec.cjs` | 003 Spaces/全屏、006 真实睡眠、004 托盘原生点击缺证据；HIT 仅 scaleFactor=1 |
| E2E | `app/main.cjs`、`app/chat.cjs`、`app/memory*.cjs`、`app/herdr-*.cjs`、`app/notification-presentation*.cjs`、`tools/herdr-*` | 单条真实模型＋隔离 Herdr 链、突发/重连、撤权在途与跨重启未合并验收 |
| DELIVERY | 根文档、`VERSION`、`tools/*` | 最终说明、全需求映射、snap 决定与环境清理由 master 主持；本轮不执行 |

## Part B：自动化验收计划（待实施）

尚无本组 Runner；以下只定义入口与观察方式，不虚构测试文件。Runner 由 Claude Code 在获准恢复后按项目现有 Node/Electron/Playwright 设施实施，Codex 独立执行。

| Contract | Setup | Driver | Observe / Oracle | Evidence / Cleanup |
|---|---|---|---|---|
| CATALOG | 工具独立副本、空临时输出、真实 Python/SQLite | 以副本入口 `python3 <副本>/build.py --output <临时路径>` 从非仓库 cwd 调用 | 记录数/外键/`integrity_check`/`cmp`/配方行 | 构建日志、SHA、临时副本；删除副本 |
| ANIM | 真实 Electron、已发布角色/服装、隔离 data-dir、可控活动时钟 | 正式播放器与活动入口；实际尺寸播放、切换、中断、探索接替、通知到达 | 帧序列/脚锚/alpha/截图/DB 活动与通知计数；覆盖矩阵 | 唯一批次日志/截图/manifest；退出清理自建环境 |
| STORY | 真实 SQLite/Electron、构造作者目录、可控 72h 时钟、正式发布状态夹具分开 | 真实活动→故事→可见邀请→接纳/稍后；解锁→告知→穿用/不穿；重启 | SQLite 事实、可见 ACK、通知次数、身份/记忆/名单前后、素材门 | 前后快照、窗口截图、重启日志；仅清理夹具目录 |
| NATIVE | 真实 Electron/SQLite、两尺寸、原生目录对话框 | 首次配置、全页面导航、设置修复、授权/取消、长内容与故障 | 滚动/可见性、焦点、真实数据、授权记录、截图 | 两尺寸截图、DOM 度量、dialog 日志；退出清理 data-dir |
| DESKTOP | 真实 macOS、自建桌面/窗口、可用硬件；缺失项如实标 | 原生点击、Spaces/全屏、锁屏/睡眠、托盘逐项、重启 | 系统事件时间、可见状态、进程/DB、alpha 路由 | 系统日志/截图/进程清单；只清理自建窗口 |
| E2E | 正式 app、真实模型配置、隔离 Herdr server/构造会话、隔离 data-dir | 双向启动、突发、重连、断模型、聊天学习/纠正/删除、撤权、重启 | 模型请求/文本、Herdr 事件、通知窗口、SQLite、语义审查 | 脱敏请求/事件、DB 前后、重开日志；停自建 server 并删除临时目录 |
| DELIVERY | 最终候选、文档、工具副本、环境清单 | 启动/配置/数据说明核对、工具独立抽查、清理 | 路径/链接/映射、版本只读、密钥扫描、进程/目录清理 | 核对清单与清理记录；不推送发布 |

## 复用、边界与不宣称

- 复用关系：CATALOG 引用既有工具历史但本轮不执行；ANIM 复用 ASSET/ASSET3/RESTUI/HIT/DESKTOP；STORY 复用 STORY/DISCOVERY/STORYRUN/STORYUI；NATIVE 扩 NATIVE-001～003；DESKTOP 补 DESKTOP-003/004/006 与 HIT 的 Runner/证据门；E2E 原样引用既有内层 Case，不复制 Expected。
- 未执行前，本组在 [cases.md](cases.md) 只登记引用，在 [evaluation.md](evaluation.md) 记 NOT_COVERED；历史日志、开发报告和工具通过不升级为本 Contract 的 PASS。
- 外部硬件（Retina、物理锁屏/睡眠、Spaces/全屏）缺失时保持 NOT_COVERED；不把缺失当 PASS，也不因此缩小完整 Goal。产品恢复由 master 在流程验收后决定。

历史批准时安排的来源身份及迁移批次已推进，当前接续入口为state.md与scope.md；本Contract全部Expected保持不变，未完成项继续计入完整Goal。
