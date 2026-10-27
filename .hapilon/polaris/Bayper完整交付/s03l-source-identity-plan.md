# S03l 独立来源身份保护

2026-10-27，Codex依据s03l-source-live-review的新证据作受托修订。原POL-FACTID-002 v1“严格同文即可确认同一事实”是错误技术假设：实际chat保存evidence片段，相同“她喜欢蓝色”可以指不同人。PRD主体隔离/管理传播业务目标不变，不能为保旧绿灯保留该假设。

## 本批改变与剩余范围

新独立来源不再依据正文指纹复用身份或返回另一个键的首次条目。不同key各自保存来源；同key只保留现有定位/幂等与冲突合同，不在本批改唯一键结构。显式share/relay和associateFacts仍建立关联，后者仍只接受调用者已核实关系，本批不接模型。相同正文作为候选/删除防回流哈希可以保留，但不能充当事实身份的证明。

缺少身份的旧记录迁移时亦不按同文归组，只认可明确派生父来源（含共同缺失父ID）；新建独立身份并登记别名歧义。已持久化的旧body自动身份组如何安全分离、已有控制如何保留，需紧接着另行迁移批次；本批不得宣称存量误关联已修复。既有删除指纹、旧来源控制、保守禁分享保护不削弱；其同文但不同主体的过度阻断仍须后续来源/语义控制细化，不能静默移除。

## 业务验收（P0/v1）

| ID | Given/When | Expected/Oracle |
|---|---|---|
| POL-SOURCE-ID-001 | 同角色两个独立chat会话，姐姐/同事各自原话含同片段“她喜欢蓝色”，不同key | 各创建条目、不同identity；resolve各自原话/前文正确；纠正或删除一个不改另一个body/版本/来源，重启保持 |
| POL-SOURCE-ID-002 | 两角色独立chat分别谈姐姐/同事，同片段不同key，管理A | 未显式关联，B正文/版本/来源/FTS仍在；不能因字面一样被默认删除/纠正 |
| POL-SOURCE-ID-003 | 独立条目未关联，随后调用正式associateFacts核实等价，再管理；另用share/relay真实派生 | 显式证据路径仍同组并传播；未知角色不新增。等价是Fixture，不冒称模型效果 |
| POL-SOURCE-ID-004 | 无身份旧库内同文独立来源及真实派生，迁移/重启 | 独立来源不同组，派生保留组，正文/来源完整；旧控制保持，不声称已修有身份旧组 |

Driver真实store/chat/memory/SQLite/来源；只有chat模型HTTP为构造。先新增前两Case并在未改生产时运行，保存失败，再修复。Codex独立执行全部及邻接回归；Expected不按输出变更。

## 技术和派发边界

Claude允许app/memory.cjs、memory-store.cjs、memory-fact-identity.cjs，新tests/acceptance/memory-source-identity.spec.cjs，以及既有memory-fact-identity.spec.cjs中POL-FACTID-002的v2（新建/旧库独立身份，已核实同步须显式associateFacts）。v2替代002旧“同文即同组”机制断言，但同步/删除/未知角色保护业务断言保留，通过显式核实Fixture测试。其他旧测试若依赖自动同文身份先报告具体失败，Codex再授权其前置适配，不能自行削弱Expected。

生产预期小范围去除body身份复用、不新增框架/表/定时器/模型客户端；严格指纹函数仍用于别名/控制，不用返回null粗暴废掉防回流。新场景约250～400行是审查信号。无Git/版本/.env/GUI/真实API，不碰其他研究产物。代码全交Claude，Codex审查与运行、文档/版本/Git。
