# 温茶招呼动画候选

2026-10-27 Codex内置imagegen生成，原始输出exec-097378b9-99e5-4f01-9607-9ddebbf5a986.png。参考温茶master-v2决定衣装/身份，基础wave-pixel-v1仅决定动作；不照搬基础短袖。原始RGBA1536×1024保留。

使用既有Claude编写的sprite-pipeline按4×2导出8帧320×384，neutral-height298，全套scale0.614433，非循环，时长280/130/180/150/150/150/130/380ms。Codex实际查看浅棋盘，抬手/摆手/收手可辨，耳尾鞋完整，方口袋与长袖保持；没有通过程序补画或逐帧fit。

尚未正式发布。首末帧裙摆/尾形略有差异，需与温茶idle在128pt实际播放并检查接地、头身和收束；与基础衣装切换亦未验收。当前GUI由通知开发独占，本轮只保存静态提取候选。

## 完整提示词

Create8 full-body PIXEL ART animation frames for Rin wearing warm-tea outfit. Reference1 is authoritative identity AND CLOTHES: charcoal-purple bob, amber eyes, cream maid headband, cat ears, single curled tail, burgundy neck ribbon, smoky-lilac LONG sleeves down to cream wrist cuffs, ivory pinafore shoulder straps and ONE square front pocket, dark tights, gold buckle Mary Jane shoes. Reference2 ONLY shows the WAVE action sequence and fixed body proportions; NEVER copy its short sleeves or pocketless skirt. All8 frames must wear exactly reference1 warm-tea outfit. 4columns×2rows equal384×512cells,1536×1024 transparent RGBA sheet. Figure height about360px, feet cell y450, ample40px margins, no ears or tail touching boundaries. Fixed camera and feet, same scale across all frames. Poses in reading order: neutral arms down; right elbow bends; open right palm lifts near cheek; palm waves outward; palm waves inward; waves outward gently; elbow lowers; exact initial neutral pose. Right hand appears on viewer left. Preserve exact face/hair/body/head size, tiny relaxed smile, no deformation or extra fingers/limbs. Clear coarse square pixels, stepped silhouettes, simple flat color clusters, no dithering or fine texture, readable at128pt fullbody. Alpha zero outside figures; no background, halo, glow, floor shadow, text or grid. Full ears/tail/shoes complete and separated.
