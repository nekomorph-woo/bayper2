# 琥珀角色制作源

## idle-v1制作提示

```text
Create a production 8-frame subtle idle sprite sheet for the EXACT Hu character in the reference. Canvas exactly 1536x1024, FOUR equal columns and TWO equal rows, cells384x512. Every frame entire character including ears, boots, long curls and ONE tail inside its own cell, at most72% cellheight and70% cellwidth; large transparent padding. Same scale, viewpoint, fixed feet baseline, no camera motion. Preserve chestnut curled twin-tail hair, amber eyes, olive ribbons/white flowers, brown ears, cream maid headband, olive-green dress cream apron brown neckbow flower, cream socks brown boots and single curled tail on image right. Detailed crisp anime pixelart matching reference, not smooth painting. Both arms remain relaxed down beside skirt throughout ALL frames; no hand gestures. Eight sequential frames:1neutral friendly attentive standing;2tiny inhale;3same pose tiny tail tip sway;4eyes halfclosed;5one natural fullblink;6eyes halfopen;7eyes open gentle exhale;8identical neutral to1 for seamless loop. Changes extremely small, no bodyshape/outfit redraw, no duplicated hands/tails, no floating feet. Transparent RGBA, no background, no shadow, no gridlines, no labels, no red edge pixels. Every frame must be separate fullbody within precise uniform cells.
```

Codex Desktop内置imagegen制作，2026-10-25。身份参考为原型中的琥珀，画风和头身比例继承凛正式master与已选10号基准；原型头像不自动成为完整动画资源。

idle-v1原件`exec-55482bf3-add4-4667-83be-8c571cea0581.png`，已原样保存。用既有sprite-pipeline切4×2格，导出256×384、统一缩放0.614433、中性主体高298，与凛导出保持同一尺寸基准。时序650/180/250/80/110/80/180/350ms，循环1880ms。Codex静态查看8帧浅色接触图：发带/耳/单尾/裙装身份连续、双脚稳定、闭眼与睁眼序列可读。

既有真实Electron播放器独立验证循环、暂停、逐帧、0.25倍速、深浅背景、导航限制与退出清理全部通过；证据`tools/sprite-pipeline/evidence/codex-hu-idle-v1.json`。这是播放器验证与静态目视，不冒称人类连续观看；正式桌面角色交接尚未接入，完整动作库仍未完成。

## 固定识别特征

栗棕卷曲双束长发、琥珀眼、棕猫耳与奶油耳内、橄榄绿双侧发带及小白花、单条蓬松栗棕尾。活泼、好奇、愿意出门收集小物件，与现有角色性格保持一致。首套服装为橄榄绿女仆裙、奶油围裙、棕领结花饰、奶油袜及实用棕短靴；服装不是角色身份本体。

## master-v1

原始输出`exec-d4acb605-0c7e-463f-b75f-12392513d2ae.png`，原样复制至本目录。实际1254×1254 RGBA，alpha范围0～255；alpha≥16主体包围盒(275,35,1112,1233)。有极低alpha边缘杂点，未程序化涂改源图，导出需按既定alpha阈值检查。目视角色识别、完整身体、头身和配色协调；仅接受作后续动作参考，不据此宣布动画通过。

提示词见下。

```text
Create one full-body production master sprite of Hu (琥珀), an original cat-eared maid companion, on truly transparent RGBA background. Image1 is Hu's identity reference: preserve chestnut brown wavy twin-tail hair, amber eyes, brown cat ears with cream interiors, olive green side ribbons with small ivory flowers, cream maid headband and lively friendly expression. Image2 is the approved STYLE AND BODY PROPORTION reference ONLY: match its compact approximately three-head-tall full-body anime pixel-art proportions, detailed crisp pixel clusters and ordered dither shading; do not copy its black hair or burgundy outfit. Extend Hu into a coherent complete standing character: muted forest-olive maid dress with cream apron and frill hem, small brown neck bow with ivory flower brooch, practical brown ankle boots, cream socks, one fluffy chestnut cat tail curling on image right. Outfit modest and practical for an energetic collector, no weapons or held props. Full body from ear tips to boot soles, front three-quarter view matching Image2, both arms relaxed beside skirt, symmetrical balanced feet. Warm smile, alert eyes, adventurous personality conveyed subtly. Lock a clear readable silhouette and restrained green/cream/brown palette. Center figure with 12 percent clear padding on all sides. No text, no labels, no scenery, no ground shadow, no grid. Preserve fine 2D pixel style rather than smooth painting or vector-filter effect.
```
