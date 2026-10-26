# 凛睡眠候选制作记录

2026-10-27，Codex内置imagegen。参考master-pixel-v2.png（身份/像素风）与animations/sit-pixel-v2-canvas256/frame-07.png（坐姿）；输出只有位图，不虚称分层工程。此时未正式接入，D04候选，不能替代困倦或坐下动作验收。

## v1 提示词与结果

Use case: identity-preserve. Asset: Bayper Rin 2D pixel-art sleep animation candidate, eight frames in a precise 4-column by 2-row sprite sheet on TRUE TRANSPARENT background. Image 1 is identity and pixel style reference; image 2 is the approved seated pose to preserve. Render exactly the same black-cat-eared maid with short dark-purple bob, cream headband, dark dress, ivory apron, burgundy neck ribbon, dark tail, shoes. Compact anime proportions, chunky square pixel clusters, crisp stepped contours, restrained flat color ramps, no smooth illustration. All eight frames keep the seated pose of image 2, hands resting together in lap, legs tucked, skirt and tail grounded; eyes closed peacefully. This is a subtle looping sleeping breath, not eight different poses: frames 1–4 shoulders/head gently rise by only 1–2 logical pixels, frames 5–8 gently return, tail tip small secondary motion. Preserve identical face structure, head size, hair silhouette, outfit, scale, camera and ground line throughout; last frame connects naturally to first. Each equal cell contains one full character centered horizontally with generous transparent margins, no clipping or overlap. No bed, pillow, furniture, scene, labels, numbers, text, borders, decorative symbols, glow, shadows or ground patch. Do not copy the enlarged master image background. Produce a clean production sprite candidate rather than a presentation poster.

原件exec-e0fa54ca-9633-4468-8328-4c6971fc3f5b.png保存sleep-pixel-v1.png。实际1774×887 RGBA，alpha0～255；尺寸不可整除4×2，各格主体跨格，等分切帧拒绝。不裁切修复，不当成功产物。

## v2 版式修正完整提示词

Repair sprite sheet layout only. Input is the same Rin seated sleep 8-frame pixel animation. Keep exactly these 8 poses, character identity, pixel style, costume and subtle breathing. Output canvas EXACT 1536 x 1024 pixels. Arrange 4 columns x 2 rows, eight equal 384 x 512 cells. UNIFORMLY shrink all characters together so every character including tail is maximum 260 pixels wide and 290 pixels high. Same scale in all frames. Each character centered at cell x=192. Ground at cell y=440 (top row absolute440, lower row absolute952). Every entire silhouette has at least50 pixels left and right empty margin and at least50 pixels top and bottom empty margin; absolutely no overlap across cells. Do not stretch or crop any character. True transparent background with no floor shadows, grid, labels, numbers, glow or borders. This is a grid-layout repair, not a new pose or new design.

原件exec-5b59bfbc-163e-4a90-a2d1-20a667355470.png保存sleep-pixel-v2.png。实际1536×1024 RGBA、alpha0～254；预览深底不是实底。alpha>16各格bbox：上行(62,125,353,446)、(65,125,357,446)、(65,122,359,446)、(66,122,360,446)，下行(63,98,359,419)、(63,97,359,419)、(62,98,359,419)、(62,97,359,419)。所有轮廓不跨格，但没有严格按提示词的尺寸/地面排布；必须显式接地锚对齐，不把提示词当事实。

初看身份与安静闭眼姿态成立；发丝/尾部/呼吸接缝、与已坐下末帧的脸部尺度一致性及实际128pt播放仍待导出审查，不视为通过。

## 导出与小尺寸候选验收

Claude CLI69554（7c5d8ba9-2e7f-4dcf-9718-aebcccaa7661）使用现有工具与显式regions导出sleep-pixel-v2-canvas256，未改源图、工具或正式运行代码。统一scale0.694704，首帧223px坐姿高，接地128,376；上行地面446、下行931为实际像素，横锚按头部带，八帧最小边距8。源/配置/12产物SHA、命令与透明逐像素检查见tools/sprite-pipeline/evidence/s07-sleep-v2/。Codex独立核对12产物SHA一致。

Codex6947实际播放器scale=128/314通过：8帧循环、暂停、逐帧、0.25倍、深浅背景、导航边界、退出与临时目录清理；原始codex-player.json/log/截图保留。Codex查看整张浅底帧表及实际小尺寸深浅第5帧，闭眼、耳尾、衣服可辨且无明显底板/裁切。此为自动循环和关键帧视觉审查，不冒称用户连续体验或正式集成。

受托接受位图候选与播放器阶段，尚不接D04正式状态。与sit末帧坐姿身高同223px，但最低可见底边376对378相差2源px（不到1pt），整体宽202～206对sit末帧192；脸部/躯干对齐及跨动作过渡须继续实测，不以相同身高断言全角色一致性。原v1网格失败保留制作追溯。
