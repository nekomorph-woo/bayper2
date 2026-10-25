# 多动作、非 Herdr 事件与中断恢复实测

日期：2026-10-25。延续前期技术研究，不形成 Bayper 产品功能、角色或交互设计。Codex 按项目授权主持 polaris、制定最小技术合同、生成位图、审查和验收；Claude Code CLI 完成全部处理、播放器、控制器与测试代码。OpenDesign 本轮无任务：需要验证的是真实素材管线与控制器，无须额外原型。

## 结论

固定三动作实验的调度流程通过：真实 PNG 的 idle/wave/alert 可切换；画布点击、按钮、键盘与真实计时器均可触发；alert 保存并恢复 wave 的精确播放位置，重复请求不覆盖恢复点；reset 取消未触发计时器。素材一致性未达到正式交付质量，不能据此宣布桌宠动画完成。没有要求用户体验，本轮不记录人工通过。

本轮 14 张动作帧分属 6/4/4 三个 clip。素材帧数、单帧停留时间、屏幕刷新率和 Herdr 业务状态是不同概念。先前 Windows 项目 README 的 72 帧指 9×8 张格子素材总数，不表示 72fps；其 metadata 中 idle 只选 6 帧。参考：[README](https://github.com/ikundasdas/herdr-/blob/main/README.md)、[frames_meta.json](https://github.com/ikundasdas/herdr-/blob/main/assets/frames_meta.json)。

## 素材与实际管线

- 复用上一实验灰蓝猫四视图作身份参考；Codex Desktop 会话内置 imagegen 生成 wave/alert 各四帧。没有另开 API 计费流程。原图 1536×1024，4 列 2 行，各格 384×512，八格非空、哈希各异，alpha≥128 内容未触格边；最窄源图边距 11px，未完全满足提示词的 24px 留白。
- 原六帧 idle 图集逐字节复制并经独立比对。新八帧以第一 neutral 的 399px 可见高度对齐 idle 224px，全组共用比例 0.561404，NEAREST 缩放后平移到 256×256；没有逐帧拉伸来掩盖比例漂移，没有重画或阈值抠除背景。
- 新帧输出脚底中心实测 127.5–128.5px、底边全部 y=248。neutral 高 223–224px，警觉抬头后可见高 232px，保留动作本身的变化。处理前检查缩放 bbox 加平移后的范围，高 alpha 内容不裁切；低 alpha 边缘与统一尺度不等于正式像素网格合格。
- 原图、新图集、接触表、metadata、逐帧 bbox/offset/alpha/hash 与精确提示词保留在 `research/action-spike/`。`alpha_max=254`，没有全不透明像素；因此“semi 像素多”本身不能当作严重透明故障，仍需在目标背景检查边缘。

## 验收覆盖

| 项目 | 结果 | 实际依据 |
| --- | --- | --- |
| ACT-01 真实 6/4/4 素材与 metadata | PASS | Node 核对 PNG 路径、坐标、帧数与时长；真实浏览器 PNG 加载、Canvas 画面；独立 Pillow 锚点与文件对照 |
| ACT-02 多动作与非 Herdr 输入 | PASS | 画布点击进入 wave；按钮触发 alert；真实 W/A 输入触发并留下 keyboard 中断记录；一次动作完成回 idle |
| ACT-03 精确恢复 | PASS | Node 固定 wave900→alert900→wave900，再1500回idle；真实按钮13.8ms、键盘5.9ms及计时器1013.9/1284.4ms，中断/恢复记录逐项相同 |
| ACT-04 重复与低优先级 | PASS | alert 中 wave/重复 alert 留 ignored，不覆盖 suspended；Node 同时核对不延期、wave 不重启；浏览器最终没有额外重入 |
| ACT-05 真实计时器及取消 | PASS | 真实 1 秒 setTimeout 打断 wave，恢复后完成；另一次排程立即 reset，超过等待期后仍 idle、pendingTimer=false，reset 后无新 alert |
| ACT-06 reset 与大 dt | PASS | Node 真实共用 controller 按可变帧时长边界推进；单次大 dt 跨 alert→wave→idle，reset 清悬挂动作；浏览器取消待触发计时器 |
| ACT-07 视觉一致性与衔接 | PARTIAL / 正式素材 FAIL | 脚底与大体身份可保持，实际 Canvas 不同动作画面可辨；脸/尾/胸部轮廓和身体比例仍漂移，idle 与新增 neutral 不同，四帧挥手存在明显离散停顿。未验证自然平滑过渡，未声称人工认可 |
| ACT-08 证据与清理 | PASS | 测试页关闭，HTTP58437停止且无监听，CLI两轮均结束；保留本轮源素材和可复现研究代码、必要本地证据 |

## 代码审查与纠正

Claude Code 2.1.310，会话 `b757eb01-b5c6-4a6a-b625-8f6ef441dcd3`。日志确认开工读取 AGENTS.md、CLAUDE.md 和本轮合同。CLI 使用本机配置模型，不将 CLI 品牌误记为 Anthropic Claude 模型。

实现四文件约 600 行，较预计 350–500 行略多。独立审查认为职责清楚，增加部分主要是测量证据、DOM 状态与实际边界断言，没有通用框架或多层包装，保留可读性，不要求机械压行。共享 controller 用 advance 消耗时间跨越动作边界，没有每个 clip 的旧完成计时器。HTML 用一个真实事件计时器，并在 reset 清除。

发现处理脚本先 paste 再查 bbox，无法识别 Pillow 已经静默裁掉的像素；另有脚底坐标由源图推算而非输出实测。Codex 给出定位并退回 Claude Code 修正为 paste 前边界检查及最终画面锚点实测，随后重跑处理、Node 断言和独立 Pillow 对照通过。没有由 Codex 代改实现。

## 证据与边界

本地证据目录：`evidence/2026-10-25-action-spike/`。关键文件：`claude-task.md`、`claude-run.jsonl`、`review.md`、`claude-review.jsonl`、`source-check.json`、`source-anchors.json`、`independent-output-check.json`、`process.log`、`tests.log`、`browser-final.json`、`reset-cancel.json`、`browser-errors.json` 及实际 PNG 截图。浏览器错误日志为空；HTTP 的脚本、metadata 与两张图集全部 200；favicon.ico 为 404，无关播放资源。证据默认本地保留，不提交大量运行日志。

仅证明这三动作和固定抢占规则可实现。没有验证无界动作数量、任意嵌套中断、复杂优先级、后台节流/系统休眠、长期压力或产品事件接入。未接 Herdr、未创建系统桌宠窗口、未修改 Dock/Spaces/全屏设置。更多动作需要新增素材与规则，并按实际需求测试，不能从本轮外推为全部状态系统已完成。正式资源精修留待后续授权，不为本次研究扩张产品范围。
