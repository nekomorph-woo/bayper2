# 澄像素提醒候选

2026-10-26，Codex内置imagegen，固定同一角色提醒手势；尚未生产接入或播放验收。当前候选attention-pixel-v3，4列2行8帧，320×384导出、neutral298、scale0.825485、时序180/110/120/180/220/120/110/220ms、no-loop。源哈希和脚锚见animations/attention-pixel-v3/manifest.json；使用既有Claude实现的tools/sprite-pipeline/sprite_pipeline.py，无改脚本。

## 迭代与证据

- v1参考master-pixel-v1，要求8格统一角色、仅IMAGE LEFT手抬至肩下伸指提醒、复位，三头身明确像素、两长垂耳完整，60%格宽/70%格高、透明。实际输出1774×887，不能被4×2整除，拒绝导出。原始exec-07cc904a-cf3d-42c9-8838-d6e948c6c964.png。
- v2仍参考母版，强调1536×1024全画布、384×512等格和大边距；实际抬手变为IMAGE RIGHT，且导出检查首格右边触界，未采用。原始exec-1afa2261-9650-4567-856f-fd96d198d7a9.png。
- v3改参考v1并要求保留原姿势、缩小人物并重新留边，完整提示词如下。原始exec-4c058cdf-1e9c-4eea-a482-353844d29c68.png，导出成功。Codex查看实际浅棋盘contact-sheet：透明背景、耳尖/鞋/尾完整，同一只IMAGE LEFT手抬起并收回；裙边/脸的细微差异仍需播放与idle衔接复验。

三个源文件均保留，不覆盖失败版本。导出日志在完整交付evidence/cheng-attention-pixel-v{1,2,3}-export.log。工具失败后被后续cat掩盖的shell退出码不能作为PASS，依据实际日志；只有v3产生完整导出。GUI目前由设置开发独占，本轮未播放、未宣称128pt实际效果通过。画布尺寸不等于本体；按本体约128×128pt等比适配。

## v3完整提示词

Repair this eight-frame pixel character animation into a regular TRANSPARENT spritesheet. Preserve the eight existing poses exactly, same image-left hand rises and lowers, same character, costume, both complete ears and tail, do NOT mirror or redesign. Layout FOUR COLUMNS TWO ROWS on a1536x1024 canvas; make every figure much smaller, around220px tall within its384x512 cell. Center all figures horizontally within their respectivecells and use identical baseline at eachcell y=360. Large true ALPHA-zero transparent padding above below between figures. Absolutely remove all background and glow, no gradients no floor no shadows. Ensure every complete ear tip and shoe inside its owncell far from edges. Preserve crisp colorful pixel details of source with no new textures. Output whole rectangular1536x1024 image, not tight crop; do not automatically trim transparent canvas. No text lines borders markers.
