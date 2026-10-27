# S03l-b 原子关联审查

2026-10-27，Codex按北极星执行与报告阶段审查。首版Claude session82ffda11-565a-4d5f-aeda-6533422f9d1a/exec37917正常终态。生产190行/测试545行，可读性规模可接受，不增加新模块。Claude自述36PASS，不据此接受。

## r1实际diff发现

1. associateFacts只对left/right执行assertAssociableEntries，随后无校验迁移整组；违反计划“整组有效性”。已有第三持有者来源受限/过期/metadata不兼容时仍可进入关联。必须在事务内对所有组成员核对，再写任何关联变化；用真实share链、同来源另一条被删除的构造操作复现来源受限，而非仅SQL篡改。
2. mergeFactIdentities迁移歧义后即使仅余canonical单一身份仍保留conflict行，getAliasIdentity因此永久返回null。需要仅清理由此次合并实际消除的歧义，第三方身份必须原样保留；测试通过正式remember证明已确认身份的精确别名仍可复用。
3. 拒绝快照未包含sourceControls/legacyForget/derivations，成功FTS只比数量。补充对应内容Oracle；故障注入目前在条目迁移阶段，另补最后context写入失败，证明此前别名/控制迁移也回滚。
4. 构造冷萃与冰滴不是同一偏好，虽然本片不验证分类，仍不应使用语义错误Fixture证明等价执行。改冷泡咖啡；其余拟成功关联的Fixture选真正同义表达，业务Expected不变。

Claude先补能在r1复现的测试并保留失败日志，再修复、运行白名单。仍不得对外接线/模型/Git/版本/文档/GUI。Codex复验后再写正式Coverage结果。

## r2独立回归发现与r3小修订

Codex独立exec21841执行12个领域文件：123tests中122PASS1FAIL。失败POL-ANALYSIS-010未调用新关联入口；在HEAD090a7e4的git archive隔离副本单独复现同样FACT_NOT_HELD，原始日志evidence/s03l-association-source-head-before.log，证明不是本轮生产退化。夹具九次写入相同detail正文“旧理解”，第二次被已生效的原文防回流阻止，却仍按新key删除不存在条目。允许Claude仅修tests/acceptance/source-analysis.spec.cjs这一夹具为九个不同构造正文，显式检查每次created与实际删除，保留SOURCE_VERIFICATION_LIMIT、0请求、0额度、0记忆等全部业务Expected。隔离副本tools/memory-tuning/results/source-baseline.RCPEY8已清理，未改工作区生产文件。

此外r2末尾context故障测试在没有禁分享控制的Fixture上运行，空表一致不能证明控制迁移回滚。为两个拟合并身份分别restrictSharing后再取before，确保无论UUID排序哪组被迁移都存在实际限制；故障后检查原两限制及别名恢复，成功后保留canonical限制。只改测试，不改已通过的生产实现。独立复验适用原生产源码，测试变化后补关联/来源及unit，无需无理由重复全部领域。

## 最终独立验收

Claude r2 exec69105、r3 exec57492均正常终态；r2修复前9tests中7PASS2FAIL日志已保留，两个失败对应整组来源控制和别名歧义复用。r3仅修改两个测试文件，生产五源SHA与Codex首轮运行时一致（evidence/s03l-association-production-sha.json）。Codex exec21841的12文件123tests中122PASS1FAIL，最终r3两个变化文件20tests全部PASS（evidence/s03l-association-codex-r3.log），其余103tests源码与Expected未变，因此最终覆盖123个不同领域用例全部通过。npm test独立19unit通过，evidence/s03l-association-unit-codex.log；不是重复相加为143项。

| Contract | 实际覆盖 | 最终状态 |
| --- | --- | --- |
| POL-ASSOC-001 | 关联后正文/来源/FTS内容不变；两角色纠正同步、未知角色为空、重启与版本核对 | PASS |
| POL-ASSOC-002 | share/relay多跳身份组迁移，限制保留，第三方歧义不动；已解除歧义的精确别名由正式remember复用 | PASS |
| POL-ASSOC-003 | 关联后独属与默认删除，其他持有者清空、FTS清除、原文换key防回流与重启 | PASS |
| POL-ASSOC-004 | 过期/元数据/主题/推断/来源限制/缺失/旧版本/forget拒绝，整组第三持有者真实share+forget来源限制复现 | PASS |
| POL-ASSOC-005 | 条目迁移和最后context写入两处故障；真实双禁分享限制与别名完全回滚，重试一次生效、当前版本幂等、旧版本拒绝 | PASS |

新增执行器只在memory服务中定义与导出，搜索app确认没有IPC/HTTP或模型调用者；不向角色聊天暴露跨角色正文。正式模型语义核验、资格/预算接线、未知关联删除防回流仍未完成，原SEM不因这些受控Fixture变绿。本片不新增GUI，因此未跑GUI/真实DeepSeek，不冒称人工体验。生产净增217行，不增加新模块，测试约700行因真实数据库/分享链/故障注入较初始信号偏大，已按职责审查，没有通用测试框架或压缩写法。

本轮无新增进程常驻，测试临时SQLite按fixture teardown删除；隔离HEAD副本清理完成。完整Goal继续。后续核验层必须克服s03l-holdout的两项误合并，并使用本执行器而不是另写一套同步/控制迁移；其“可信等价决定”参数不是模型正确性的证明。对已删除身份的关联本片保守拒绝，仍需后续失效/防回流管线完成原产品目标。
