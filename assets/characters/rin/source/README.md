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
