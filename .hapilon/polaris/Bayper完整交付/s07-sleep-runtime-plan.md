# S07 睡眠正式运行最小切片方案（已批准实施）

2026-10-28，Codex master 受托批准。依据：PRD REQ-44、`state-and-rhythm.md` resting 行、`animation-plan.md` D03/D04、已验收的 rest 运行与 drowsy 候选。本批只接凛 D03/D04；不新增角色状态种类、不建通用动画框架、不调用模型、不改亲密/心情、不做动画额外精力扣减。真实 GUI 本批由 Claude Code 独占执行；master 随后独立复验与视觉接受。

## Part A：业务行为与验收

### A0 只读现状

- `desktop-assets.cjs` 当前只接凛 idle/wave/stretch/sit；drowsy/sleep 尚未成为正式动作；Hu/Cheng 无 sit。
- `app/desktop/main.cjs` 的 `syncHitFrame` 帧集只列 idle/wave/stretch/sit，`canvas:hit-frame` 会拒绝集合外帧；本批必须加入 drowsy/sleep，否则睡眠帧不能更新 alpha 命中。
- 休息已有 `restToken` 与真实 `rest-settled`；host 的 `restSettled` 缓存按 token 区分，但不得作为困倦/睡眠等待的立即放行依据。
- 当前没有 20s 静默计时、睡眠阶段、sleep 循环边界或唤醒节点；`mode` 只有既有状态。

### A1 触发、延续与退出

1. 仅凛 `resting` 且本次 `restToken` 的真实坐下完成（`rest-settled`）后开始安静计时；无 sit 的其他角色继续 idle，不等待不存在的节点。
2. 安静满真实 20s 且无聊天、无交接/轮换、无运行中活动、画布可见且 ready、系统未暂停时，播放一次 8 帧困倦（400/240/220/420/300/240/300/500ms，非循环），结束接 sleep 8 帧循环（350ms×8）。`mode` 仍 `resting`，不新增行为状态。
3. 只有一个安静计时器；只在 rest-settled、聊天开关、交接/活动变化、锁屏/隐藏/错误/恢复时建立或清除。60s 心跳与重复 `syncDesktop` 不重置、不加速、不重复发节点。聊天结束/取消后从该事件重新完整 20s。
4. 唤醒复用：sleep→drowsy 7→6→0→sit 末帧；禁止倒放哈欠帧 4/3/2/1。聊天在困倦手抬到嘴边时不得瞬移到 7：先完成当前困倦短段（剩余最长约 2.62s），再从 7/6/0 唤醒；sleep 中可在当前帧直接进入唤醒。聊天文本/窗口不等动画，启动立即生效。切换人/探索离桌不要求唤醒动画，只等睡眠循环有限末边界。
5. 手动换人、再次休息、探索离桌：静坐立即；困倦/睡眠等 `rest-sleep-boundary`（最坏约一次循环 2.8s+余量 1.2s）后收束。已待开始的探索在该边界走既有 `completeNaturalNode`/`startScheduledActivity` 启动并选接替者，不能只靠“sleep 不发 idle-loop”把探索永久卡住。超时不得伪造完成，按 `NODE_TIMEOUT` 失败。
6. 必需通知走现有独立窗口，不叫醒、不暂停、不吞 P0；通知不改变睡眠计时。锁屏/休眠/隐藏/素材错误/子进程退出立即停表停帧（`restSuspended`/`visible=false`），不播唤醒、不产生假 `rest-settled`；恢复显示合法坐姿（sit 末帧）后从新的 20s 开始；新的 20s 后允许新一次困倦，不重播旧的半截困倦。
7. host 只接受与当前 `restToken`、displayGeneration、displayKey、当前实际 drowsy/sleep 帧全部一致的 `rest-sleep-boundary`；它只解除睡眠边界等待，绝不写入或冒充 `restSettled`。旧 token/角色/代次帧与旧 settled 均不得复活或提前放行。
8. 显示沿用 128/314 与真实 alpha 命中；drowsy/sleep 全帧进入缓存、预载、身份 key、`desktop/main.cjs` 帧 allowlist 与 alpha 缓存。并集预计 216×314、窗口约 89×128，scale 不变；若实际改变 scale/ground 立即停止报告，禁止逐动作 fit。Hu/Cheng 继续既有 sit/idle，不借凛素材、不换服装。

### A2 精力、数值与副作用

