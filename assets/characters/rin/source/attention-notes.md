# 凛提醒动作制作记录

2026-10-25，Codex Desktop内置imagegen，参考master-v1；定位E02轻提醒，不改变通知预算。

attention-v1.png原件：exec-e664b4cd-550d-40fd-8cf1-b8093b79ccf9.png（本会话generated_images目录）。实际1774×887 RGBA，alpha0～255，不能按4×2整数网格切分；第4/5帧换了手。拒绝运行导入。

v2针对同手连续与1536×1024网格返修，审查结论见文末。

## v1实际提示词

```text
Use case identity-preserve. Make an eight-frame sprite animation for Rin, EXACT same original catgirl maid as reference, gently drawing attention to a work notification. 4 columns x 2 rows, equal cells, transparent RGBA background. Same gold eyes, plum-black bob, ivory headband, burgundy bow, black dress ivory apron, dark tights, gold buckle shoes, one curled tail on image right. Crisp detailed anime pixel art, ordered dither shading, no smooth paint. Fixed front three-quarter view, unchanged scale, feet fixed. Every full-body sprite occupies only 72% of cell height and 70% of cell width including tail/gesture, centered with generous clear padding; no cropping, no overlap. ONE consistent motion using ONLY the arm on the RIGHT SIDE OF THE IMAGE, near the tail; left arm stays lowered. Frame1 neutral relaxed pose identical to master. Frame2 right forearm begins raising with small attentive eyebrow lift. Frame3 right hand at chest height, index finger begins extending. Frame4 right index finger gently raised beside shoulder, other fingers curled naturally. Frame5 holds polite reminder pose with alert but kind eyes, not angry. Frame6 index finger relaxes, right forearm begins lowering. Frame7 right arm almost down. Frame8 original neutral pose. No text, punctuation symbols, motion lines, props, background, ground shadow, grids or labels. This is one character in sequential frames, strict consistent face/head proportions, outfit geometry and pixel grid. Reminder gesture restrained and quiet, suitable for a desktop companion.
```

## v2实际提示词

```text
Correct this production sheet. Output EXACTLY 1536 pixels wide by 1024 pixels high, four equal 384x512 cells across two rows. Rearrange same eight Rin poses into those cells, not stretch bodies. Uniform small character scale, each complete figure including tail fully inside its cell with at least 12% side padding and 8% vertical padding, feet same local baseline. Correct frames4 and5 ONLY: they mistakenly raise the LEFT SIDE hand. ALL gestures must use the RIGHT SIDE hand beside the tail, like frame3. In frames4 and5, LEFT arm hangs down beside left skirt exactly like frame1, RIGHT forearm raised with index finger up next to right shoulder. Keep other gestures continuous on right arm; frame6 lowers right forearm, left still hangs. Same face, proportions, cat ears, single tail, maid dress and crisp pixel details as reference. Eight sequential neutral -> gentle reminder -> neutral poses, fixed viewpoint. Completely transparent alpha background, no stray red pixels or outlines, no text, no shadows, no grid. Preserve opaque dark hair/dress/tail. Do not swap arms mid-action.
```

# attention-v2 审查补记

原始产物：`exec-fa57c8a1-9840-4de8-9c97-4988721d1413.png`，已原样复制为本目录`attention-v2.png`。Codex目视发现第2、7格举起画面右手，而第3、4、5格举起画面左手；动作中途换手的问题仍然存在，因此拒绝作为正式动画导出。四行列尺寸修正不等于动作一致性通过。后续需以单一固定姿势做更小幅动作，或基于已有合格动作组合语义，不反复扩大图集要求。
