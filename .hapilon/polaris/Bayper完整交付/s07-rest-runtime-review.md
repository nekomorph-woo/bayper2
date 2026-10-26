# S07 休息运行接线审查

2026-10-27，Codex，尚未接受。实现中期只读审查发现以下必须复验点，不能用旧功能绿灯接受：

1. main的waitForPresentationBoundary用presentation.resting直接return，会把刚开始坐下也当已静坐末帧，手动换人可能跳过尚未完成的自然节点。需要基于真实播放完成确认区分过渡与稳定静坐；稳定静坐不能等待不存在的新循环，过渡不能提前放行。不得用固定sleep或以mode代替动画事实。
2. resting来源直接读取全局current_mode，可能将稳定角色A的休息意图套到临时聊天的角色B。必须限定意图归属；A本人的聊天可保留坐姿，B不能继承A姿势。
3. 原规格要求离开休息短节点后恢复，当前syncRest直接startIdle尚未证明过渡自然。允许既有坐下帧逆放作为起身候选，必须标记为复用、看实际效果，不虚称新素材。
4. 实施扩大至main/desktop-main与既有desktop/activity Runner，职责确有接线需求，但未先报告；在复验前由Codex明确批准必要边界，不能追认所有任意修改。脚锚距窗口底部原<1pt需对应四动作真实并集修正，不应机械宽放所有角色；精确核对凛128/314×308，Hu/Cheng保留旧约束。

本记录是代码检查假设和约束，尚无相应GUI复现，不写FAIL/PASS业务结论。须Claude通过真实入口补回归、Codex独立冻结后执行。

后续静态复核补充（仍待真实Case）：resting分支需要限定实际有sit素材。Hu/Cheng无sit时仍idle，不会发送rest-settled；此时不得让用户从休息状态换人必然NODE_TIMEOUT。desktopHost.lastNode在同资产身份中不会因resting变化自动清空，不能无条件用历史rest-settled放行本次新过渡；请核对重复休息/起身中再休息、短节点生命周期及当前帧/身份代次，使用真实完成事实，不靠全局旧lastNode。必要时允许最小修改desktop-host.cjs与presence-boundary.cjs，保持身份/代次校验，禁止宽放节点任意解除。请先报告范围依据，再交付修正。

## 返修与独立接受

CLI66400首版、43516/r2、28107/r3均terminal。Codex明确批准必要main/desktop-main/preload/host/presence-boundary及相邻断言扩展：本次restToken限定休息完成，host核对当前角色/代次/真实末帧；无sit走原idle边界，临时聊天不继承稳定角色姿势。生产净增约250行，无新框架；坐下与静坐共用原播放器，起身为坐下逆序复用。

Codex92096/r1：001/002通过，003在点击后lastNodeAt比较失败，实际仍frame07且新节点为rest-settled。夹具在显示末帧时提前取了旧节点，忽略末帧600ms停留。r3只修Runner等当前restToken的真实完成回执，保留原断言与失败批次。Codex76708/r2独立三Case全部PASS；原始证据evidence/s07-rest-runtime/codex-20261027-r2，六份Runner记录源码SHA与当前文件一致，补充完整13文件摘要s07-rest-codex-frozen-source.sha256与生产diff用于复核（补充摘要为验收结束时记录，不冒称Runner自动包含全部依赖）。

| Case | 状态 | 实际证据 |
|---|---|---|
| POL-RESTUI-001 | PASS | 真正点击安静休息，实际帧序0～7，之后静坐不再idle；mode=resting，88×128pt窗口、同scale128/314与ground；真实子窗口截图完整无裁切 |
| POL-RESTUI-002 | PASS | 坐下中聊天仍播完；关闭不重播；起身逆序收束后待机；二次休息token1→2，旧settled清零；换人等待第二次真实完成，无迟到旧帧；程序发锁屏/解锁事件后恢复 |
| POL-RESTUI-003 | PASS | 本地构造事实通知窗口可见且不可聚焦；静坐点击不wave，节点不变；拖动窗口实际位移；临时与琥珀聊天不继承凛姿势；无sit的琥珀休息后可切回凛，旧帧不覆盖新角色 |

Codex79144相邻18测试通过：activity-runtime 6、desktop 11、透明输入合并测试1（覆盖POL-HIT001/002/003），日志s07-rest-neighbor-codex-r1.log。真实系统鼠标路由仅本轮自建底板，scaleFactor1；证据s07c-transparent-input/run-20261026232809194-8ac535，角色/底板退出、目录删除、用户光标恢复。19单元独立通过s07-rest-unit-codex-r1.log。diff --check通过。

Codex查看静坐与拖动后的真实小画布截图、聊天/回待机图，角色大小与脚锚保持；自动记录完整坐下/逆序帧，不能据此写成用户人工连续体验。三Case父/子窗口、CDP连接、HTTP与临时目录清理成功，无残留进程。

受托接受凛D01/D02正式运行接线及逆放起身候选的本轮行为。尚不代表其他角色休息资源、D03/D04、全部36动作或正式内容发布完成；锁屏用powerMonitor事件路径，不冒充真实系统睡眠；通知是本机受控事件而非真实Herdr，未在此批截图单独审查气泡视觉；真实Retina仍未验。睡眠与倾听候选独立播放器已通过，但跨动作/正式触发另验。
