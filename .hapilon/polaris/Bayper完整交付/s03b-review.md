# S03b服务首版审查

Codex独立6项服务测试通过，保留s03b-codex-first.log，但暂不接受。以下是实际源码风险，请先实际复现再最小修复，不改Case预期。

1. retryRequest 会把原userMessage.content再次作为最后一条user送出，即使该来源已被纠正/删除排除；buildMessages只过滤recent，不过滤重试原输入。重试前核验来源仍可用，否则不给旧文本外发，返回明确失效状态。测试失败请求含旧偏好→明确纠正/删除该来源→重试，不得向HTTP发送旧事实。
2. applyMemoryCandidates在聊天完成transaction之外提交。随后insertMessage或updateRequest失败，会显示失败但记忆已写；符合“失败不记住”的事务需要将同一SQLite所有结果原子提交。用真实SQLite trigger注入助手消息写入失败，断言记忆/请求/消息一致回滚，无半成果；修复注意现有memory内部事务不能简单嵌套BEGIN。
3. nowMs传给runModelRequest后始终为发起时间，completedAt及记忆createdAt忽略真实等待时间。完成时读取时钟，测试延迟期间可控时钟推进，完成时间正确，发起时间不变。
4. 同一requestId换conversationId或换text只检查characterId就返回旧结果。严格幂等应相同输入才重放，不同输入返回REQUEST_CONFLICT，不能把旧回答当新提问完成。
5. validMemoryCandidates的evidence只要是原话子串就允许任意body被标为stated，例如原话“我喜欢温茶”，evidence“我”，body“用户喜欢冰茶”。这不是语义审核。先明确最小可交付可信提炼策略：保留完整证据、不把宽泛引用当确认，不能自动把模型重述升级为用户明确事实；由你提出简洁修正并测试相反/无关body。不要为此新建额外每轮评审API或庞大语义框架，真实模型后续独立验收。

仅原授权store/chat/model/专属服务tests，允许必要memory事务兼容的窄接口改动但需说明并回归memory测试，不得削弱来源排除或角色隔离。不改UI/main/tools/Git/版本/文档，不GUI不真实API。明确覆盖边界，控制规模。
