# S07b 三角色基础动作：独立审查

Codex受托审查，2026-10-27。接受三角色基础动作接入这一阶段成果；透明命中仍有缺口，保留候选标记，不更新正式故事素材可用性，不宣称S07b全部条件或完整动作库交付。

## 已实际查看

- 生产变更限desktop-assets映射/共同画布和角色主窗口母版引用，未增加播放器框架。四项320宽导出保留原图，Claude平移检查记录身体RGBA未变；独立复核待最终源文件稳定后执行。
- Codex查看 `evidence/s07b-three-character/run-20261027-044500-s07b-final/` 琥珀/澄的idle与wave深浅背景截图，及前一独立批次 `run-20261026204215817-f62c35/` 的实际桌面stretch原生截图。耳尾脚完整，小尺寸身份可辨；琥珀96×128pt、澄100×128pt、凛88×128pt为共同动作包围范围。截图/帧序列审查不是人类连续播放体验。
- 已独立运行desktop-assets单测，退出0，日志 `evidence/s07b-codex-assets-precheck.log`；这是预检，不能代替最终GUI复验。
- Claude运行报告和截图属于实施方自测；Codex暂未独立运行本轮GUI，以免与66451的独占测试重叠。

## 返修项

1. `runDailyCase`第一次退出前保存desktopPid，重启后finally使用旧变量的空值兜底，可能仍检查上一轮已退出PID而遗漏本轮子进程。每次launch后重新记录实际PID，逐轮退出检查当前父子进程；在确认进程退出后清理目录，失败不得记PASS。
2. 精力只断言完成值不低于开始值约0.06，无法发现意外增加/重复恢复。按受控时间和现有精力规则给出双边预期，覆盖首次扣除一次、两次暂停和重启不重复扣除、不凭空增加；不要删除原有计费语义断言。仅比较单边下界不能证明数值一致。
3. 规格POL-ASSET3-001含“透明空白不抢点击”。当前Case验证窗口共同包围裁剪，未验证透明像素点击穿透；代码只显式切换整窗ignoreMouse。共同画布没有放大窗口不能替代透明命中证据。需如实拆分已验证裁剪与尚未覆盖的透明命中，后续补实际窗口输入验收，不能将整项写PASS。

每次返修保留旧日志、新批次与源摘要；最终独立运行完成后补Coverage Matrix、接受范围与未验证边界。上述属于本轮实现/Runner审查，不是北极星skill缺陷，不为此修改skill。

## 独立复验进展

- 原CLI66451终态退出0，GUI释放。Codex随后独占41763执行S07b两项真实Electron入口，退出0；证据 `evidence/s07b-three-character/codex-20261027-r1/`、总日志 `evidence/s07b-codex-gui-r1.log`。Hu/Cheng各自daily日志业务通过，父退出0、子退出、目录删除；组合Case的透明命中仍未覆盖。前后核对desktop-assets、characters、chat、memory、memory-store及本Runner六份SHA一致，记录 `s07b-codex-before.sha`。
- 已独立逐字节核对32帧：四项256→320导出仅向右平移32，身体RGBA完全一致，两边新增区域alpha全0；证据 `s07b-codex-body-translation.log`。单元13/13通过，`s07b-codex-unit.log`。
- 返修1/2已在当前Runner中改为重启重新取PID和精力双边预期，独立上述运行通过。仍要求清理前确认退出、超时timer及时清除、批次不可覆盖；组合状态PARTIAL不是Polaris规定值，需改INCONCLUSIVE并逐项列出NOT_COVERED。CLI10101仅修这些Runner问题，不许GUI；Codex64783独占串行跑受影响桌面与活动回归。
- 已确认透明像素并非Electron透明窗自动提供的命中区域。[官方窗口样式说明](https://github.com/electron/electron/blob/main/docs/tutorial/custom-window-styles.md)列明此限制；[官方鼠标穿透示例](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)提供setIgnoreMouseEvents与macOS转发移动事件机制。下一窗口输入切片需基于实际帧alpha/坐标及拖拽状态做选择性穿透，真实底板点击证据后才能关闭该缺口；不能仅监听DOM点击就宣称系统事件到达底层应用。

## 最终证据与受托阶段接受

Runner收尾10101退出0，仅修测试；批次排他创建、状态枚举、超时timer及先确认进程退出再清理均已审查。受影响回归64783退出0：单元13/13、桌面6/6、活动运行004一项通过，分别见s07b-codex-unit/desktop-regression/runtime-regression.log。生产动作映射未随后改变。

必须保留的调度问题：Codex原r2复验23764与S03f代码编辑共用源码目录，Electron启动恰读到memory.cjs半编辑状态，发生语法错误。这是非稳定源码的执行ERROR，不是本轮动作失败或通过；Codex终止唯一自建PID18672，确认退出后删除唯一构造目录，见s07b-codex-gui-r2.log及s07b-r2-manual-cleanup.log。实施方此前复用044500-final目录，旧截图亦不作为最终同批证据。

随后以c13a815已提交app/tests为基础，在/tmp/bayper-s07b-review-WfNV8H建立固定副本，仅覆盖本轮两项生产变更及测试；assets/node_modules/prototypes稳定只读来源软链，不链接.env。Codex独占80886运行最终Runner，退出0、两入口通过；源码摘要s07b-isolated-source.sha，总日志s07b-codex-isolated-r3.log。证据原样保存在evidence/s07b-three-character/codex-20261027-isolated-r3/；日志的原临时证据路径对应此目录同名文件。已逐个验证最终父子PID退出及fixture删除，再删除隔离源码副本，见s07b-isolated-cleanup.log。

| 条件 | 最终状态 | 依据与边界 |
| --- | --- | --- |
| POL-ASSET3-001 导入、尺寸、裁剪 | PASS（子项） | 实际窗口96/100×128pt，各自idle；Codex查看r3截图；透明命中子项NOT_COVERED，因此整体INCONCLUSIVE |
| POL-ASSET3-002 招呼与回待机 | PASS | Hu4/Cheng8帧完整序列，重复点击仅一自然节点，深浅图与身份检查 |
| POL-ASSET3-003 日常中断与恢复 | PASS | 两角色真实主进程、SQLite、帧进度、同活动ID重启、10秒有效时间和动作完成，精力双边一致；模拟系统事件不冒充物理锁屏 |
| POL-ASSET3-004 切换/错误/恢复 | PASS | 旧wave回调失效，缺帧明确asset-error且不记日常完成，恢复正确身份 |
| POL-ASSET3-005 凛及相继显示 | PASS | 凛8帧招呼与88×128pt保持，三角色单画布相继显示，主窗口母版同源及自建进程清理 |

Codex另查看最终r3的琥珀wave浅图、澄wave深图、琥珀stretch原生图和澄回idle原生图，未见耳尾脚裁切或大幅尺度跳变。只是自动时序加关键帧视觉审查，不冒称用户长期体验。正式素材发布、透明命中、更多动作与衣装继续后续切片；S03f进行中改动不纳入本次提交，也不由上述固定副本验收背书。
