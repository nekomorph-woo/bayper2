# S07 休息动作接入最小切片

2026-10-27，Codex依据用户master授权确认。本轮仅凛D01坐下→D02静坐及恢复；不将它冒称D03困倦/D04睡眠，不发布其他角色或服装。来源：PRD REQ-44、state-and-rhythm.md resting行、animation-plan.md D01/D02；素材验收见s07-rest-review.md。

## 目标与实现边界

正式应用点击安静休息，凛使用sit-pixel-v2-canvas256八帧一次性坐下，完成后保留末帧安静坐姿。没有适合接替者的本地休息也使用同一表现。聊天、手动切换及锁屏/恢复沿既有规则，不能假完成日常任务、强叫醒或额外模型请求。恢复陪伴应在短自然节点完成后回待机；可使用坐下帧逆序作为起身过渡候选，但必须实际审查，不能宣称新绘制起身动作。休息时事实气泡独立显示，不自动招呼打断坐姿。

保持单一同屏、统一缩放和脚锚、透明alpha命中、身份代次校验、非抢焦点和128pt主体上限。manifest的output_ground_anchor与旧output_foot_anchor均需读取其真实定义，不删除稳定性检查。四动作并集215×314，默认scale128/314；不要逐动作fit造成呼吸式大小变化。坐姿最低像素低于锚最多约2pt属于完整轮廓，不裁掉裙摆或尾部。

允许文件：app/desktop-assets.cjs、app/desktop/renderer/canvas-app.js；如必要可改app/desktop/canvas-ipc.cjs的节点允许集，但不得放松角色/代次校验。新增tests/acceptance/desktop-rest.spec.cjs；既有tests/unit/desktop-assets.test.cjs（若实际名不同先回报）仅增必要断言。若需要其他生产文件先说明理由。无需新框架/播放器/独立状态机文件，不扩张36动作完整库；目标生产增量约120～220行，规模是审查信号非压行指标。

## Acceptance Contract

| Case | Given / When | Expected / Oracle |
|---|---|---|
| POL-RESTUI-001 | 真正配置并接纳凛，待机时从主窗口点击安静休息 | 真实桌面子窗口依次播放8坐帧并停末帧，主业务mode=resting，2秒以上不回idle/伸展；同一缩放/锚，无裁切。读取实际sprite帧序列、SQLite/应用状态、截图，不用测试接口替代操作 |
| POL-RESTUI-002 | 凛静坐，主动聊天后关闭；或坐下过渡中触发聊天 | 进入互动和退出后恢复resting原意，不循环重新坐下、不误报活动完成；过期帧回调不覆盖新身份；自然节点与切换无永久等待。通过真实聊天控件、本机HTTP、子窗口帧和持久状态核验 |
| POL-RESTUI-003 | 休息时收到事实通知，点击身体/拖动，随后手动换角色再回凛 | 通知独立，点击不把静坐变招呼；拖动及透明区仍正确；旧坐帧回调不能写入新角色；单角色、≤128pt、桌面不抢焦点。实际窗口状态与截图，透明命中沿已有回归，不把DOM点击当物理鼠标证据 |

Runner可复用既有测试方法与本地HTTP构造配置，不读.env不调用真实API。固定三Case、独立证据批次位于.hapilon/polaris/Bayper完整交付/evidence/s07-rest-runtime；源码SHA、帧观察、截图、父子进程及HTTP/临时目录清理均记录。GUI由Codex排他执行，Claude只语法/非GUI自测。没有真实Retina或用户人工体验不得声称通过；没有正式sleep资源仍标未覆盖。
