# 凛困倦候选制作记录

2026-10-28，Codex 使用会话内置 imagegen。对应现行动画规划 D03，作为 S07 正式动画目标的候选素材，尚未切帧、播放、接入或通过正式验收。依据 STYLE.md、角色母版 master-pixel-v2.png 与已批准坐姿 animations/sit-pixel-v2-canvas256/frame-07.png。AI 产物仅为位图，没有分层工程源。

## v1：动作候选与网格失败

原件 exec-c6d1915a-6683-4d6e-9a2b-0995649dc719.png 保存为 drowsy-pixel-v1.png。内置工具 transparent_background=true。实际 1536×1024 RGBA，alpha 范围 0～254，角点 alpha=0。逐格 alpha>16 包围框（格内坐标，右下为开区间）：

| 帧 | 包围框 |
|---|---|
| 0 | 32,79,384,495 |
| 1 | 33,77,384,495 |
| 2 | 0,77,381,495 |
| 3 | 27,77,372,495 |
| 4 | 32,46,384,464 |
| 5 | 0,45,384,462 |
| 6 | 0,46,384,463 |
| 7 | 0,46,371,463 |

动作顺序与猫耳、短发、女仆服等识别点初看成立，但多格轮廓触及分格边界，不接受等分切帧；保留失败原件。没有用裁切或逐帧拉伸掩盖问题。

完整提示词：

> Use case: identity-preserve. Create Bayper Rin D03 drowsy animation candidate sprite sheet. Image 1 fixes character identity, costume and chunky pixel style. Image 2 fixes the seated pose, camera and proportions; keep this seated silhouette. EXACTLY eight full-character frames arranged 4 columns by 2 rows, true transparent background, ideally 1536x1024 canvas, equal cells 384x512. Each character at same scale, centered x=192 within cell, seated baseline y=440, no silhouette wider than 260 or taller than 290 pixels, ample empty margins. Sequence left to right then next row: 1 calm seated eyes open hands together in lap; 2 eyelids droop head tilts down slightly; 3 right hand rises toward mouth; 4 small sleepy yawn discreetly covered by right hand, eyes closed; 5 yawn settles, hand still near mouth; 6 hand lowers; 7 both hands return to lap, eyes half closed; 8 seated head slightly lowered, eyes peacefully closed ready for sleep. Gentle single action, no exaggerated squash, no standing, no props or motion symbols. Preserve short dark-purple bob, amber eyes, black cat ears pink inner, cream maid headband, burgundy neck ribbon, dark dress ivory apron, dark tail curving to viewer right and grounded folded skirt. Restrained flat color ramps and clear square pixel clusters, crisp stepped contours, no smooth gradients, no painterly anti-aliased illustration. Preserve consistent face, head size, hair silhouette, ear and tail anatomy, apron seams and palette in every frame; only eyelids, mouth, hand pose and tiny head inclination change. All feet/skirt/tail fully inside own cell, no cropping/overlap, no floor/background/shadow/grid/labels/text. This is a production sprite candidate, not a decorative presentation board.

## v2：仅修正版式

参考 v1，原件 exec-62da6f48-831f-4e10-a8f8-c4ed2d904afe.png 保存为 drowsy-pixel-v2.png。实际 1536×1024 RGBA，alpha 0～254。上行四帧包围框均为 (73,128,341,445)；下行依次为 (73,121,343,442)、(73,121,342,442)、(73,121,342,442)、(73,121,341,442)。各格完整留白；实际宽高约268～270×317～321，并未严格满足提示词250×280，不能用提示词尺寸代替实际检查。

Codex 观看整图：打哈欠、抬手与收手顺序可辨，闭眼末姿可作为与睡眠衔接的候选。仍须检查同坐姿/睡眠的脸部尺度、头部锚点、手势跳跃、眼睛开合顺序与实际128pt连续播放；下行地面较上行差3源像素，切帧时显式对齐，禁止逐帧独立缩放。当前仅接受继续制作，不是正式 D03 PASS。

完整修订提示词：

> Repair ONLY sprite sheet spacing. Preserve exactly the eight pixel-art Rin drowsy poses and their order from the input, same character/costume/face/proportions, no redesign. All eight characters MUST be uniformly shrunk to approximately 65% of current size. Output transparent 1536x1024 with exact 4 columns x2 rows, cells384x512. Each complete seated character including tail occupies maximum250px width and280px height. Center each at cell x192, set bottom at cell y440, leaving at least60px clear empty space between each silhouette and left/right cell boundary. No overlap or clipped tails, no pixels touching cell boundaries. Absolutely uniform scale in all cells, no stretching. Keep chunky sharp pixel clusters with nearest-neighbor style edges, crisp square steps and flat color ramps. True transparent RGBA background, no opaque backdrop, no glow, shadows, checkerboard, labels or grid. Keep first frame alert seated, second drowsy, third hand raises, fourth covered yawn, fifth settling yawn, sixth lowering hand, seventh hands in lap half-closed eyes, eighth eyes closed. This is strictly spacing repair.

后续由 Claude Code 使用现有 sprite-pipeline 切帧、统一缩放对齐并播放；Codex 独立审查实际小尺寸、深浅背景及坐姿→困倦→睡眠衔接。无需增加活动/API频率，未授权本批更改生产动画路由。
