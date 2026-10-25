# 澄新版像素待机候选

2026-10-26，Codex内置imagegen，以master-pixel-v1为身份及画风参考。保持银白短发、蓝灰眼、垂兔耳、蓝裙/奶油围裙与圆兔尾；8帧4×2眨眼待机。

## v1：拒绝导入

原件exec-b9423d8a-b7e1-4d6f-a15d-6469eb95175e.png原样保存idle-pixel-v1.png。既有sprite_pipeline检测第0格底边触边并拒绝，未放宽阈值。日志为.hapilon/polaris/Bayper完整交付/evidence/cheng-idle-pixel-v1-export.log。没有合格导出，不能用于生产。

```text
Create a production candidate IDLE animation sprite sheet of exactly Cheng from the reference. Preserve silver-white bob hair, blue-gray eyes, TWO long lop rabbit ears with pale pink insides, two navy bows with ivory flower ornaments, ivory maid headband, slate blue maid dress and cream apron, navy neckbow, cream tights, navy Mary Jane shoes, ONE small round white rabbit tail. Calm observant closed-mouth smile, compact approximately three-head-tall proportions. EIGHT frames, exactly FOUR columns by TWO rows, equal cells in reading order. Virtual cell160x240, entire character INCLUDING long ear tips at most110 wide and175 high, centered with generous transparent gaps within EACH cell, fixed camera/scale/feet baseline. Gentle blink cycle open/open/open/half/closed/half/open/open, frame8 identical to1. Arms relaxed fixed, only tiny breath of one logical pixel; no waving or head turns. Consistent bold square pixel clusters, sharp stepped outline, broad hair masses and three flat shades per material, no fine dithering/gradients/smoothing. CRITICAL actual transparent RGBA background, NO halo/glow/haze/black backdrop/drop shadow/floor; reference surrounding glow must NOT be reproduced. No grid, text, numbers, scenery or props. Do not crop ears/shoes, every frame fully inside equal cell. This will be cut to equal cells and displayed with the entire body max128pt; preserve face and silhouette readability. Build one coherent loop, not eight independently redesigned illustrations.
```

## v2：候选导出，未播放验收

原件exec-52bc639d-849e-4959-b0df-28d4f25dcaa8.png保存idle-pixel-v2.png，增加每格留白。使用既有工具导出8帧256×384、neutral-height298、统一缩放0.866279，元数据在animations/idle-pixel-v2/manifest.json。Codex查看浅棋盘contact sheet：耳尾鞋完整，眨眼顺序可辨，未见原始预览中的大范围背景光晕；各帧脸部与脚部仍有微小差异。只接受继续播放检查，不声称循环自然或像素网格严格统一，不替换生产。128pt实际播放等待GUI独占任务结束。

```text
Edit this Cheng eight-frame idle sprite sheet. Keep exact character identity and eight-frame blink action and pixel art. REQUIRED LAYOUT FIX: reduce EVERY entire figure uniformly to 65 percent of its current size around each cell center. Leave very large EMPTY fully transparent padding above/below/left/right INSIDE each of the 4 columns by 2 rows equal cells. All long ears and BOTH shoes must be comfortably inside each cell, at least 40 actual output pixels below each shoe baseline and above ear tips. Do not only move feet or crop ears. Grid exactly4x2, no borders/text. Same sprite scale and foot baseline relative to each cell, first and last neutral identical. Preserve crisp pixel clusters, white bob, blue eyes, long lop rabbit ears, navy maid dress/cream apron and tights, one white round tail. True transparent alpha background with ZERO glow/haze/shadows/background pixels, all negative space entirely clear. Reference has overly tight cell height; correct that, not character design. No smoothing or painterly changes.
```

导出命令：

```sh
python3 tools/sprite-pipeline/sprite_pipeline.py --source assets/characters/cheng/source/idle-pixel-v2.png --columns 4 --rows 2 --frame-size 256x384 --neutral-height 298 --output assets/characters/cheng/animations/idle-pixel-v2
```
