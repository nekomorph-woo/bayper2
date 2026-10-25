# 凛：角色母版制作记录

角色ID：rin。受托设定：安静、细心、有轻微俏皮的黑猫系Bayper；善于留意小事，愿意陪用户安静工作，偶尔整理衣袖，不因用户忙碌责怪对方。称呼“凛”为初始显示名，用户昵称不改变身份。

本目录为产品共享角色源素材，不是工具数据。运行时导出及动画尚未完成；母版候选通过不代表可发布角色通过。

## master-v1.png

- 2026-10-25，Codex Desktop内置imagegen，透明背景；参考`tools/appearance-catalog/references/style-board-02-maid.png`第10格。
- 原始输出：`/Users/chaooswoo/.codex/generated_images/01a17121-7952-7433-8359-b082940fc70d/exec-0d15ef5a-499e-4e2e-95be-ae90dce467ba.png`。原文件保留，本项目内副本为制作输入。
- Codex静态审查：脸、耳、发色、蝴蝶结、裙装和鞋的识别点一致，保持紧凑比例及抖色纹理。尾巴在画面右侧，不能未经核对直接镜像成相反结构。尚需实际目标尺寸、透明边缘、多视图和连续动画审查；不是人类亲自接受记录。
- 文件核查：1254×1254 RGBA，alpha范围0～255；alpha≥16主体边界(256,46)～(1024,1193)，极低alpha杂点延伸至底边。导出须处理透明杂点并在深浅背景复验，未按原始全alpha边界判为可用运行帧。
- 固定项：金瞳、深紫黑短发、黑猫耳及粉色耳内、单尾、紧凑体型。此套服装固定乳白褶边发箍、酒红领结、黑紫裙与乳白围裙、深色袜和金扣黑鞋。新服装允许服饰变化，不重抽脸/体型/底色。

### 实际生成提示词

```text
Use case: identity-preserve. Asset: Bayper production character master candidate, ONE full-body sprite, genuine transparent background. The reference is a style comparison board: ONLY cell 10 (row 3 column 2) is authoritative. Extract and carefully redraw this SAME original adult anime catgirl maid, keeping its compact approximately 3-head proportions, detailed pixel-art face, amber eyes, short plum-black bob, two black cat ears with pink inner ear, ivory ruffled headband, dark black-plum maid dress, ivory apron, burgundy neck bow, opaque dark tights, black Mary Jane shoes, one black upward-curled tail. Preserve cell10's delicate ordered dithering in shadow, fine crunchy pixel clusters and stepped outlines; do not smooth into digital painting. Neutral relaxed front three-quarter standing pose matching cell10, arms at sides, both feet fully visible, gentle small smile. One character only, centered with transparent margins on all sides, at least 8% margin around ears, tail and feet. Uniform pixel grid, legible at desktop sprite size. No other cells, numbers, typography, grids, ground shadow, props or background. Maintain same face, outfit and identity exactly. This is a reference master, not an animation sheet.
```

## turnaround-v1.png

内置imagegen，参考master-v1，输出原件`exec-df466ece-3592-40a6-915e-9857145221f0.png`（同上生成目录），2172×724。前、三分之四、侧、背四视图；静态识别点一致，背部围裙交叉带与蝴蝶结作为结构补充。四视图是结构参考，不作为转身动画直接播放；个别透明边缘出现彩色残点，运行时需另验。

```text
Use case: identity-preserve. Production reference turnaround for the exact character in input: Rin, an original adult feminine catgirl maid mascot. Four full body views in a single horizontal row with equal cells and generous separation: FRONT, front THREE-QUARTER matching reference, SIDE facing left, BACK. No text or labels. Genuine transparent background. Every character equal height and consistent compact proportions, identical gold eyes, plum-black short bob with side locks, two black/pink cat ears, ivory ruffled maid headband, burgundy bow, black and ivory maid dress, ivory apron, dark tights, gold buckle black shoes, ONE black curved tail. Back view has large ivory apron tie and clear tail emerging at lower back, coherent with reference. Same detailed crisp anime pixel art with ordered dithering shadows and stepped edges as input, no smooth painting, no 3D. Strict identity and outfit continuity. Neutral arms relaxed; feet, ears and tail fully inside each cell, no overlap. This is a structural reference, not animation frames.
```

## idle-v1.png / idle-v2.png

内置imagegen，8帧4列2行呼吸/眨眼候选，1536×1024。v1原件`exec-45e3a89b-d664-4667-94b3-9a2223574fd8.png`，v2原件`exec-73e5107a-9c55-4e52-bfdf-c9c0d7b084f6.png`。原始路径均为上面生成目录。

