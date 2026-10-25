# 2D 像素桌宠动画技术预研

日期：2026-10-25，Asia/Shanghai。本轮是官方文档、X 作者原帖与公开项目材料研究，未制作 Bayper 角色、未安装新动画工具、未运行正式像素素材性能测试。不是产品设计或正式工程选型。

## 用户方向与研究结论

用户明确希望“高像素的像素风格，偏向2D，不需要3D”，并授权 Codex 根据这个方向自主研究。当前按**细节丰富、清晰且保留像素颗粒与轮廓的2D像素画**理解，不将“高像素”直接翻译成超大画布、平滑插画或高帧率。源尺寸与显示尺寸要结合可见效果选择，后续由 Codex 提供样例，用户反馈观感即可。3D 路线退出本轮范围。

优先验证路线是：**可编辑逐帧像素素材 → PNG 图集与播放元数据 → Canvas 2D 最小播放器；需要多角色或更复杂场景时再比较 PixiJS 8。** 这是下一步技术验证顺序，不是提前冻结 Bayper 的角色、动作清单、产品功能或最终技术栈。

骨骼动画保留为次要研究：只有能够保持目标像素画观感，或先烘焙并修整为逐帧素材时，才有比较价值。Rive/Spine/Live2D 不因为名字更专业而成为默认路线。

## 先区分四件事

| 层次 | 通俗理解 | 本轮分工与边界 |
| --- | --- | --- |
| 角色素材 | 翻页书里的每张画 | 原始像素画、分层、逐帧修改与动作节奏；写播放器不能代替画好每一帧 |
| 播放与衔接 | 决定翻哪一页、何时换动作 | Claude Code 实现可控播放器、时间推进、切换、中断与资源释放 |
| 桌面运动 | 整本翻页书在桌面上移动 | Electron/Tauri 的窗口位置、显示器与缩放；不等同于画布内部移动 |
| 外部状态 | 告诉播放器当前应表达什么 | Codex 主持业务边界与验收；Herdr 的状态恢复问题不由动画引擎解决 |

“原地走路循环”和“角色横向移动”需协调，才能避免脚在地面上滑动；素材脚底锚点、画布位置和窗口位置不能各自漂移。这是技术检查项，尚不定义 Bayper 要有哪些行为。

## 适合当前画风的路线比较

| 路线 | 实现方式与长处 | 成本与限制 | 当前判断 |
| --- | --- | --- | --- |
| 逐帧像素 + Canvas 2D | 按时长从图集中取帧，直接保留像素形状、阴影和逐帧节奏；依赖少 | 每个新动作需要真实素材；图集、锚点与时序需整理 | 最小技术基线优先 |
| 同一逐帧素材 + PixiJS 8 | 纹理、图集、AnimatedSprite、Ticker和交互设施较完整，便于多个Sprite共用纹理 | 引入渲染库与GPU上下文；少量简单内容不保证优于Canvas | 复用同一素材比较后再决定 |
| 2D骨骼制作后烘焙为逐帧像素 | 可以复用骨架制作动作，再导出帧并修整像素 | 烘焙后仍要检查像素簇、轮廓与接缝；制作工具不会自动赋予像素画质量 | 有素材证据后作为制作侧备选 |
| 直接播放Rive/Spine等骨骼/变形 | 连续变形与混合可控；适合某些矢量或分层角色 | 任意旋转、缩放、变形可能破坏像素网格与轮廓一致性；额外工具和授权条件 | 不作为当前像素风默认方案 |

