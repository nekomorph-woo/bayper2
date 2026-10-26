# 温茶待机候选

2026-10-26 Codex通过内置imagegen生成，参考同目录master-v2.png。v1原始输出exec-28d75f9c-c2a5-4c3f-92d3-07c9066045c8.png；v2修订exec-30f70333-a8b5-4d3d-bde1-2f95873778c5.png。原始RGBA均保留。

v1等分切帧失败：第0格右侧主体触边，不裁尾、不忽略。v2留白修订后既有Claude工具成功导出8帧320×384、neutral-height298、统一scale0.704492，loop，时长700/220/100/110/100/220/400/600ms。工具调用未改代码。浅深棋盘均由Codex实际查看，完整耳尾鞋，透明背景可透；方口袋、长袖、金扣鞋及身份保留。

仍为候选，不发布不解锁。末帧尾巴与首帧弯曲不同，呼吸身高与耳位略有差异，需128pt连续播放检查循环接缝与闪动。没有把眨眼一项替代整套衣装动作。GUI当前由S05i独占，本轮不启动播放器。源图、提示与导出保留，AI无分层源文件。

## 初始提示词

Create a production candidate PIXEL ART idle animation sprite sheet of the EXACT SAME female cat-maid Rin from the reference, wearing her warm-tea outfit. Preserve charcoal-purple bob, amber eyes, cream maid headband, cat ears, ONE curled tail, burgundy neck ribbon, smoky-lilac LONG sleeves with cream cuffs, ivory pinafore with shoulder straps and ONE square front pocket, dark tights and gold-buckle Mary Jane shoes. Same compact anime proportions and face in EVERY frame. 8 full-body frames in EXACT uniform 4 columns x 2 rows grid on a 1536x1024 transparent canvas, each cell384x512. Each figure about310px tall, feet at cell y450, body center x185; keep complete tail/ears/shoes inside its cell with generous clear margin. Camera and ground position locked. Sequence: 1 neutral eyes open;2 subtle inhale;3 half-close eyelids;4 eyes fully closed blink;5 half-open;6 open slight exhale;7 settle;8 matches frame1. Arms relaxed consistently at sides; no new props, no waving, no different costumes or random head turns. Small coherent breathing, ear and tail-tip motion, no scaling or head growth. Strong coarse square pixel clusters, stepped outlines, limited flat shading, no micro-texture or smooth painted detail, readable at128pt body. True transparent RGBA background, no black backdrop, no glow, no shadows, no grid lines, labels or text. Frame cells evenly spaced both rows, do not enlarge top row or crop feet.

## 留白修订提示词

Correct the attached warm-tea Rin idle sprite sheet layout ONLY. It is eight frames on1536x1024,4 columns2rows. The first and fifth tails cross x384 boundaries. Every character must be scaled down uniformly to 75% of current figure size; same scale for ALL eight frames, and recentered inside its own384x512 cell. Feet y450 within each cell. Keep the exact face, costume, hair, long sleeves, square apron pocket, amber eyes, full tail, all8 blink/breathing poses and coarse pixel art style. Full figure about365px tall maximum. Minimum40px clear margin on ALL FOUR sides of each cell, including tail. No figure touches cell border. Exact equal rows and columns. True transparent RGBA outside characters, NO dark background, glow, floor or drop shadow. No frame labels or grid lines. Do not redesign, do not stretch proportions or crop anything.