初看工具预览疑似灰色背景，因而请求透明边缘返修；随后实际读取PNG发现角落及帧间背景alpha=0，不能把预览RGB直接视作不透明背景FAIL。v2仍需要真实合成审查；v1像素纹理较强，优先作为切帧候选，v2仅为备选，不静默替换。未验收播放和首尾接缝。

v1提示词：

```text
Use case identity-preserve. Make an actual 8-frame idle breathing and blink sprite sheet for EXACT SAME Rin catgirl maid in reference. Transparent canvas, exactly 4 columns by 2 rows of equal rectangular cells, reading order left to right then next row. No borders, text or labels. Each cell holds ONE complete same-scale full-body character, front three-quarter view exactly as master, feet on identical local baseline, center aligned. Preserve identical face proportions, gold eyes, short black-plum bob, two pink-inner black cat ears, ivory frilled headband, burgundy neck bow, black dress and ivory apron, dark tights, gold buckle shoes and ONE tail curled to viewer right. Keep pixel texture and detailed stepped pixel edges from reference. This is one continuous subtle loop, not eight different designs/poses. Foot positions fixed, no body scaling or viewpoint change. Arms stay naturally at sides. Frame1 neutral eyes open and relaxed shoulders; frame2 subtle breathing in, shoulders/apron lift only a tiny amount; frame3 breathing apex eyes open; frame4 eyelids halfway lowering; frame5 eyelids closed gentle blink; frame6 eyelids half opening; frame7 eyes open, chest settling; frame8 returns almost exactly to frame1 to loop cleanly. Hair and tail subtly follow breathing, no large gestures. Consistent clothing geometry, identical hands/fingers, same head size and silhouette. Generous clear transparent margin around every cell; no overlap, cropped ears/feet or cast shadow. Render very crisp high-detail 2D anime pixel-art at consistent pixel grid. No smoothing, no painted gradients.
```

v2参考v1，提示词：

```text
Use case background-extraction. Change ONLY the background of this exact eight-frame sprite sheet. Remove ALL grey/purple gradient, glow and cast shadow completely to genuine alpha=0 transparency. Preserve the eight Rin character sprites exactly, same pixels, scale, layout, faces, expressions, outfit and 4x2 equal-cell arrangement. Keep black/plum hair, ears, dress, stockings and tail OPAQUE; ivory apron remains opaque. Do not repaint or move characters. Transparent gaps between all characters; no checkerboard baked into pixels, no replacement backdrop, no edge glow/halo. The previous background was an error; this asset must be clean RGBA sprites on fully transparent pixels.
```

## idle-v3.png

v1和v2被实际切帧命令拒绝：第0格尾巴触到右边界，不能作为安全等分网格导出。v3参考v1缩小主体并增加格内留边，原件`exec-6cdbbf22-d6fa-478c-ba77-f935d300d2b1.png`，仍待实际导出与播放验收。

```text
Edit this exact eight-frame sprite sheet for production grid safety. Preserve Rin's identity, pixel-art rendering, outfit, and all eight animation poses in reading order. Keep canvas 4 equal columns by 2 equal rows. CRITICAL: every sprite including tail MUST fit completely inside its own equal grid cell with at least 12% fully TRANSPARENT padding left AND right and 8% padding above AND below. Uniformly reduce the same scale of ALL eight sprites to approximately 75 percent of their current scale around each cell center; do not distort proportions. The first tail currently crosses its equal cell boundary; fix this with more space, NOT clipping tail. All feet share the same local baseline with visible transparent space beneath. Genuine clear alpha background, no painted gradient, no checkerboard, no text/gridlines. Keep crisp small pixel clusters, detailed face and dithered skirt from original, not smooth painting. Do not change poses or expressions. Eight separate equally spaced complete characters, 4x2.
```

## wave-v1.png / wave-v2.png

2026-10-25，Codex Desktop内置imagegen，参考master-v1，制作8帧4×2轻挥手。原件分别为同上生成目录的`exec-2688959d-b30f-41f4-8dcc-12814cf91a41.png`、`exec-2cfbf978-9ea1-4439-a5ab-1b455333c974.png`。

v1拒绝：第2/7帧抬起了画面左手，中间却挥右手，不是连续动作。v2定向修复同手挥动并缩小留边，静态审查8帧均为右侧手动作；实际CLI切帧成功，但自动fit后首帧高315像素，相对idle-v3的298像素约放大6%，跨动作尺寸尚未通过。Claude已补显式中性高度约束，Codex独立运行5项测试通过，并使用`--neutral-height 298`重新导出：整套scale0.728606、首帧高298、统一脚锚(128,376)。静态比较身高与落脚点已对齐；跨动作动态衔接仍待运行时复验。

v1实际提示词：