PixiJS 的 AnimatedSprite 支持纹理序列与spritesheet中的动画定义，允许播放/停止和手动更新；其纹理视图可以共享同一图片来源。以上是官方能力说明，不是本机性能胜出证据。[AnimatedSprite](https://pixijs.download/release/docs/scene.AnimatedSprite.html)、[纹理生命周期](https://pixijs.com/8.x/guides/components/textures)

GIF/APNG/animated WebP 可做预览或简单循环，但单用图片元素时，不如显式播放器方便管理逐帧时间、停止点与动作衔接。GIF 的颜色/透明表达也有限，不宜把它当唯一母版；PNG逐帧/图集保留为可控运行资源，GIF/视频可另作演示。格式支持不等于本机WebView下的行为已验证。[MDN图片格式](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Image_types)

## 素材生产与可调度工具

### Aseprite：优先调查的像素制作工具

Aseprite 面向像素画与逐帧动画，可保留 .aseprite 可编辑源文件，按tag导出spritesheet。官方CLI支持无界面batch、导出PNG与JSON、按tag/layer等拆分，适合作为 Codex 调度、Claude Code 执行的素材流水线工具。[Sprite sheets](https://www.aseprite.org/docs/sprite-sheet/)、[CLI](https://www.aseprite.org/docs/cli/)

本机未在PATH或/Applications标准位置发现Aseprite/LibreSprite，没有据此声称全盘不存在；本轮未安装或购买。采用前核对授权、版本和输出。CLI能批量导出已有像素画，不等于它会自动创作高质量角色。Aseprite JSON与播放器结构必须实际核对，不预设任何导出JSON都可直接通用。

需要保留的交付信息包括：可编辑源、图集与帧矩形、每帧时长、动作tag、循环/一次播放信息、统一源画布、裁切偏移、脚底/视觉锚点、调色板与来源许可。丢失裁切偏移会导致逐帧位置抖动；把不等长帧强行均分会改变动作节奏。

### OpenDesign：原型、预演和返修，不默认承担像素资产生产

上轮已经实测其MCP派发、预览、审查与返修闭环。本机0.25.0还带motion-design、ui-animation、review-animations等资料；其中motion-design区分可交互HTML与演示视频，不能把导出MP4等同于可驱动的角色资源。这次只读了相关资料，没有验证像素帧或骨骼文件生产能力。

它适合承担像素风界面原型、动作节奏试样、播放器交互预演，以及按Codex反馈修改；不默认它能直接交付合格的逐帧像素角色、专业绑定文件或运行时性能。UI动效资料的“短于300ms”等规则也不能直接套给角色循环。

AI辅助绘图或代码绘图只改变生产方式，不降低验收标准：必须检查每帧同一角色、比例与轮廓、调色板、透明边缘、落脚位置及循环一致性。平滑矢量加像素化滤镜不自动等于用户想要的像素画。

### Codex Desktop 与 CLI：谁实际生成素材

当前采用 **Codex Desktop 当前会话的内置 imagegen**：这里明确提供生图与参考图编辑工具，便于连续审图、修改和呈现。角色位图创作由 Codex 执行，不属于项目代码；程序化绘图及素材处理代码继续交给 Claude Code。OpenDesign 保持原型与动作预演职责。

官方文档也支持 Codex CLI 自然语言生成/编辑图片和显式调用 imagegen，所以不能说“CLI只能写代码”或“CLI生图一定需要API key”。本机 CLI 为0.164.0，已检查命令入口，本轮没有在CLI实际生成图片；官方支持与本机成功执行分开记录。内置生图与另设 OPENAI_API_KEY 的 API 工作流是不同路径，不静默切换。[官方生图说明](https://learn.chatgpt.com/docs/image-generation?surface=cli)

选择 Desktop 是当前工具可用性与审图流程判断，不是两入口画质对照结论。正式制作时保存原始输出、参考图、提示词、迭代与导出信息；AI输出没有分层时如实记录，不把PNG重命名为工程源文件就声称可编辑源齐备。

### X 案例：多帧、多视角与多视图

2026-10-25定向检索后，用浏览器直接读取下面两篇X原文及一篇关联原帖；web抓取返回403不代表浏览器不可读。证据在本地 `evidence/2026-10-25-pixel-sources/`。没有登录、点赞或发帖；没有复刻作者角色、安装其skill或运行外部工程。

| 来源 | 核实到什么 | 对本项目的研究价值与局限 |
| --- | --- | --- |
| [Chong-U，2026-03-11](https://x.com/chongdashu/status/2031743032266043687) | 原文自报GPT5.4+Image1.5；固定认可帧，生成整段，再统一尺度、padding和锚点，放入引擎预览；展示过单帧独立缩放导致角色压扁的问题 | 值得测试“参考帧→整段→规范化”；不能以作者自述推导本机已成功或最新模型稳定性 |
| [852話，2026-09-09](https://x.com/8co28/status/2097423580229521849) | 原帖展示像素角色、GIF入口和图集缩略图；作者自报GPT-Image2.5，透明失败后另开对话做4×4切分、对齐与GIF | 证明此类公开案例及后处理步骤存在；本轮只看公开画面和说明，没有逐帧测量或完成连续播放验收 |
| [Todd Grilliot，2026-09-29](https://x.com/GrilliotTodd/status/2104670788637106326) | 原帖自述Claude调用Pixel Engine API制作等距行走循环，账号简介为该工具开发者 | 属于专用服务路线，不能当作纯ChatGPT/Codex内置生图能力证明 |
| [Scenario：Iso Cycles](https://www.scenario.com/explorations/iso-cycles/) | 制作者提供八方向示例及流程：图像模型出角度参考，视频模型制作各动作，再脚本抽帧、定色与镜像；五个生成方向加三个镜像方向 | 八方向输出未必是八次独立生成；这是混合流水线与厂商案例，本轮未复现，不能声称内置生图单独完成全部 |
| [Gorest开源仓库](https://github.com/NO6KIKO/gorest-2d-animation-spritesheet-generator) | README提供Codex辅助图集/预览流程，并描述16个水平方向×3个高度、共48视图的转台素材 | 能借鉴方向元数据和预览组织；48个角度不是48帧行走动画，也不是3D模型。未安装或审计源码，不能认可“game-ready”宣传为验收事实 |
| [Agent Sprite Forge](https://github.com/0x0funky/agent-sprite-forge) | 作者区分Codex CLI image_gen生成主图与后续图生视频、抠图、配准、循环、调色和导出 | 主图生成功能与动画能力必须拆开归因；仓库量化改善是作者报告，未独立复测，不直接引入其依赖 |

另发现 [HatchPet制作者实录](https://spacex.weilanx.com/episodes/ep04-codex-pet/)，将头像候选、动作选择图与正式宠物图集分开，说明多格动作参考仍需补齐方向、透明与包结构。可借鉴分步审查；这不是Bayper的格式规范，不在本轮调用ChatGPT/Work专属宠物skill或安装宠物。

原帖中的模型名仅按作者标注记录，不用于推断本会话实际生图模型，也不凭宣传判断接口、费用或稳定性。Higgsfield提示词回复等线索在本次浏览器未读到有效正文，未纳入直接核实案例。

以下是 Codex 据上述材料整理的**待验证方法**，不是社媒案例的普遍成功结论：

1. 先确定一张像素母版，再以同一参考制作多视图，锁定轮廓、比例、配色和左右不对称细节。视图用于身份检查，不直接按时间顺序播放。
2. 每次只验证一个方向的一段短动作。主提示词明确用途、同一角色参考、固定正交相机、格数/阅读顺序、动作关键姿态、透明背景、统一基线/尺度和循环要求；再分别只改变参考约束、格数、姿态幅度等变量作受控比较。不要把所有方向与动作一次塞入大图。
3. 将“4×4格”视为生成要求，实际量测输出尺寸、格数与边界；切帧及统一缩放由Claude Code实现。伸手/跳起改变外接框时，不逐格重新适配大小；真正的垂直运动也不能被机械脚底对齐消除。
4. 多方向分别检查同一动作相位、相机高度、阴影与服饰。镜像只适用于允许对称的素材；单侧饰品、文字和持物不能无条件翻转。
5. 放大检查像素网格/孤立噪点，实际尺寸检查可读性，连续播放检查体型漂移、闪烁、滑步和首尾接缝。AI视频抽帧路线作为对照，不能因画面流畅就省略像素质量检查。

后续预期流程为 **Codex生成/编辑候选图片→Claude Code处理与集成→Codex审查实际播放并返修**。用户只需观看结果和反馈体验，不要求手工画像素或理解资产参数；只有工具无法达到要求时，再由Codex调查额外修整方式。

### 骨骼工具的保留结论

Spine有官方PixiJS runtime，要求编辑器导出与runtime的major.minor匹配，且另有分发许可条件；因此不能只复制一个库就视为制作流程打通。[官方spine-pixi](https://esotericsoftware.com/spine-pixi)、[runtime许可](https://esotericsoftware.com/licenses/Spine-Runtimes-License-Agreement.pdf)

Rive官方提供CLI/RML，可配合Claude Code创建、验证和预览场景，支持生成.riv；本机未发现rive命令，未安装实测。其文档说明本地创建/预览/构建可不登录，但含脚本的Web资产需要publish，发布签名、账户与无水印条件需要单独核对。新工作推荐Data Binding而非旧Inputs接口；这些只证明可自动化的潜力，不能证明像素角色观感或离线分发条件已满足。[CLI概览](https://github.com/rive-app/rive-docs/blob/main/cli/overview.mdx)、[当前构建与发布规则](https://github.com/rive-app/rive-docs/blob/main/cli/getting-started.mdx)、[数据绑定迁移](https://github.com/rive-app/rive-docs/blob/main/editor/data-binding/migration-guide.mdx)

Live2D更偏分层插画变形，虽然有Web SDK，但当前像素画方向没有必要优先引入；没有安装测试。[官方SDK](https://docs.live2d.com/en/cubism-sdk-manual/cubism-sdk-for-web/)

## 像素清晰度的工程关键

- **素材像素、CSS尺寸和物理屏幕像素分别处理。** Retina/DPI和系统缩放可能使一个素材像素覆盖非整数个物理像素，出现粗细不一与移动闪烁；需要实际显示器下检查，不能只看导出图。
- **关闭不合适的平滑。** Canvas放大图片默认会平滑，可用imageSmoothingEnabled=false保留像素边缘；CSS的image-rendering控制元素缩放，不能替代Canvas内部采样设置。nearest取样、整数有效缩放和物理像素对齐要一起验证，不承诺一个CSS属性解决全部问题。[Canvas采样](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/imageSmoothingEnabled)、[CSS缩放](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/image-rendering)
- **动作与位移分开计时。** 例如一段每秒12张画的像素动作，可以在更高刷新率屏幕上移动；反复显示同一帧不会凭空增加中间画。显示刷新率不是动画质量指标，也不强迫所有素材统一60fps。
- **按时间推进而非按回调次数前进。** requestAnimationFrame跟随显示刷新率，后台/隐藏情形可能暂停；要用时间戳并处理休眠、恢复和大间隔，不能醒来后暴跳或补播长队列。桌面WebView的后台节流还需分别实测。[MDN rAF](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)
- **停下来时尽量停绘制，必要时低频播放轻微动作。** 不用高频渲染轮询Herdr，也不把业务事件处理放在每一帧；Ticker提供stop与帧率上限，但正确停启仍由实现负责。[PixiJS Ticker](https://pixijs.com/8.x/guides/components/ticker)
- **资源提前准备、按需释放。** 上传/解码、第一次切动作、换皮肤等可能形成尖峰；atlas尺寸、透明padding、边缘出血及裁切锚点要测，不能只比较下载包大小。[PixiJS性能说明](https://pixijs.com/8.x/guides/concepts/performance-tips)

以下只是RGBA8展开体积算例（宽×高×4×帧数），不是实际RSS/GPU测量；不含mipmap、图集留白、多份缓冲或纹理共享优化：

| 单帧尺寸 / 60帧 | 展开数据量 |
| --- | ---: |
| 128×128 | 3.75MiB |
| 256×256 | 15MiB |
| 512×512 | 60MiB |

宽高各翻倍会使这部分数据量变成四倍。“细腻像素风”不能简单靠无限增大图集获得。上轮小方块的Electron/Tauri资源结果不能外推到真实角色素材。

## 分工与下一步研究判据

| 参与方 | 负责什么 | 完成依据 |
| --- | --- | --- |
| Codex | imagegen位图生成/编辑与多视图、候选动画图集；技术路线、素材规格、调度、设计/动作审查与验收 | 图片审查及实际导入与连续播放，区分事实、作者自述与推断 |
| OpenDesign | 按任务制作像素风原型、动作节奏与交互预演，接受返修 | 实际预览；不以网页或视频代替正式像素资产 |
| Claude Code | 正式代码、可控播放器、素材导入/导出与校验脚本；经核实的工具调用 | diff、真实运行、相关检查；不自行扩大到通用动画引擎 |
| 绘图/像素编辑工具或按需制作 | Codex调度的逐帧修整、必要中间帧和源文件整理；按证据决定是否需要 | 同一角色真实素材及连续播放质量，不预设用户承担绘制 |
| 用户 | 审核产品方向与最终使用体验，反馈喜欢/不喜欢和具体感受 | 人工实际观看和使用；无需选库、格式或参数 |

后续优先用独立通用像素素材比较Canvas基线与PixiJS：同一素材、同一显示尺寸、相同动作时长，覆盖透明边缘、静止/移动、动作切换与中断、不同DPI、恢复后时间推进，以及首次加载/稳态/静止的资源；骨骼不作为当前必测前置条件。这是研究样本计划，不是Bayper动作清单或MVP设计。

用户只需反馈：像素轮廓是否清楚、角色是否有生命力、循环是否突兀、移动有没有滑步/发抖、动作是否烦人或影响工作。技术原因由Codex定位并组织修正，不要求用户诊断。

当前证据缺口：没有真实像素角色的跨Electron/Tauri测试，没有Aseprite CLI或骨骼生产实测，没有确认具体素材许可或估算制作报价，也没有保证OpenDesign能代替专业像素动画制作。结论只冻结研究优先级与协作边界。
