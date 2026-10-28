# S06m 自动解锁告知与相遇邀请

2026-10-28，Codex master受托批准v1；增量开发，父级S06/S05。S06l换装技术链路已接受，但成熟内容尚不会自然告知。本轮接通“已有成熟内容→合法自动机会→低频气泡实际显示→用户主动查看/处理”，不以单独预算模块通过代替交付。

## 业务决定与边界

来源：PRD、clues-and-discovery.md“角色相遇与接纳/服装解锁与穿用”、state-and-rhythm.md“自动气泡分享/邀请”。自动气泡全应用滚动1小时最多1次、8小时最多3次；实际首次可见才计数，重复回执不重计。与自动API额度完全分离，必需工作通知不受其限制。邀请另受实际首次自动显示起7天最多一次；服装归属72小时规则保持，告知不重新解锁、不自动穿衣。

已有未告知服装/合资格成熟相遇优先在既有30分钟/25%自动机会中占用本次机会，避免同次再安排另一活动；不新开定时抽签。启动/恢复沿用既有nextTarget，不立即追发积压。无可呈现内容才走原活动流程。只用已保存故事与版本文案，不新增模型请求，不把虚构故事当用户真实经历。

聊天、暂停、退出、桌面隐藏/未就绪、在屏休息/探索/动作收尾或工作通知繁忙时不显示自动气泡；保留已存内容，下次合法机会再考虑，不建立催促队列。最多一个自动卡，复用现有非激活通知窗；工作通知一到即优先，自动卡退让，不挤占加急位，不超过既有普通位总量。已确认显示的不重播；尚未显示不计数。自动卡正常展示6秒后淡出；工作通知可提前打断。关闭/查看是用户主动操作，不抢焦点自动开管理窗。

衣装告知写清角色、衣装名及一小段已有故事由来，提供“查看衣装”，打开角色页由用户决定换装。邀请写清目标角色和引荐来源，提供“看看邀请”，打开既有故事页的接纳/稍后/不接纳；气泡本身不自动接纳、不改当日名单。稍后/拒绝不自动催促，手动重开仍用原邀请。未知/未发布/资源不可用的目标不自动介绍。

## 现状与实现约定

- discoveryOutcomes已存在prepared/pending邀请、automatic/manual ACK、7天额度，以及衣装notification_pending；不得另建一套归属或邀请状态。
- notificationPresentation/ledger仅描述连接器工作事实，不往connector账本塞虚构Agent事件。自动告知用独立明确类型，复用窗口但使用独立noticeId、token、ACK和action；现有正整数eventId验证不放宽。
- automaticOpportunities是统一30分钟机会及恢复不补账入口；在主进程runActivity注入处优先尝试准备自动告知，未取得显示资格时按明确结果决定是否跳过本次，不为告知开新API。
- 选内容按最早未告知/成熟时间稳定排序，当前仅两类（outfit/invitation）；一个活跃展示，保存内容身份不复制正文真相。不做通用消息总线。
- ACK必须与发现结果确认和自动气泡收据同SQLite事务；失败全部回滚。discoveryOutcomes现用BEGIN，允许窄改为固定SAVEPOINT以支持外层组合，复验原独立事务语义。清单/准备不消耗任何显示额度。

## Part A：领域与持久化

允许新增app/automatic-notices.cjs（约220～320行）及必要独立的app/automatic-notice-budget.cjs（确有职责需要才建，约80～120行），窄改app/discovery-outcomes.cjs事务助手；不接main/UI、不改正式内容发布门。

工厂复用真实db、storyProgress/storyWindow/discoveryOutcomes；主进程提供可呈现资格回调，方法prepare({speakerId})、getView()、acknowledge({noticeId,token})、cancel/dispose。准备只创建内存待显示token，邀请可落prepared；不将准备记为可见。稳定sourceKey区分邀请/衣装及源ID。SQLite自动显示收据保存sourceKey、kind、presentedAt，唯一约束杜绝重计；同源重复ACK幂等，未知/旧token不写。时间回拨不得提前重开额度，边界以独立毫秒值校验。