- resting 仍按既有规则 +20/小时恢复；本批只禁止动画帧导致额外扣减、重复恢复、重复结算或改亲密/心情。
- Case 以两次真实 snapshot 的实际间隔独立计算 `20/3600 × 秒数`，允许测量与结算舍入容差；同时断言精力未下降、亲密/心情不变、无模型请求。
- 探索开始时按既有活动规则一次 −8 是合法业务结算，不是动画副作用；Case 单独核对恰好一次，不重复扣。
- sleep/drowsy/边界节点不得触发轮换、故事、自动机会或 API；通知队列与 P0 优先级不变。

### A3 Acceptance Contract

| ID | Given / When | Expected | Oracle | Boundary |
|---|---|---|---|---|
| POL-SLEEPUI-001 | 凛真实点击休息并停 sit 末帧；无聊天/交接/活动，可见且未暂停；等待真实 20s | 前 20s 保持 sit 7；到点一次 drowsy 0…7，再 sleep 循环；`mode=resting`、token 不变；精力按 +20/h 恢复且无额外扣、亲密/心情不变、无模型请求 | 真实 Electron/SQLite/正式按钮；逐帧 URL/时间、两次 snapshot、服务器请求计数、DB 状态 | 真实 20s；人类自然度另审；不通过测试接口启动睡眠 |
| POL-SLEEPUI-002 | 困倦第 2～5 帧手在嘴边时真实发起聊天；随后关闭 | 点击时固定记录当时实际帧；此后困倦必须连续完成到 7（采样已显示帧可不重复），唤醒序列必须非空且出现 0，最终停 sit 7；无 4/3/2/1 倒放；聊天期间无 sleep 帧；关闭后重新完整 20s 再出现新困倦 | 点击时 sprite 帧、之后的真实帧序列/时间、聊天面板可见耗时、两次 20s 观察、snapshot；空 natural 或空 wake 直接 FAIL | 唤醒视觉须 master 复核；不合格保留 FAIL，不自动 fallback 成通过 |
| POL-SLEEPUI-003 | sleep 中插入本机 P0 事实通知 | 通知窗口独立可见、不可聚焦、P0/优先级原样；不唤醒、不清计时、无 rest 唤醒节点；无数值/API 变化 | 通知 view/窗口事实、DB 优先级、前后帧与 snapshot | 本机构造非真实 Herdr；气泡视觉另审 |
| POL-SLEEPUI-004A | sleep 中真实手动换人 | 在约 ≤4s 的 sleep 末边界完成，不永久等待；旧 token/代次帧不写新角色；Hu/Cheng 合法 idle/sit 不借素材 | 切换耗时、characterId/displayKey/generation、旧帧记录 | 真实换人体验另验 |
| POL-SLEEPUI-004B | 已排队探索，以及公开活动请求的低精力/交互/无接替/额度边界 | 已排队探索只在有限 sleep 边界经既有启动/换人流程出发，只扣一次既有 −8；低精力、交互中、无接替者、活动额度仍按原规则阻止；不得靠新 resting 例外绕过任一门禁 | 公开活动服务请求、活动行/探索标记、精力一次变化、拒绝原因、真实换人帧 | 受控时钟/正式自动机会；真实外出体验另验 |
| POL-SLEEPUI-005（锁屏） | 睡眠中锁屏/恢复 | 锁屏立即停表停帧并显示合法 sit 7；恢复后重新 20s，不重播半截困倦；新 20s 后允许新困倦；无假 rest-settled | `powerMonitor.emit`、帧记录、token/generation、snapshot | 非物理锁屏；隐藏路径另列 |
| POL-SLEEPUI-005B | 睡眠中隐藏、子进程退出/重建、应用退出、旧回调 | 真实托盘菜单回调停帧；子进程退出/重建后重新 rest-settled 并新 20s；无 sleep 帧复活、无假 rest-settled、无重复 API/精力 | 真实菜单回调（标明非原生鼠标）、真实 PID、重连 CDP、帧与节点记录 | 隐藏非原生鼠标；物理锁屏另列 |
| POL-SLEEPUI-005C | 睡眠中真实素材加载失败，再恢复 | 停表停帧；旧 token/回调不复活、不伪造 rest-settled；恢复后合法坐姿与新的完整 20s 再困倦 | 真实 renderer 加载拦截（不改共享素材）+ 真实“重新启动角色画布”菜单回调 | 拦截属可恢复测试通道，不是共享素材损坏 |
| POL-SLEEPUI-006 | 加载凛并逐帧显示 drowsy/sleep；指向身体/透明区；再切 Hu/Cheng | 全帧进入预载、身份 key、displayedFrame、`desktop/main.cjs` allowlist 与 alpha 命中；scale 128/314、ground 128,376、无裁切；Hu/Cheng 无睡眠帧且不借素材 | unit + 真实 DOM 帧/窗口尺寸 + 既有 s07c 透明输入回归；不重复物理点击 | Retina/原生物理覆盖沿既有证据 |

