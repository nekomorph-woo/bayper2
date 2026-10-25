# 琥珀新版像素待机候选

## v2（2026-10-26，候选导出）

Codex内置imagegen编辑v1以增加单格留白；原件exec-498e1a5d-cda9-409e-a6b2-ec9202ee9f75.png保存idle-pixel-v2.png。使用既有sprite_pipeline成功导出8帧256×384、统一缩放0.659292、中性身高298，源文件哈希与脚锚见animations/idle-pixel-v2/manifest.json。原始预览的边缘杂色没有出现在导出的浅棋盘对照中；Codex实际查看contact-sheet-light，耳尾鞋完整、身份基本稳定。嘴部仍为开口微笑，首尾面部有小差异，需在128pt播放判断循环感，不冒称无缝或用户验收。其后已串行完成下文播放器检查。未接入生产。

```text
Regenerate this exact Hu idle animation sheet with ONE required correction: much larger clear transparent margins WITHIN EVERY cell so no tail, hair, ears or shoes touch a cell edge. Grid exactly4columns x2rows. Each virtual cell160x240, visible character width at most110 and height at most175; CENTER each character in its cell with at least25 logical pixels clear to left/right and30 above/below. Large transparent gaps between characters, no grids. Preserve identity, chunky square pixels, olive/cream maid costume, chestnut curly twin tails, amber eyes, one tail and same3-head proportions. Do not cut or shrink just the tail; scale whole figure uniformly for all8 frames. Gentle blink cycle across8 frames: open/open/open/half/closed/half/open/open. Same warm smile throughout and feet planted on exactlysame baseline, relaxed arms fixed. Frame8 should match1, no body/head scale variations. Actual transparent background, no glow/shadow/scenery, no text, no anti-aliasing or dense dithering. Four equally spaced columns and two equally spaced rows. This is an animation spritesheet that will be cut into EQUAL cells, so all clear padding is essential. Reference shows identity and action, not required tight spacing.
```

## v1（2026-10-26，拒绝导入）

Codex内置imagegen，参考master-pixel-v2，原件exec-4132905f-2aff-40f4-9a8e-3c43c16f6da7.png保存idle-pixel-v1.png。4×2八帧。Codex目视右侧尾巴留白不足；实际运行既有sprite_pipeline（256×384、neutral-height298）退出报错：第0格右侧触边，可能跨格。日志见.hapilon/polaris/Bayper完整交付/evidence/hu-idle-pixel-v1-export.log。拒绝导出，不降低检查阈值、不裁掉尾巴；后续重新生成更充分留白。

```text
Create production candidate idle animation sprite sheet for EXACT Hu character in reference. Preserve the reference's chunky square pixel grid and stepped outlines, chestnut twin-tail curls, amber eyes, olive flower ribbons, cream maid headband, olive maid dress and ivory apron, brown bow, cream socks, brown boots, ONE chestnut tail viewer-right. Exactly EIGHT frames in FOUR columns TWO rows, equal cells, reading order. Virtual logical canvas 512x384, cells128x192, body about100x150 each; crisp nearest-neighbor enlarged pixel art. Same camera, same scale, same calm neutral standing pose and same planted feet baseline in every cell. Keep head/body approximately3-head compact proportion. Gentle breathing and blink only: 1 eyes open relaxed warm CLOSED smile; 2 chest rises one logical pixel; 3 breath apex; 4 eyes half-closed; 5 eyes closed; 6 half-open; 7 eyes open settling; 8 identical to1 for seamless loop. Arms relaxed at sides throughout; do not wave, change hands or turn head. Hair curls and flower counts stable. Full ears boots tail contained in every cell with generous transparent margin; no frame may touch neighboring cell. ACTUAL transparent RGBA background, no glow, haze, floor shadow, text, grid, numbering or props. No gradients, smoothing, fine strands, dithering or painterly detail; preserve bold clusters from reference. Build a coherent animation, not independent illustrations. Ensure most silhouette and face remain fixed between frames.
```

## v2实际播放器检查

Codex独立运行verify-player，display-scale=128/299（0.4280936455），本体最大高约128pt，制作画布保持256×384。正常循环、暂停、逐帧、0.25×、深浅背景、导航限制和退出清理均通过；证据tools/sprite-pipeline/evidence/codex-hu-pixel-idle-v2-128pt.json及配套截图/日志。Codex查看实际深浅两图，脸/发色/绿裙/耳尾鞋可辨，未见明显背景光晕。该结果证明候选导入与播放，不证明首尾视觉无缝或全部自然度；未替换生产Hu旧idle-v1。无本轮播放器/临时目录残留。
