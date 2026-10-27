# S07 睡眠运行专用 review（最终整改报告）

2026-10-28。master 对 final-r2 的 SIGINT 为主动中断，不是观察超时或产品失败；final-r2 已产生的 001～005 记录保留。最终证据批次为 `evidence/s07-sleep-runtime/attempt-20261028-final-r3/`。本报告只陈述实际执行结果，不替代 master 独立 GUI/视觉验收。

## 1. 最终 Case 结果

| Case | 结果 | 证据要点 |
|---|---|---|
| POL-SLEEPUI-001 静默 20s→困倦→sleep | PASS | 真实首次静默约 20s；drowsy 0…7 一次后 sleep 完整循环；`mode=resting`；精力按 +20/h、无动画额外扣；无模型调用 |
| POL-SLEEPUI-002 抬手时聊天→完成短段→唤醒→重等 | PASS | 点击时为 drowsy 2；之后 3/4/5/6/7 连续完成；wake 6/0 非空并到 0；停 sit 7；关闭后新 20s 再困倦 |
| POL-SLEEPUI-003 真 P0 不叫醒 | PASS | `priority/original_priority=0`，返回 eventId；按 eventId 进入 urgent 面板与真实 notification DOM、回执 6s；静默 20s 有上下界；睡眠不唤醒、无模型调用、不抢焦点 |
| POL-SLEEPUI-004A 睡眠中换人 | PASS | 睡眠末边界约 2.8s 完成；旧帧不写新角色 |
| POL-SLEEPUI-004B 已排队探索离桌 | PASS | 有限 sleep 边界经既有启动/换人流程出发，接替者生效，只扣一次 8 |
| POL-SLEEPUI-004B-ACTIVITY 公开活动门禁 | PASS | 既有 `character-activities.spec.cjs` 真实服务/SQLite：resting 可出发；低精力、交互、无接替、4h 额度仍阻止；无接替不扣精力 |
| POL-SLEEPUI-005A 锁屏/恢复 | PASS | 立即停表停帧到 sit 7；恢复后新 20s，不续播半截困倦 |
| POL-SLEEPUI-005B 隐藏/子进程退出 | PASS | 真实托盘菜单回调（程序化，非原生鼠标）；隐藏后停帧，恢复新 20s；杀真实 PID 后重启、重新 rest-settled、新 20s 再困倦；可重连 CDP |
| POL-SLEEPUI-005C 素材加载错误 | PASS | 真实 renderer 加载拦截 sleep 帧（不改共享素材）；assetState error、停帧、token/settled 不被改写；移除拦截并经真实“重新启动角色画布”恢复后新 20s |
| POL-SLEEPUI-006 尺度/预载/命中 | PASS | 10 帧全播放；scale 128/314；窗口 89×128；sleep 身体 alpha 可拖动；Hu 无睡眠素材 |
| POL-SLEEPUI-007 继续陪伴 | PASS | 睡眠中点击正式按钮：先 wake 7/6/0，再 sit 7…0 逆序起身，回 idle；无直接跳 idle |

最终命令与 exit：睡眠套件 `exit 0`（10/10）、rest `exit 0`（3/3）、activity-runtime `exit 0`（6/6）、desktop `exit 0`（11/11）、unit `exit 0`（9/9）、character-activities `exit 0`（16/16）。通知最终版全量一次 10/11（010 时序失败），010 聚焦复跑 `exit 0`；同生产版本的上一轮全量曾 11/11，010 原件保留，不写“全绿”。

## 2. 本轮修正

- 边界协议：`boundaryKind` 贯通 renderer→preload→desktop/main→host；仅接受 `drowsy-end=drowsy7`、`sleep-end=sleep7`、`wake-end=drowsy0`，并核对 token/displayKey/generation/current frame；中间帧/错种类/旧代次拒绝，不写 `restSettled`。修复前 A/B 失败见 `attempt-20261028-fix-ab-r1`。
- Runner 页面错误：enterRest 在 canvasPage 安装 trace，但 001/002/003/005 等曾把管理 page 传给等待器；已逐调用改为 canvasPage，管理 page 只用于 snapshot/按钮。历史 fix-r2/r3/r4/debug 的空 trace 结果应视为 ERROR 观察，不据此判断产品未入睡；原件保留。
- renderer 素材接线：首次 load、缓存恢复、预载、身份 key 全部包含 drowsy/sleep；此前仅声明的真实缺陷已修复。
- P0 夹具：旧 003 的 priority=1 只证明普通通知，历史记录标夹具 ERROR，不得称 P0 PASS；新 003 使用 0 并按 eventId 等 urgent 面板/DOM/回执。
- 生命周期：坐下过渡中锁屏不提前停帧，保证真实 rest-settled；睡眠/困倦立即停；系统暂停期间已开始的日常伸展继续播完并按完成事实收束（renderer 依据 `systemPaused`，不截断日常）。
- 通知可见性：新增未经 `intendedVisible` 钳制的 `actualVisible`，测试等待真实隐藏后断言；未改 notification 业务 Expected。
- 继续陪伴、隐藏、子进程退出、素材错误、公开活动门禁均已补实际入口与证据。

