# S06e 独立审查

80591终态。Codex独立运行story-progress四Case，4/4无skip/exit0，evidence/s06e-codex-first.log。实现复用真实活动/关系表、同事务进度与额度；并未接正式目录、邀请/解锁/主进程，不能作完整发现链路通过。

## 待补验：内容更新不能挪用旧进度

normalizeCatalog仅验证当前输入内部ID唯一；recordNode/selection按旧next_node_index读新目录，尚未看到对持久story的type/target/owner/theme和已记录node/fact前缀一致性核验。现有004的“目录冲突”是输入内重复fact，不是已有库与新版目录冲突。

POL-STORY-005：通过正式活动为storyS/targetB记录node1/fact1并关库，重开时同storyId分别改target/owner/type，或交换node顺序/替换已记录factId；必须明确拒绝冲突或把该故事标为不可用，旧事实/来源/进度不可被套到新身份。不能出现旧progress.target=B、下一候选target=C并继续成熟。仅增补未经历的后续节点、修改普通措辞不改变已有事实身份时可继续；素材暂不可用/重新可用与旧Case兼容。不建设通用迁移平台，按现有四表保存的事实与元数据做最小校验。先真实失败，再修正并回归五Case。

005修复独立5/5通过，evidence/s06e-codex-repair.log。select/recordNode身份保护符合预期；最终公开读取审查发现progressPublic仍直接从新目录读取nextNodeId，导致getProgress在冲突时混合旧target与新节点，或内容下架时无状态说明。请在同一005中补getProgress断言并统一公开状态：保留旧进度事实，冲突/缺目录不暴露新nextNodeId，明确unavailable原因；合法更新保持正常下一节点。不要扩大为迁移框架，其他行为不变。

## S06e 领域切片接受

95102已终态，公开读取修改前两条真实失败保留10-progress-read-before-fix.log；Codex独立5/5无skip/exit0（evidence/s06e-codex-public-final.log）。核对progressPublic：旧生命周期保留progressStatus，可用性与原因独立表达，冲突/缺目录nextNodeId为空，正常后续追加与素材恢复不阻断。记录/选择/公开读取对持久身份一致。

接受作者节点、全局额度、真实活动归属、来源合并、目录身份保护与事务回滚领域模块。586行生产/701行测试高于原建议，主要为四表事实、选择与目录一致性，没有通用迁移平台；后续重用时按职责整理。还未接正式作者目录、相遇邀请/接纳、服装解锁或main/GUI/模型。当前来源为构造数据，不能把此通过写成正式故事系统完成。
