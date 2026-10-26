# s07 sleep-pixel-v2 显式区域导出与静态检查

日期：2026-10-27。范围：仅新增 `tools/sprite-pipeline/data/rin-sleep-v2-regions.json`、导出
`assets/characters/rin/animations/sleep-pixel-v2-canvas256/`、证据写入本目录。未改工具代码、生产代码、
文档、版本或 Git；未运行 GUI/播放器；未读取 `.env`；未修改源图。

## 实际命令

```bash
python3 tools/sprite-pipeline/sprite_pipeline.py \
  --source assets/characters/rin/source/sleep-pixel-v2.png \
  --columns 4 --rows 2 \
  --frame-size 256x384 \
  --output assets/characters/rin/animations/sleep-pixel-v2-canvas256 \
  --regions-json tools/sprite-pipeline/data/rin-sleep-v2-regions.json \
  --neutral-height 223 \
  --padding 8 \
  --durations-ms 350,350,350,350,350,350,350,350
```

工具输出：`已导出 8 帧，统一缩放 0.694704`，见 `export.log`。`--no-loop` 未传，manifest 为 `loop: true`。

只读检查使用内联 `python3 - <<'PY'`（未落脚本文件），完整结果写到 `checks.json`；检查内容为：源区域与
bbox 复算、输出 bbox/paste、最近邻源裁剪逐像素对照、安全边距、透明背景、atlas 拼回、统一缩放和 sit 参考对比。

## 锚与区域依据

- 源图为 1536×1024 RGBA，八帧实际排布与提示词不同：上行主体 y122–446，下行绝对 y609–931。
- 区域按实际内容分行：上行 `y100..470`，下行 `y590..950`；每帧横向范围同格内 `x..x+328`。
  上下行使用不同的区域纵向布局和不同接地锚，不沿用提示词 y440/952，也不使用自动站立脚带。
- `anchor.y` 取该帧最低 `alpha>16` 像素（鞋底实际落点）：上行 446，下行绝对 931。
- `anchor.x` 取该帧顶部 40% 轮廓带（头/耳/发顶）水平中点，避免尾巴伸缩把整体 bbox 中点带偏。
  该带不含尾巴；躯干带仍会被右侧尾巴污染，因此未用。
- 输出统一地面 `(128, 376)`。因全部帧锚在最低像素，`max_below=0`，用 `padding=8` 得到
  `output_ground_anchor.y = 384 - 8 = 376`；最低可见像素落在 376 线上，底边留白 8px。

## 源、配置与导出 SHA-256

| 对象 | SHA-256 |
| --- | --- |
| `assets/characters/rin/source/sleep-pixel-v2.png` | `9de834440d72c440be7397d78c64394fe7b88cc1e42c25f8917a0bef1a3aa12f` |
| `tools/sprite-pipeline/data/rin-sleep-v2-regions.json` | `9f5af1af1065e851484044be36e79eda740b6c315c6b304a848d96b6b88dbc28` |
| `.../sleep-pixel-v2-canvas256/manifest.json` | `286a9731f296bc153f8cf241e1ba1bd2d4582a30c35334b590c1cac580c63163` |
| `.../atlas.png` | `0451e59a30e8606820789aa0a8bf317475599a1f39771a34d8cadbfa9264d419` |
| `.../contact-sheet-light.png` | `e973785f8a05d799f53c4fc4e08dccca8954590b5db865b4070e6be5725ca97a` |
| `.../contact-sheet-dark.png` | `04041a5a0687e7b45cccd1027097b7954e1ce5a822707ad296022b9a25820336` |
| `frame-00.png` | `0e93ffe00b35957aff8df0cfb915d55abe95767cd05a61a5d1acd07c74c4dc99` |
| `frame-01.png` | `d98e661fd9f2c4c2bf0897aa8a07923771219c7247fcd7bbfe4635987d0b9d7e` |
| `frame-02.png` | `9987ef0b530a2a8782be5fcad834f31762e526c6c3babdb4220d8b89ddcf3cc7` |
| `frame-03.png` | `38749e9514c3af5d477abf9ae5025e4133ce0182206e33d626dba510c38e7a68` |
| `frame-04.png` | `6c468a5739b83b59dfa683bbf62bf0b267d0f09bc577f60b734695748714c2e7` |
| `frame-05.png` | `2f20257d3d1c66cf2151f181887d655d482359b6a818b372592dc25f9712d1fc` |
| `frame-06.png` | `d0bf48bd4696b5a1730d893853ac271d3378be38e25d1643662db16389b05973` |
| `frame-07.png` | `ab973e3abffcc2d779b11adf69d624ffc7a3b7841a062a6d8e05f074ebc1694b` |

源图导出前后 SHA 一致；manifest 记录的源 SHA 与复算一致。

## 每帧结果

`source bbox`、`anchor` 为源图绝对坐标；`scaled`、`paste` 为 256×384 输出坐标；边距顺序为左/右/上/下。

