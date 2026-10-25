# 新版像素角色与128点本体接线

Codex受托最小切片：将用户认可的凛像素画风与约128×128pt本体约束落实到正式Electron画布，保留实际审查边界。依据assets/characters/STYLE.md、desktop-scale-feedback.md及已通过独立播放器的idle-pixel-v2/wave-pixel-v1；attention暂不接业务触发，通知系统后续单独实施。不得称本切片完成全角色/全动画。

允许文件：app/desktop-assets.cjs、app/desktop/main.cjs、app/desktop/preload.cjs、app/desktop/renderer内必要文件、tests/acceptance/desktop.spec.cjs及必要已有desktop单测。禁止改app/main.cjs、chat/memory及其测试、assets、tools、版本/Git/文档/.env。当前聊天协议开发者只写chat/model及专属tests，无GUI；本任务可串行运行隔离桌面GUI。先读AGENTS/CLAUDE，按业务责任组织，不建立通用动画框架，不压行。

业务结果与约束：
- 凛实际加载idle-pixel-v2/wave-pixel-v1，点击招呼后完整收束回待机。身份、自然节点和旧异步加载失效规则保留，不丢显示generation。其余角色不能借凛图片，未接入角色明确pending。
- 本体可见范围等比适配约128×128逻辑点，不能把256×384透明画布缩为128×192就算满足。由manifest的paste/scaled_size计算同角色所有已接动作的共同包围范围；同角色所有帧/动作共用一个缩放和原点，不逐帧或按动作单独fit。不运行时读PNG解码求bbox，不改源帧。
- 窗口包住共同可见范围，尽量裁去透明画布外边距以减少鼠标占用，但不能裁耳、尾、手、脚；图片用同一等比尺度及偏移渲染，窗口整数舍入不要反向拉伸图片。脚锚/落脚点稳定；拖动、屏幕边界夹取、角色切换后窗口尺寸仍正确。此为无场景角色层，未来场景不计入本体128约束。
- Hu旧素材仍可接入回归，以同样本体规则计算；新画风Hu尚未完成，标签不冒称全部升级。
- 继续Prohibited非激活panel、透明、pixelated；不改macOS全局设置。缺素材错误与降级状态可读，不以无角色图片通过测试。

验收Case POL-DESKTOP-007（本切片新增）：Given已接纳Rin、真实画布；When加载新版待机、触发挥手回待机并切Hu再回Rin；Expected所有角色共同可见范围不超约128pt（允许窗口整数舍入1pt），宽高比例保持，各动作同尺度同脚锚，资源URL为对应角色版本；现有自然节点、无焦点、切换、缺素材和退出清理Case不退化。Oracle：真实Electron尺寸/DOM渲染与manifest推导独立核对、截图序列、实际资源路径和进程清理；不得只检查写入常量。没有真实原生鼠标/Spaces证据不称该部分通过。

开发先最小实现与有业务断言的必要回归，预期约100～180行生产增量；超过时先解释职责与必要性。不做新版Hu生成、不扩通知/聊天UI。保留证据返回路径，Codex随后独立验收与体验，不自行提交。
