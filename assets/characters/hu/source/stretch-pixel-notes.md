# 琥珀伸展候选

2026-10-27 Codex Desktop内置imagegen，参考master-pixel-v2。保持棕色卷发/耳尾、琥珀眼、绿色女仆装、奶油围裙头饰、小花与绿色发带、棕靴身份，采用轻快但不跳跃的舒展。未使用额外计费API。

v1原件exec-a962e873-1907-4273-9fff-a434f6b1d94e.png，保存stretch-pixel-v1.png。第5帧上举手掌侵入上排，既有sprite-pipeline实际以“第0格主体触到下边界”拒绝；不绕过校验、不吞裁手掌。日志完整交付/evidence/hu-stretch-pixel-v1-export.log。

v2编辑原件exec-d4e9dfe3-390e-43cc-b42a-7e3033223f3e.png，保存stretch-pixel-v2.png，修透明留白后既有Claude编写的工具成功导出8帧256×384、neutral298、统一scale0.665179、脚锚128/376。时长240/140/160/200/500/180/160/260ms，非循环，仅候选初值。日志完整交付/evidence/hu-stretch-pixel-v2-export.log。

Codex实际查看源图与浅棋盘：双手由胸前到举臂/头顶合手后落下，阶段可辨；卷发、耳尾、绿色衣装和棕靴持续存在，脚位对齐、无裁切；峰值转正/闭眼及衣摆变化仍需在约128pt实际播放、与Hu新版idle衔接核对。当前GUI由S03e独占，未播放，不接生产、不打开Hu daily能力。不能用导出成功代替正式动作验收。

## 2026-10-27 小尺寸独立播放

S03e释放GUI后，Codex运行既有verify-player，scale=128/298≈0.4295302，工具23374退出0。8帧总1840ms、非循环到末帧停止、重播、暂停、逐帧、0.25×慢放、深浅背景与导航限制均通过；实际透明画布约109.95×164.94 CSS点，本体中性高度128点，二者不混算。临时目录bayper-sprite-verify-fCbcl8已移除、Electron退出0。

证据为`tools/sprite-pipeline/evidence/codex-hu-stretch-v2-small.{json,log}`及同名前缀light/dark截图。Codex查看实际小尺寸第5帧两种背景和八帧对照：举臂完整、卷发耳尾及绿色围裙身份可辨，深底无大块不透明背景，保持小体量。自动时序与关键帧审查不等于人类连续体验；与新版idle切换、生产日常中断/恢复及身份连续性仍待正式集成验证。仍是候选，不启用Hu daily、不改发布标记。

## v1提示词

Use case: stylized-concept. Create an eight-frame NONLOOPING gentle stretch animation spritesheet for exact Hu in reference. Preserve chestnut curly twin tails, amber eyes, brown cat ears and single thick curved brown tail, dark olive-green short maid dress, cream apron/headband, dark green hair bows with one little cream flower, brown collar bow and gold clasp, bare knees, cream ankle socks and brown buckle boots. Compact anime proportions and coarse crisp square pixel clusters matching reference, limited flat shades, no fine dithering or smooth illustration. Four columns two rows of equal cells, canvas1536x1024. Full complete character in every cell with generous transparent margins, same scale/head size/foot baseline in BOTH rows. Feet stay planted, body root stable; a small cheerful stretch, not bouncing/waving. Frame1 neutral relaxed arms low, smiling softly. Frame2 both hands lift to chest. Frame3 bent elbows hands beside head. Frame4 arms extend upwards in a narrow V, eyes comfortably closed. Frame5 full comfortable overhead stretch with hands safely below cell upper border, small torso extension. Frame6 elbows soften hands beside head. Frame7 hands descend to waist. Frame8 returns neutral same as1. Hair curls, bows, apron and tail maintain design, slight follow-through only. Raised hands, ears, complete tail and boots must stay within 75 percent of cell width/height, at least35px transparent gutter to every cell boundary. All8 use same camera3/4 front angle and same uniform size; do not shrink second row. Transparent background, no floor/shadow/glow/text/grid/backdrop, no objects, no cropped limbs, no extra hands.

## v2提示词

Repair layout ONLY of this exact eight-frame Hu stretch sheet. Preserve all eight poses in same reading order and exact character identity, brown curls/ears/tail, green-and-cream maid dress/bows/flower, brown boots, face and chunky pixel style. Equal4columns2rows canvas1536x1024, cells384x512. Uniformly reduce ALL eight figures together by about20 percent, never individually resize. Put every figure at same scale and planted soles local y450. Maximum upward hands and ears above local y50 and no lower than topmargin; keep all hair/tail/hands at least30px from cell sides. Entire fifth pose including overhead clasped hands MUST be fully INSIDE bottom-left cell, never intrude into first row. Empty transparent horizontal gutter around row boundary. Eight same-size figures, generous empty transparent margins. No grid/labels/background/shadow/halo/ground, preserve alpha transparency. Do not change poses, outfit or add detail.

日志说明：本次shell stdout与工具内部log误用了同一路径，尾部出现108个NUL空洞；raw.log保留原件，展示用log仅去除NUL，正文/结果未改写，JSON与截图不受影响。后续stdout使用独立文件名。
