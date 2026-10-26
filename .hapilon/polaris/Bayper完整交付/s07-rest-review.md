# S07 坐下动作统一画布验收

2026-10-27，Codex。CLI43194仅用既有sprite-pipeline导出sit-pixel-v2-canvas256，未修改工具/源图/regions/运行代码。原候选320×384已小尺寸通过，本轮新256×384与idle/wave/stretch共画布、共地面(128,376)。padding2、neutral-height298、nearest、8帧非循环和原时长保持；8帧相对旧版均纯平移(-32,+6)，没有重新fit、裁切或改变图像内容。

证据tools/sprite-pipeline/evidence/s07-rest-align：verify.json逐帧参数/alpha预算、compare-320-shift.json、前后SHA与导出日志。首次外层zsh误用只读变量status出错但导出已成功；再次干净调用exit0、两份产物逐字节一致，原错误保留，不将包装错误当导出验证成功。

Codex独占播放器48702 exit0，verify-player采用scale=128/314=0.4076433121，以四动作并集215×314为尺寸基准。未采用仅按中性身高128/298放大（这样并集高度134.87pt超目标）。新播放器证据codex-player.json及深浅截图：8帧完整播放后停末帧、重播、暂停、逐帧、0.25倍、背景切换、导航限制、退出/临时目录清理全部通过。Codex查看全帧表与实际小尺寸第5帧深浅截图，耳尾、围裙、手脚清楚，未见边缘裁切。

锚点不等于最低可见像素：坐姿鞋/裙摆/尾部部分像素低于地面线最多5源像素（约2pt），完整保留；所有帧源锚映射一致，不通过裁内容伪造齐底。最小底部安全余量2px。此差异须在idle→sit→静坐及退出的正式衔接中继续观察，不能仅因manifest锚一致就宣布无跳姿。

受托接受统一画布候选与小尺寸播放器阶段。仍未接入正式rest状态、跨动作过渡/中断或用户人工体验；sit末帧静坐不能冒称困倦/睡眠动画已完成。后续desktop-assets读取需要识别output_ground_anchor与原output_foot_anchor的不同字段，仍应检查真实共地面，不取消footStable约束。
