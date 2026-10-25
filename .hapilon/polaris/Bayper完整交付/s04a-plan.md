# S04a 外部会话来源：发现与授权基础

Codex受托决定，依据PRD REQ-13及memory-and-sharing.md“来源停用与授权撤销”。最终仍需设置UI、会话解析、预算和记忆接线，本轮只交付可复用的权限基础，不能标完整REQ-13通过。与当前main/desktop/chat写者隔离。

## 技术核实

2026-10-26读取[Claude官方会话说明](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)：默认~/.claude/projects，CLAUDE_CONFIG_DIR可改变根；JSONL为内部格式，不保证兼容。只将其作为发现候选，不能因目录存在直接分析。读取[OpenAI官方rollout测试源码](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/common/rollout.rs)：sessions/YYYY/MM/DD、session_meta及response_item/user/input_text，且同一输入还可能存在event_msg/user_message；后续解析只选一种规范消息来源，不能重复计入。本轮不实现解析、不读真实私人日志。后续版本适配必须保留检测与不支持提示，不能猜测解析。

## 最小业务/接口

新增app/external-sources.cjs（确有职责需要才拆第二小文件），构造服务显式注入现有SQLite连接及候选目录配置；本轮禁止修改app/store/main/preload/renderer，后续正式接线复用同一DB。默认全局分析disabled，授权持久化，发现/授权/开关三个状态独立。

- discoverCandidates只检查显式候选路径是否为目录（或其realpath），返回provider、展示路径、可用性；不列出内部会话、不读取内容、不执行Agent、不网络请求。根目录配置由后续main根据已核实默认路径/用户选择传入，本轮测试全部临时fixture。
- setEnabled(false/true)持久化，打开分析不能自动授权。grantDirectory(provider,path)代表将来可信主进程收到用户明确确认后的动作；模块本身不声称能证明“人类点击”。授权绑定实际规范目录而非易被改指向的软链别名，保留展示路径/规范根与修订号，重复相同授权幂等。
- listGrants只返回授权状态/路径，不包含会话正文。revokeDirectory立即失效且可重启保持。撤销不删除已有记忆或外部文件，重新授权不操作memory防回流限制。
- issueReadPermit(directoryId)要求enabled且active且当前规范根仍对应当初授权目录；返回不透明给renderer的主进程令牌/快照，包含本地权限修订。validateReadPermit在开始读/分析前及发布结果前使用，检查当前enabled/授权版本/路径有效性；关→开、撤→再授权也不能使旧令牌复活。无须内建API调度或线程控制。
- resolveAuthorizedFile(permit,relativePath)只解析/验证文件路径，不读取内容：绝对路径、..逃逸、软链跳到授权根外、目录替换为软链等不能通过；普通授权内文件返回规范路径。目录消失/权限异常提供明确业务错误，不静默当作空日志。此函数不是免除后续打开文件时核验的安全保证，后续读取层还需处理TOCTOU；本轮不要虚构完全抵御本机恶意进程的隔离。
- 开关和撤销都必须先本地提交再返回成功；不能更新内存假报成功。无每轮模型请求，无watcher、后台扫描、全盘递归、外部SDK或加密框架。约200～300行生产、约200行测试是规模信号，超出先说明，不压行。

## Acceptance Contract（正式Case，受托确认）

| ID | Given / When | Expected / Oracle |
| --- | --- | --- |
| POL-SOURCE-001 | 独立SQLite+两个候选目录和内容文件，发现后重启 | 默认disabled、零grant；仅候选目录可用性，不返回/分析文件正文；测试真实目录及DB，不能用模型Mock代替权限 |
| POL-SOURCE-002 | 开启分析但无授权；授权A而不授权B | 无授权permit被拒；A可得到有效permit，B仍被拒；同目录重复grant不造多份权限，重启仍正确 |
| POL-SOURCE-003 | 已有A令牌，关闭再打开或撤销再授权 | 旧令牌始终失效，新授权后的新令牌可用；用真实DB重开验证而不只读返回值 |
| POL-SOURCE-004 | 授权A内普通文件与指向B的软链、../及绝对路径 | 普通文件路径有效，逃逸/外部软链均拒绝；不读取B正文，不删除任何fixture原文件 |
| POL-SOURCE-005 | 授权目录消失或被换成指向别处软链 | 不可再发/验证旧读取许可，明确失败，不能把同字符串路径当原授权；重新授权不改变已有memory表/防回流控制 |

Runner放tests/acceptance/external-sources.spec.cjs，使用node:sqlite与临时文件系统，所有目录清理finally。不碰真实HOME或本机Agent会话、不.env、不GUI、不真实API。Codex独立运行并审查，再派正式设置与分析接线。上述5Case只证明权限基础，不覆盖读取解析/在途模型提交/UI授权/预算。

补充Case POL-SOURCE-006（Codex基于实际审查受托确认）：Given同一目录两个有效许可，When显式释放其中一个、重复释放，以及SQLite trigger强制关闭/撤销事务失败；Expected仅被释放许可失效，事务失败后原开关/授权/其他许可仍有效；成功权限修订后旧令牌清理，重启不复活。Oracle为真实SQLite状态与许可API及释放返回，不以Map内部计数自证。Runner同external-sources.spec.cjs。
