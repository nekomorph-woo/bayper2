# S03l-b 有界聊天来源上下文

2026-10-27，Codex按北极星受托确认，接续同协议两模型均误判的证据。目标是给后续中立核验提供可追溯原话和时间，不把记忆片段误当完整发言，不增加敏感正文副本。本片完成真实聊天→记忆→来源解析→纠正/删除后失效的纵向链；不发新增模型请求，不直接判等价。

## 实现契约

新增app/memory-source-context.cjs，createMemorySourceContext({db,memory,now})返回resolve({characterId,entryId,expectedVersion})和isCurrent(snapshot)。由app/store.cjs在chat初始化后用同一db组装为内部store.memorySourceContext；不新增IPC/HTTP/UI字段。只读现有表，不迁移/建表、不保存正文、不访问文件系统/网络/日志。

resolve只读取调用角色实际拥有、版本匹配、未过期、stated/user且非派生的条目。derived/relay/share必须返回来源不可用，不追溯其他角色原始私聊；这些角色已通过显式派生继承身份，不需重新揭露私聊。外部/主题/面板合成来源暂标unsupported，不能伪装为user原话，也不得越权打开外部目录。删除条目、跨角色、版本变更、受限来源、缺失chat来源均不返回正文。

直接来源只接受entry.sourceId精确等于chat:<messageId>且sourceVersion=1，对应chat_messages.id/source_id/role=user/character_id及chat_conversations.character_id必须一致。原消息正文必须包含entry.body原文（不删除标点/否定或把相似内容当依据）；找不到明确片段则unavailable。用户纠正后的直接chat来源可以按同样规则读取，旧source不回流；本片不扩张派生转为用户亲述的语义。

当前完整原话上限3000字符，超过则unavailable，不能截断可能改变指代的原话。最多补2条同一会话、同一角色、seq在当前之前的user消息；不读assistant、其他角色、其他会话或之后消息。每条不超过3000，总文字不超过6000。受限、过长或超预算的前文省略并明确contextIncomplete；查询数量固定有界，不为补齐无限扫历史。当前sourceCreatedAt来自实际消息，返回speaker=user及holder characterId供“我/昨天”的参照，但不据此认定所有被谈论的人都是用户。

成功snapshot包括当前记忆/来源/消息版本与标识、角色contextVersion、源时间、原文片段与有界messages、contextIncomplete及内容摘要；isCurrent通过重新解析核对版本/上下文/所返回消息内容摘要，删除/纠正/来源控制或原消息被改后旧snapshot失效。原始body/消息只在内存返回给内部中立核验层，不写日志，不给角色回复或新角色新增记忆。此方法不是权限隔离技术保证，所有调用仍须在现有授权和预算链路。

参数错误明确AppError；正常证据不可用返回无正文的status/reason，不能返回半份成功证据。原源缺失不能自动关联；不为本片新建持久缓存或后台。

## P0 Case v1（Codex受托确认）

| ID | Given/When | Expected/Oracle |
| --- | --- | --- |
| POL-SOURCECTX-001 | 真实chat.send构造模型提炼用户原话；从store.memorySourceContext.resolve读取并重启 | 返回实际user原文/片段/source时间/所属角色，最多2条前文；来源准确、无额外模型调用/新表/数据副本 |
| POL-SOURCECTX-002 | 不同角色/会话、assistant与后续消息、share/relay派生、外部/主题合成来源 | 不返回他人原话/助手/未来消息；不支持来源明确unavailable，正常同角色只限同会话 |
| POL-SOURCECTX-003 | 有效snapshot后正式correct/forget/keepExclusive或同来源其他条目被删 | 旧snapshot失效；当前受控/删除源无正文，原历史不被当恢复记忆来源 |
| POL-SOURCECTX-004 | 版本冲突、过期、错误sourceVersion/role/消息归属、缺失或body不含于原文 | 无正文unavailable；输入非法抛明确错误，不猜造原文 |
| POL-SOURCECTX-005 | 长原话/前文、超预算、来源消息修改、相同时间按seq排序 | 当前超长拒绝；前文有界且标不完整；相关原话变化使snapshot失效，时间/顺序由实际表证明 |

真实SQLite、正式store/chat/memory入口，模型只用本地HTTP构造响应，不访问远程/private用户资料。测试构造role与会话/消息不可绕过首次真实chat闭环；其他异常可用数据库故障fixture并说明。独立检查源内容/时间/版本、无副作用与清理。此片不宣称主体语义正确或原SEM完成。

## 派发

只允许app/memory-source-context.cjs、app/store.cjs小接线、tests/acceptance/memory-source-context.spec.cjs。生产约150～220行、测试约300～450行，不加框架/重复存储。只syntax及新测试、chat-memory-operations.spec.cjs、chat-exclusive.spec.cjs白名单，不GUI/远程API/环境配置/其他源码/Git/版本/文档。代码与测试全部Claude实现，Codex审查并独立验收后snap。

## 审查补充Contract

POL-SOURCECTX-006（P0，Codex受托追加）：真实chat完整原话谈论姐姐、evidence只包含“她喜欢蓝色”；resolve保留全文和短片段的区别，不判定偏好主体。修改快照excerpt、speaker、holder、source时间、上下文/条目版本、前文或原话但保留旧摘要，isCurrent必须false；未修改快照仍true。摘要覆盖所有核验语义字段并重新解析，不将摘要称为签名/权限机制。由r1审查实际发现驱动，原Case Expected保持。
