# S03f 聊天中明确管理记忆：CLI 阶段证据

- 批次：`claude-20261027-s03f-r1`
- 日期：2026-10-27
- 执行边界：只运行 Node + `node:sqlite` + 构造 HTTP 模型响应；未启动 Electron/GUI/浏览器，未读 `.env`，未调用真实模型或真实服务，未改 Git/版本/文档/桌面/动画/故事/活动领域。
- 唯一证据目录：`.hapilon/polaris/Bayper完整交付/evidence/s03f-chat-memory/claude-20261027-s03f-r1/`

## 实际改动

- 新增 `app/chat-memory-operations.cjs`：候选短 ID、用户原话授权/引用/假设/否定/歧义判断、目标定位、本地确认文案与三个操作的调用。
- 修改 `app/chat.cjs`：单次既有模型调用增加可选 `memoryOperation` 建议；候选列表与系统提示；操作回合跳过 memoryCandidates；操作、确认回复与请求完成同一 SQLite 事务。
- 修改 `app/memory.cjs`：`correct` / `forget` / `restrictSharing` 支持 `inTransaction`，由聊天事务统一提交/回滚，不嵌套 `BEGIN`。
- 新增专属测试 `tests/acceptance/chat-memory-operations.spec.cjs`。未新增 tools 目录或其他业务模块。

生产净增约 569 行（新模块 479；`chat.cjs` 净 +81；`memory.cjs` 净 +9），高于规格的 250～400 行信号。增量主要是本地中文授权/目标定位规则和事务接线，未引入通用工作流引擎、向量服务或并行记忆存储；是否进一步拆分由 Codex 决定。

## 执行命令与结果

| 命令 | 结果 |
| --- | --- |
| `node --test tests/acceptance/chat-memory-operations.spec.cjs` | 10/10 PASS，退出 0；日志 `s03f-chat-memory.log` |
| `node --test tests/acceptance/chat.spec.cjs tests/acceptance/memory.spec.cjs tests/acceptance/memory-sharing.spec.cjs` | 41/41 PASS，退出 0；日志 `s03f-domain-regression.log` |
| `node --test tests/unit/*.test.cjs` | 13/13 PASS，退出 0；日志 `s03f-unit.log` |

专属测试每个 Case 的清理行都记录在 `s03f-chat-memory.log`：共 10 条 `S03F_CLEANUP`，均为 `dbClosed=true httpClosed=true tempDirRemoved=true`。HTTP server 使用 `closeAllConnections` 后关闭；临时目录删除后再次确认不存在。

## 覆盖的验收点

- POL-CHATMEM-001：A/B 正文同步纠正、旧来源失效、C 不新增；确认回复本地生成且与记忆/回复/请求同一事务时间；关库重开与 FTS 检索确认；青岛经历保留。补充覆盖否定与“最近”保留，拒绝丢掉否定/时效的模型改写。
- POL-CHATMEM-002：默认忘记删除 A/B；`只你` 强制 self 只删 A，B 派生来源与正文保持；旧来源再提炼与 FTS 重建不能恢复；无关记录、名单、数值、故事进度不变。
- POL-CHATMEM-003：禁分享跨持有者持久生效，重启后仍拒绝 relay/share；已有 A/B 内容保留；不自动解除；本地确认只说明限制后续、不声称撤回旧传播。
- POL-CHATMEM-004：两条相关事实时最小澄清；引用、假设、否定、记忆正文中的指令、越界短 ID、越权 `clearAll`、多动作均不改库且不展示模型假成功；正常命令对照实际删除。
- POL-CHATMEM-005：模型延迟期间本地修改使旧请求 stale；取消不展示迟到回复；同 requestId 重放不重复执行；重启遗留 pending 不执行操作；不学习迟到响应中的旧正文。
- POL-CHATMEM-006：助手回复写入失败和 request 最后一写失败都整笔回滚；解除故障后同一请求重试一次成功；无隐藏旧正文行。

## 源摘要

见 `source.sha256`（`app/chat.cjs`、`app/chat-memory-operations.cjs`、`app/memory.cjs`、专属测试）。规模统计见 `diff-stat.txt`。

## 未验证 / 明确边界

- 构造 HTTP 只证明本地授权、事务和响应处理；不证明真实 DeepSeek 的自然语言识别准确率。真实模型对照与真实窗口输入待 Codex 另行调度。
- 未运行 GUI/Electron/浏览器（S07b 独占 GUI）；未验证桌面聊天界面的展示与交互。
- 未覆盖：明确转告、仅当前角色保留的分享范围、全局自动分享禁令、不同 factKey 同义事实整合。
- 候选短 ID 只取当前角色重要性/更新时间排序的前 20 条；更早或更不重要的记忆不能通过本切片聊天定位，仍可用既有本地管理入口。
- “最近/暂时”等时效词保留在纠正正文中，未据此自动计算 `expiresAt`。
- 自然语言忘记后，操作回合的聊天消息仍作为会话历史存在；本轮只清除了记忆条目、FTS、记忆上下文和既有来源控制，未把当前聊天消息来源加入删除控制。
- 模型不可用时既有本地选中管理入口未改动，但本 CLI 批次未重新做 GUI 验证。
