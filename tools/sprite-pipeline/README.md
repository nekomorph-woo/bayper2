# sprite-pipeline

固定网格角色 spritesheet 的切帧、统一缩放和脚底中点对齐工具，并附带一个极简 Electron 审查播放器。工具不重绘、不补画、不自动染色；播放器只做审查，不构成视觉验收。

## 依赖

- Python 3
- Pillow（已用 12.3.0 验证）
- 审查播放器使用根目录已有的 `node_modules/electron`，不额外安装依赖。
- 自动验证复用根目录已有的 `playwright`，不新增依赖。

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
- `--neutral-height 298`：可选，以第0帧主体高度计算整套唯一缩放，用于与已确认动作对齐中性身高；所有帧仍共用比例。超出任一格安全留边时报错，不自动裁切。未指定仍自动fit。第0帧必须是适合比较的中性站姿，不能用跳跃/弯腰帧盲目匹配。

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

## 审查播放器

在项目根目录启动：

```bash
node tools/sprite-pipeline/preview.cjs \
  --manifest assets/characters/rin/animations/idle-v3/manifest.json
```

`--manifest` 接受任意本工具生成的 manifest，不硬编码素材路径。窗口约 720×620，按 manifest 的 `spec.frame_size` 以实际像素显示帧（idle-v3 为 256×384）。播放器读取每帧 `duration_ms`，用 `requestAnimationFrame` 推进，支持正常/0.25×速度、暂停、上一帧/下一帧、浅/深背景、帧号和循环数；关闭窗口即退出。

安全边界：`nodeIntegration` 关闭，`contextIsolation` 与 `sandbox` 开启；preload 只通过固定启动参数暴露已读取的 manifest 和本地帧 `file://` URL，没有任意 IPC 或文件接口。外部导航与新窗口被拦截。

`preview.cjs` 用 `fs.mkdtempSync` 创建本轮临时目录并传给 Electron 的 `--data-dir`，同时转发退出信号；Electron 退出或启动失败后由 launcher 同步删除自己的目录。`player.cjs` 只使用传入的 `userData/sessionData`，不负责创建或删除，也不写默认 Electron 用户目录。

自动验证入口：

```bash
node tools/sprite-pipeline/verify-player.cjs \
  --manifest assets/characters/rin/animations/idle-v3/manifest.json \
  --evidence tools/sprite-pipeline/evidence/player-evidence.json
```

脚本自行创建临时目录并传给播放器，在 `finally` 关闭 Electron 后同步删除并断言目录消失；同时按manifest时长检查循环推进或非循环末帧停止/重新播放，以及暂停、逐帧、0.25×速、背景切换、外部导航拦截和退出码，截图与状态日志写到 evidence 同目录。当前证据为 `evidence/player-evidence.json`、`.log`、`-light.png`、`-dark.png`。单项时长超过30秒验证上限会标记`covered:false`，不得把该项称为通过。这些只证明播放入口行为，不代替 Codex 实际观看播放。

## 测试

```bash
python3 tools/sprite-pipeline/test_sprite_pipeline.py -v
```

测试用构造的 2×2 小图验证切帧、统一缩放、脚底对齐、空格/触边报错、源文件不变和重复运行输出一致；另用尾巴左右伸缩但双脚不变的构造帧，验证输出脚位置不随整体 bbox 变化。测试不需要真实素材。

## 当前状态

已对 `assets/characters/rin/source/idle-v3.png` 实际导出并完成静态检查；此前 v1/v2 因格边触尾被拒绝。审查播放器已自动验证帧号推进、暂停、逐帧、0.25×速、深浅背景切换、单窗口与退出清理。Codex已通过真实窗口截图序列和逐帧操作审查身份、接缝及深浅背景，并操作0.25×播放；未冒称人类连续观看。默认时序的长期自然度仍待桌面集成复验。独立自动证据见`evidence/codex-idle-v3.json`。

## 按桌面实际尺寸审查

播放器及验证器支持 `--display-scale 0.5`（默认1，允许0.1～4），仅设置CSS尺寸，源帧和manifest保持不变。256×384源帧在0.5时为128×192 CSS点，仍为pixelated。验证器新增display-size证据，记录实际getBoundingClientRect、源尺寸及计算样式。

2026-10-26 Codex独立运行参数构造检查，并对rin/idle-pixel-v2运行0.5验证：实际128×192，循环、暂停、逐帧、慢放、背景切换及清理通过。证据`evidence/codex-rin-pixel-idle-v2-half.json`。这是工具能力与候选导入证据，不能代替连续视觉、跨动作和正式桌面合成验收。
