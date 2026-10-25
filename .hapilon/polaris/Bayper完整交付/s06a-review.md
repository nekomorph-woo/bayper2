# S06a 自动模型预算验收

2026-10-26，Codex受托审查并独立执行 `node --test tests/acceptance/automatic-budget.spec.cjs`，5/5通过，日志evidence/s06a-codex-first.log。开发者CLI42352已终态completed。新增automatic-budget.cjs约327行、测试约447行；显式SQL与单层事务，未引入通用调度平台，规模可接受。

| Case | 结果 | 证据与边界 |
| --- | --- | --- |
| POL-BUDGET-001 | PASS | 五角色具体时间序列，1h/8h/24h与角色2h窗口真实阻止，独立SQL核对；不是实际HTTP |
| POL-BUDGET-002 | PASS | 真实预留/发送/取消及重复调用，只有首次begin可发，失败/超时/发送后取消仍占次数 |
| POL-BUDGET-003 | PASS（r2） | 独立补验真正in_flight重启：interrupted、次数保留、占位释放、旧token/ID拒绝；原午夜/回拨断言保留 |
| POL-BUDGET-004 | PASS | insert/update/state trigger故障事务回滚，无部分记录或假许可，解除后显式恢复 |
| POL-BUDGET-005 | PASS | 预留后构造另一已发送历史触及额度，begin重新检查并取消未发预留，未发finish不假报完成 |

005补充Contract：Given真实SQLite中已有预留且未发送；When在begin前构造一条发送记录触及小时额度；Expected拒绝发送并释放预留、不多计一次发送，finish未发送项返回NOT_SENT；Oracle真实SQL状态与canSend，边界为预算服务、不发网络。

r2补齐003后受托接受预算模块；模块接受不等于自动活动接受。后续接线必须每进程仅构造一次，不能用构造恢复去打断另一个活实例；名单/状态/聊天优先与机会检查仍上层负责；只有begin.canSend=true才调用transport且finally关闭占位，发送前取消不耗额度，显式用户聊天不走随机/自动预算。锁屏/睡眠无补机会，实际模型网络/取消/发布权限/数值/探索并发后续分别验证。status只是展示快照，不能替代事务内发送许可。

审查发现：003使用send helper，该helper已经finish(success)，因此不能证明in_flight重启恢复。补一个未finish的真实begin，关闭重开后断言interrupted、sent保留、占位释放、旧token与ID不可再发送、额度不释放；不能把开发者自述当该分支证据。

r2：Claude仅增33行测试，Codex审查diff并独立回归5/5通过（evidence/s06a-codex-r2.log）；没有修改生产实现。首轮日志保留，明确区分原覆盖缺口与补验后的结论。
