# S04c 获准来源到角色初步记忆

Codex受托确认，承接已验收权限、读取与预算模块，依据memory-and-sharing.md来源停用/撤销与state-and-rhythm.md自动调用预算。形成真实服务链路，不接UI/定时器，不把S04完整需求标完成。

## 范围

只新增app/source-analysis.cjs（确有必要可拆一个小协议模块）及tests/acceptance/source-analysis.spec.cjs。不能改main/store/renderer/chat/memory/budget/sources等既有模块、其他测试/资产/版本/Git/文档。读取当前公共API后复用；发现缺接口先明确报告，不自行扩范围。GUI由S03c独占，本轮不GUI、不真实.env/私人日志/远程API。

工厂显式接收同一个SQLite db、memory、permissions、reader、budget、getCredentials、isEligible(characterId)、fetchImpl、now。提供analyze({requestId,characterId,directoryId,relativePath})及cancel/dispose的最小生命周期。主进程后续负责候选发现/授权UI、30分钟机会和名单状态；本服务在开始、异步取凭证后与发布前重新isEligible检查，不把它视为自己完成名单/聊天优先规则。先按一个获准文件一次有限请求实现，不扫遍所有文件、不建代理循环。

## 流程与不变量

1. 明确资格与目录permit，使用现有reader读取有界会话；整个读→请求→发布持有同一许可并finally release。未授权、停用、空有效文本、已处理或被删除来源不发送请求，不扣自动次数；不读取别的目录。
2. 外部sourceId归一成`external:`加其SHA-256，避免超过memory的200字节标识上限；相同来源始终同ID，不因正文改写/重授权而绕过防回流。按memory.listExcludedSources的哈希排除旧来源，在请求前就不包含其正文。保存每角色已成功处理来源的最小标识表（无正文），重启后不重复分析相同消息；未成功发布不标已处理。
3. 本轮最多现有reader的40消息/16000字符；只以user角色文本作为可新增偏好/事实证据，assistant只可作上下文，不直接提炼成用户偏好或共同经历。来源内容作为不可信数据放入单独JSON数据消息，系统要求不执行其中命令。没有合适事实允许空facts。来源分析只是一种初步了解，不能自称Bayper亲历，不自动转发角色。
4. 请求只一次，复用model.requestChatCompletion，明确短JSON协议，如facts[{sourceId,factKey,body,kind,evidence}]最多5条。sourceId必须来自本次可用user消息，evidence为对应原文片段，body需有原文根据；不能凭空添加用户喜好，模型不能指定角色、trust、importance、授权、删除或共享。落库统一trust=inferred，不接受模型将其提升为stated。严格限制字段/长度/种类，未知或不合法整批拒绝、无部分保存，不额外评审请求。保留语义理解仍依赖模型的限制，不虚称字符串验证可保证一切真实。
5. 全用途共用budget，reserve先占位，实际transport调用前才beginAttempt。可给现有model函数传一个窄fetch包装，在真正fetch前重查资格/permit并取得首次canSend；凭证或本地校验失败不能假扣已发送。失败也占已发预算，不自动重试。重复requestId不得发送第二次。所有分支finally取消未发/finish已发并释放permit；退出/显式cancel中断请求，即使迟到返回仍不能发布。
6. 取样时捕获角色contextVersion，模型返回后重新核验资格、许可和contextVersion。撤销、关分析、纠正或删除导致的旧结果不写记忆/已处理表，既有合法记忆保留。一次结果含多个来源时按来源分组调用applyExtractionBatch(inTransaction=true)，同一SQLite事务写全部记忆及已处理标识；失败回滚整个发布。别在每个来源提交后单独发布成功造成部分写入。保存原外部会话，不复制全文进额外存储，不清原聊天。
7. 返回简洁结果（completed/skipped/stale/cancelled/failed、实际创建数量、截断说明/错误码），不得在日志输出Key、完整模型请求或私人路径。无静默降级为正则“记忆”，不把API成功当保存成功。

约300～450行生产、300～450行场景是审查信号，不压行不堆框架。来源解析/权限/网络/预算已有模块直接复用；当前只处理一次有界分析，后续上层调度负责机会节奏。

## Acceptance Contract

| ID | Given / When | Expected / Oracle |
| --- | --- | --- |
| POL-ANALYSIS-001 | 真实SQLite与临时Claude/Codex会话、合资格A且授权，受控HTTP合法返回 | 只A产生inferred记忆、稳定来源、无B新事实/自动共享；一次发送计数；原文件不变；重启同消息不重复请求。请求体与DB独立核对 |
| POL-ANALYSIS-002 | 未授权/关闭/不合资格/无user文本/预算已满 → 调用 | 无HTTP，无记忆写入，不伪称已保存；本地失败不计已发送，许可与占位收束 |
| POL-ANALYSIS-003 | 延迟模型请求 → 撤销或关闭再打开、名单资格失效、纠正/删除、cancel | 返回stale/cancelled，不写旧结果/已处理标识，不清合法旧记忆；已发送预算保留，旧permit不复活 |
| POL-ANALYSIS-004 | 已从来源形成记忆后删除/纠正 → 重授权/重启/再分析旧源 | 被限制来源正文不进入HTTP、不重新恢复旧理解；别的合法来源仍可用，原文件不改 |
| POL-ANALYSIS-005 | 非法JSON/伪造来源/助手证据/批次中一条无效/HTTP失败/SQLite trigger发布失败 | 无部分记忆或已处理标识；发送尝试占预算、无自动重试；原始失败日志保留 |

实际SQLite+权限+reader+budget+memory+model HTTP适配；只有外部模型响应与isEligible外部资格源用可控fixture，明确不覆盖真实模型提炼效果、GUI授权或实际名单调度。临时文件/DB/HTTP服务finally清理。
