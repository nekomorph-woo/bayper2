# 多动作与非Herdr事件最小实测合同

2026-10-25。需求来源：用户授权独立验证多动作切换、非Herdr事件、中断恢复；素材由Codex生成、代码由Claude Code实施、Codex审查验收并清理。不进入Bayper产品设计。本文件只规定实验规则，不是产品动作/优先级设计。

样本：沿用Codex生成的六帧idle，新增同一小猫的wave四帧、alert四帧。idle循环，每帧150ms；wave一次，每帧600ms，总2400ms；alert一次，时长[200,250,250,200]ms，总900ms。JSON记录图集位置和各帧时长，播放器不得假定所有动作帧数相同。

固定调度：idle下wave/alert立即开始。wave被alert打断时，保存wave精确playhead（含帧内时间）；alert播完从该playhead继续，wave完成回idle。alert期间wave和重复alert均丢弃，不排队、不延长、不覆盖已保存进度；重复wave不重启当前wave。alert从idle开始时完成回idle起点。reset取消悬挂动作及尚未触发的计时器。播放时间用实际共用控制器推进，不使用每段旧setTimeout抢回状态。

| ID | Given / When | Expected | Oracle / Execution Boundary |
| --- | --- | --- | --- |
| ACT-01 | 真实素材读取、切帧并播放三个clip | 6/4/4帧非空，位置/时长来自metadata；动作可辨、身份要素可检查 | PNG/JSON与真实Canvas画面；不以文件存在等同观感合格 |
| ACT-02 | idle中通过画布点击或W键触发wave | wave只播一次，2400ms后回idle；alert按钮/A键也能独立触发并返回 | 共用controller的Node固定时钟检查+真实浏览器事件/截图 |
| ACT-03 | wave推进900ms后触发alert，再推进900ms | alert完整播一次；恢复wave playhead恰为900ms，不从0重播、不跳回idle；剩余1500ms完成 | 实际控制器固定时钟断言；浏览器interrupt/resume日志与画面交叉验证 |
| ACT-04 | alert中再发wave/alert | 忽略低优先级与重复请求；不覆盖保存进度、不延长alert；结束无旧完成回调篡改状态 | 实际controller断言+浏览器按钮连续触发；无模拟渲染器 |
| ACT-05 | 安排真实1秒计时器，期间播放wave | 非Herdr timer触发alert并恢复wave；reset后待触发timer取消 | 浏览器真实setTimeout及可见日志，非直接调用内部trigger冒充事件 |
| ACT-06 | reset或跨多个动作边界的一次时间推进 | reset清空suspended；一次大dt正确处理alert→wave→idle，不残留旧动作 | 共用controller的独立边界检查；浏览器reset后等待复核 |
| ACT-07 | Codex看三个动作及衔接 | 记录变形/缩放/脚底跳动与接缝；区分调度正确与素材质量，不冒充人工体验 | 原始图、接触图、实际Canvas截图；质量不足保留FAIL/未确认 |
| ACT-08 | 完成 | 保留素材/提示词/处理与测试/报告，停止本次HTTP与测试页 | PID/端口与Git检查；不动系统Dock/全屏设置，不连接Herdr |

范围research/action-spike/。预计process.py、controller.mjs、controller.test.mjs、index.html四个清楚小文件，总规模约350–500行，必要增长需说明，不压行。Python标准库+现有Pillow、Node内置assert；无新框架/依赖安装，无通用状态机引擎。固定时钟只验证实际控制器，不能代替真实浏览器播放；未覆盖长时间后台/系统休眠、嵌套多级打断或任意业务状态图。
