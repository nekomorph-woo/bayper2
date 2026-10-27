# S03l 事实关联：基线与方案审查

2026-10-27，执行中，未接受产品修复。

## 北极星流程与授权

本轮使用仓库现行polaris；复用既有PRD业务预期，选择增量开发前的存量补建基线。Codex受托确认SEM-001～008 v1，唯一Contract在s03l-plan.md，cases.md登记；Claude负责工具，Codex独立审查/执行。用户再次提醒使用北极星已纳入状态，不把规则使用等同于必须修改skill。

## 只读可行性核对

CLI15768已终态，session c4cfc5b2-94a2-4682-8a9c-8f969268d874，原始报告evidence/claude-s03l-readonly-assessment.json。Codex对照源码确认correct/forget/keepExclusive/currentHolders直接listEntriesByFact、共享控制和忘记控制直接factKeyHash；独立同义漏关联与同键误合并都是实际实现风险，基线运行前仍按源码判断记录。

不接受报告的原样方案：以factKey哈希为节点的连通分量能扩展不同键，却把相同键天然视为同一事实，保留SEM-003/004要解决的误合并。不能为兼容既有Case就排除此问题，也不能把“至少同一角色曾看过两条”当作最终跨角色同步范围。报告关于无法无成本识别未共同出现语义、删除后正文不可再用于比对的边界有效；不据此取消PRD需求。

技术方向待基线后细化：事实身份应独立于模型topic键，分享派生继承明确身份；独立记录只能在主体、适用时期、事实性质一致且候选核验通过时关联。当前偏好变化与过去共同经历必须分开。维护关联不把其他角色记忆插入当前角色回复上下文；若做无人格后台分类，要明确额外调用预算、失败/取消、版本校验与实测语义质量。控制关系持久化只保留必要不透明标识/摘要，不藏被删正文。暂不实现有已知错误根基的关系表。

基线工具CLI59634仍待结果。未跑Case不预填PASS；基线预期失败也必须实际观察，不拿审查猜测代替结果。

## 基线Runner首轮静态审查（执行者仍在工作，待冻结后复核）

- openDatabase重启路径重复CREATE TABLE relationships，需幂等打开已有库；否则SEM-002是Runner ERROR，不是产品缺陷。
- SEM-008在forget后才查询bCorrect.id的FTS新正文，必然把正确删除当失败。应在纠正阶段捕获FTS，再在删除阶段独立检查清空。
- writeBlocked把任意异常当正确阻止，会吞掉产品异常；语义控制应核对预期业务拒绝码/blocked或reason，未知错误为ERROR。SEM-005不能只看!relay.ok。
- source.sha只有HEAD，不足以复核未提交生产源码；补memory.cjs/memory-store.cjs/memory-retrieval.cjs与Runner内容SHA256。
- cleanup失败必须记ERROR并检查路径确实消失。结果保留实际临时路径供独立复核，不把调用rm成功当清理证明。

这些是Runner/Oracle修正，不改变SEM业务Expected；最终仍必须保留真实产品失败。

## 独立执行结果（基线，不是修复）

首轮工具CLI59634完成，session 4c670354-cbbb-4202-b47c-efe2e4454915。首轮虽自测1PASS/7FAIL，但压缩到399行且异常分类/内容摘要/清理不足，Codex未接受；r2 CLI99916修复，恢复可读步骤与完整Oracle。原始两轮报告在evidence/claude-s03l-baseline-tool*.json，首轮工具结果保留tools/memory-tuning/results/semantic-baseline-claude-r1.json。未改业务Expected，没有用产品变更迎合基线。

Codex实际执行：
- node --check tools/memory-tuning/semantic-baseline.cjs：通过。
- node tools/memory-tuning/semantic-baseline.cjs --out tools/memory-tuning/results/semantic-baseline-codex-r2.json：执行完成，退出0表示诊断工具完成，不表示产品通过。完整日志同目录semantic-baseline-codex-r2.log。

| Case | 结果 | 实际观察 |
|---|---|---|
| SEM-001 | FAIL | B仍为加糖咖啡，版本1，旧FTS保留，新FTS未写 |
| SEM-002 | FAIL | B正文及FTS删除后仍在，重启仍在 |
| SEM-003 | FAIL | B的姐姐偏好被替换为用户的新偏好，版本错误递增 |
| SEM-004 | FAIL | B去年的共同经历正文被替换，历史FTS消失 |
| SEM-005 | FAIL | A禁分享后B的不同键同义记忆成功relay到C，C正文/FTS新增 |
| SEM-006 | FAIL | 独属要求未清B，旧来源新键重学后B有2条与2条FTS |
| SEM-007 | FAIL | 默认删除未清B，旧来源新键重提炼后B有2条与2条FTS |
| SEM-008 | PASS | 真实share派生链正确同步，删除清FTS，旧分享来源重学被拒；C无新增 |

合计8场景：1PASS、7FAIL、0ERROR；75项观察检查42通过、33不符。不是75个独立产品场景。Codex核对各场景initial/after状态及控制计数，四个文件内容SHA与当前源码一致，八个独有临时路径均已不存在。app/和现有tests/零diff，无GUI/模型/真实数据，故不补跑无关全套。Runner现1109行，主要是八条明确步骤、75项断言和证据展开，未增加通用框架；本轮接受可追踪性与完整性，不再为初始行数提示压缩语句。

## 受托决定与后续修复顺序

接受这批补建基线及工具，不接受S03l产品功能。七处失败进入后续实施的必需回归，不能以SEM-008原有链通过抵销。

1. 先把事实身份与模型键分离，解决同键不同主体/性质被误改、独立身份和派生继承的持久存储；迁移不按相同键盲合并，不清掉既有隐私控制。同步操作必须依据明确身份及经过核验的关联，重新覆盖纠正/删除/独属/分享与在途上下文。
2. 再接有界的语义候选核对，覆盖不同键同义；需要同一主体与时间适用性，不能只提高FTS召回。跨角色判定在独立维护上下文完成，不把他人原文暴露给角色回复。新增调用需受既有预算和取消/失败约束。
3. 对旧来源改键重扫、纠正后的旧提炼、重复/在途/重启、已删除正文不留存进行回归。已知旧来源和已校验别名要可靠阻断；未见过的新表达仍需真实模型策略对照，不虚称全语义确定性。

下一轮按此顺序补具体身份迁移与Acceptance Contract再派Claude，不能采纳只扩展键哈希闭包的捷径。全Goal、正式动画/故事与最终交付仍保持原范围。
