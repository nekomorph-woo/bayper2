# S06h 日常动作在途审查

55311仍在开发，以下依据当前实际diff，不冒称独立FAIL；终态前须核对是否已解决并以真实Case证明。

## 动作完成必须携带活动身份

当前canvas发送通用字符串daily-action-complete，main收到后从getSnapshot().current.activity取“现在的”活动ID并完成它。displayKey/generation标识角色素材，不标识活动；同角色不同活动/旧消息迟到时不能用当前ID补出一个完成事实。应在动作开始时捕获activityId，经现有窄通道传回，并核对来源角色、显示代次与当前运行ID；旧活动/暂停/已取消的回报不能完成别项，不要仅依赖当前快照碰巧相同。复用既有自然节点通道，不建立第二套消息框架。

## 暂停恢复不要反复从头伸展

当前renderer注释明确“暂停后动作未完成，恢复重新从头播放”，syncActivity将key清空，恢复同ID重播。这不满足计划的“不能因反复恢复刷动作”。应保留同ID的最小播放进度，恢复适合衔接的帧/节点；至少真实覆盖连续两次中断，不能每次都从首帧再来。退出重开需记录采用的恢复节点和依据，不把有效活动时间直接等同于已播放帧事实。已actionComplete必须保持，不因重启/切人重播或再扣费。无需通用时间轴或动画引擎。

## 证明实际动作与时间共同收束

新action_completed_at方向合理。必须覆盖：有效时长已到但未收到真实完成仍不completed；完成回报先到但有效时长未满仍保持，之后自然节点才收束；旧库迁移、保存失败不能假确认。现有领域Case若此前用纯计时结束daily，应按新真实契约明确给动作事实，不能给生产服务一个默认“视为播放过”的后门来保绿。

## scheduled 精力断言要能识别提前扣费

当前 runtime-001 使用 `scheduledEnergy <= before.energyOf("rin") + 0.02` 来证明 scheduled 不扣活动精力，方向不足：额外扣除2也能通过。triggerOpportunity 将时钟推进31分钟，不能直接忽略正常陪伴结算。请建立包含正常时间结算的明确基线，核对 scheduled 没有额外活动扣费，再核对节点启动只扣2；保留真实调度入口，不用宽松单边不等式替代业务断言。这是测试证明力缺口，尚不等同于生产提前扣费已复现。

### 完成与暂停相邻的顺序

最新main修改试图保留“已播完、消息抵达时刚暂停”的事实，这个目的合理；需区分有效完成的迟到与旧活动回报。不要仅凭paused一律丢弃已完成回报而使活动卡住，也不能从当前快照补ID把任何迟到消息记到它。以播放开始捕获的activityId和角色/代次核验，并测试完成—暂停消息相邻的两种顺序。仍禁止未实际播完的暂停状态直接宣称完成。

## 正式窗口关键帧预审

Codex实际查看开发批次run-20261026191630710-09f7c9的runtime-001-daily-stretch.png与daily-stretch-peak.png：约88×128窗口截取中可见放手和双臂上举，两图脚底位置稳定，耳、尾、鞋完整，透明区域透出桌面，像素轮廓在该尺寸仍清楚。峰值闭眼与原身份协调，没有仅用整图位移伪装动作。此为开发批次两个静态关键帧预审，不能代替独立连续播放、idle衔接和中断恢复验收；尚不发布素材。

## 返修在途核对：身份应被闭包捕获，不能只换字段名字

当前返修renderer的sendNode和playFrames回调仍从可变dailyActivityKey/dailyCharacterId读取身份。syncActivity遇到新活动ID时改写这两个变量，但不一定停止旧playingDaily计时器；同角色同displayGeneration的旧动作因此可能把剩余进度和完成算给新ID。请以开始播放时不可变的activityId/characterId捕获并传递给该轮回调，身份换代时停止旧计时器；回报/本地进度写入都核对仍是同一活动。补同角色不同活动ID在旧动作未结束时替换的真实renderer场景，不只测服务拒绝不存在ID。新canvas:activity-progress通道以及相关完成回报还应校验真实canvas webContents来源，不让其他窗口的同名IPC冒充播放事实；沿用现有窗口身份，无需权限框架。

## 领域独立执行

77921终态后，Codex已明确把上节“闭包捕获身份/真实canvas sender”反馈至下一返修77373（evidence/claude-s06h-callback-fixes.json），仍唯一GUI。没有把首轮自述的“捕获”直接当通过。

