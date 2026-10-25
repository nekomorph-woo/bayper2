# S05a 独立审查

CLI51184 completed，Codex独立6/6（s05a-codex-first.log）。682行生产虽超信号，但SQLite与领域规则直接分层，无额外框架；不以删除业务规则凑行数。尚有以下真实控制流遗漏，先补失败再修，允许三个现有connector文件，不扩GUI/真实Herdr/main。

1. 新appRunId构造仅把runs设reconnecting，agents仍effectiveState=finished等旧值；重新register也未取快照就继续读成当前事实。原契约要求重启暂不可确认，保留lastKnown；现有006在新app仅重放旧duplicate后断言finished是错误Oracle，须按契约改为unknown，真正新权威快照后才恢复。不能保留错误断言迎合实现。
2. resolveRun不拒绝stopped/offline，confirmStopped后recordAgentChange/applySnapshot仍可更新当前Agent为working。明确停止不可被迟到数据复活；断联未重新登记时收到旧流回包也不可把effective unknown当在线事实。可保留真实历史事件但不得修改当前或伪造在线；停止代次的新快照拒绝，新run正常接受。补停止/断联迟到回包。
3. 初始快照没有episode账本，q.fact只找pending/presented。初始baseline seq10 working，随后seq11 attention，再迟到seq10 working事件，会按低seq新增pending，违反基线不冒充变化。需把baseline/observed episode纳入最小去重事实；事件仍可附sourceId，不能复活通知。补baseline先→新事件→旧baseline事件，以及快照更新后事件去重两种顺序。
4. 晚到低seq的needs_attention如果当前已恢复，当前代码priority=0；PRD要求已结束历史待介入按P1，当前仍需介入才P0。保留history过程，不把已过时事件升级成当前催促。补对应断言。

业务契约补充POL-CONNECTOR-007覆盖上述重启/停止/迟到基线与历史优先级，真实SQLite与可控来源fixture；不声称Herdr已对齐该sequence。失败日志新批次保存，修后全7Case回归。各问题有独立SQL/当前状态/通知行Oracle，不只看返回ok。

## r2独立验收

CLI96486 completed。Codex独立connector-ledger.spec.cjs 7/7，evidence/s05a-codex-r2.log；核对实际restart unknown、离线历史不改当前、baseline episode持久化、P1历史与P0现状的SQL与断言。失败日志s05a-connector/run-review-fail.log保留。006原Oracle纠正依据为原契约而非迎合代码。

| Contract | 状态 / 实际边界 |
|---|---|
| POL-CONNECTOR-001 | PASS：两实例同名/同局部Agent，分别归属与一次上线，基线不通知 |
| POL-CONNECTOR-002 | PASS：往返过程、事件去重、旧seq不回滚 |
| POL-CONNECTOR-003 | PASS：短断/3秒长断/恢复/停止分别去重，无批量任务完成 |
| POL-CONNECTOR-004 | PASS：事件与快照交错、缺口/缺Agent unknown及同episode去重 |
| POL-CONNECTOR-005 | PASS：运行代次隔离、主动停用与明确启用 |
| POL-CONNECTOR-006 | PASS：SQLite重建/新appRunId、分页/pending及业务事务回滚 |
| POL-CONNECTOR-007 | PASS：重启当前unknown、迟到停止/断联记录、基线不复活、历史attention P1及权威当前P0 |

Codex接受这一SQLite账本切片。生产570+175行、测试741行，比原规模信号大但按业务/SQL直分，无通用框架，暂不为凑数删除行为。仍未接真实Herdr/GUI/系统时序。历史已presented后恢复当前attention不再重复气泡，当前稳定待处理标记需S05c从当前状态另行显示，不能把该提示义务取消。真实协议无事件seq，S05b接线约束另见s05b-protocol-review.md。
