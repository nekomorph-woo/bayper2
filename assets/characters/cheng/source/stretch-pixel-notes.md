# 澄的伸展候选

2026-10-27，Codex Desktop内置imagegen，参考master-pixel-v1。保持银白短发、蓝灰眼、两只长垂兔耳、蓝蝴蝶结/奶油小花、灰蓝女仆裙与奶油围裙、连裤袜、蓝鞋和单个圆兔尾。动作比琥珀更舒缓，闭嘴轻笑，不跳跃。未调用额外计费图像API。

## 迭代与真实检查

- v1原件exec-8364c1c0-45e8-445c-9329-244164329759.png原样保存stretch-pixel-v1.png。4×2八帧；既有sprite-pipeline因第4格右边触界拒绝，保留cheng-stretch-pixel-v1-export.log，没有放宽阈值或裁耳。
- v2原件exec-4d51e93f-fbdc-48f5-b3cb-2b86ce2d2c56.png保存stretch-pixel-v2.png。修正每格留白；256×384、neutral298导出仍因第3格超出安全留边拒绝，记录cheng-stretch-pixel-v2-export.log。
- 改为320×384透明画布，保持neutral298和整套统一scale0.894895，成功导出animations/stretch-pixel-v2-canvas320。脚锚160/376，八帧300/180/180/240/550/220/200/300ms，非循环；没有逐帧拉伸，较宽画布容纳长耳及动作偏移。日志cheng-stretch-pixel-v2-canvas320-export.log。以上导出日志均在完整交付/evidence。
- Codex查看八帧浅棋盘：耳、鞋、圆尾完整，抬臂→伸展→落臂可辨，脸型和衣装基本保持，实际透明区域没有预览背景光晕。仍需跨动作连续性复验。
- Codex独立播放器48539退出0，scale128/298；非循环停止、重播、暂停、逐帧、0.25×慢放、深浅背景、导航限制和临时目录清理通过。证据tools/sprite-pipeline/evidence/codex-cheng-stretch-v2-small.*，stdout单独保存。临时目录bayper-sprite-verify-t9dWlh已删除。实际查看两背景第5帧，长耳与双手完整、小尺寸身份可辨；中性本体约128pt，画布约137×165 CSS点，画布不等于本体。

结论仅为候选导出和小尺寸播放检查，不是人类连续体验、正式动作发布或Cheng日常能力已启用。新版idle→stretch→idle、生产暂停恢复、旧新版素材一致性须另行审查；未改任何生产manifest或assetAvailable。

## v1完整提示词

Use case: stylized-concept. Asset: eight-frame nonlooping pixel sprite animation of EXACT Cheng reference, gentle sleepy stretch. Preserve silver-white bob hair, bluegray eyes, TWO long white lop rabbit ears pink inside, navy bows and cream flower ornaments, ivory maid headband, slateblue maid dress cream apron and navy neck bow, cream tights, navy MaryJane shoes gold buckles, ONE small round white rabbit tail. Compact three-head-tall proportions, chunky clearly stepped square pixel clusters, broad flat colors, no smooth shading or dense textures. Reference glow/background MUST NOT appear: all empty pixels completely transparent with no halo/shadow/haze. Layout exactly4columns2rows equal cells, canvas1536x1024; every figure same camera3/4 front and uniform size. Entire figure including ear tips and overhead hands comfortably inside each cell: max70% height and65% width, generous40px+ transparent margins. Shoes planted at same local baseline, constant body root and headsize; NO separate frame resizing. Motion quiet/low-energy, no jump or smile with open mouth. Frame1 neutral arms down calm expression. Frame2 hands rise close to chest. Frame3 elbows softly outward hands near cheeks but avoid covering ears. Frame4 arms reach upward in narrowV, comfortably closed eyes, long ears remain hanging to sides. Frame5 hands loosely joined overhead in small comfortable stretch, both long ears clearly preserved, closed subtle smile. Frame6 elbows relax and hands return beside cheeks. Frame7 arms descend toward waist. Frame8 exact neutral matching1. Ears, hair, apron and roundtail retain design with minimal follow-through. Distinct coherent action progression, no extra limbs, no cat tail, no cropped shoes/ears, no giant stretch, no grid/text/labels/floor/props.

## v2完整提示词

Edit ONLY the layout and empty background of this exact Cheng eight-frame stretch sprite sheet. Preserve all8poses in reading order, same character identity/outfit/long rabbit ears/short silver hair/round tail/closed-mouth expression, pixel edges and proportions. Exact canvas1536x1024, 4columns2rows, eachcell384x512. UNIFORMLY SHRINK ALL EIGHT complete figures together to 70% of current size. Put each entire figure centered within its OWN equal cell, soles at localy450. Maximum ear-tip spread no more than270px, raised hands fully inside cell and all limbs/ear tips at least40px away from ANY cell edge. In particular bottom-left frame5 right ear MUST NOT touch or cross x384 boundary; generous clear gutters around all cells. Do not individually distort or crop ears, do not change action. ALL EMPTY BACKGROUND MUST BE FULLY TRANSPARENT alpha0, remove any haze/glow/gray or black backdrop, no floor or shadows. Empty transparent gutters on EVERY side. Same uniform character scale and baseline in both rows, not smaller second row. No grid/text/labels. Keep all designs unchanged.
