# S07c 角色透明区域的鼠标交互

Codex受托决定，接续S07b实际未覆盖项POL-ASSET3-001和STYLE.md“额外空白不抢占鼠标”。本轮在独立worktree `/Users/chaooswoo/.codex/worktrees/desktop-alpha-input/bayper` 实施，基线9c59663；不修改原工作目录正在实现的记忆代码。

## 业务与方案

用户点击角色身体可以招呼或拖动，点击其透明区域应直接到达下方应用；角色不抢焦点、不影响文本输入。约128pt和现有非激活panel策略保持，通知气泡使用自己的窗口与点击规则。画布换帧/换角色或拖动后不能沿用失效命中区域。

Electron透明窗口不会自动提供透明像素穿透。依据官方[窗口样式](https://github.com/electron/electron/blob/main/docs/tutorial/custom-window-styles.md)与[鼠标交互](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)，在macOS可使用setIgnoreMouseEvents配合forward移动事件；必须实测当前Electron45而非仅依赖文档。

优先从实际显示PNG取得当前帧alpha，以现有display裁剪/缩放把指针映射到图像坐标，阈值明确，透明区穿透、身体区接收。只缓存当前需要的alpha数据，换帧/角色使缓存更新，不每个mousemove重新解码整张PNG，不预生成新图集或另建引擎。指针静止时换帧、窗口首次出现在指针下和窗口移动后也应重新判定。拖拽已开始则维持捕获直至结束/取消，再恢复命中判断；透明区不能启动拖拽或招呼。全局ignoreMouse开关优先于局部命中。

IPC保持窄接口和当前画布sender/generation校验，不允许通知窗口或过期renderer控制命中。错误/加载时不能留下大块透明区域吞点击；退出清理timer/监听和自建测试环境。只有实际需要时增加一个小helper，生产预期约150～250行信号；禁止高频全屏截图、全局输入钩子、通用场景引擎、插件框架或原生打包依赖。

## Acceptance Contract

| ID | Given / When | Expected / Oracle |
| --- | --- | --- |
| POL-HIT-001 | 三角色约128pt位于自建底板上；分别实际点击身体与透明区 | 身体招呼一次且底板不增；透明点底板增一次而角色不触发；下方保持输入焦点。记录真实系统路由、坐标、当前帧alpha、双方计数；向目标renderer注入DOM事件不能证明穿透 |
| POL-HIT-002 | idle/wave/stretch换帧、换角色、窗口初现或移动，指针停留在边缘 | 命中与当前显示帧/位置一致，无旧generation控制；透明处持续可达底板，身体可交互，无跳焦点；含Retina逻辑点换算 |
| POL-HIT-003 | 从身体拖动跨透明区再释放；全局忽略输入开关；资源错误 | 拖拽不中断不误触下方，释放后透明恢复穿透；全局ignore时身体也不接收；错误不假报动画完成；既有自然节点、日常暂停恢复和通知窗口行为保持 |

执行边界分开：纯坐标/阈值测试用于映射正确性；真实Electron/自建底板用于事件路由。可使用已有可用系统输入能力，只操作本轮自建窗口，不更改全局权限、Dock/Spaces配置或用户应用内容。若系统模拟输入不可用，保留NOT_COVERED并报告Codex，不伪造原生点击；Codex再安排可用工具。模拟输入也不能写成人类亲手点击。

## 实施范围与清理

允许app/desktop/main.cjs、preload.cjs、canvas-ipc.cjs、renderer/canvas-app.js及必要小helper；专属测试与受影响测试。若需要本项目专用原生点击/底板辅助，聚合到tools/desktop-input/（入口/源码/说明/构造数据/证据自包含），尽量复用既有能力，不复制整套研究项目。

不改chat/memory/store、故事/活动领域、版本/Git、角色候选标记或maid-stories。所有源码和测试在本worktree；依赖可链接原node_modules，只读素材沿用本worktree。证据在本worktree的工作证据目录唯一批次，禁止覆盖。清理只针对自己的PID、临时目录与窗口，实际确认退出后才删除。完成后交给Codex独立审查、必要回归与固定源码体验，不能自报成功就发布。
