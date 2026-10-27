# S03r 用户明确要求记住：直接事实优先保留

2026-10-28，Codex master受托批准v1。父级S03/MEMORY-006，PRD来源`../Bayper桌面陪伴/memory-and-sharing.md`第17、19行。增量开发；前置S03q已snap79e3b92。不是整个自然语言记忆管理或自动整理完成。

## 证据与业务边界

Claude只读核查UUID476bbcd8-0415-4a0c-9eea-f7cc6288019f，结果/tmp/bayper-explicit-remember-inspect-20261028.json；master独立读chat.validMemoryCandidates/applyMemoryCandidates、memory.importanceOf/insertFactIfAllowed/correct。detail默认20，聊天候选不接收importance；同键同正文幂等不提升。不能把模型kind选择当作固定的重要性结果。

沿用已读源码依据memory-source-review.md及S03q锁定LangChain的时间/重要性分离机制，不引入新记忆产品或依赖。本批只接线用户明确优先保留，不更改检索算法。

## Part A：行为与接口

- 仅用户当前原话中的有效请求可提升优先级。支持请求框架与明确句首命令“请记住/帮我记下来/记住/别忘了”等直接事实；陈述、引用中的命令、假设、转述、助手话、否定记住或询问能力不得授权。引用事实可作为被用户外部命令明确指向的内容，不得把引用里的命令当授权。
- 将授权定位到事实段/证据片段，不能整轮只要含记住就提升全部候选。明确两个独立命令可分别处理；“另外/顺便”等无关事实不连带。若多事实或指代无法唯一定位，简短澄清，不声称已牢记；不得无说明地降级普通保存。首片直接事实与同键同正文覆盖，跨键改述、仅“刚才那件事”需后续语义关联/上下文方案，不冒称完成。
- 新事实仍经原grounding、原始用户来源、提炼批次门禁与同一聊天事务。模型输出的importance不能直接可信；只由本地已验证授权赋予至少80（复用DETAIL_CONTEXT_CONFIG.importantThreshold），不降低identity等更高原值。没有有效候选/事实冲突/被门禁拦截时如实未保存或澄清，不凭模型reply声称成功。
- 已有同角色、同factKey、同正文、同metadata且仍有效条目只提高importance，不造新条目；保持正文、kind、trust、原来源、createdAt/updatedAt、expiresAt及关系，递增version/contextVersion且重复调用不重复递增。不得调用correct冒充优先保留（其会改来源/时间及跨角色传播）。不跨角色或共享持有者传播“重视”决定。
- 来源排除、删除控制、临时到期/失效、并发版本变化等既有门禁保留；普通明确记住不等于解除删除防回流，不自动设置explicitConsent。不能把临时事实改成永久。与correct/forget/relay等已有操作并存时优先既有已授权操作并如实说明本片未执行，不能偷偷新建被删事实。
- 新增/提升与assistant确认及请求完成同事务，失败回滚，重试幂等。memoryApplied继续只统计新建；已有条目提升的确认须来自真实结果，必要窄返回updated计数，不伪造创建。
- 不新增API调用、后台定时器、数据库schema或GUI设置。优先复用已有分句/引号/请求检查；必要小模块可单独承担授权定位，避免将现有大文件再塞入通用自然语言框架。

## Part B：正式Case v1（均P0）

全部通过真实chat.sendMessage→SQLite→context；模型仅在本地HTTP边界构造，固定时钟/隔离临时目录并清理。人工Expected来自下表，不调用生产评分函数生成Expected。

| ID | Given / When | Expected与Oracle |
| --- | --- | --- |
| POL-REMEMBER-001 | 单个新detail，用户明确要求记住；随后时间前进并与3新普通细节竞争 | 新条目至少80，正文/来源正确，老重要条目仍入选；仅一次既有模型请求；无候选或失败不假确认 |
| POL-REMEMBER-002 | 引用命令、假设、否定、转述、助手内容、陈述或问能力；模型恶意附importance100 | 不发生本地优先提升；普通合法事实可沿既有保存，不把命令段当事实；有外部明确命令的引用事实另有正例 |
| POL-REMEMBER-003 | 同轮明确事实＋无关“另外”事实；两个独立明确命令；无法唯一指代的命令 | 精确提升授权事实，其他不变；明确两条均可处理；歧义如实澄清不假完成 |
| POL-REMEMBER-004 | 同键同正文旧20再次要求、重复request/再次请求；同键异正文/metadata | 只升优先级不改来源/时间/关系；version/contextVersion一次有效变更；冲突不覆盖；更高原值不降低 |
| POL-REMEMBER-005 | A/B分享或独属、来源排除/临时失效/删除控制、已有管理操作、事务失败 | 仅合法当前角色提升；不复活旧内容，不取消临时期，不绕过管理操作；失败无半写入/成功回复，重试幂等 |

Runner：`tests/acceptance/memory-explicit-remember.spec.cjs`，默认unit入口不混入。先保留真实缺失基线，区分fixture ERROR和业务FAIL。独立attempt保存命令、真实exit、版本/SHA、日志；相关chat/记忆/操作/细节回归，master独立复验。真实DeepSeek语义和GUI体验后续仍必需，不把构造模型视为产品全验。

## 派发与规模

允许app/chat.cjs、app/chat-memory-operations.cjs、app/memory.cjs及必要小app/memory-explicit-remember.cjs；确需memory-store.cjs窄写接口先反馈理由。新增上述Runner，不改旧Expected。生产约150～250行、Runner约400～600行作为审查信号，不压行凑数。先解释局部接线，不一次扩成通用语义系统；如约束互相冲突先给master反馈。禁止子代理、GUI/Herdr/真实API、Git/版本/文档改动；Codex负责文档、验收和snap。