准备与ACK均经显式isAssetAvailable回调（严格true）核查实际资源；B复用现有desktop-assets固定映射/角色presentation，不只信catalog布尔值。ACK时重读来源、发布资格/归属和现行邀请状态，失效不写收据。受控资格回调代表上层门禁，不能拿A的模拟回调冒充GUI。关闭/被抢占在ACK前取消本次展示但保留内容，ACK后不重播。邀请已pending/deferred/rejected不再次自动准备。实际标题/昵称/衣装名称组装与窗口交互留B，不接受用内部ID充当最终文案。

新增tests/acceptance/automatic-notices.spec.cjs（约300～450行），真实SQLite+正式故事/归属入口构造数据、固定时间、资格回调可控；不以SQL伪造显示成功。读回发现表、收据、非空记忆/关系/衣装/名单快照和API预算，检查禁止副作用。A完成后master审查，再派B实际窗口路径。

## Part B：运行与真实窗口（A后细化文件范围）

主进程接自动机会、资格门与通知优先级；desktop-host/子进程通知窗窄扩展独立自动卡和可信ACK/action。完整可见350ms后回执，主进程原子确认；用户对可见卡的主动点击/收起可作为实际呈现依据，但必须通过当前窗口、当前token与完整可见校验，不能以收到请求本身假定显示。旧子进程/token/隐藏窗口不确认；接收失败有界重试而不重复扣额。B必须实际验证窗口、重启、优先打断与点击路由。

## 验收Case（v1，P0，全部为本切片必需）

共同Boundary：真实SQLite/正式领域逻辑；A构造时间/资格回调，B真实Electron/main/preload/renderer、loopback模型、构造作者目录和系统事件，不能冒充真实模型/物理锁屏。每次唯一证据目录、保留失败与SHA，结束关闭进程删除自建data-dir。

| ID | Given→When | Expected与独立Oracle |
|---|---|---|
| POL-AUTONOTICE-001 | 已成熟已归属且pending衣装→正常自动机会→真实显示→重复回执/重启 | prepare不计数；实际ACK一次清pending、写一次收据，故事由来/名称正确；不换装、不变归属时间/记忆/数值/名单、不调用模型；重启不重播。A+B合并。 |
| POL-AUTONOTICE-002 | 成熟未相遇角色→合法机会→显示→用户查看并稍后/拒绝/接纳 | 自动ACK后7天额度及气泡额度同时落定，一份邀请；手动操作复用原邀请，不自动改名单、不催促；只读/准备不计数，手动旧邀请不被重新当自动发现。 |
| POL-AUTONOTICE-003 | 跨角色/两类内容连续到达→小时/8小时边界与重启/回拨 | 独立固定时间证明全局1/h、3/8h，不按类型/角色翻倍；重复ACK不重计，API额度/必需通知账本不变。 |
| POL-AUTONOTICE-004 | 聊天/休息/隐藏/暂停/通知忙或进程退出→机会/恢复 | 不自动抢焦点/不假ACK；工作通知优先；恢复不追发积压；未显示内容保留、已显示不重复；真实GUI门禁与固定时间支撑分开记录。 |
| POL-AUTONOTICE-005 | 准备后源资格失效、旧token、DB写入失败→ACK/重试 | 无半确认：收据与归属pending/邀请状态同时成功或全回滚；失败后正确重试一次；旧回执不写，无资源/未发布不展示。 |
| POL-AUTONOTICE-006 | 真实气泡可见→查看衣装/邀请或收起；同时工作事件到达 | 文案清楚、单屏可读，不伪装工作状态；仅用户点击才打开正确角色/故事；动画/通知必要信息不丢，普通位/加急位约束保持；不是只查返回值。 |

初始计划未执行；现行Part A子项结果见s06m-master-review.md r182，完整GUI Case尚未通过。每批按snap保存通过的自洽成果，主功能未接真实窗口不能接受完整切片。禁止子代理、真实API、正式素材/PRD/skill/版本/Git自行修改；代码全部单Claude CLI实现。工具无需新增；若需要专用工具严格tools/<能力名>自包含。

