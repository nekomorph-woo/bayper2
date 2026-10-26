# desktop-input

S07c 透明命中验收的专用输入与取点辅助。只服务 `tests/acceptance/s07c-transparent-input.spec.cjs`，不是产品运行时，也不是通用输入框架。

## 边界

- 只对调用方传入的坐标发事件；本仓库用例只使用本轮自建底板与角色窗口的坐标，不点击用户应用，不移动/关闭用户窗口，不切换 Spaces、锁屏或系统权限。
- 不安装全局钩子、不截图、不申请权限。`system-input.py` 只读检查辅助功能信任；未授权时返回 `trusted=false` 并以非零码退出，不弹系统授权提示。此时用例记录 `NOT_COVERED`，不用 DOM click 冒充穿透。
- 点击/拖拽是真实 macOS CGEvent，不是 DOM 合成事件；仍不代表人类亲手操作或长期体验验收。
- 每个工具（含坐标、脚本）都是本目录自包含的验收辅助；不读取 `.env`、用户数据库或模型 Key。

## 工具

### `system-input.py`

用途：向指定屏幕坐标发送真实鼠标事件，供真实双侧计数使用。

输入/输出（stdout 为单行 JSON，`ok` 表示执行成功）：

| 命令 | 输入 | 说明 |
| --- | --- | --- |
| `check` / `cursor` | 无 | 读辅助功能信任与当前光标（DIP 逻辑点，左上原点） |
| `move X Y` | 整数/小数坐标 | 发送 mouse moved |
| `click X Y [holdSec]` | 坐标、可选按住秒数 | move → left down → left up |
| `drag X1 Y1 X2 Y2 [durationMs]` | 起点/终点、可选时长 | move → down → 多次 dragged → up |
| `down X Y` / `dragto X Y` / `up X Y` | 坐标 | 分段按住，用于“按下后隐藏/换代再释放”的中断用例 |
| `restore X Y` | 原始光标坐标 | 用例清理时恢复用户光标 |

实现依赖 macOS `ApplicationServices`/`CoreGraphics` 框架和辅助功能信任；无第三方包。

### `alpha-probe.py`

用途：从实际导出 PNG 读取 alpha，按与生产相同的 display 缩放/裁剪公式给验收选点。

输入：stdin 的 JSON，包含 `threshold`（默认 16）与 `jobs`：

- `kind: "stable"`：`frames`、`display`、`window`，输出身体/透明稳定点及逐帧 alpha；
- `kind: "toggle"`：`frames`、`display`、`window`、`from`、`to`，输出该帧身体、目标帧透明的切换点；
- `kind: "switch"`：`fromFrames/fromDisplay`、`toFrames/toDisplay`、`window`，输出换角色前后“透明→身体”“身体→透明”的同屏幕点。

输出：stdout 单行 JSON（`ok`、`threshold`、`results`）；取点失败在对应 job 写入 `error`。依赖 Pillow（仅验收机需要）。

### `plate.cjs` / `plate.html`

用途：自建下方应用底板，记录真实 pointerdown/up、mousedown/up、click 与焦点状态，供“透明点击到达下方、身体点击不到达下方”计数。由验收用例通过 Playwright 启动，窗口尺寸/位置由 `BAYPER_PLATE_BOUNDS` 指定；不改变用户其它窗口。

## 证据

验收用例在 `.hapilon/polaris/Bayper完整交付/evidence/s07c-transparent-input/` 下排他创建唯一批次，保留失败/最终日志、alpha 取点、坐标校验、源码 SHA、截图与清理结果；不覆盖历史批次。
