# 本机 OpenDesign 调度可行性

日期：2026-10-25，Asia/Shanghai。用户希望把原型生成交给本机 OpenDesign，由 Codex 调度和独立审查。本次仅验证工具能力，不进行 Bayper 产品设计。

## 安装与接口

本机 /Applications/Open Design.app 为 0.25.0，Bundle ID io.open-design.desktop。它打包了 CLI、daemon 和 MCP server；系统 PATH 没有 od 命令，但可直接使用应用内 app/prebundled/daemon/daemon-cli.mjs。

通过实际 --help 确认 CLI 支持 MCP、导出、lint、artifact、automation 等入口。应用的“设置 → OpenDesign MCP”提供当前本机连接配置。首次直接运行 mcp 因缺少 runtime 连接发现而失败；按设置页的 OD_DATA_DIR 和 OD_SIDECAR_CLIENT_ENDPOINT 建立临时连接后，initialize 与 tools/list 成功，实际发现22个工具。没有安装插件、修改Codex全局MCP配置、更新OpenDesign或读取用户已有项目文件。

已发现的关键工具：create_project、start_run、get_run、get_artifact、get_file/list_files/search_files、cancel_run、list_agents，以及删除自己测试项目的delete_project。可发现不等于全部已验证，本轮只验证下列固定闭环。

官方说明也将 daemon/CLI 列为面向 agent、shell 与 CI 的运行入口，但官方最新网页不代表本机0.25.0的全部能力。[官方入口](https://open-design.ai/official/)、[官方仓库](https://github.com/nexu-io/open-design)

## 独立样本与实际结果

只创建 codex-opendesign-probe-wvdsmd（“调度连通性验证（可丢弃）”），与原有项目隔离。通过 list_agents 实际发现 Claude Code 2.1.310 后，显式指定其作为执行者，模型使用既有CLI默认配置，不把CLI品牌当作底层模型名称。样本是一个中文状态卡片：标题、Ready、展开/收起按钮；单文件HTML、无依赖，适配240px，不包含Bayper功能或视觉决策。

1. create_project 返回项目与conversation ID。
2. start_run 返回run ID，get_run观察到running及其Claude Code子进程；首轮随后实际succeeded、exitCode=0。
3. 返回可用的previewUrl与artifactRef；get_artifact省略entry时提示缺少入口，按artifactRef显式传entry=index.html后成功取回91行源文件。不能假定项目默认入口已自动设置。
4. Codex打开真实预览，检查标题、状态、按钮层次；实际点击展开、Escape收起、Enter展开均得到可见结果。
5. 独立发现布局问题：740px视口下收起宽238.23px、展开宽359.99px，会横向跳动。视觉上层次基本清楚，但无实际意义的“LOCAL · NODE 01”装饰行增加噪声。
6. 通过第二个start_run在同一项目、同一conversation下发具体返修：稳定桌面宽度、适配240px、去掉装饰行、保留键盘与焦点样式。此处由OpenDesign管理的Claude Code改文件，Codex没有自行代写原型。

首轮run：a69e93b3-71f8-4bb2-a0e9-b3d283c50ecf；返修run：85c93918-e72d-402c-bc82-a22f29a7fa04。每次使用独立且固定的requestId；状态不明时不能换ID重复启动。一次长JSON因临时PTY的canonical输入限制未完整送达，清除未提交输入后改用短规格，确认只接受了一个首轮run；不是OpenDesign生成失败。

返修run实际succeeded、exitCode=0；get_artifact再次取回87行最终HTML。Codex重新加载预览并独立复验：

| 条件 | 实际结果 |
| --- | --- |
| 740px CSS视口，收起/展开 | 均为359.99px，宽度跳动消除 |
| 240px CSS视口，收起/展开 | 卡片约216.01px，document scrollWidth=240，无横向溢出 |
| 键盘交互 | Enter/Space展开、Escape收起，真实DOM及aria-expanded随之变化 |
| 视觉审查 | 无意义装饰行已移除；标题、状态与操作层次清楚，保留可见焦点环 |

浏览器缩放比例为1.3；viewport override按实际innerWidth校准，表中尺寸是实际CSS视口，不把传入的物理宽度当CSS宽度。完整metrics与结果截图已保存。本次小卡片不能代表复杂原型的设计上限，也不是正式产品体验验收。

闭环已实际完成：新建隔离项目 → 派发 → 观察running/succeeded → 取源文件与预览 → 独立发现问题 → API返修 → 再取产物 → 视觉与交互复验。没有用write_file替它完成设计，也没有把Agent的自述当独立通过证据。

## 对协作方式的判断

技术上适合分工为：Codex给目标、范围、风格约束和验收标准；OpenDesign生成可运行原型；Codex看实际渲染与交互，给出具体返修点并复验；正式项目实现仍按仓库约定交给Claude Code。

Codex可以采用设计师的评审标准检查信息层级、排版、间距、颜色、状态、交互和响应式，但不能把模型审美判断冒充人类用户体验或自动产品认可。OpenDesign的succeeded只代表运行完成，不代表设计合格，首轮宽度跳动就是本次反例。

本轮不评估复杂产品、多页面原型、长期会话恢复、图片/视频生成、云端模型、费用或商业设计质量；cancel_run与导出等工具虽可发现，但尚未实测。当前连接是临时CLI/MCP调度，不是已在Codex原生工具列表中永久注册。

## 证据与收尾

本地证据 evidence/2026-10-25-opendesign/ 包含MCP原始回复、首轮/返修HTML、browser-metrics.json和review-card.png。原始证据不入Git，正式记录入Git；不会在报告中保存连接凭据或用户既有项目内容。

归档后仅调用delete_project删除本次明确创建的测试项目；返回ok=true，再get_project实际返回no project matches，目录也已不存在。关闭测试预览、重置浏览器viewport、退出临时MCP连接（退出码0），并把OpenDesign返回首页，原有项目仍在。未改CLI选择、API提供商、全局MCP注册或应用版本；OpenDesign本体保持运行供用户继续使用。

协议文件归档后删除/tmp/bayper-opendesign-spike-WVDSMD。应用自身的运行历史与审计记录由OpenDesign管理，不把删除测试项目宣称为系统中绝无历史痕迹。
