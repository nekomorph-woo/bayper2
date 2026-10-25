# 温茶围裙单人母版候选

Codex Desktop 内置 imagegen，2026-10-26。参考凛 master-pixel-v2 身份与 turnaround-v2 衣装。master-v1 原始输出 exec-ae794e91-7596-419d-ac78-11cca5d39f3e.png；master-v2 为背景修订，原始输出 exec-b65dfbb8-09a6-41bd-a3d4-25a2b0e0ff43.png。两份均1024×1536 RGBA，原始保留。

初看工具预览呈黑底/光晕，Codex提出疑虑并用imagegen修订；实际只读alpha检查显示两者均有透明背景，alpha范围0～254，v1透明像素849562，v2为860448，不能把原预览外观直接断言为不透明失败。使用既有sprite-pipeline导出v2单帧320×384、neutral-height298、统一scale0.208246，实际查看浅棋盘：完整耳尾鞋、背景能透出，未见明显外圈底板。没有程序重绘或自写修图。

身份、烟紫长袖、方口袋与金扣鞋的静态方向接受；仍仅候选，不发布、不解锁、不当动画。尚未128pt实际桌面查看、深背景审查与动作衔接。master-preview-v2只是一帧检查资源，1000ms不是动作设计。后续需维持同角色身份与全动作统一缩放，不把单帧循环当已完成动画。

## 初始完整提示词

Create ONE full body neutral three-quarter standing sprite of EXACT SAME Rin identity as reference1, wearing warm-tea outfit from reference2. Reference1 defines face, charcoal-purple bob haircut, amber eyes, black cat ears with coral interiors, ONE curved tail, compact anime head/body proportions and bold coarse square pixel clusters. Reference2 defines ONLY costume: smoky lilac LONG sleeves with cream cuffs, ivory pinafore with shoulder straps, ONE clear square front pocket, burgundy neck ribbon, dark tights, dark gold-buckle Mary Jane shoes, small cream maid headband. Arms relaxed at sides, no props. Match reference1 head/body ratio, do not elongate or simplify into tiny chibi. Clean large stepped pixel outlines, coherent coarse logical pixel grid, flat color clusters with 3 shades per material, no fine dither, no micro-texture. Sprite must read at full-body height128pt; prioritize face, silhouette and pocket. Single figure centered occupying75% canvas height, complete ears/tail/shoes and ample transparent margin. TRUE TRANSPARENT RGBA, hard clean alpha edges, no stray colored pixels, no halo, glow, floor, shadow, background or text. Do not copy reference1 black backdrop or glow. This is production candidate master, not an animation sheet, not a turnaround.

## 背景修订完整提示词

Remove the entire dark background AND all purple/gray halo/glow around the character from this image. Keep the exact character pixels, face, silhouette, clothing, colors, pose and proportions unchanged. Produce clean transparent background cutout, alpha ZERO everywhere outside the character, no floor shadow. Do not replace with a solid black or checkerboard background. Preserve crisp stepped pixel-art silhouette, no soft feathering. Keep full ears/tail/shoes. Only background removal, no redesign.
