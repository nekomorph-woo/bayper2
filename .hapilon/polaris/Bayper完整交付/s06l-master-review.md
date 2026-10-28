# S06l 主动换装 master 审查

## r166 Part A 退回（2026-10-28）

35976已终态exit0，单Claude session24fed262-8188-45ab-8d3d-21168f685e7c，未使用子代理。开发者报告领域6/6、资产3/3、单测23/23、story37/37；master未据此接受，也尚未独立重跑全套。

master直接用临时目录复制温茶资源，真实buildDesktopPresentation加载后删除该临时root的idle/frame-00.png，再调用相同root的isOutfitAssetAvailable/buildDesktopPresentation。实际：before=ready、removedFrameExists=false、availableAfter=true、stateAfter=ready。违反素材不可用不能提交/冒充就绪的Expected，记POL-OUTFIT-004支撑FAIL。临时目录已在finally删除，未修改正式素材。原始输出见本线程exec chunk261dcb；摘要见evidence/s06l/master-cache-failure.json。

其他审查：基础/服装重复七动作装配与布局缓存，退回合并为小函数；领域状态构造重复与q缩写不利可读性，要求精简但不压行。补SQLite已穿写/待穿删除失败的真实事务回滚，及pending后接纳资格失效。availability严格布尔true；旧token和pending重启测试保留。开发中曾见取消当前衣装Expected不一致，最终开发者已经修正，不再登记为现存失败。

B接入另有几何风险：desktop子进程setContentSize后applyPosition仍按窗口左上角定位，两套显示计划脚锚不同，必须真实核查屏幕脚位，不能用各自锚点元数据宣称无跳动；尚未运行GUI，不记FAIL/PASS。

退回由单Claude CLI继续，句柄88549，输出/tmp/bayper-s06l-part-a-repair.json。生产和测试未接受，不提交本轮实现；完整Case003/005协调/007仍NOT_COVERED。修后master独立验证再决定A是否可进入B，A不替代整条业务接受。Polaris已要求副作用与实际结果核查，本次为实现/验收覆盖不足，无新skill矛盾，不机械修订skill。

## r167 Part A独立有限接受（2026-10-28）

88549返修已终态。master已逐段审查outfits全文件、资产差异、store组装和相关测试，独立执行全部unit + outfits + story五套件，**71/71、0 skipped、exit0**，变更五文件执行前后SHA一致。证据 `evidence/s06l/master-a-x6gk88ba/tests.log`、`result.json`，命令完整存于result。r166缓存FAIL原件保留，新的同root消失/恢复反例已执行通过。

|Case|本批证据|聚合状态|
|---|---|---|
|001|SQLite正式归属、只读、待穿/提交、非空记忆完整快照通过|领域通过，GUI未覆盖|
|002|重复/基础取消/回退、重开已穿与昵称/记忆通过|领域通过，实际帧重启未覆盖|
|003|未运行聊天/休息/日常换装|NOT_COVERED|
|004|未拥有/错误owner/未发布/素材false或undefined/缓存帧消失与恢复/已穿身份保留通过|领域与资产通过，主进程/GUI不可用路径未覆盖|
|005|旧token、pending重开、base重复token稳定、两处SQLite写失败回滚/重试、接纳资格构造消失通过|领域通过，暂停/超时/换人等真实协调未覆盖|
|006|构造名单外探索角色保存选择不动名单/当前/探索通过|领域通过，真实再次出现未覆盖|
|007|候选三个动作映射和真实资源路径/锚点数值通过|实际连续播放/屏幕脚位未覆盖，不记整体PASS|

代码职责审查：outfits346行，已合并资格检查/引用视图/待穿写入，名称清楚；资产净增171行，七动作加载共用一个私有函数，含缓存真实性与固定ID路由；store窄组装11行。总规模高于最初信号，但持久化/失效身份/安全提交/同衣装能力和测试注入均为当前需求，没有通用引擎，不再机械按行数返工。候选标记保持，正式目录未改。

测试边界：真实SQLite，时间/作者目录/部分素材可用性回调为fixture；资格消失分支在隔离库关闭FK构造异常，不代表支持取消接纳；业务无新API。临时库和复制素材目录均由teardown清理，无GUI/Herdr/真实模型进程。接受仅A内部能力，正式整组未接受；继续B的用户选择→真实节点→桌面帧→重启。Polaris流程支持本轮反例/返修/独立审查，未发现新skill矛盾。

## r168 B进行中的素材初看

Codex直接查看基础idle-pixel-v2/frame-00.png与温茶outfits/warm-tea/animations/idle-pixel-v2/frame-00.png。静态可识别同一角色的紫黑短发、琥珀眼、猫耳/尾与女仆头饰，温茶有围裙方口袋；但不能据此判断连续动作身份/比例稳定。温茶该帧前臂明显露出，与母版文字要求的烟紫长袖仍需逐帧核对，正式素材发布不接受为完成。这里只是原尺寸静态初看，不是128pt桌面或全动画验收，不阻止隔离候选用来验证换装技术链路。

## r169 B中途纠偏

master在实际diff中发现attemptOutfitCommit进入等待前后均以presentation.resting或assetState!=ready直接return，违反已批准的休息/睡眠安全节点与失效衣装选回基础的路径；且只处理current角色，没有名单外pending推进。先中断67920/CLI4576，确认exit0但结果terminal_reason=aborted_streaming、is_error=true；这是master方向纠偏，不能算实现成功或环境故障。未改写任何代码。

修正要求：休息/睡眠复用waitForPresentationBoundary的rest-settled/rest-sleep-boundary，不把resting当禁换条件；当前素材不可用没有需完成的可见动作时允许校验新目标后恢复基础，不把ready前提设为恢复障碍；名单外/探索不强拉上桌，安全应用自身意图；暂停/聊天保留待穿、恢复推进。只允许一个节点等待，无立即do/while重试，外部既有心跳/结束事件驱动下一次。超时保留旧穿，旧token/换人回调不得提交。

下一派发先修核心协调并验证这些必需路径，再完成角色概览与001/002/007正常GUI。完整003/005/006测试可按原计划分批，但不能将实现本身设计成不支持这些状态。Expected未改；当前未运行GUI，不把阅读发现虚称实际GUI失败。现行Polaris要求一致性审查已足以处理，此处为执行不遵循，无新skill修订。
