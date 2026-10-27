# S03l-b 独立留出审查

2026-10-27，Codex受托主持并独立验收，沿用北极星增量路线。计划与事前Expected见s03l-holdout-plan.md；非人工体验，非产品完整交付。

## 实际实现与检查

Claude session8375cbdd-2f99-4533-a41c-7448bc381337、exec35771正常终态，报告evidence/claude-s03l-holdout.json。脚本净增12行、有限dataset选择及实际输入路径记录，新JSON325行；没有增加框架、修改提示/策略、产品代码、原数据或旧结果。Codex查看实际diff与16条数据，独立syntax/dry-run；默认baseline messages与已保存v2真实批次逐字相同。holdout零凭据读取/零网络、32个participants均null、Expected不发送。实际工具及数据SHA随结果记录并复核。

Codex exec65479独立真实调用，仅1models+1chat，无自动重试；/models确认deepseek-flash，models157ms、chat1452ms、总1610ms。原始失败见tools/memory-tuning/results/semantic-holdout-codex-live-v2.json/.log，dry与默认兼容检查结果在同目录。此批没有GUI、产品数据库、常驻进程或测试目录，无环境清理负担；Claude及真实执行均已终态。凭据未输出，证据实际Key核对在提交前完成。

## Acceptance Coverage Matrix

POL-SEM-HOLD-001由semantic-probe.cjs --dataset holdout驱动真实服务，输入/输出与逐项评分见上述JSON。

| 子项 | 实际 | 状态 |
| --- | --- | --- |
| 01～05 明确主体同义 | 全部equivalent | PASS |
| 06～10 主体/时间/否定/实体不同 | 全部different | PASS |
| 11 未知“我们”与相对日期的同文经历 | equivalent，Expected uncertain | FAIL |
| 12 “她”未消歧与明确用户偏好 | equivalent，Expected uncertain | FAIL |
| 13 上下位 | different | PASS |
| 14 故事与现实 | different | PASS |
| 15 相关偏好不等价 | uncertain | PASS |
| 16 注入 | different，无执行或泄密 | PASS |

总体14PASS2FAIL0ERROR，falseMerge=2、missedEquivalent=0、uncertain=1。Contract整体FAIL，不因14/16较高就接受生产判定。5个明确正例单次成功不证明中文通用能力；未验证来源混合、真实会话和长期分布。原SEM产品基线仍3PASS5FAIL，未修复。

## 受托决定与后续

保留工具及失败证据作为诊断成果，不接受v2模型建议直接触发全局事实合并、纠正或删除。冻结本轮Expected，不再针对这16项反复改提示刷分。两个失败说明只声明“参与者未知不得推断”不足；相同经历正文也不能证明同一事件。

下一最小设计必须使主体、指代与绝对时间证据可核对，且未知时不建立关系。优先在既有提炼里保留可校验的来源证据与有限关联建议；不能硬编码“我们/她”词表当作通用语义方案。生产提交仍需事实版本、来源有效性、角色可见范围及事务校验，模型建议与角色回复上下文隔离。复用现有低频机会和全局预算，不能另建无限后台或逐聊天额外调用。删除/纠正选中条目离线先生效，尚未确定的关联不得声称同步完成。

本次仅补前置证据，不修改PRD目标、不缩小Goal；当前无工具不可用阻塞。其他S06/S07/S08未完成范围继续保留。未发现Polaris实际流程缺陷，不为本次措辞改skill；发生有效修订时仍须先完整归档。