Part A 规模：1 角色、2 段既有素材、3 个阶段（静默/睡眠/唤醒）、1 个新边界节点；不扩其他角色、服装、通知、数值规则或 36 动作库。

## Part B：最小实现、规模与顺序

### B0 实施结果与规模

- 本切片已完成整改并真实复验；master 对 final-r2 的 SIGINT 属主动中断，不计产品失败；final-r3 为最终证据批次。
- 当前只读 diff：`app/main.cjs +220/−5`、`app/desktop/renderer/canvas-app.js +254/−9`、`app/desktop-host.cjs +63/−3`、`app/desktop-assets.cjs +11/−3`、`app/app-tray.cjs +17/−1`、`app/desktop/main.cjs +8/−1`、`app/desktop/canvas-ipc.cjs +8/−1`、`app/desktop/preload.cjs +2/−1`、`app/companionship.cjs +3/−1`、`app/presence-boundary.cjs +3`；**生产合计 +589/−25，净 +564**，超过 550 信号 14 行，均为明确缺陷修复/最小观测，不新增功能，按 master 指示如实报告、不压行。
- 测试变更：新增 `desktop-sleep.spec.cjs` 1491 行；既有 character-activities/notifications/desktop 与三份 unit 合计约 +205 行。新增 Case 预计 100～220 行的信号已按实际必要执行。
- final-r3：睡眠 10/10、休息 3/3、活动 6/6、通知 11/11（另一轮 010 一次时序失败、单独复跑通过并保留）、desktop 11/11、unit 9/9、活动服务 16/16。边界 A/B 失败与旧基线均保留，不覆盖。

### B1 数据流与节点

`main.cjs` 单一 `restQuiet` 控制器（token/characterId/blocked/eligible/timer）→ presentation `sleepEligible`/`restSuspended` → `canvas-app.js` 播 drowsy 一次后 sleep 循环 → 困倦结束、每个 sleep 循环末、唤醒结束发 `rest-sleep-boundary`（displayKey/generation/restToken + `boundaryKind`）→ `desktop-host.cjs` 按当前实际收束帧/token/代次校验 → main 有界等待或启动已排队探索。`mode`、companionship 存储与数值系统不加状态。

**边界协议（已实现并验证）**：`boundaryKind` 只允许 `drowsy-end`（实际帧必须 drowsy 7）、`sleep-end`（sleep 7）、`wake-end`（drowsy 0），经 preload/canvas-ipc 白名单贯通。host 同时核对当前显示帧、边界种类、restToken、displayKey、displayGeneration；非收束帧、旧 token/代次、错种类一律拒绝，且不写入 `restSettled`。unit 4 类正反例与 GUI 换人/探索/唤醒已覆盖。

### B2 文件与规模信号

> 下表是实施前估算；实际已完成净增与停工估算以 B0 为准。

| 文件 | 最小职责 | 预计净增 |
|---|---|---|
| `app/desktop-assets.cjs` | rin 可选 drowsy/sleep；公共帧/时长/loop；共同 display 并集；候选标注 | +25～40 |
| `app/main.cjs` | 单一 20s 控制器、阻塞矩阵、presentation 两旗标、忽略/启动边界、有限等待、暂停/隐藏清理 | +80～110 |
| `app/desktop/renderer/canvas-app.js` | 预载/身份 key、睡眠阶段、困倦短段完成、wake 7/6/0、边界节点、暂停停表、失效清理 | +90～130 |
| `app/desktop/main.cjs` | 帧 allowlist/`currentFrames` 加入 drowsy/sleep（不预载其他角色） | +5～10 |
| `app/desktop-host.cjs` | `rest-sleep-boundary` 帧/token/代次校验；期望节点有界放行；暴露边界事实 | +25～40 |
| `app/presence-boundary.cjs` | 超时纳入 drowsy/sleep（sleep 约 4000ms） | +5～10 |
| `app/companionship.cjs` | 允许当前角色在 `resting` 但仍在屏时经既有探索启动/换人流程离桌；只放宽该资格判断，不改数值/模式种类 | +3～8 |
| `tests/unit/desktop-assets.test.cjs` | 并集/scale/ground/身份 key/其他角色不借用 | +20～40 |
| `tests/acceptance/desktop-sleep.spec.cjs` | 真实 Electron/SQLite/按钮/帧记录/清理 | +500～750 |

