# S03g 明确聊天转告审查

2026-10-27，Codex。CLI8448在/tmp/bayper-chat-relay-BNAnK2隔离副本实施，尚未终态/整合；主目录四项相关源SHA仍等于派发前。

## 首轮代码关注项

`resolveRelayRecipient`当前通过segment.includes(alias)选角色。原话“把饮品偏好告诉琥珀的朋友”或未定义昵称“小琥珀”可能被匹配到琥珀，但用户并未指定该角色本人。应以明确的接收对象完整范围核对名字/已定义昵称，不能任意子串命中；保持礼貌句式可用，也不要无止境扩名单黑词。需要CLI通过正式chat入口先复现，再修复并增加同一候选集正反对照。

这属于操作接收者边界，不是语义事实全局归并；不得借本项改自动共享/扩大权限，也不得由Codex代写测试。

初轮8448已exit0，Claude UUID6e8f2b02-0ff4-48ae-85cc-580ec4062ffd。自述11relay、22S03f、18chat、8sharing通过；unit17/18中唯一desktop失败为副本未复制assets的环境限制。Codex接受298生产净增的职责解释，未接受行为；19219已派复现接收者子串问题后修复，仍仅隔离副本纯Node。

## 独立服务复验与受托接受边界

19219已exit0；原话三个反例在修前真实chat入口发生错误投递，见20261027-062241-review1/repro-before-fix.log，不能删除此失败。修后完整名称/昵称边界代替任意子串命中，正例完整名、语气后缀、昵称和“跟…说”保留。Codex已审四生产实际diff与新增Runner：约330生产净增用于命令/目标映射与事务接线；未引入框架，memory.relay仅增加外层事务参与分支。935行解析模块较长，但沿既有主题组织，本轮不为行数机械拆出循环依赖或隐藏调用。后续应替换/收敛策略而非无限叠词。

Codex在固定隔离副本独立执行 `node --test tests/acceptance/chat-relay.spec.cjs tests/acceptance/chat-memory-operations.spec.cjs tests/acceptance/chat.spec.cjs tests/acceptance/memory-sharing.spec.cjs`：60/60通过，0跳过，exit0。证据s03g-codex-domain-r1.log，5项文件SHA前后全部一致，s03g-codex-source.sha256。所有模型响应来自本地构造HTTP，不是DeepSeek实效结论。

| Case | 状态 | 实际观察 |
|---|---|---|
| POL-CHATRELAY-001 | PASS（服务） | 单条饮品到指定名单外已结识角色，C无事实，原关系/名单/数值不改，只有一HTTP |
| POL-CHATRELAY-002 | PASS（服务） | 名称/昵称可用；重名、未知、自身、多接收者/伪造C拒绝；关系描述/昵称前缀/词内同字三个反例不投递 |
| POL-CHATRELAY-003 | PASS（服务） | 真实近期话题唯一才可指代，不以唯一候选兜底；错M、引用/假设/否定/能力提问与正文指令不写 |
| POL-CHATRELAY-004 | PASS（服务） | 禁分享、自忘、冲突、过期拒绝；D→A→B保留D原来源+A讲述者与派生关联 |
| POL-CHATRELAY-005 | PASS（服务） | requestId重启幂等，取消/来源纠正失效；最后确认写入失败，接收记忆及版本全回滚，重试仅一份 |
| POL-CHATRELAY-006 | PASS（服务） | B的旧在途回复stale，新对话可检索带来源事实，无要求B立即额外回应 |

已核验Runner的SQLite、上下文、实际请求数和禁止副作用断言。接受服务子阶段；正式聊天UI、真实模型以及整合后的相邻回归仍NOT_COVERED，当前尚未复制回主项目，不能据此宣称完整S03通过。语义判定保守，未实现无共同字词的事实归并；“如果方便”等条件句当前会澄清，后续以真实体验决定调优，不能为测试强行扩大操作权限。

## 主项目整合及正式GUI独立接受

48321 exit0，只在隔离副本新增chat-relay-ui.spec.cjs（579行），四生产文件冻结。额外规模用于父/desktop退出、实际请求/DB与失败证据，不引入框架。Codex选择性复制四生产文件和两项Runner前，主目录派发前SHA全部一致；未覆盖故事/版本文件。

主目录独立60/60服务、18/18 unit通过，见s03g-codex-main-domain.log和s03g-codex-main-unit.log。POL-CHATRELAY-UI-001独立15203 exit0、1/1通过，evidence/s03g-chat-relay-ui/codex-20261027-r1：真实配置→实际聊天输入/发送→本地确认→琥珀记忆页→澄空态→重启后持久。只饮品进入琥珀、住址未进入、澄无事实，名单/当前角色/亲密度心情保持，精力没有因转告扣减。反例“把住址告诉琥珀的朋友”不新增记录/不假确认。每条用户操作仅一HTTP，没有接收者额外调用。

Codex查看01-chat-relay-confirmation.png和03-memory-hu-source.png，确认实际UI及来源语义；11源文件SHA在验收后全部核对一致。三轮父进程exit0、desktop均不存活、无强制退出，HTTP关闭、临时目录删除，fixtureErrors及cleanup.errors为空。对应上述服务6Case+GUI Case受托接受；模型使用本地构造HTTP，真实DeepSeek尚未运行，不能当作真实模型的可靠性证明。完整S03未完成项保持不变。

## 真实DeepSeek三轮对照

CLI37568（UUID8fd932fd-4dcf-4380-a928-7e206412847f）只新增349行Runner，无生产修改；Codex审后独立74993执行`S03G_LIVE_BATCH=codex-20261027-r1 node --test tests/acceptance/live-chat-relay.spec.cjs`，exit0，三场景全部PASS。真实GET /models包含deepseek-flash，恰1 models+3 chat，无重试；实际SQLite为依据而非模型建议字段。

- LIVE-1“把我的饮品偏好告诉琥珀”：模型M1/C2与实际候选对应；仅琥珀收到冰美式及凛来源，住址未带入、澄无事实；本地落库后确认“已经…告诉琥珀”。
- LIVE-2“把我的住址告诉琥珀的朋友”：模型也提出澄清，最终本地确认未改动；两接收者无记录，凛住址仍在。
- LIVE-3“我只是问问，你能把饮品偏好告诉琥珀吗”：模型未建议转告，最终说明“我这次没有转告任何内容”，双方无新增，原记忆保持。

Codex逐条审查真实messages、模型建议、最终回复与DB机器断言，语义接受此三条构造表达。5源SHA全部一致，3上下文dispose/SQLite关闭/临时目录移除均成功。证据evidence/s03g-live-chat-relay/codex-20261027-r1/run.json及source.sha256；日志s03g-codex-live-r1.log。使用用户已授权.env，未记录Key/headers。真实对照不经过GUI，GUI由前述本地HTTP独立批次覆盖，不冒称同一批端到端真实模型窗口验收；表达鲁棒性仍有边界。
