# sprite-pipeline

固定网格角色 spritesheet 的切帧、统一缩放和脚底中点对齐工具。只处理位图素材：不重绘、不补画、不自动染色，也不包含播放器或视觉验收。

## 依赖

- Python 3
- Pillow（已用 12.3.0 验证）

## 命令

在项目根目录运行：

```bash
python3 tools/sprite-pipeline/sprite_pipeline.py \
  --source path/to/sheet.png \
  --columns 4 --rows 2 \
  --frame-size 256x256 \
  --output path/to/output
```

源图由命令行显式给出，工具不硬编码 PRD 或素材目录。默认参数：

- `--alpha-threshold 16`；
- `--padding 8`，脚底到画布底边、主体到其他边的最小安全边距；
- `--durations-ms 650,180,250,80,110,80,180,350`，这是 8 帧呼吸试样的元数据初值，不代表已验证自然；
- `loop=true`，传 `--no-loop` 可改为 `false`。

帧数不是 8 时必须显式传 `--durations-ms`，数量需等于 `columns × rows`。

## 处理规则

- 源图需为 RGBA 或 LA，按 `columns × rows` 等分。
- 尺寸不能整除、格子为空、主体 bbox 触到格子边界（可能跨格）或缩放越界时，命令以退出码 2 报错，不猜测吞掉。
- alpha ≤ threshold 的像素按背景处理；其余 alpha 保留原值，不重绘、不补画、不染色。
- 脚锚取每格底部 12% 高度区域的 alpha 主体水平中点，纵坐标为 bbox 底边。该模式只适用于双脚着地的站立素材；尾巴低垂进入底部带、趴卧或道具低于脚时不适用，未来用显式锚点另行支持。
- 所有帧共用一个缩放系数，按各帧相对脚锚点的左右最大扩展和上方最大高度适配画布与 `padding`，避免尾巴伸缩改变脚的位置或造成裁剪。
- 每帧把源脚锚点整数平移到画布水平中线（`frame_width // 2`）与 `frame_height - padding`；不逐帧拉伸。
- 源图只读，不写回；`manifest.json` 记录源文件 SHA-256。输出目录中的已知产物文件名会被覆盖，不清理其他文件。

## 产物

- `frame-00.png` 等：逐帧 RGBA PNG，尺寸均为 `frame-size`；
- `atlas.png`：按 `columns × rows` 拼回的图集；
- `manifest.json`：源哈希、网格/画布/阈值/统一缩放、`padding`、脚带比例、每帧源 bbox、源脚锚点、输出脚锚点、缩放后尺寸、粘贴位置、时长和 loop；
- `contact-sheet-light.png`、`contact-sheet-dark.png`：浅/深棋盘对照图，仅用于检查透明边缘和帧位置。

## 测试

```bash
python3 tools/sprite-pipeline/test_sprite_pipeline.py -v
```

测试用构造的 2×2 小图验证切帧、统一缩放、脚底对齐、空格/触边报错、源文件不变和重复运行输出一致；另用尾巴左右伸缩但双脚不变的构造帧，验证输出脚位置不随整体 bbox 变化。测试不需要真实素材。

## 当前状态

已对`assets/characters/rin/source/idle-v3.png`实际导出8帧并核对源哈希、脚锚点及深浅背景合成图。此前v1/v2因格边触尾被拒绝。contact sheet只证明静态检查，不能代替播放器体验；默认时序仍未经播放验证。