原估算为生产净增 235～350 行；当前最终净增564，见 B0。350 是审查信号，不是压行目标；不为凑数删断言、挤行或合并 Case。原计划预计不改preload，实际为传递boundaryKind增加参数；notification渲染/chat/memory不改，`companionship.cjs` 只改探索资格一行判断。

### B3 实施顺序与失败基线

0. 已完成 host 边界收束帧/种类校验、002 非空/连续断言、004B 公开门禁、005A/B/C 生命周期与 P0 正确夹具；修复前 A/B 失败记录保留在 `attempt-20261028-fix-ab-r1`，旧基线不覆盖。生产净增 564 超过 550，按实际缺陷职责报告，不再扩功能。
1. 先修订本计划并冻结批准修正。
2. 先新增 `desktop-sleep.spec.cjs` 与 unit 断言，在当前生产上执行，保存失败基线（独立 attempt、before/after SHA、exit、逐 Case 状态）；不得先改生产再补造基线。该基线已存在于 `attempt-20261028-baseline-before-impl/`，保留不覆盖。
3. 再按 B2 最小实现；每轮独立 attempt，保留失败与修正记录。
4. 跑新 Case、`desktop-rest.spec.cjs`、`desktop-assets.test.cjs`、s07c 透明输入；按影响面补跑 activity-runtime 与 desktop-notifications，不机械全库。
5. 真实 GUI 全由本 CLI 独占；master 之后独立复验。自动证据不写人类体验通过。
6. 004B 必须同时覆盖公开活动请求与低精力/交互/无接替/额度门禁，不能只证明消费一条手工排队记录。

### B4 唤醒复用风险

1. 困倦 2～5 帧手在嘴边，直接跳 7 会瞬移；必须完成当前短段后再 7/6/0，Case 检查。
2. sleep 头部带约 175px、sit 约 163px（静态代理），同 scale 下可能显头大；不得逐动作缩放，交 master 视觉判断。
3. sit 最低像素约 377、drowsy/sleep 约 375，可能有 2px 接地跳；需深浅截图。
4. sleep 0↔7 接缝、闭眼一致性、窗口 88→89pt 均须实际小尺寸审查；候选播放器通过不等于正式衔接通过。
5. 唤醒视觉不合格必须报告并保留 FAIL；回退（直接 sit 7 或暂停接入）由 master 决定，不自动记通过。
6. 探索边界只允许既有活动流程启动与一次合法扣减；不得以“sleep 不发 idle-loop”掩盖无法离桌。
7. 手工“继续陪伴”已实现自然唤醒后逆坐起身（007 验证）；连续视觉仍待 master，不以自动帧序替代体验。
8. 隐藏/错误/退出路径已补 005B/005C；素材错误用真实 renderer 加载拦截构造，不改共享素材；真实 BrowserWindow 可见性由 `actualVisible` 独立观测。

### B5 证据、Case 状态与边界

- 证据目录 `.hapilon/polaris/Bayper完整交付/evidence/s07-sleep-runtime/<独立批次>/`：源码 SHA、before/after、逐 Case JSON/日志、帧序、深浅截图、精力/亲密/心情前后、API 计数、通知事实、进程/临时目录清理；不覆盖旧 attempt。
- 交付逐 Case 写 PASS/FAIL/NOT_COVERED 与视觉待验，不汇总成“全 S07 完成”。
- 最终证据 `evidence/s07-sleep-runtime/attempt-20261028-final-r3/`：睡眠 10/10、休息 3/3、活动 6/6、通知 11/11、desktop 11/11、unit 9/9、活动服务 16/16；各命令独立 exit/SHA。`final-r2` 为 master 主动 SIGINT，记录为中断非产品失败；notification 010 另有一次时序失败、单独复跑通过，原件保留。
- 真实/mock 边界：真实 Electron/SQLite/正式按钮/本机 P0 行与 powerMonitor.emit；Herdr/模型未调用；素材错误为 renderer 加载拦截，不改共享素材；物理锁屏/Retina/人类连续体验仍 NOT_COVERED。
- 本批结束后结束等待 master 独立验收；未获接受前不写正式发布或完整 S07 结论。


## master收口补充

独立结果见master-review：GUI10/10、边界9/9、公开活动16/16，受托接受已测运行行为。通知另批10/11失败仍未归因，文中早期11/11为历史批次，不表示当前通知整体已通过。静态图已检查，正式连续动画美术仍待验。POL-SLEEPUI-007补充契约：Given凛睡眠；When点击正式继续陪伴按钮；Expected先合法唤醒到drowsy0，再sit7…0逆坐起身、回idle，不直接跳帧；Oracle实际DOM帧序与正式snapshot；真实Electron、构造数据，连续美术另验。