## 3. 规模与测试分布

生产相对 HEAD：`+589/−25，净 +564`（main +215、renderer +245、host +60、desktop-assets +8、app-tray +16、desktop/main +7、canvas-ipc +7、preload +1、companionship +2、presence-boundary +3 的净增口径）。超过 550 信号 14 行，全部用于明确正确性/生命周期/观测缺口，无新增功能；未压行、未删断言。

测试：`desktop-sleep.spec.cjs` 1491 行；既有 character-activities +77、desktop-notifications +11、desktop +4、unit +113（host/canvas-ipc/assets）。本轮新增 Case/断言约 220 行，处于 100～220 上限。

## 4. 保留失败与调查

- 旧实现失败基线 `attempt-20261028-baseline-before-impl`（7 GUI FAIL、unit FAIL、SHA 一致、清理完整）保留。
- fix-r2/r3/r4/debug、p0-005c-r1 的失败保留；不覆盖、不补造。
- final-r1 通知 004 失败、final-r6 无通知生产行为改动即通过：本轮未能证明根因；新增 raw `actualVisible` 观测后 final-r3 通过且真实 isVisible=false。不能称“已修复 notification 回归”，只记录为构造时序/观测钳制待 master 独立复核。
- notification 010 在最终版一次全量中“6 秒内被裁切”失败，聚焦复跑通过；保留两轮结果，不当作全绿。

## 5. 边界（未验证）

- 未取得人类连续观看、真实物理锁屏、Retina/多屏、真实 Herdr/真实模型证据；P0 为本地 SQLite 行，tray 为程序化菜单回调，素材错误为 renderer 加载拦截，均如实标注。
- 截图仅静帧；小尺寸连续自然度、唤醒观感、sleep 接缝、head/ground 差异仍待 master 视觉验收。
- 未改 state、版本、Git、skill、memory、env、API、依赖或共享素材；未用子代理。等待 master 独立验收。

## 通知 010 偶发裁切：最小 Runner 补证（本轮，仅改测试）

范围：`tests/acceptance/desktop-notifications.spec.cjs`。未改生产、通知分页业务、6 秒阅读或任何断言；未运行 Electron/Herdr/GUI，仅 `node --check`。改动 `+106/−18`（净 +88），在 30～80 预计略上但低于 120；增加部分全部是失败可审查字段与 010/011 两处既有循环的去重赋值。

### 实际采集字段与调用点

- `sampleNotificationGeometry()` 现在在真实 DOM `evaluate` 内取 `sampledAt = Date.now()`，并在 Node 侧保留 `requestStartedAt/requestEndedAt`；返回 `innerWidth/innerHeight`、urgent/list rect、每行 `eventId/ack/source/meaning`、`rowRect/sourceRect/meaningRect`、`sourceClipped/meaningClipped/fullyVisible/clipped/clipReasons`；普通卡文字补 `rect`。
- 新增 `absentTimelineEntry`、`rowTimelineEntry`、`timelineForEvidence` 三个小 helper，只复用现有采样结构，不新建工具/框架。
- 调用点：010 与 011 的既有采样 while 循环；timeline 条目现在带 `t`（DOM 内时间）、请求起止、窗口/容器/行/来源/含义 rect、clipped 具体判定。
- 断言前落盘：010 写入 `record.facts.auto.timeline`，011 写入 `record.facts.timeline`；每条样本附对应 `acknowledgedAt/holdUntil`（当时 DB 值）。若后续断言失败，catch/finally 仍会写出 case JSON，因此无需等最终 debug 几何。
- 原有失败 catch 的 `record.facts.debug`、DB items、logs 保留。

### 尚未证实的时序假设

1. `sampledAt` 来自 renderer DOM 时钟，而 `acknowledgedAt/holdUntil` 来自 Node/DB 时间；跨进程毫秒级偏差可能在 6 秒边界把一次采样误归入/排除阅读期。
2. 分页/普通位到达会异步改变 list 高度；一次 200ms 间隔内可能先采样到过渡布局，`fullyVisible=false` 或 `scrollHeight>clientHeight` 可能只是瞬时裁切，而非 6 秒内持续不可读。
3. `fullyVisible` 同时使用 list rect 与 window innerHeight；若采样与窗口尺寸更新交错，需用新 timeline 对照请求起止判断。

以上均只是待验证假设，不称根因。新证据将让 master 区分“真实长名称裁切”与“采样时间/布局错配”。本轮不做 GUI 运行，等待 master 执行聚焦 010/011。
