# S03h 独属保留服务审查

2026-10-27，Codex受托接受服务首片。CLI36138（e7c5c0b7-d704-4894-aa7e-4b578aa403e6）在/tmp/bayper-exclusive-em1C2Y隔离快照实现；实际diff仅memory.cjs新增keepExclusive及导出（约66行），memory-store未变；新增536行固定5Case，不搭框架。原报告声称唯一证据批次但没有给出落盘日志，副本也未发现对应文件；不采信为已存证据，以下以Codex独立运行落盘为准。

keepExclusive核对选中ID/版本，保留当前持有内容、清除同factKey其他持有者并写最小source/forget/share控制；同事务更新保留者条目版本与受影响上下文。已只有当前持有者且禁分享时幂等不变。来源使用既有派生表，不以父条目存在作为有效性的唯一条件。代码职责清楚，未改聊天、GUI、内容或全局设置。

独立隔离批次5+8+12=25/25通过，evidence/s03h-codex-domain-r1.log；选择性复制两文件后主项目65/65相关领域、18/18unit通过，evidence/s03h-codex-main-domain.log及s03h-codex-main-unit.log。memory-store内容与主目录完全一致，memory.cjs SHA b5ba9b6361d469be657a056460504d2c86a79af682d8f07e69784d2ef81c17a0；测试SHA effb90bfe69e1f944c3431a75263b619f21a9a4ee81ccc67a93194e93adec193。

| Case | 状态 | 实际独立观察 |
|---|---|---|
| POL-EXCLUSIVE-001 | PASS（服务） | A仍检索到，B正文/FTS清除，C无新增；A/B版本变，关系/名单/数值保持 |
| POL-EXCLUSIVE-002 | PASS（服务） | D→A→B中仅A保留，D/B清除；A仍听D说过，保留直接/原始来源，不能继续share/relay |
| POL-EXCLUSIVE-003 | PASS（服务） | 旧版本/未知条目/非持有者/缺少选中项拒绝，重复新版本调用幂等 |
| POL-EXCLUSIVE-004 | PASS（服务） | 中途删除与最后版本写注入失败均回滚正文/FTS/派生/控制/版本，移除故障后重试成功 |
| POL-EXCLUSIVE-005 | PASS（服务） | 旧来源、新来源历史提炼及转告不能回流，重开库仍受控，无关事实/控制保持 |

本轮只同factKey及既有派生链，未实现不同factKey语义归并；聊天和面板仍NOT_COVERED，在途完整对话失效另需接线测试。没有真实模型、GUI或人工体验，不以服务Case代表完整需求。后续须支持参与聊天外层事务、自然语言候选定位、本地面板与单次确认，再独立验收，不改原Expected。