## r182 Part B实施边界（master受托批准）

A已独立78/78接受，详s06m-master-review.md。本批完成两种正常告知的真实窗口与主动跳转，并覆盖关键抢占/回执边界；不再只做内部模块。自动机会仍唯一入口，runActivity先尝试告知，成功占用本次机会，不继续API活动；无可用内容/告知额度不足可沿用既有活动。全局暂停/聊天/不可见等当前门禁不允许为了fallback绕过。选中名单角色可作为分享者，但不为展示切换在屏角色；文案明确分享者与故事所属/目标角色，不让其冒充同一个人。

允许文件：新增app/automatic-notice-runtime.cjs（约220～320行，持有展示副本、到期/抢占、ACK/action，不做泛用调度器）；窄改app/main.cjs、app/desktop-host.cjs、app/desktop/main.cjs、app/desktop/notification-preload.cjs、app/desktop/renderer/notification.js及notification.css；可新增独立companion-notice.js并在通知html引用，以免复杂工作通知渲染器继续膨胀；管理窗app/preload.cjs、app/renderer/app.js和story-panel.js只加明确目标跳转。若需要固定衣装文案映射，与既有outfit-panel映射保持一致，不新建外观数据库或改正式发布。新tests/acceptance/automatic-notices-ui.spec.cjs（首批约500～800行）及必要runtime场景测试（约180～250行）；现有通知测试仅作回归，不削弱断言。若scope/规模显著超出先交分析说明，不生成框架。

协议为通知payload中独立companionNotice，不伪造presentations/items/eventId。传输token/generation与领域noticeId/noticeToken同时核对，限当前子进程/当前可见通知窗；ACK和action各自具名IPC。现有connector验证函数保持原正整数事件约束。有效ACK后A会清active，runtime保留本次只读展示副本直到6秒结束/用户操作/工作通知抢占；重复ACK不续命、不再次计数。无ACK的卡也需有界等待（最多10秒），失败撤下内容留待下一次正常机会，不无限占窗或立即重发。当前卡ACK之前的查看/收起仅在实际完整可见350ms条件已满足时确认，未达到不得假确认或抢先执行跳转；renderer与子进程均核对窗口可见，master验证结果。

沿现有tick统一组合通知视图；出现任意工作presentation即取消自动卡并优先工作，不挤普通3位/加急位。聊天开始、暂停、退出、隐藏、桌面进程丢失、角色休息/探索/自然动作进行中或等待切换时取消自动卡；ACK前保留待告知，ACK后不重播。恢复只走现有30分钟机会，不新增补发。禁止为场景绿灯自动关闭聊天或切角色。资源回调用实际固定白名单和desktop-assets检查；不将catalog布尔当实际资源；未就绪角色不自动邀请。

仅用户有效点击打开管理窗并导航：衣装选择所属角色概览并显示衣装区域；邀请进入故事页并选对应storyId（不要只打开小窝）；不自动穿衣/接纳/改名单。窗口未加载时保留一次目标并在ready后送达，避免点击路由丢失；既有chat不因导航自动关闭。文本只由已保存故事节点/固定角色衣装名组成，限制长度并显示来源，渲染用textContent。

首批GUI必需：1正常衣装实际可见350ms→单收据/pending清除→点击正确角色且未自动穿用；2相遇实际可见→单7日额度→点击正确故事、稍后后不再催促；3工作通知到达抢占、旧自动ACK/action不生效且工作项仍实际可见；4桌面隐藏/暂停至少一组不假ACK，恢复不立即补发。真实Electron/SQLite，复用已有活动Runner的主进程Date/Math.random控制机会、loopback模型、构造作者目录和临时data-dir；这些不是真实随机等待/物理锁屏。须直接观测DOM/窗口/SQLite与模型请求次数，不能通过调用新runtime私有方法伪造自动机会。保留截图和实际命令/失败，清理本轮进程与临时库。其余门禁/重启/完整错误路径继续按001～006聚合，不因首批通过直接关闭S06m。
