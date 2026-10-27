# S07 E03 欣喜动作候选导入与审查

2026-10-28，Codex master受托批准。父级S07/S05，来源PRD animation-plan.md的E03及state-and-rhythm.md的工作结束短反应。目标是为真实finished事件提供符合凛设定的短反应，先核素材，再接业务；本片不替代完整24+12语义或其他角色验收。

## 本片范围

Codex已生成assets/characters/rin/source/happy-pixel-v4.png，源图与母版、STYLE.md、happy-pixel-notes.md是输入。Claude Code复用tools/sprite-pipeline现有入口进行切帧/对齐，不重绘、不新增框架或依赖、不改源图、不自行发布，不调用其他Agent。允许新产物assets/characters/rin/animations/happy-pixel-v4/；仅确实需要显式区域时增加tools/sprite-pipeline/data/rin-happy-v4-regions.json。工具代码若遇真实问题先报告，由master确认最小修复范围；禁止散放新脚本。

4列2行8帧，统一256×384制作画布，站姿中性高度参考298，脚锚一致；初始时长250/120/180/250/350/180/160/300ms、非循环。这是master待体验调整的节奏，不把毫秒值视为用户亲自确认。若统一缩放越界或脚锚受尾巴污染，保留失败并反馈，不逐帧变形/自动裁切。保持alpha原值；禁止提高阈值抹去耳尖或头发来凑干净。

## 验收契约 v1

| ID | Given / When | Expected / Oracle |
|---|---|---|
|POL-HAPPY-ASSET-001|固定v4源图，经现有pipeline导入|源SHA不变，8帧完整，无触边/跨格，无逐帧变比例，manifest记录源/区域/缩放/锚/时长；透明不是预览黑底推断。以实际alpha、bbox、源/产物对照检查。|
|POL-HAPPY-ASSET-002|实际Electron审查播放器非循环播放/暂停/慢放/重播|依次抬手、微笑、回落，末帧停止；慢放、逐帧及背景切换真实可用，临时数据和进程清理。复用verify-player，不把脚本成功当视觉通过。|
|POL-HAPPY-ASSET-003|同idle的统一128pt本体比例，深浅背景与逐帧/时间序列|身份/服装/像素簇稳定，双脚不漂移、无裁切/明显光晕或身体半透明闪变，首尾可接站姿；坐姿不放大。Codex查看实际截图/序列并记录方法局限，未取得人类体验不声称取得。|

当001/002通过但003失败，保留候选并返修图像，不接生产。通过后另按真实业务Case接finished事件：通知必达且独立、以事件身份避免重复演出、原动作可恢复、聊天/休息不被无故打断、不额外扣数值或调用模型；本片尚未证明这些运行时行为。

证据在tools/sprite-pipeline/evidence/本轮新唯一目录，工具自包含；Polaris记录只引用该证据，原图不复制到流程目录。Claude报告命令、真实exit、产物路径和未覆盖项；Codex独立审查后负责文档、版本与snap。单个CLI串行接当前记忆诊断，不抢占在途任务。
