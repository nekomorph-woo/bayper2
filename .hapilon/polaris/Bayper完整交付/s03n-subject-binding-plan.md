# S03n 主体绑定门 v1（受托实施，已测有限接受）

## 定位

- 仅对 raw `equivalent` 做反证防护：明确身份绑定才允许 effective equivalent；不证明一般中文指代，不承诺全部主体识别完成。
- 不改 prompt/协议字段/旧 Expected/评分（后文获批的 POL-SOURCE-REL-001/002 source Case v2 迁移为唯一例外，见「POL-SOURCE-REL-001/002 迁移 v2」）；raw 可保持 equivalent，effective 与数据库关联由本门决定。
- 受托实施 ≠ master 验收；未执行/未 live 的不写 PASS。

## 支持路径

1. **同一 text**：分句起点的 `她/他 + 是/叫 + 指称`，绑定句前置且紧邻事实句；事实句以同一代词开头。
2. **最近一条保留用户前文**：明确 `她/他 + 是/叫 + 指称`；当前 text 为事实句。`sourceContext.context` 只含用户消息，assistant 不能作证。
- 同一指代可在绑定句与事实句重复（P1 两次“她”通过）；不得出现第三个代词或其他分句代词。
- 姓名-only/`叫 X` 没有指代身份句时**不再兼容放行**（`namedAntecedent` 已移除）。

## 判据

| ID | 判据 | 来源 |
|---|---|---|
| C1 | 触发：raw equivalent 且 text 含 `她/他`；排除“其他/吉他/利他”等词；`她们/他们` 不支持 | text |
| C2 | 仅绑定句+相邻事实句（同 text）或当前事实句（前文绑定）可出现同一形式代词；第三处代词即竞争 | text |
| C3 | 绑定句起点位置、`是/叫`、指称必须存在；绑定句 trailing 标点参与否定/假设/疑问检查（`？` 不再丢） | text/segment |
| C4 | 直接来源完整 `utterance` 中，excerpt 前的**完整句范围**不得有条件/引号；不再按逗号最后空分句判断 | sourceContext.utterance |
| C5 | subject 非代词、长度≥2；`是` 指称须以 subject 结尾或相等，`叫` 须相等；含并列/另一代词/“小雅同事”前缀均拒绝 | text、subjectQuote |
| C6 | 绑定/事实不得在 `“”`、`""`、`「」`、`『』`、`‘’`、ASCII `'` 引号内；引号内不豁免 | text/context |
| C7 | 前文绑定必须是最近保留用户消息；多个明确绑定、同名多人、条件/否定/问句均不通过 | context |
| C8 | 截断且绑定缺失 → uncertain；绑定已保留则按证据判断，不机械拒绝自足事实 | sourceContext |
| C9 | corrected_v2：逐 segment 检查来源条件/引号；绑定必须完整落在单一真实 segment，拒绝 canonical 拼接 | segments |

## Case 与结果（Polaris ID）