| 帧 | source bbox (x,y,w,h) | anchor (x,y) | scaled (w,h) | paste (x,y) | 边距 L/R/T/B | 最小边距 | α=0 / αmax |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 62,125,291,321 | 199,446 | 202,223 | 33,153 | 33/21/153/8 | 8 | 67845 / 254 |
| 1 | 449,125,292,321 | 585,446 | 203,223 | 34,153 | 34/19/153/8 | 8 | 67864 / 254 |
| 2 | 833,122,294,324 | 968,446 | 204,225 | 34,151 | 34/18/151/8 | 8 | 67611 / 254 |
| 3 | 1218,122,294,324 | 1355,446 | 204,225 | 33,151 | 33/19/151/8 | 8 | 67513 / 254 |
| 4 | 63,610,296,321 | 201,931 | 206,223 | 32,153 | 32/18/153/8 | 8 | 67452 / 254 |
| 5 | 447,609,296,322 | 586,931 | 206,224 | 31,152 | 31/19/152/8 | 8 | 67358 / 254 |
| 6 | 830,610,297,321 | 969,931 | 206,223 | 31,153 | 31/19/153/8 | 8 | 67451 / 254 |
| 7 | 1214,609,297,322 | 1354,931 | 206,224 | 31,152 | 31/19/152/8 | 8 | 67331 / 254 |

全部帧输出为 256×384 RGBA；atlas 1024×768，按 4×2 拼回后与逐帧逐字节一致。

## 完整性与透明检查

- 八帧 `checks` 全为 true：源 bbox 与 manifest 一致；输出 bbox 等于 paste+scaled；alpha 通道与
  源区域最近邻裁剪逐像素一致；可见像素（alpha>0）的 RGB 也逐像素一致；主体外全部 alpha=0。
  因此没有裁切、重绘或逐帧拉伸，只有工具 `alpha_composite` 把全透明像素的 RGB 归零（不可见）。
  首轮按 RGBA 全字节比较曾把这类 alpha=0 的 RGB 差异误判为失败；定位后改为
  “alpha 逐像素相等 + alpha>0 时 RGB 相等 + 透明像素 RGB 为零”，复算通过，未改动导出图。
- 每帧透明背景 alpha=0 像素约 6.73 万～6.79 万；不存在 1–16 的残留；17–254 为角色半透明/柔边，
  最大 254；没有 alpha=255。没有实底矩形或未清理的深底。
- 最小边距全部为 8（底边），左 ≥31、右 ≥18、上 ≥151。
- 八帧共用唯一 scale `0.694704`；按每帧源 bbox 复算的 scaled 尺寸与 manifest 全部一致。
- 头部带水平中点输出范围 126.5–128.5（相对画布中线 128 约 ±1.5px）；若改用整体 bbox 中点，
  输出范围为 133.5–135.5，整体偏右约 6–8px，且源图逐帧范围 5.5px 大于头部带的 4.0px
  （右侧尾巴伸缩）。实际采用的头部锚没有这种尾巴驱动的偏置。

## 与 sit-pixel-v2 参考对比

- 睡眠第 0 帧输出高 223px，与 sit 末帧 `frame-07.png` 的 223px 相等；
  两者输出地面锚均为 `(128,376)`。
- 睡眠统一 scale `0.694704`（neutral-height 223 / 源高 321）；sit 为 `0.697892`
  （neutral-height 298 / 站姿源高 427）。相对差 `-0.4568%`。这是不同源图的坐姿 bbox 高度
  321 vs 319 导致的四舍五入到同一输出高度，不是同一比例因子；若要求与 sit 的 scale 完全一致，
  需要 Codex 重新定 neutral-height（会使睡眠首帧变成 224px），本轮按“首帧 223px”执行。
- sit 末帧因 `padding=2` 且全组 `max_below=9`（第 4 帧最低点）得到地面 376，末帧可见最低像素
  在 378；睡眠把实际最低鞋底对齐到 376 线、底留白 8。两者地面锚相同，可见最低点差约 2px；
  这是“实际接地锚 + ground 376”与 sit 参考导出策略的差异，是否调整由 Codex 决定。

## 未验证事项与边界

- 未运行审查播放器或任何 GUI；未声称视觉通过。呼吸幅度、闭眼/发丝/尾部衔接、上行第 4 帧到
  下行第 5 帧的过渡、第 7 帧回第 0 帧的循环接缝，以及 128pt（0.5×）小尺寸连续播放，均需
  Codex 独立观看。
- 未验证在桌宠运行时中的真实导入、状态切换、与 sit 末帧的切换衔接、中断恢复和资源开销。
- 源图为独立生成的睡眠候选；身份、服装与像素簇是否与已确认基准一致，仍需 Codex 按
  `assets/characters/STYLE.md` 和小尺寸播放审查。
- 本轮静态检查全部通过；未发现的失败项不做篡改处理。若 Codex 要求不同的接地定义或与 sit
  可见底边严格对齐，应回到锚/区域配置调整后重新导出，而不是改源图。
