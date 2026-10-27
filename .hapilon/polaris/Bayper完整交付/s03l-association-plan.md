# S03l-b 已核实事实的原子关联

2026-10-27，Codex依项目授权确认，北极星增量切片。前置依据：s03l-holdout-review.md两次误合并，因此不能直接用v2模型判定生产写入。本片实现后续核验层需要的真实记忆事务能力，不改原SEM Expected、不声称语义判定已完成。

## 技术与边界

新增memory服务内部associateFacts({left:{entryId,expectedVersion},right:{entryId,expectedVersion},nowMs})，只供可信应用内核验层调用；不加IPC/HTTP/模型输出直接绑定。该方法是事实等价决定的执行器，不负责推断等价，输入的等价决定在本轮测试由已冻结构造Fixture明确提供。下一片必须完成主体/时间/来源核验后才能接生产模型；不得把此方法的存在当安全核验已完成。

在同一SQLite事务重新读取两条及其身份全组，拒绝缺失、过期、版本不符、不同kind/trust/sourceKind/expiry、主题来源、inferred与有效来源限制冲突；用同一现有业务校验方式，不复制来源权限系统。独立文本可以不同，保留每条正文/factKey/来源/派生记录，不创建任何新持有者，不用模型写的新正文覆盖。

选择确定的canonical身份，迁移所有组成员、严格指纹别名及歧义身份引用、禁分享限制。旧身份记录可保留无正文空壳，不创建递归重定向框架。别名中的其他第三方歧义不得被消除。身份级forget限制须保守处理：如任一待关联身份存在forget限制，本片拒绝整体关联，不因关联复活或删除内容；跨被删除事实语义关联仍待后续受控失效管线，不虚称已覆盖。

关联后每个实际受影响角色contextVersion仅递增一次，受影响条目version递增以拒绝旧请求，FTS/body不变；已同一身份按当前有效版本输入幂等不重复写/递增。更新别名和迁移控制都属于同一事务，故障整体回滚。条目/别名/控制已有函数优先复用，不建立第二套记忆库或一般图框架，不新增模型调用和定时器。

## Contract / Case v1

| ID | Given / When | Expected与Oracle |
| --- | --- | --- |
| POL-ASSOC-001 | A甜咖啡、B加糖咖啡，身份/key不同；可信内部关联，然后A明确纠正，重启 | 两组仅已持有者同步，C未知不新增；关联本身正文/来源/FTS/派生性质不变；context与条目版本按规则增加；纠正后B新正文、旧来源受限 |
| POL-ASSOC-002 | 两个事实及真实share/relay派生组；先禁分享其中一组，再关联 | 禁分享合并后仍对全部同义组有效，转告被拒绝；其他第三方身份/歧义控制不丢 |
| POL-ASSOC-003 | 关联后默认删除或独属 | 已关联其他持有者清除，原文别名换key重学受限，C无新增；真实SQLite/FTS和重启检查 |
| POL-ASSOC-004 | 任一条目过期/变更/消失、metadata不同、来源受限、inferred/theme、身份存在forget控制 | 明确拒绝、零正文/别名/版本/限制部分变更 |
| POL-ASSOC-005 | 关联迁移中注入数据库错误，再重复调用与重启 | 故障全部回滚；当前版本同身份重试幂等；成功只增每角色一次context；旧版本不可重放 |

Driver为真实memory.associateFacts及既有correct/forget/share/relay/keepExclusive入口，真实SQLite，固定时间和构造角色。无模型/GUI/目录访问；人工提供等价Fixture只是本片执行器边界，不是原SEM语义验收。实际diff、业务观察和执行日志由Codex独立复验。

## 派发

Claude读取AGENTS/CLAUDE及本计划后实施。允许app/memory.cjs、app/memory-store.cjs、必要小型app/memory-fact-association.cjs和tests/acceptance/memory-association.spec.cjs；不改原Case/旧Runner/产品接口/提示词/文档/版本/Git。生产增量约150～250行、测试约300～500行是审查信号，不压缩语句凑行。事务逻辑清楚，不为测试搭通用框架。不运行GUI/真实模型/网络。只运行本新领域测试及明确列出的memory-fact-identity.spec.cjs、memory-sharing.spec.cjs、memory-exclusive.spec.cjs；不得用通配符跑全套。遇到实际结构不能满足计划，具体说明再处理，不自行弱化限制。