| ID | Given / When | Expected | 实际 |
|---|---|---|---|
| POL-SUBJ-BIND-001 | 同句 `她是我妹妹小雅，她喜欢蓝色。` vs `小雅喜欢蓝色。`，真实 chat 更正 | equivalent，B 更新 | PASS，B 同 identity |
| POL-SUBJ-BIND-002 | 前文 `她是我妹妹小雅。` + 当前 `她喜欢蓝色。`，真实 chat | equivalent，B 更新 | PASS |
| POL-SUBJ-BIND-003 | 前文裸姓名 `我妹妹小雅最近很忙。` + `她喜欢蓝色` | uncertain，不传播 | PASS |
| POL-SUBJ-BIND-004 | 模型错误 equivalent：`用户说她喜欢蓝色` 更正传播 | uncertain，A 阶段 1 完成、relation HTTP 1 次、B 不变/无 edge | PASS |
| POL-SUBJ-BIND-005 | 无前文她 / 独立 `她喜欢蓝色` | uncertain | PASS |
| POL-SUBJ-BIND-006 | 引号内未定她 / 单引号 / 『』 / ASCII `'` | uncertain | PASS |
| POL-SUBJ-BIND-007 | 多个竞争绑定 | uncertain | PASS |
| POL-SUBJ-BIND-008 | 截断且绑定缺失 | uncertain | PASS |
| POL-SUBJ-BIND-009 | `contextIncomplete=true` 但同 text 完整绑定 | equivalent | PASS |
| POL-SUBJ-BIND-010 | “其他/吉他”等无关词 | 不触发 | PASS |
| POL-SUBJ-BIND-011 | `她是我妹妹小雅同事` 前缀伪匹配 | uncertain | PASS |
| POL-SUBJ-BIND-012/013 | 否定/假设绑定 | uncertain | PASS |
| POL-SUBJ-BIND-014 | 事实问句 / 分句尾 `？` | uncertain | PASS |
| POL-SUBJ-BIND-015 | 同名不同人/多绑定 | uncertain | PASS |
| POL-SUBJ-BIND-016 | 蓝/红真 different | different 不变 | PASS |
| POL-SUBJ-BIND-017 | 引号内第一人称转述 | 既有规则不变 | PASS |
| POL-SUBJ-BIND-018 | 既有同义/self/转述/年份回归 | 不退化 | PASS（五套见报告） |

## POL-SOURCE-REL-001/002 迁移 v2（master 受托，非用户确认）

- master 独立证据 `evidence/master-s03n-review-ssLemyz2`：248 tests / 246 pass / 2 fail / 0 skip、tests.exit 1、before/after 相同；失败仅 001/002。据此批准两 Case 迁移 v2。
- v2 契约：引用结构合法、模型 raw equivalent 保留；新增 **effective relation = uncertain** 与具体“第三人称绑定证据不足”理由。合法引用不再等于跨角色操作授权。
- 旧 001/002 FAIL 与历史 v1 证据不覆盖；仅改 `memory-source-relation.spec.cjs` 两 Case 必要断言/版本说明，保留引用字段、上下文完整性、错误引用拒绝、存储零写等全部原断言。
- v2 独立 attempt `attempt-20261027-221802-s03n-source-relation-v2-final`：4/4、exit 0、SHA 一致。
- **能力边界**：这是更严格的关联授权，不表示自然命名/弱指代产品能力完成；S03 剩余路径保留“自然姓名/弱指代支持缺口”和“真实模型验证未完成”，不删需求，不把保守拦截当全面支持。

## 最终接受状态（2026-10-27 r70）

- master 最终五套 `evidence/master-s03n-final-NSKiCUx4`：**248/248 pass、0 skip、tests.exit 0、before/after 一致**；查看 live 请求/响应/DB 后，**受托接受 S03n 已测主体绑定反证防护与 source Case v2**（非用户确认）。
- live L2：8 REVIEW / 3 FAIL（C02/C03/C07），44 chat + 8 relation + 1 models，DB falseMerge 0，11 目录无残留。C02/C03 是模型 `memoryOperation: null` 并澄清、产品如实显示未改记忆，**不是绑定门错误，不得改 Expected 抹掉**；C07 仍 different vs uncertain。
- live L1 `evidence/master-s03n-live-brz61rpr`：10/11（C07）；grounded holdout 15/16，falseMerge 0、missedEquivalent 0，仅 15 分类 FAIL。
- 版本 `0.1.199 → 0.1.200`（10 文件 11 处），待 master snap。下一步仅登记“操作识别与澄清反馈闭环”，本轮不实现、不调第三轮 prompt。

## 规模与验证

- 生产新增约 256 行（protocol +203、helper +53），测试 +438；master 认可职责可理解，本批不再重构/加新门。
- 五套 248/248；live 结果如上。**未覆盖**：自然姓名/弱指代、C07/15 分类、完整主体识别、真实语义 S03 与 `POL-SEMOP-001～008` 聚合；保守拦截不等于全面支持。
