# S03r master审查与有限接受

2026-10-28，开发CLI41435仍live。本页是静态中途审查，不代表最终实现、执行或通过；代码由Claude修改，master不代改。

## 已纠偏

原002负例统一要求写入普通记忆，包含明确“别记住”，Oracle不合格。已中止原60444并在其终态后用同UUID恢复41435。原基线仍保留，不能把旧负例PASS当正确业务结论。计划解释性修订已写明不得新建、不得提升、不自动删除既有事实、不影响其他独立事实。

## 终态后须核对的具体问题

- 首版candidateMatchesContent使用`content.includes(normalized) || normalized.includes(content)`。后半允许候选正文包含整个授权事实段并额外带“另外”后的未授权事实；例如用户“请记住，门牌是307，另外我喜欢咖啡”，模型若把两事实合成一条完整原文候选，可被提升。上游grounding只证明原文存在，不能证明整条被授权。最终需有效反例覆盖，不能只测模型恰好拆成两条候选。
- matchedFactKeys只检查0，不检查多候选含义/范围，需区分明确两条独立命令与单个含混范围，不让单一模糊命令变成整批提升。没有证据不能宣称一般多事实解析完整。
- 首版applyMemoryCandidates原返回只有applied/count/reason，chat新逻辑却读取memoryResult.facts；开发仍在实现，终态必须核对是否真正返回真实逐项结果，不能用模型reply确认成功。
- 原005到期temporary候选未携带expiresAt，可能先被同键metadata差异挡住；不能单凭此例声称来源有效性/到期分支全部覆盖。需查未到期但权威来源失效、已有条目来源被排除及版本变化是否有独立证明。
- 回滚采用真实applyExtractionBatch后故障注入，保留真实SQLite事务验证但不是实际磁盘故障。源测试790行，最终须说明必要分支，不压行。

后续独立验收必须覆盖原Case与相关chat/memory/detail/operations；自然语言真实模型、跨键改述、指代与自动整理仍为父级待办。

## 返修中复核

41435仍live。已观察Runner850行、授权模块265行：明确否定保存加入新建拒绝、既有不删、无关事实及另一明确命令不牵连的场景；chat.applyMemoryCandidates已返回facts，前述接线遗漏已修。双向contains仍在candidateMatchesContent，终态后必须补组合候选反例并修正。已有after2/after3等exit0及regression-core exit1原件，最新regression-final尚运行，不作最终汇总。

## 首轮终态后的退回

41435已终态completed，开发报告20套503/503（构造HTTP＋SQLite，非GUI/真实模型）。实际代码仍有双向包含授权范围问题，另有clarify分支在独立候选已保存时仍声称“没有改动任何记忆”的不实确认。两项退回，需真实chat反例先FAIL后修；正向范围不得扩大，否定排除应拦住包含拒绝事实的宽候选，不能机械共享一个includes判定。只改授权模块/chat/新Runner，不再重跑20套开发回归，交master独立复验。

## 第二轮终态与独立复验

42186终态后master实际运行11文件441/441、unit21/21，exit0、0skip、before/after SHA一致；证据`evidence/s03r-explicit-remember/master-final-c6e29kDM/`。正向宽候选与歧义部分完成反例修前实际失败、修后通过；否定宽候选修前已通过，不能称它曾失败。

仍未接受：master直接调用`analyzeExplicitRemember('请不要记住，门牌是309。')`实际返回kind:none。常见请求前缀的否定遗漏，已交回只修授权模块及新Runner，先真实chat反例再小修。不把441绿例覆盖范围外的此缺口忽略。

## 最终独立复验与受托接受

36671终态后，master审查最后一轮仅否定请求前缀正则及对应测试变更；独立运行新Runner、chat、chat-memory-operations、memory-detail-context四文件158/158，exit0、0skip、源码前后SHA一致。证据`evidence/s03r-explicit-remember/master-polite-IunFLlsY/`。前轮11文件441/441及unit21/21为未改变存储/事务/来源/分享部分的回归依据，最后一轮不重跑无关全量测试。

受托接受POL-REMEMBER-001～005 v1在本片明确范围内的真实chat/SQLite＋构造HTTP能力：新事实与同键同正文提升、精确事实段、正/负请求与引用边界、无候选/冲突/部分完成反馈、保持来源与时间、角色不扩散、事务回滚/幂等。不得据此声称一般自然语言理解、真实模型或完整S03已经通过。直接询问能力不会作为授权，含混指代与跨键改述仍需后续设计/真实验证。

规模审查：312行授权定位模块（分句/范围/否定/结果解释职责）及chat、memory小接入，973行Runner覆盖真实HTTP/SQLite隔离清理与独立负例/事务分支。高于初始信号，追加量与实际三次审查发现相关；未引入数据库schema、通用框架或多余模型调用，接受现阶段组织，后续新增语义策略不得无限堆规则。内置QUESTION_END为未使用常量，仅维护小瑕疵，不影响本片业务验收；留后续有实质改动时清理，不为其单独新建返修批次。

体验边界：未执行GUI/真实DeepSeek；使用构造数据与本地HTTP，不冒称人类体验。既有单键冲突保护保留；真正同义但不同factKey、只指“刚才那件事”及自动整理仍为父级待办。下一步须检验真实模型能否生成合格候选与稳定事实键，不能继续用构造模型自证产品语义完成。

Polaris复查：错误Oracle与授权范围通过master审查、保留反例、Claude返修和独立复验纠正。当前skill已有相应约束，未发现需要归档修订的新流程缺陷；不为了迭代计数改写skill。
