# S03d 审查

首轮CLI79074终态，session a956165f-0a0b-4606-9120-f7e6814be2cf；报告claude-s03d-explicit-sharing.json。生产净增175行，范围符合计划，尚未独立验收接受。

## 需要补足的真实边界

1. **直接讲述者不能依赖仍存在的父条目。** relay保存originCharacterId=A、derivedFromEntryId=B条目，但memory_derivations没有直接讲述者B的角色身份。B仅自己忘记后父条目删除，C只能知道原始来源A和不可解析的旧UUID，无法继续表达“听B说，原先来自A”。保留最小直接讲述者身份，在删除父正文后仍有效，不额外保留被删正文。核对旧库迁移可确定的信息，不捏造旧转述来源。补真实A→B→C后B自删除、重开、C上下文/列表仍保留B讲述+A原来源；C再次明确转述给D仍能说明直接讲述者C、原来源A。
2. **事务Case须真的在部分写入后失败。** 当前006插入触发器在唯一条目首个INSERT就失败，不能证明第二条失败时首条/FTS/派生回滚。增加两条合法转告，让第二条插入失败，或在上下文版本更新处失败；核对条目、FTS、派生、版本均不留半写。已有拒绝/回滚断言不删。

不是扩大到自然语言或自动共享；允许范围继续只有memory/memory-store及专属测试。补完后Codex独立运行相关56项并核对实际diff，正式UI仍不冒称完成。

## 返修与独立验收：本地领域切片接受

返修34593终态，报告claude-s03d-review-fixes.json。Codex检查实际diff：新增narrator_character_id只存直接讲述者，不存父正文；旧库只从仍存在的父条目补可确定身份，未知保持NULL。relay逐条核对entry/version与持有者，禁止控制跨同factKey持有者，保守share不放开派生转发；纠正不解除限制，单人忘记仍拦截回流。生产208增/9删，沿用现有事务，没有新框架；专属测试独立组织，部分写入失败由条件触发器明确保证先写入第一条。

Codex实际命令：`node --test tests/acceptance/memory.spec.cjs tests/acceptance/memory-sharing.spec.cjs tests/acceptance/chat.spec.cjs tests/acceptance/session-sources.spec.cjs tests/acceptance/source-analysis.spec.cjs`。工具会话76619退出0，58/58，0 fail/skip/cancelled；日志evidence/s03d-codex-domain.log，源摘要s03d-codex-source.sha。真实SQLite和正式业务服务，临时目录由测试关闭/清理，无GUI/网络/真实模型。

| 条件 | 实际观察 | 状态 |
| --- | --- | --- |
| POL-SHARING-001 | 单条投递、无旁带私人/工作记忆、C未知、名单数值不变、重复不增版本 | PASS |
| POL-SHARING-002 | 保守转发拒绝、显式A→B→C成功，原始来源/派生保留 | PASS |
| POL-SHARING-003 | 重开后禁止仍在、纠正不解除、显式独立解除；写控制失败回滚 | PASS |
| POL-SHARING-004 | 单人忘记后仍阻止回流；全局删除无正文控制、旧来源不能恢复 | PASS |
| POL-SHARING-005 | 旧版本/已删条目拒绝，已有不同内容不覆盖，未知角色无新记忆 | PASS |
| POL-SHARING-006 | 非持有者/未知接收者/自己/重复ID拒绝；第二条与末尾版本写入失败均完整回滚 | PASS |
| REVIEW-S03D-1 | B自删除重开后C保留B讲述+A原来源；C转D保留C讲述+A原来源 | PASS |
| REVIEW-S03D-2 | 旧库补可确定身份，缺父条目保持未知，不额外保存被删正文 | PASS |

Codex受托接受此本地领域切片。正式GUI、IPC可信用户授权、自然语言定位/转告、主题自动分享预算/资格、全局禁自动分享仍NOT_COVERED，下一切片需接线，不把服务成功当产品共享已交付。当前factKey关联不是任意不同键语义等价证明，后续语义纠正另验；上下文返回讲述元数据也不等于模型已自然正确复述，实际聊天需后续覆盖。
