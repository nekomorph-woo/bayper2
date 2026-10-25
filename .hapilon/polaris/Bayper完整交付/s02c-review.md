# S02c 关系数值独立验收

Codex受托接受此数值基础切片，完整聊天/活动事实接线未完成。

53449终态后，独立执行node --test tests/acceptance/relationship-effects.spec.cjs tests/acceptance/companionship.spec.cjs，exit0，23/23；日志evidence/s02c-codex-first.log。4个关系场景使用真实SQLite和companion，包括真正关闭重开DB、跨日重放、每日两类额度、自然恢复余量、回拨锚点及trigger写入失败。其余19个既有陪伴场景回归通过。

代码审查：character_stats仍唯一数值真相；事件ID/角色/类别冲突明确；每日额度与事件/冷却/数值同事务，主进程可信时间显式传入；相同ID同角色类别即便重试时间改变也按旧事实幂等，接受此语义。亲密与心情使用互斥明确类别，目前尚无复合事件入口，后续真实活动/聊天接线须明确事实映射，不得用每条消息或模型HTTP成功自动加分。settleMoods在现有生命周期入口调用，没有模型请求或每tick事件行。新增规模超预估但保持单一业务模块与直接SQL，未引入框架。

本次不证明有效互动精力、共同故事判定、日常/探索成本或用户可感知的全部成长。旧单日/离线精力和名单行为保持；正式main/UI及真实模型验证另行完成。git diff --check通过，版本按snap同步。
