# 琥珀像素母版生成记录

## v2

工具：Codex内置imagegen；2026-10-26。参考1为Hu master-pixel-v1（待修目标），参考2为凛master-pixel-v2（像素颗粒）。transparent_background=true。只定向增强粗像素，保留身份，静态候选不等于运行资源通过。

```text
Edit Hu in image1 to use the EXACT LARGE CHUNKY PIXEL GRID of image2 (Rin), preserving Hu's identity and outfit. Important targeted correction: image1 is too fine and painterly. REDRAW on a visibly coarse 96x144 logical sprite grid then enlarge with nearest neighbor; each square pixel should appear around 10x10 pixels in the large output. Simplify hair into 6-8 large chestnut curl masses, remove tiny strands, gradients and all dithering. Three flat shades per material. Square eyes/highlights and stepped diagonal outlines. Match image2's chunky block scale, not image1's fine edges. Preserve the Hu design: chestnut twin tails, amber eyes, brown cat ears with ivory interiors, green flower ribbons, cream maid headband, olive green dress, ivory apron, brown neckbow and boots, cream socks, ONE brown tail on right. Full body balanced neutral front three-quarter pose, relaxed arms, warm cheerful smile, about three heads tall. No extra props. Entire ears feet and tail in frame with transparent padding. Transparent background with ZERO glow or shadow or scenery. One sprite. No text. Make pixel clusters clear at 128pt visible-body display.
```

## v1

工具：Codex内置imagegen；2026-10-26。参考1为hu/source/master-v1.png（身份），参考2为rin/source/master-pixel-v2.png（风格）。请求transparent_background=true，产物与静态判定见README.md。

```text
Create a single full-body production master sprite of Hu (琥珀) for Bayper. Image 1 is IDENTITY ONLY: preserve chestnut brown wavy twin-tail hair, amber eyes, brown cat ears with cream interiors, olive ribbons with tiny ivory flowers, ivory maid headband, olive green maid dress and cream apron, brown bow with flower brooch, cream socks, brown ankle boots, ONE fluffy chestnut tail curled viewer-right, lively warm smile. Image 2 is STYLE AND PROPORTIONS ONLY: match its clearly visible chunky square pixel clusters, stepped contours, compact approximately three-head anime proportions and simple three-tone material shading. Do not copy its black hair or burgundy costume. Redraw Hu as coherent true 2D pixel sprite with virtual 128x192 logical canvas and roughly100x150 body, crisp nearest-neighbor enlargement, no dense dithering or smooth gradients. Full body upright balanced relaxed arms at sides, same front three-quarter direction as reference2. Design for entire visible body displayed at max128pt height, clear face/hair silhouette and readable large color blocks. Single character, generous transparent padding around complete ears/tail/boots. Actual transparent RGBA background. No background glow, halo, floor, shadows, text, panels, grid or additional accessories. Keep Hu's cheerful identity and green/cream/brown palette. Output one sprite, not a sheet.
```
