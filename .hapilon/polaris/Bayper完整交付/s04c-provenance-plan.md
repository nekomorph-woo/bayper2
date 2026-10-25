# S04c 无显式消息ID的来源防回流修订

Codex受托决策，依据memory-and-sharing.md删除/纠正后不从旧来源重新学回、重新授权不解除限制。POL-ANALYSIS-006已真实失败：前置插入行使旧消息offset变化并重新发送。仅给正文取哈希无法覆盖旧正文改写；仅改成行号同样不能覆盖前插。不能用停用所有来源掩盖。

## 方案：保留有界读取区段的完整性依据

本规格在预算r3接受后再派发，不与当前budget写者并行。

允许session-sources.cjs、source-analysis.cjs及两者专属测试，可新增一个小型source-provenance.cjs承载SQLite保护映射；不改memory/main/renderer/权限/预算/模型策略。现有reader安全检查必须复用，禁止额外绕过permit直接读私人路径。先阅读已有adapter/sourceId和源文件检查，再实现，规模明显超出须报告拆分。

1. reader在成功读取时可附带不含正文的checkpoint：稳定文件key（provider+规范根摘要+相对路径）、已实际读取的bodyStart/byteLength、该字节区段SHA256、文件身份dev/ino与snapshotBytes。只覆盖本次有界窗口，最多现有512KiB，不声称校验全文件。
2. 新增窄verifyCheckpoint(permit,relativePath,checkpoint)能力，用同一授权路径解析、O_NOFOLLOW、fstat/路径再次核对，仅读记录区段并比摘要。追加不改变旧区段即通过；前插、改写、截断、文件替换影响保护区段则返回明确changed。读取失败/撤权不当通过。不返回正文，单个checkpoint读量仍受原上限；校验后仍检查permit。
3. source-analysis成功发布时，同一事务保存所分析来源到checkpoint的最小映射（sourceId、fileKey、区段元数据，无原文）。失败不留半个标记；映射在用户删除记忆后保留用于限制，但不可被模型检索。针对本轮候选以索引查询processed，不全量读取整个角色历史集合。
4. 后续分析当前文件前，查本角色被memory.listExcludedSources限制的sourceId所对应checkpoint。若本文件存在受保护来源，先核验相关历史读取区段，即使该旧消息已不在当前tail，也要按原区段验证。全部通过才继续读取/组请求；任何changed则返回skipped/SOURCE_HISTORY_CHANGED，零HTTP、不扣发送预算、不标已处理。只暂停这份无法可靠关联的改写文件，其余获准文件和正常追加可继续；不能因重新授权清除限制。不得把新记录静默标processed，也不将其称作已经分析。
5. 这是一项安全边界，不自动猜测修改后的哪句话仍是旧记忆。保护区段损坏时停止该文件的自动提炼，保留明确诊断供后续来源设置显示；不删除/改写外部原文。纯追加时旧排除sourceId仍可准确匹配，旧正文不进模型，新追加用户消息可正常分析。
6. 验证量有界：去重相同checkpoint；一次最多检查8个区段/4MiB，超限返回skipped/SOURCE_VERIFICATION_LIMIT，不把未经核实当安全。这只是单次有界操作，可后续优化索引/检查进度，不缩减正常来源范围。保护信息不保留明文，对读出的临时buffer只作摘要验证。
7. 同次HTTP在途时外部文件被改写，发布前再次核验本次checkpoint，拒绝过时提炼；目录permit/contextVersion现有门继续保留。实际发送次数保留，不重发网络。

## 验收

修复现有006并补POL-ANALYSIS-008/reader对应Case：
- 无ID旧消息删除/纠正→重授权→前插/正文改写/截断或文件替换：旧文本不再进HTTP，结果说明文件无法核实，不恢复旧事实。
- 同一无ID文件正常append新消息：保护区段校验通过，已删消息不发，新消息可分析；其他文件不受影响。
- 旧已删消息退出最新tail，随后修改旧区段：仍按历史checkpoint拦截，不仅检查当前tail。
- 在途响应前源区段改写：不发布记忆/processed，已发送预算保留。
- verify撤权/越界/超量安全失败、SQL映射发布故障全回滚；源文件只读、无正文影子存储。

真实临时文件/权限/reader/SQLite/HTTP，模型fixture，先保留006原失败后修复；不把字符串/区段核验宣称为跨不同文件改写复述的通用语义防回流。语义相同不同来源的关联仍属于S03后续策略与调优，不由本修复虚称完成。完成后Codex独立审查与全模块回归才接受。
