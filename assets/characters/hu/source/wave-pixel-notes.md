# 琥珀新版像素招呼候选

2026-10-26，Codex内置imagegen生成，参考master-pixel-v2。下列均为候选，不替换生产。GUI当前由S08a占用，尚未播放验收。

## v1 拒绝

exec-95e774d6-d9cf-489f-bb6c-b91996218d2d，保存wave-pixel-v1.png。8帧中手臂左右互换，出现动作线，连续性不合格，不导出。

```text
Create a coherent 8-frame greeting animation spritesheet of EXACT Hu from reference: chestnut curly twin tails, amber eyes, two cat ears, olive bows and small ivory flowers, ivory maid headband, olive maid dress, ivory apron, brown neck bow with round gold center, ivory socks, brown boots, ONE chestnut curled tail on viewer-right. Match chunky stepped pixel art and compact approximately 3-head proportions. Exactly FOUR columns by TWO rows of equal-sized cells, generous transparent padding inside EVERY cell. Virtual cell160x240; character occupies at most110x175 centered with at least25px horizontal and30px vertical clear margin, tail and waving fingers never touch edges. No grid lines/text/numbers. Fixed frontal camera, feet planted on identical baseline, consistent face/head/body scale and costume details. Sequence reading order: 1 relaxed neutral arms down;2 viewer-left forearm lifts halfway;3 viewer-left hand beside cheek palm out;4 small outward wrist wave;5 inward wrist wave;6 outward wrist wave;7 hand lowering halfway;8 exact neutral pose as frame1. Other arm stays down. Warm small smile and open amber eyes throughout. Hand moves, not torso translation. Hair and tail largely steady. Use bold square pixel clusters, limited colors with 3-tone materials, no anti-aliasing, no gradient/airbrush/dithering. Actual RGBA transparency, no colored background, halo, floor shadow, props or scenery. Reference is identity/style, generate fullbody small sprites not portrait crops.
```

## v2 拒绝

exec-86f1557c-a3fd-4dd9-8592-a0e3cb62df20，保存wave-pixel-v2.png。手臂方向修正，但多帧尾巴消失，工具实际报第0格右侧触边。保留evidence/hu-wave-pixel-v2-export.log，不降低检查阈值。

```text
Regenerate Hu's 8 frame greeting sheet, with strict corrections. Reference 1 is correct identity, reference2 failed because the raised hand switched sides. ALL frames use ONLY the hand on the LEFT SIDE OF THE IMAGE (her anatomical right) to wave. The hand on the RIGHT SIDE OF THE IMAGE stays hanging beside skirt in ALL eight frames. Never mirror or swap arms. NO motion strokes or markings. Exactly4columns x2rows equal cells. Much smaller figures centered in cells: visible body and tail must use no more than65% of cell width and70% of cell height, large clear transparent gaps on every side. Feet same height within each cell, same scale, fullbody all8. Sequence:1 arms down;2 left-image hand halfway raised;3 left-image palm beside cheek;4 same wrist tilts left;5 same wrist tilts right;6 same wrist tilts left;7 left-image hand lowering;8 arms down exactly as1. One fixed head angle, same open eyes and small smile, hair/costume/boots/tail unchanged. Hu identity chestnut curly twintails, amber eyes, cat ears, olive bows white flowers, white headband, olive maid dress ivory apron, brown bow and boots ivory socks, ONE tail on image-right. Compact3-head proportions and chunky visible square pixel clusters, stepped outlines, no smoothing, gradients, texture or dithering. Actual transparent RGBA background. No glow or shadows or text. Sheet only, no decorative background. This must be a single coherent frame sequence, not pose variations.
```

## v3 导出候选，未播放

exec-4f7e3ae8-3704-4ba7-b0fe-c464b838181f，保存wave-pixel-v3.png。改为2×2四帧短招呼以核实固定手臂/尾巴连续性，不宣称替代全部动作范围。使用既有Claude实现的sprite_pipeline，neutral-height298。256×384画布因安全留边不足拒绝，保留hu-wave-pixel-v3-export.log；增大制作画布为320×384，保持身高与统一缩放后导出成功，hu-wave-pixel-v3-wide-export.log。不得用缩小角色身高掩盖裁剪。时序180/220/200/260ms，no-loop，仅初始试样节奏。

Codex查看浅棋盘contact sheet：所有帧的耳尾鞋完整，头脸和绿裙身份基本一致，同一手招呼；第三帧更像伸手招呼，第四帧脸/发/尾与首帧有细微差异。下一步检查128pt实际播放、idle→wave→idle衔接、统一尺度与锚点；若跳变明显返修，不能单凭导出成功接入正式资源。较宽透明画布不改变角色本体128×128pt范围，不扩大鼠标占用。

```text
SQUARE 1024x1024 transparent spritesheet, exactly TWO columns TWO rows, FOUR spacious square cells. Generate four SMALL full-body pixel sprites of reference Hu for a brief friendly greeting. Each figure INCLUDING tail and raised hand occupies only central60% width and70% height of its square cell, with large empty margins. All4 have exactly same head/body size, costume, hair curls and one chestnut tail extending on viewer-right in EVERY FRAME, fully visible and same fixed curved shape. Figure1 neutral botharmsdown. Figure2 ONLY hand on imageLEFT rises beside cheek palm out. Figure3 SAME imageLEFT hand gently tilts outward, imageRIGHT arm still down. Figure4 exactly neutral pose1. Feet stayplanted same baseline. Warm small smile sameface. Chestnut curlytwintails, amber eyes, two catears, olivebows and whiteflowers, ivory maidheadband, olive dress/ivoryapron, brown bow, ivorysocks/brownboots. 3-head compact proportions, chunky squares and stepped pixel outlines like reference, no dithering/gradients/smoothing. No motion lines, no text/number/grid/shadow/glow. True alpha background. IMPORTANT tail must remain fullyvisible to RIGHT of skirt in all four frames and fit fully within its own cell. This is ONE consistent character animated in place, not four different drawings.
```