并行只运行不依赖GUI且本次返修不改的领域入口：`node --test tests/acceptance/character-activities.spec.cjs`，实际15/15、0 fail/skip/cancelled，日志evidence/s06h-codex-domain.log与三文件SHA s06h-codex-domain-source.sha。包含动作/时长双条件、完成暂停两种顺序、旧/取消ID、保存失败和迁移。后续若这三个源文件再变须重验；该结果不是renderer/桌面集成通过。

## 独立正式集成与素材接受

77373终态后Codex独占GUI完成：

- `node --test tests/acceptance/activity-runtime.spec.cjs`：工具2230退出0，6/6，无fail/skip/cancelled。批次run-20261026193901103-165ce2，六Case均cleanup ok、子进程正常退出；总日志s06h-codex-runtime.log。
- `node --test tests/unit/*.test.cjs tests/acceptance/character-activities.spec.cjs`：28/28，无fail/skip/cancelled，s06h-codex-unit-domain.log。
- `node --test tests/acceptance/desktop.spec.cjs`：11/11，包含同角色同displayKey下旧活动未播完换ID的真实renderer验证，s06h-codex-desktop.log。
- `node --test --test-name-pattern='POL-NOTIFY-UI-001' tests/acceptance/desktop-notifications.spec.cjs`：1/1真实隔离Herdr通知回归，s06h-codex-notification.log。以上GUI回归工具99587退出0，依次运行，未抢占。

| 验收项 | 实际观察 | 状态 |
| --- | --- | --- |
| RUNTIME-001日常 | 正常结算基线核对scheduled无活动扣费，节点一次-2；真实8帧、action_frame=8；动作先完等时长，自然节点后completed，回idle不再扣费 | PASS |
| RUNTIME-001通知组合 | ordinary/urgent两个正式presentation、实际气泡可见；活动ID及精力不变，正常完成 | PASS（组合输入为账本构造事实，传输另有真实Herdr回归） |
| RUNTIME-002探索回归 | 有接替者才出发/换人，一次-8；无接替者不开始 | PASS（不代表探索正式动画） |
| RUNTIME-003探索与日常 | 聊天/切人/锁屏及多原因暂停，沿同ID与剩余有效时长恢复，退出重开不补离线进度 | PASS（锁屏由系统生命周期fixture触发，不声称人工锁屏） |
| RUNTIME-003连续中断 | 已播放2帧→恢复首帧2→再次中断/重开首帧2→最终8，不从0重复 | PASS |
| RUNTIME-004能力与预算 | 单一用途无双发、预算约束；其他角色/缺帧副本/不可见daily不建立活动、不假开始 | PASS |
| DESKTOP-007换代 | 实际renderer同角色换ID，新进度1至8、无旧ID继续进度/完成，确认后idle不重播 | PASS |
| 领域/宿主/IPC | 双条件两种先后、旧取消ID/角色校验、进度/完成写失败、旧库迁移；canvas sender与displayKey/generation校验 | PASS（非可信sender为单元边界，未做恶意窗口集成攻击） |

Codex查看本批runtime-001的伸展首段、举臂峰值、回idle三张原生截屏，以及兼容导出8帧浅棋盘：实际88×128窗口，耳尾鞋完整，脚底及本体尺度稳定，透明区显示桌面；8个关键姿势可辨，脸发服装保持身份，峰值闭眼与伸展一致。结合已执行逐帧文件序列和正常/中断恢复，受托接受凛stretch-pixel-v2-canvas256为当前正式日常动作。方法是Codex静态关键帧/逐帧视觉审查与真实时序自动化，不冒称用户亲自连续观看或长期体验通过。后续体验仍可调整节奏。

生产改动约490净增，主要是持久进度/完成事实、已有通道的身份校验与既有播放器恢复；新增canvas-ipc为十行窄sender判定，复用现有模式，无新引擎。规模比初估250～450稍高，职责可逐条对应已复现缺口，接受必要增量。旧失败和NOT_COVERED历史保留；本轮不接受其他角色daily、探索正式离场/返回、全动画库或故事产出。

仅发布标注由CLI91134收尾，禁止改行为/素材/尺寸/时序；须核对实际diff后记录最终检查，不能把标签修改重新当一套功能验收。

发布标注91134已终态，Codex核对仅desktop-assets的wave/stretch候选布尔与验收说明、对应unit断言变化，资源ID/尺寸/时序/能力门无额外变化。独立assets测试1/1（s06h-codex-release-label.log），无需因标签重复全GUI。S06h阶段接受并按snap保存，不将候选行走/倾听等顺手标为可用。
