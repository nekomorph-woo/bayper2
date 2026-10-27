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

## 制作事实：v2 切帧导出与播放检查（Claude Code，2026-10-28）

- 使用现有 `tools/sprite-pipeline` 导出，未改工具代码。源图 SHA-256
  `4942b685e1e334cd2b4e8ca30c9ae3e31d8664d839b5241aa81e2f5354a87db0`，导出前后不变。
- 实测上行 bbox 高 317、下行 321，两行在各自512px单元格内的实际接地相差3源像素。显式 regions 上行 `y100..470`、
  下行 `y600..980`；`anchor.x` 取顶部 40% 头/耳/发顶轮廓带中点，`anchor.y` 取每帧最低像素下边界
  （上行 445、下行绝对 954）。配置见 `tools/sprite-pipeline/data/rin-drowsy-v2-regions.json`。
- 导出 256×384、padding 8、地面 `(128,376)`；`--neutral-height 223` 以首帧源高 317 定唯一缩放
  `0.703470`，首帧输出高 223，下行 321 高帧同 scale 输出 226。八帧共用比例，未逐帧 fit。
- 非循环八帧，时长 400/240/220/420/300/240/300/500ms；产物在
  `assets/characters/rin/animations/drowsy-pixel-v2-canvas256/`。
- 静态检查：八帧透明背景、无 1..16 残留、最低边距 8px（底边）、无触边；atlas 拼回逐字节一致；
  头部带输出中点 128.0～128.5。自动播放器以 `display-scale=0.40764331210191085`（128/314）通过
  非循环停末帧、重放、暂停、逐帧、0.25×、深浅背景、导航拦截与清理，`player-verify.json`。
- 对照 sit 末帧与 sleep 首帧：困倦首/末帧整体高 223/226，sit 223、sleep 223；头部带高 89～90，
  sit 89、sleep 89；头部带宽 165～169，sit 163、sleep 175；困倦与 sleep 最低像素同在 375 行，
  sit 既有导出在 377 行（约 2px 差异，未改 sit）。以上为静态数值/目视代理，不是人类体验或正式
  衔接验收；产物仍是候选，未接生产路由或发布。

完整命令、SHA、逐帧数据与边界见
`tools/sprite-pipeline/evidence/s07-drowsy-v2/report.md` 与 `checks.json`。


## Codex独立检查（2026-10-28）

master句柄81231真实Electron验证exit0，证据tools/sprite-pipeline/evidence/master-drowsy-of9iPGOZ/。源、配置与12项导出SHA核对一致，前后SHA不变；8帧一次性停止/重播、暂停/逐帧、0.25倍、导航边界和清理通过。实际画布104.34375×156.53125 CSS点，缩放128/314沿用站姿统一比例；坐姿本体约91～92pt高，不按坐姿重新放大到128pt。

Codex查看实际小尺寸深浅第5帧、全帧表与sit07→drowsy00..07→sleep00对照：整体身份、服饰、手部顺序可辨；困倦首末高223/226，睡眠首帧223，sit最低像素与困倦相差2源px（不到1pt）。睡眠头部带略宽，静态初审未见明显身份突变，但自动播放器与截图不能替代跨动作连续运行体验。受托接受POL-DROWSY-ASSET-001、002的已测导出/播放器范围；003静态初审有证据，正式切换和中断仍NOT_COVERED。未发布、未改生产路由。
