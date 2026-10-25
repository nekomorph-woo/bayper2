# 琥珀轻提醒像素动作候选

2026-10-26，Codex Desktop内置imagegen，参考master-pixel-v2；原件exec-c9f968b9-ba64-45ef-b3aa-ebc744183114.png，已原样保存attention-pixel-v1.png。八帧4×2，仅画面左手抬起食指后放下，保持猫耳、双卷发、橄榄裙和画面右侧单尾。

既有Claude实现的sprite_pipeline导出8帧，320×384制作画布、neutral-height298，共用缩放0.616977；时序180/110/120/180/220/120/110/220ms，no-loop。日志evidence/hu-attention-pixel-v1-export.log。制作画布不等于桌面本体，目标仍128×128pt等比适配。

Codex查看源图及浅棋盘contact sheet：耳尾鞋和指尖均完整，固定同手抬起，身份色块基本连续。尚需128pt实际播放、与idle共享几何/脚锚及首尾脸部/发丝细微变化审查，当前未接正式资源，不作为通知链路或全部动作验收通过。

## 完整提示词

```text
Use case: identity-preserve. Generate ONE transparent RGBA spritesheet of the reference Hu catgirl maid making a gentle polite attention gesture. Exactly FOUR columns by TWO rows, eight equal cells, no grid or text. Same compact roughly 3-head anime proportions and chunky square pixel clusters as reference; chestnut curled twin tails, amber eyes, two cat ears, ivory maid headband, olive bows with white flowers, olive dress ivory apron, dark brown chest bow, ivory socks, brown boots gold buckles, ONE chestnut curled tail fully visible on image-right in EVERY frame. Strict fixed front view and planted feet, same scale, head/face/hair/costume/tail unchanged. Only arm on LEFT SIDE OF IMAGE moves; image-right arm stays lowered all frames. 1 neutral arms down;2 left-image forearm rises slightly;3 left-image hand at chest;4 left-image index finger raised gently beside shoulder;5 holds same pose with attentive kind eyes;6 hand lowers to chest;7 almost down;8 exact neutral pose1. No arm swapping, no mirrored character. Each full figure INCLUDING tail/gesture occupies no more than 65% cell width and 70% cell height, generous transparent margin all sides. Entire ears, hair, tail and boots fit inside own cell. Clear pixel steps, 3-tone flat materials, no anti-aliasing/gradients/dithering/noise/glow/shadows. Real alpha background, no props, exclamation mark, motion marks or scene. One coherent animation sequence, not eight different character designs.
```
