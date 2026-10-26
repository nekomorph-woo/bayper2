# 凛坐下动作候选

Codex内置imagegen制作，参考master-pixel-v2；D01站立到坐下，8帧4×2，非循环。两轮生成均结束，未导出、未播放、未批准生产。坐姿不能使用按每帧身高重新fit的方式，否则坐下后会被放大；站立脚锚自动检测也不能未经检查用于裙摆/坐姿接地锚。

v1已保存sit-pixel-v1.png，原件exec-fc7b9c04-f835-4ddf-9424-99622581d5dc.png。1536×1024 RGBA，alpha范围0～254；工具预览的深底不能当不透明结论。实际帧序可辨，但首行站姿超过512行分界，耳部也过于接近顶边，不能直接等分切帧。当前仅原图，无导出/播放通过结论。

## v2版式修正提示词

Repair ONLY the layout of this 8-frame Rin stand-to-sit sprite sheet, preserving the eight poses/order, face, hair, maid outfit, chunky pixel style. EXACT canvas1536x1024, 4 columns and 2 rows of equal384x512 cells. Current top row is too tall and crosses the y512 boundary. UNIFORMLY reduce ALL eight characters to 70 percent of their current scale, same scaling for every pose. Put feet or seated contact point at y450 within each cell (row1 absolute450, row2 absolute962). Stand pose head must start below y80. Entire figure and tail inside its own cell, at least40px left/right margins, no cropping. Seated head naturally lower than standing, do not independently fit seated poses to fill height. Keep eight progressive poses unchanged, no new props, no duplicate limbs. True transparent background, absolutely no glow or painted gradient or floor shadow. Do not draw the cell grid or labels.

## v1完整提示词

Create an 8-frame NONLOOPING stand-to-sit animation sprite sheet of EXACT Rin from the reference. Preserve short black-purple bob, amber eyes, black cat ears with pink interiors, cream maid headband, burgundy neck ribbon, black short-sleeve dress with cream apron, opaque dark tights, gold buckle shoes, single curved black tail. Same compact anime proportions and coarse readable pixel clusters as reference. 4 columns x 2 rows equal cells on a 1536x1024 transparent canvas, reading left to right then next row. Fixed camera, three-quarter-front view, same character scale in all frames. Ground baseline at local y470 in every cell. Frame1 neutral standing reference. Frame2 lowers hands toward skirt and bends knees slightly. Frame3 bends knees further, torso lowering. Frame4 gently crouches, holds apron modestly over knees. Frame5 lowers hips to ground, knees together angled a little to viewer right. Frame6 settles into a modest side-sitting pose, skirt fully covers thighs, feet in front visible. Frame7 hands rest on lap, shoulders settle. Frame8 relaxed seated, same pose as7, attentive soft face. Natural decreasing body height, do NOT rescale the seated character taller to fill the cell. No chair or floor object. Whole silhouette including tail and shoes stays inside each cell with 35px side margins. Keep face, outfit details and anatomy consistent. Clear progressive movement, not eight unrelated poses. Hard square pixel edges and few shade bands, no fine texture, no smooth painting, no glow. Actual transparent background; ignore dark reference backdrop. No shadow, labels, numbers, borders or grid. Fully clothed, calm restful motion, no exposed underwear.

## v2结果与后续边界

v2原件exec-a8003338-d769-4e03-b33b-99950fef0c0d.png，已保存sit-pixel-v2.png。1536×1024 RGBA、alpha0～254。按4×2等分并以alpha>16只读核对：第0～3格bbox底边均达到512，第4/6/7格bbox顶边为0，说明首行像素仍跨界，判定等分切帧FAIL。版式比v1改善但没有满足安全留白，未运行切帧、不使用程序裁掉脚或逐帧fit掩盖错误。

坐姿设计保持同角色黑裙/围裙、两耳单尾，基本站→屈膝→侧坐可辨；服装褶皱/第4到5姿势衔接及实际128pt像素可读性尚未验。下一轮需要更明确均匀网格或重排源图后再做接地锚检查；不能直接沿用站立脚带锚。此次仅保存可追溯失败候选，不据此通过D01、休息状态或正式素材库。生成使用Codex内置imagegen，无外部计费API，无项目代码代写。

## 小尺寸播放器独立验收（2026-10-27）

此前等分失败由显式区域与接地锚导出解决，见 `.hapilon/polaris/Bayper完整交付/s07-explicit-regions-plan.md` 与 `tools/sprite-pipeline/data/rin-sit-v2-regions.json`；没有裁掉角色或逐帧拉伸。Codex独占GUI以既有verify-player导入sit-pixel-v2，display-scale=128/298；证据`tools/sprite-pipeline/evidence/codex-rin-sit-v2-small.*`。8帧一次性动作停止于末帧、重播、暂停、逐帧、0.25倍速度、背景、导航拦截全部通过，退出0且自建目录删除，没有未覆盖播放项。画布实际137.4375×164.9375 CSS点，仍含透明留白；保持中性站姿参照比例，坐下不重新放大。

Codex检查深浅背景实际第5帧截图：坐姿可辨、猫耳尾与双鞋完整，未看到白边底板或裁切，角色身份可辨。这是自动播放加关键帧视觉审查，不是人工连续体验；与idle的转入转出、休息业务和中断恢复尚待集成，保持候选。