```text
Use case identity-preserve. Production sprite sheet for the EXACT Rin catgirl maid shown in reference. Make 8 sequential frames of a gentle greeting wave, 4 equal columns x 2 equal rows, reading order. Genuine transparent background, no text, borders, shadow, props or extra characters. Every frame full body same scale, same 3-head compact proportions, gold eyes, plum-black bob, ivory maid headband, burgundy bow, black dress ivory apron, dark tights, gold buckle shoes, single tail curled to viewer right. Preserve detailed crisp pixel clusters and dithering from reference, no smooth painting. Fixed feet and unchanged camera, front three-quarter view. Character must fit inside each grid cell with at least 12% transparent side margins including tail and hand, 8% top/bottom margins. This is one continuous action, not different designs: frame1 exact relaxed reference pose; frame2 raises viewer-left forearm slightly; frame3 hand reaches shoulder level palm outward; frame4 hand gently tilts outward; frame5 tilts inward; frame6 small outward wave again; frame7 forearm lowers; frame8 returns to original relaxed pose. Hand stays below ear, no giant sweeping arm. Same face/outfit/head/body proportions and foot positions in every frame. Tiny natural smile, warm restrained greeting. Frame1 and8 should connect to neutral idle. Match reference silhouette and outfit details exactly. Uniform body scale across all eight sprites, generous transparent gaps.
```

v2实际提示词（参考wave-v1）：

```text
Identity-preserve correction of this 8 frame sprite sheet, 4 equal columns x 2 equal rows. Fix TWO concrete errors only. 1) Wave must use the SAME arm throughout: the arm on the RIGHT SIDE OF THE IMAGE in each cell (beside tail). The LEFT SIDE arm hangs down exactly as frame1 in ALL eight frames. In frame2 and frame7 currently the wrong left-side hand raises; instead keep left arm down and make right arm intermediate lifting/lowering. Frames3-6 wave right-side hand as now. 2) Uniformly shrink ALL characters to 75% current size, center in each equal cell, retaining same common feet baseline, so ALL ears feet hand and tail have clear transparent margins at least 12% cell width on both sides. Preserve exact character face, clothing, body proportions, pixel art and frame sequence. Genuine fully transparent alpha background. No glow, gradients, checkerboard, labels, borders. Frame1 neutral right arm down; frame2 right forearm halfway raised; frame3 right hand near shoulder; frame4 right hand tilted outward; frame5 inward; frame6 outward; frame7 right forearm halfway lowered; frame8 neutral same as1. Left hand remains lowered at left skirt edge in every frame. Tiny gentle wave, no camera movement.
```

## master-pixel-v2.png（用户已认可的当前画风母版）

实际提示词：

```text
Use case: style-transfer / identity-preserve. Redraw the provided Rin character as TRUE low-resolution hand-clustered pixel art for a tiny desktop companion. Reference image is identity/outfit/proportions ONLY; its fine dithering and smooth illustrative rendering are TOO SMOOTH and must be replaced. ONE complete full-body sprite, neutral three-quarter stance, genuine transparent background. Exact identity: adult anime catgirl maid, compact 3-head-tall silhouette, amber gold eyes, plum-black short bob, black cat ears pink inside, ivory frilled headband, burgundy neck bow, dark plum dress, ivory apron, opaque dark tights, black gold-buckle Mary Jane shoes, ONE tail curled on viewer right. Keep these designs and head/body ratio. CRITICAL PIXEL STYLE: design on a virtual 128 x 192 pixel canvas, character about 100 x 150 logical pixels tall, then present as a sharp nearest-neighbor enlargement; every logical pixel visibly square, uniform pixel grid throughout. Deliberately stepped 1-pixel contours, 32-color-style restrained palette, 3 solid shade levels per material, chunky intentional pixel clusters, eyes built of a few readable clusters. Simplify lace and hair into pixel groups; do NOT draw tiny linework. No antialiasing, no soft edges, no gradients, no painterly highlights, no dense dithering/noise, no fake pixel filter over illustration. Faithful recognizable Rin but with much stronger crisp game-sprite pixel structure visible at actual 128x192 display. Full figure including ears, tail, feet; generous transparent margins, no ground shadow, text, grid, props or additional characters. A single static mother reference candidate, not an animation sheet.
```

2026-10-26，用户认为真实桌面测试角色过大且像素感不足。内置imagegen以master-v1为身份参考重绘，原件exec-cbcf075c-679d-48b0-b09c-be2822949d49.png。保留金瞳、短发、耳尾、服饰及紧凑比例，改成明显阶梯轮廓与较大色块，去除密集纹理。1024×1536 RGBA，抽样角色外alpha=0，角色内253～254；预览中的背景RGB光晕不能据此认为实际不透明。仍需小尺寸合成与动画，未替换运行资源。

用户随后明确认可此版并要求同步设计约束，现为assets/characters/STYLE.md有效视觉基准。认可范围是静态画风，不是动画或其他角色自动通过。
