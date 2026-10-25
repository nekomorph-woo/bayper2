# Bayper 前期技术与产品调研

调研日期：2026-10-25，Asia/Shanghai。

本轮只有一个方向依据：**Bayper 是基于 Herdr 插件的桌宠应用**。以下记录现有技术能力、参考产品事实、代码发现与证据缺口，不构成 Bayper 的产品定位、功能设计、技术选型、架构或 PRD。没有开发代码，没有安装或运行参考插件，没有完成性能或桌面体验测试。

证据分为三类：官方文档说明、参考仓库代码事实、项目作者在 README 中的声明。静态阅读不能证明实际运行效果；下文推断单独标注。

## 1. 来源与阅读范围

用户提供的 [Herdr 中文文档入口](https://herdr.dev/zh-cn/docs/) 在本轮网页抓取工具中不可访问，因此核对了对应的英文官方文档。这是抓取限制，不据此判定中文站点已下线。

两个指定仓库的 main 在调研时分别指向：

| 仓库 | 调研基线 | 阅读范围 |
| --- | --- | --- |
| [hmu332233/herdr-pets](https://github.com/hmu332233/herdr-pets) | [710883b](https://github.com/hmu332233/herdr-pets/commit/710883b89ea1d101aceab290b971eb86e4a7e872) | README、插件清单、Agent 获取、应用入口、窗口、场景、宠物状态及素材清单 |
| [ikundasdas/herdr-](https://github.com/ikundasdas/herdr-) | [d3b7cdf](https://github.com/ikundasdas/herdr-/commit/d3b7cdf5b14d376f4c8d5bc52937957100552e9e) | README、插件清单、客户端、引导脚本、主循环、Windows 渲染器、帧元数据和素材说明 |

另外查阅三个相邻项目的公开 README，用于观察已有产品形态，没有审计其完整实现或实机验证其宣传。两个指定仓库的关键代码已用上述 commit 固定链接重新读取，确认与本轮 main 阅读内容一致。

## 2. Herdr 技术边界

### 插件与桌面程序的关系

官方插件是带 `herdr-plugin.toml` 的可执行命令包，语言和依赖由插件自理。插件 v1 不提供原生非终端 UI 宿主；原生桌面窗口由参考项目自行启动的 GUI 程序创建。插件命令以当前用户运行，Herdr 不对插件代码做 sandbox 隔离。[官方 Plugins](https://herdr.dev/docs/plugins/)

安装时可执行 build；本地 `plugin link` 不执行 build。startup 是 API 就绪后运行的一次性入口，不是 daemon supervisor；link/enable 本身不会补跑 startup。插件更新不会重启既有进程，脱离的后台进程还涉及旧安装目录清理问题。以上是官方生命周期约束，不能把“已安装”视为“已持续运行”。[官方 Plugins](https://herdr.dev/docs/plugins/)

### 状态与通信

| 已确认能力 | 事实与边界 | 来源 |
| --- | --- | --- |
| 当前状态查询 | CLI 与 socket 提供 Agent、pane 和 session 查询，也支持聚焦等控制；存在控制方法不代表桌宠必须使用这些能力 | [Socket API](https://herdr.dev/docs/socket-api/)、[CLI reference](https://herdr.dev/docs/cli-reference/) |
| 平台传输 | 本地协议为按行分隔的 JSON；Unix 使用 Unix domain socket，Windows 使用 named pipe；CLI 可屏蔽传输差异 | [Socket transport](https://herdr.dev/docs/socket-api/#socket-transport) |
| 变化通知 | 可以订阅 `pane.agent_status_changed` 等事件。历史不持久化，订阅不回放；落后可收到 `events_lost` 并断开，官方要求重订阅及权威快照对账 | [Event subscriptions](https://herdr.dev/docs/socket-api/#event-subscriptions) |
| 会话边界 | named session 各自有 socket；快照和事件不存在共享序列边界，不能假设缓冲事件可无条件重放到快照上 | [Socket paths](https://herdr.dev/docs/socket-api/#socket-paths)、[Event subscriptions](https://herdr.dev/docs/socket-api/#event-subscriptions) |

`idle`、`working`、`blocked` 来自 Herdr 的检测规则或 Agent 的状态报告。官方 Agents 文档说明，部分 Agent 通过屏幕底部内容识别状态；因此这些值不能直接当作业务任务成功与否的证明。[Agents](https://herdr.dev/docs/agents/#how-status-works)

当前官方集成文档特别说明：Claude Code 和 Codex 的 hook 上报 session identity，状态来自 Herdr 的 screen manifest detection。不能笼统假定这两者的每次状态变化都由原生生命周期 hook 直接报告。[Integrations](https://herdr.dev/docs/integrations/)

`done` 包含“已结束、尚未查看”的注意力语义：完成状态会保留到用户查看。它不是业务验收成功、测试通过或代码已提交的证据。元数据中的标题、summary 等又与语义状态分离。[State rollups](https://herdr.dev/docs/agents/#state-rollups)、[Agent state reporting](https://herdr.dev/docs/socket-api/#agent-state-reporting)

### 配置和发现

Herdr 注入运行环境与配置、状态目录路径，持久化文件格式和清理由插件负责。插件 marketplace 根据 GitHub topic 与 manifest 自动发现，不是审核认证。[Plugins](https://herdr.dev/docs/plugins/)、[Marketplace](https://herdr.dev/docs/marketplace/)

## 3. 指定参考产品对比

下表描述已有项目，不是 Bayper 功能清单。

| 维度 | herdr-pets | herdr- |
| --- | --- | --- |
| 平台与依赖 | manifest 声明 macOS，最低 Herdr 0.9.3，安装时用 swiftc 构建 | manifest 声明 Windows，最低 Herdr 0.9.0，使用 Python、tkinter、pythonw |
| 状态呈现单位 | 每个 Agent 对应一只宠物 | 单个桌宠聚合多个任务状态，并显示任务相关提示 |
| 用户可观察行为 | README 描述 blocked 时跑向指针、working 时游走、done 时庆祝，其余休息 | README 描述状态动画、提示音、气泡、单击定位任务、双击拉起 Herdr、拖拽记位置 |
| 设置与交互取向 | 菜单栏设置、角色选择、尺寸、活动区域、显示器、Reduce Motion；宠物 overlay 本身不接收鼠标 | tkinter 桌宠可点击和拖动；Windows 窗口激活逻辑与透明像素处理在渲染器中实现 |
| 观察证据 | README 与主要 Swift 路径均已阅读；未实机体验 | README 与主要 Python 路径均已阅读；未在 Windows 实机体验 |

来源：[macOS README](https://github.com/hmu332233/herdr-pets/blob/710883b89ea1d101aceab290b971eb86e4a7e872/README.md)、[macOS manifest](https://github.com/hmu332233/herdr-pets/blob/710883b89ea1d101aceab290b971eb86e4a7e872/herdr-plugin.toml)、[Windows README](https://github.com/ikundasdas/herdr-/blob/d3b7cdf5b14d376f4c8d5bc52937957100552e9e/README.md)、[Windows manifest](https://github.com/ikundasdas/herdr-/blob/d3b7cdf5b14d376f4c8d5bc52937957100552e9e/herdr-plugin.toml)。

### herdr-pets 的代码事实

- `fetchAgents()` 通过子进程调用 `herdr agent list` 并解码 JSON；应用以 2 秒 Timer 调度轮询，已有查询未完成时跳过。它不是持续 socket 订阅器。单次 CLI 挂起时有 10 秒终止逻辑。[Herdr.swift](https://github.com/hmu332233/herdr-pets/blob/710883b89ea1d101aceab290b971eb86e4a7e872/src/Herdr.swift)、[main.swift](https://github.com/hmu332233/herdr-pets/blob/710883b89ea1d101aceab290b971eb86e4a7e872/src/main.swift)
- `terminal_id` 用作宠物身份键；最多呈现 20 只，blocked 优先。动画按状态使用 15/30 fps 调度，全部静止时停止 Timer。这些是代码策略，不能等同于已测得的 CPU、内存或电池消耗。[Scene.swift](https://github.com/hmu332233/herdr-pets/blob/710883b89ea1d101aceab290b971eb86e4a7e872/src/Scene.swift)
- 独立 AppKit `NSPanel` 设置透明、floating、忽略鼠标事件和 nonactivating。支持多 Space 的窗口选项与按显示器保存区域，但具体全屏、Stage Manager 和不同显示器组合效果未运行验证。[Overlay.swift](https://github.com/hmu332233/herdr-pets/blob/710883b89ea1d101aceab290b971eb86e4a7e872/src/Overlay.swift)
- 所有 Herdr session 共用一把临时文件锁，源码明确标注只有首个 session 获得宠物。插件启动模式连续 15 次读取失败后退出；由于查询耗时和轮询跳过，不能把它解释为严格的 30 秒故障时限。[main.swift](https://github.com/hmu332233/herdr-pets/blob/710883b89ea1d101aceab290b971eb86e4a7e872/src/main.swift)

### herdr- 的代码事实

- 主循环默认 1500ms 轮询 `pane.list`；hook 向 `inbox.jsonl` 写事件，GUI 以 250ms 检查信箱并唤醒轮询。状态最终以重新读取的 pane 为准，不能据此声称端到端响应一定小于 250ms。[main.py](https://github.com/ikundasdas/herdr-/blob/d3b7cdf5b14d376f4c8d5bc52937957100552e9e/main.py)、[ensure_pet.py](https://github.com/ikundasdas/herdr-/blob/d3b7cdf5b14d376f4c8d5bc52937957100552e9e/ensure_pet.py)
- 当前聚合优先级为 blocked > working > done > idle。首次快照建立基线、不发通知；同 pane 同新状态具有 4 秒去重窗口。这说明它区分“当前显示状态”和“是否产生新提示”。[main.py](https://github.com/ikundasdas/herdr-/blob/d3b7cdf5b14d376f4c8d5bc52937957100552e9e/main.py)
- 客户端每次请求建立 named-pipe 连接，失败时尝试 CLI snapshot；snapshot fallback 只有读取路径，不能完成 pane focus。GUI 线程外执行阻塞 I/O，但 named-pipe 打开/读取仍缺少明确超时保障，不能仅凭异步线程认定不会卡住。[herdr_client.py](https://github.com/ikundasdas/herdr-/blob/d3b7cdf5b14d376f4c8d5bc52937957100552e9e/herdr_client.py)
- 引导使用 named mutex 保持单实例；配置与状态固定写入 `%LOCALAPPDATA%` 下的应用目录，明确忽略 Herdr 注入的独立插件目录。README 解释其历史动机是避免双份配置，这是一项实现取舍，不是通用 Herdr 要求。[ensure_pet.py](https://github.com/ikundasdas/herdr-/blob/d3b7cdf5b14d376f4c8d5bc52937957100552e9e/ensure_pet.py)、[herdr_client.py](https://github.com/ikundasdas/herdr-/blob/d3b7cdf5b14d376f4c8d5bc52937957100552e9e/herdr_client.py)

### 发现的资料差异

1. Windows README 称“糖宝皮肤”，但 `assets/LICENSES.md` 将 DeepSeek whale 描述为当前皮肤。两者不一致；本轮未检查运行截图及图像内容，不能据文字断定实际显示哪一版。[README](https://github.com/ikundasdas/herdr-/blob/d3b7cdf5b14d376f4c8d5bc52937957100552e9e/README.md)、[素材说明](https://github.com/ikundasdas/herdr-/blob/d3b7cdf5b14d376f4c8d5bc52937957100552e9e/assets/LICENSES.md)
2. `frames_meta.json` 的 `play_rule` 写三轮后回到 idle，而渲染器明确使映射状态持续播放，主循环也维持 unread done。运行逻辑与素材元数据描述存在差异。[帧元数据](https://github.com/ikundasdas/herdr-/blob/d3b7cdf5b14d376f4c8d5bc52937957100552e9e/assets/frames_meta.json)、[pet_render.py](https://github.com/ikundasdas/herdr-/blob/d3b7cdf5b14d376f4c8d5bc52937957100552e9e/pet_render.py)
3. 两个仓库的 GitHub metadata 均返回 `license: null`。本轮未确认完整代码的通用复用许可证；不能把公开可读当作已核实的复用许可。macOS README 标注品牌角色为 fan art；Windows 素材说明另有历史素材和不再分发的资源记录。这里只记录许可信息缺口，不作法律结论。[macOS 仓库](https://github.com/hmu332233/herdr-pets)、[Windows 仓库](https://github.com/ikundasdas/herdr-)、[Windows 素材说明](https://github.com/ikundasdas/herdr-/blob/d3b7cdf5b14d376f4c8d5bc52937957100552e9e/assets/LICENSES.md)

## 4. 相邻产品样本

以下均是作者公开资料中的能力声明，尚未独立运行验证；它们也不构成“市场上全部产品”。

| 样本 | 作者描述的已有形态 | 状态接入与技术信息 | 本轮能证明什么 |
| --- | --- | --- | --- |
| [ifBars/agent-pets](https://github.com/ifBars/agent-pets) | Agent 状态桌宠、手动桌宠、兼容 pet.json 与 spritesheet | 多 provider；Claude hooks 状态文件及本地元数据 fallback；另有 JSON 状态文件模式 | 存在把动画包与状态来源分离的公开产品；不证明各 provider 可靠性 |
| [ntd4996/agentpet](https://github.com/ntd4996/agentpet) | Agent monitor 与桌宠结合，另含 XP、成长、成就和可选联网服务 | README 描述 macOS 用 Swift/SwiftUI，Windows/Linux 用 Tauri；本地 hooks/daemon 接入 | 状态监测与养成叠加的形态已经存在；不证明用户需要或长期使用这些能力 |
| [zlmind/code-pet](https://github.com/zlmind/code-pet) | README 称 Clawd：像素桌宠、多 Agent 接入、主题和远程接入 | Electron，hooks/插件集成，发布多平台安装包；README 中还有指向 clawd-on-desk 的链接 | 现有项目也直接接多种 Agent；不能仅凭该 README 判断仓库间的维护和派生关系 |

研究推断：目前可以观察到 Herdr 状态复用、直接接各 Agent、通用状态文件等不同接入方式，以及独立宠物和附带监控面板等不同形态。这只说明已有解法多样，不意味着某一种更适合 Bayper。

没有做用户访谈、留存或安装量分析、定价分析。没有用 star 数或作者的“轻量”“实时”等表述推断市场需求、性能或体验质量。

## 5. 目前成立与尚不成立的结论

**有文档和代码支持：** Herdr 提供可供桌宠复用的 Agent 状态查询与事件表面；指定项目已实现“插件入口启动独立 GUI 进程，再把 Herdr 状态映射为桌宠表现”的代码路径。macOS 与 Windows 存在各自实现，但两个项目都没有以同一套代码证明跨平台行为一致。

**本轮没有证明：** 本机运行兼容性、端到端状态准确率、通知时延、CPU/内存/电池消耗、桌面遮挡与误触、安装成功率、退出及升级后的后台进程清理、多 session 合并行为、素材可复用范围、用户长期价值。

技术证据缺口包括：目标 Herdr 版本对应的实际 schema 与 CLI 输出、真实 Agent 状态变化及 done 的读取清除、订阅丢失和重连、多 session 与重复启动、系统休眠/唤醒与显示器变化、打包和分发环境。这是待调查项，不是实现计划或产品需求。

本轮停留在 PRD 前期研究。尚未定义 Bayper 的目标用户、核心场景、功能范围、交互、商业模式、MVP、成功指标或正式技术方案。
