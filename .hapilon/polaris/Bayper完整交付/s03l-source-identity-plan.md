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

## master本批授权与执行记录（2026-10-27）

master完成流程补齐验收并snap `a68d03f`（VERSION 0.1.182，领先origin/main 134，未推送），解除原冻结门。本决定是master受托决定，**不是用户亲自确认**；本批只做旧同文fixture适配与独立回归，不是S03完成，也不代表父级通过。

- 允许修改仅 `tests/acceptance/memory-fact-identity.spec.cjs` 与 `tests/acceptance/memory-association.spec.cjs` 的6处旧同文身份机制fixture；生产 `app/memory.cjs`、`app/memory-store.cjs`、`app/memory-fact-identity.cjs` 与新 `memory-source-identity.spec.cjs` 只读。其他代码/测试/GUI/API/.env/Git/版本/skill/共享工具未改。
- 原则：不同来源同文不能证明同一事实；显式 `share`/`relay`/`associateFacts` 才可证明关联。v1业务约束不变，只适配错误fixture与机制断言，不删测试、不降门禁。
- 6处：禁分享先显式关联a/b；独属先关联a/b/d并保留清除2与姐姐隔离；旧库新secretCopy不复用canonical但保留正文别名`SHARE_BLOCKED`，keptRecall被旧控制拒绝时保留已存记录；回滚后旧库独立a/b身份不同并保留DDL/事务/派生断言；跨键同文各自独立、同key冲突保留、接收者c显式关联后验证复用；关联后新来源c先独立再显式归并。
- 真实结果：四套件基线35项29 PASS/6 FAIL，适配后35/35 PASS；日志与摘要见 `evidence/s03l-source-identity-fixture-20261027/`。
- 当时仍未完成：来源身份v2与父级独立验收（后由master接受有限能力）、存量误合身份组迁移、S03语义纠正/删除/共享闭环；不得以本批绿灯宣称S03完成。

## 本轮窄修正：SOURCE-ID-003 来源与版本读取（2026-10-27）

master受托授权，**不是用户亲自确认**；本批不扩大范围，不宣称S03或父级通过。

- 仅改 `tests/acceptance/memory-source-identity.spec.cjs`：`POL-SOURCE-ID-003` 的 b 来源改为与 a 同一个姐姐的等价表述，保留“她喜欢蓝色”原片段；`POL-SOURCE-ID-001/002` 的姐姐对同事负例保持不变；`correct` 的 `expectedVersion` 改为从被操作的 a 条目读取。
- `app/memory-store.cjs` 仅修 `resolve` 旧注释，删除“退回严格同文”的不实描述，行为未动。
- 实际执行：全新 attempt 目录 `attempt-20261027-132619-source-id003`，直接重定向保存完整 stdout/stderr 与真实 node 退出码；未用 `tee`/`tail`，未覆盖旧证据。结果 exit 0、35/35 PASS。
- 证据：`evidence/s03l-source-identity-fixture-20261027/attempt-20261027-132619-source-id003/summary.md`。仅为开发结果，当时待 master 独立验收（后由 master 接受有限能力）。

## 本轮窄修正：memory.spec 三处旧同文 fixture（2026-10-27）

master受托授权，**不是用户亲自确认**；不扩大范围，不宣称S03或父级通过。

- 仅改 `tests/acceptance/memory.spec.cjs`：`POL-MEMORY-003`、上下文版本回滚、`REVIEW-1 correct` 三例的 a/d 前置改为正式 `associateFacts` 显式核实关联，不凭同文自动关联；版本基线移到关联完成后读取。
- 保留 `updated=3`/`updatedDerived=1`、全持有者纠正、FTS、旧来源排除、trigger 抛错与完整事务回滚等全部业务断言；未改 Expected、生产或其他测试。
- 实际执行该文件加前述四套件：全新 attempt 目录 `attempt-20261027-132823-memory-fixture-repair`，直接重定向保存完整 stdout/stderr 与真实 node 退出码；未用 `tee`/`tail`。结果 exit 0、50/50 PASS。
- 证据：`evidence/s03l-source-identity-fixture-20261027/attempt-20261027-132823-memory-fixture-repair/summary.md`。仅为开发结果，当时待 master 独立验收（后由 master 接受有限能力）。

## master独立验收：来源身份v2有限能力（2026-10-27）

master受托接受来源身份v2这个**有限能力**，不是S03或Goal完成；本决定不是用户亲自确认。

- 最终独立运行17套件 **163/163 PASS、0 skipped、真实exit 0**，证据 `evidence/master-source-final-aYYduWmG/`；命令/摘要见 `evidence/source-identity-v2-acceptance-20261027/`。首次独立35/35（`master-source-identity-zc3R8p9n`）与前次128/125/3（`master-memory-regression-VAyixWhR`）保留，失败原件未覆盖、未改写。
- 接受范围：新独立来源同文不归组；缺身份迁移只按明确派生；显式`associateFacts`后管理传播；相关回归通过。真实SQLite/chat核心，聊天模型HTTP为构造；未取得UI/真实模型/live证据。
- 未完成：存量已有误合身份组未迁移；语义模型闭环、正式主题自动分享GUI、正式资源未完成。
- 本轮开发attempt已实际采用新规则（全新唯一目录、直接重定向防覆盖、真实退出码）；旧失败原件保留；未改skill。VERSION 0.1.184 已按既有10文件11字面量准备，待master snap。

| Case | 结果 | 未覆盖边界 |
|---|---|---|
| POL-SOURCE-ID-001 | PASS | 构造HTTP；真实模型/GUI未验 |
| POL-SOURCE-ID-002 | PASS | 构造HTTP；不证明通用语义 |
| POL-SOURCE-ID-003 | PASS | 等价为Fixture明确提供，不冒称模型判断 |
| POL-SOURCE-ID-004 | PASS | 已持久化旧误合组未拆解，迁移另批 |
| POL-FACTID-002（v2） | PASS（有限） | 真实模型语义核验未完成；v1同文复用机制PASS仍失效 |

下一步仅设计存量误合身份组的安全迁移，不提前编码：区分可证明派生与无持久关联证据的旧组，控制不得丢失，不臆测旧关联来源。
