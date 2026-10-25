# 澄制作源

## idle-v1提示

```text
Make an 8-frame production idle sprite sheet of EXACT Cheng from reference. Canvas EXACT1536x1024 pixels, 4 equal columns x2 equal rows, each384x512. Identical scale fixed footbaseline, fullfigure in every cell, shrink character to72%cellheight maximum and70%cellwidth including long ears, generous transparent margins. Preserve silver-white curved bob, bluegray eyes, two white lop rabbit ears pinkinside, navy ribbons ivoryflowers, creamheadband, slateblue maid dress cream apron, navy neckbow flower, cream tights navy Mary Jane shoes, small round white bunnytail. Detailed crisp pixelart exactly as reference, fixed front3/4 view. Both arms stay relaxed down in allframes. Quiet slow idle sequence:1neutral softsmile eyesopen;2tiny inhale;3eyes slightly relaxed;4halfclosed;5fullyclosed blink;6halfopen;7open exhale;8same as1. Ears move at most a fewpixels, don't change size or shape. Feet planted, dress geometry stable, same face/headbody proportions. No handgesture, no props, no change outfit, no perspective drift. True transparent RGBA background, no shadows/grid/text/labels. No cropped ear tips or shoes, no overlapping cells.
```

2026-10-25，Codex Desktop内置imagegen。参考原型澄头像的身份、凛master的画风与头身比例。固定特征为银白短发、蓝灰眼、白色垂兔耳、深蓝发带及小白花；首套服装为灰蓝女仆裙、奶油围裙/连裤袜、蓝色Mary Jane鞋。性格延续安静、慵懒、先观察的底色。源图不是完整动作交付。

master-v1原始输出`exec-519cb464-5b2c-4590-8718-a4b1713e1049.png`，原样保存。Codex目视完整身体与两只垂耳，未混入猫尾。后续通过切帧透明边缘和实际播放器检查后才接受动画。

idle-v1原始输出`exec-9e9edfb9-0e94-4a02-9dbe-f903d808413d.png`，已复制。按4×2等格导出256×384，统一缩放0.610656、中性主体高298，脚锚与其他角色一致；8帧1880ms循环。Codex目视深色接触图：耳部轮廓、头饰、单尾和服装连续，闭眼段可读，双脚位置稳定。

真实Electron播放器独立运行循环、暂停、逐帧、0.25倍速、深浅背景和退出清理均通过，证据`tools/sprite-pipeline/evidence/codex-cheng-idle-v1.json`。未冒称人类连续观看、正式桌面已接入或完整动作通过。

实际提示词：

```text
Create one full-body production master sprite of Cheng (澄), original quiet rabbit-eared maid companion. Image1 specifies her identity: silver-white bob with soft curved tips, blue-gray eyes, two long white lop rabbit ears with pale pink inside, cream maid headband, navy side ribbons and small ivory flowers, sleepy gentle reserved expression. Image2 Rin is STYLE/PROPORTIONS only: match compact approximately three-head-tall full-body anime pixel character, crisp fine pixel clusters and ordered dither shading. Do not copy Rin cat ears, tail, black hair or outfit colors. Complete Cheng standing relaxed with both arms down beside skirt, fixed front three-quarter view matching reference2: muted slate-blue maid dress, cream apron and frill hem, navy neck bow with small ivory flower, cream opaque tights, navy comfortable Mary Jane shoes. Small white round rabbit tail may peek on image right, not a cat tail. Single character centered, entire ear tips through shoe soles included with generous transparent padding. The long lop ears hang naturally to shoulder height, don't extend beyond the frame. Calm observant warmth, no held objects or sleepy symbols. Clear modest silhouette, stable proportions compatible with Rin and Hu. Transparent RGBA, no background, no shadow, no text or labels. Detailed 2D pixel art, no smooth vector/paint filter.
```
