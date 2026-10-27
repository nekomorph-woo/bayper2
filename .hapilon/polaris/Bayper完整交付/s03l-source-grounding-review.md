# 来源上下文关系核验审查

2026-10-27，Codex受托审查并接受本片确定性协议能力；不代表S03或完整Goal通过。需求/Case唯一来源为s03l-source-grounding-plan.md。Claude CLI session 8db12203-c36d-439b-87a8-86c6416b23c5，r1/r2/r3报告在evidence/claude-s03l-source-grounding*.json。没有外部API/GUI/真实用户会话操作。

## 实际成果与返修

现有关系协议接受可选来源快照，模型消息区分原话、片段、前文、说话者与持有者。text/excerpt逐字符一致，保留合法换行；仅user/stated成功来源，角色/时间/顺序/大小校验。只传语义白名单，Expected/内部版本/摘要/任意额外字段不进入请求。引用按独立消息匹配，不能跨消息拼接。前文不完整且证据仅来自前文时降uncertain，仍可能保守漏关联。旧无来源prompt及POLICY_VERSION不变，SOURCE_POLICY_VERSION独立标识新增协议。

r1正文包含判断允许拼入额外命题，Codex退回精确一致；Claude先复现新Case为2PASS2FAIL，修复后通过（失败记录在CLI报告，非Codex独立复现）。r2为维持旧导出清单采用不可枚举属性，Codex不接受该特殊处理；r3改为普通导出，仅同步旧测试导出清单，不改变业务Expected。生产427行/净增194，职责为有界校验与协议，接受当前规模；新增场景451行含真实HTTP/SQLite，不引入新框架。

## 独立执行与覆盖

源码冻结后Codex执行：

`node --test tests/acceptance/memory-source-relation.spec.cjs tests/acceptance/memory-relation-protocol.spec.cjs tests/acceptance/memory-source-context.spec.cjs`：18PASS、0FAIL、0跳过。

`npm test`：19PASS、0FAIL。`git diff --check`通过。

| Case | 结果 | 实际观察 |
|---|---|---|
| POL-SOURCE-REL-001 | PASS | 正式chat提炼→SQLite→source→协议，姐姐原话/片段分开；内部/额外字段不传；多行保留；原话注入在user数据中，system不变 |
| POL-SOURCE-REL-002 | PASS | 单条前文引用接受，跨消息/不存在引用拒绝；不完整前文降级；明确主体的当前原话可用 |
| POL-SOURCE-REL-003 | PASS | 无来源合同兼容；超限/时间/角色/错片段/额外正文/来源标签混用拒绝，无额外数据库写入 |
| POL-SOURCE-REL-004 | PASS | 正式forget/correct使isCurrent为false；协议单独仍能构造旧快照消息，明确必须由调用者检查当前性 |

证据：evidence/s03l-source-grounding-codex.log、s03l-source-grounding-unit-codex.log、s03l-source-grounding-final-sha.txt。旧r1 diff留存s03l-source-grounding-r1.diff；不是最终源码。

## 局限和下一步

模型边界全部构造。把指令留在数据中不等于真实模型抗注入已通过，引用存在不等于主体推断正确；isCurrent不等于语义正确或签名。结构验收不更新原SEM失败，不将本片接入自动associateFacts。下一步使用真实来源构造数据、固定Expected和本协议做有界真实模型核验；随后再验证现有预算/角色资格/调用前后版本有效性与原子关联的纵向链。生产调用者当前仍只有诊断工具，来源扩展尚未接调度。
