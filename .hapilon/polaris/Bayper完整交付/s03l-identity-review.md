# S03l-a身份修复审查

2026-10-27，S03l-a已按末尾范围由Codex受托接受；完整S03l语义关联仍未通过。以下保留首轮至最终的审查与失败过程。Contract见s03l-identity-plan.md，POL-FACTID001～006及原SEM003/004/008，现有业务与GUI回归仍必需。

## 实施中静态关注项（待最终diff确认）

1. 初版memory-store把SCHEMA与ensureFactIdentityColumns放在SAVEPOINT之前，只有行级回填在SAVEPOINT内。不能据此声称迁移失败“旧库原状”，schema可能已改变。新身份相关DDL、回填及旧控制迁移应同一事务/保存点，注入中途故障验证原子性；若改变已有初始化事务边界，验证嵌套调用与FTS初始化。
2. 新身份控制表应成为新控制的唯一来源；旧键控制只用于迁移/无法恢复身份的历史兼容，不能为了旧count/hash测试再写一份平行旧控制。多个身份同旧key的既有控制需明确迁移覆盖与已处理标记；新不同主体不能被新旧影子控制误伤。
3. 别名歧义不能选择首项绕过forget/share控制；遇多个身份要检查每个相关控制或拒绝自动复用，不能每次新分配UUID就躲掉旧限制。删除不清必要别名身份，但不能留正文。

代码仍由Claude实施，以上为Codex审查关注，不是已经观察到最终产品失败；等CLI终态后核对具体方案和证据。

进一步静态定位：当前forget/keepExclusive同时addForgetControl和addForgetIdentityControl，insertForgetBlocked仍无条件检查所有旧factKey哈希，因此新删除会继续封锁同key不同主体的新事实。migrateLegacyControls又枚举全部旧行（含已有identity_id），可能重启时把影子控制重新扩到另一个身份。必须移除新操作对旧控制的写入，旧控制只迁移尚未处理的行，已处理行不得每次按当前key重新归因。旧测试技术SQL可在定位审查后调整，不是保留这一错误的理由。

测试审查补充（本轮需补，不改业务Expected）：
- 自忘后的不同主体测试目前写入角色c，不能证明原角色a不会被旧key误拦。补原角色a从全新来源学习相同key的姐姐偏好，再重启复查；原已忘事实换key仍阻止。
- 迁移故障测试目前明确期待新表存在且为空，只证明回填回滚。应比较迁移前后sqlite_master/列清单及业务行，验证DDL也回滚，并验证调用者已有事务可正常回滚。
- 补两组事实纠正到相同严格指纹而产生别名歧义后，旧忘记/禁分享不能被新UUID绕过；不要只检查单一无歧义身份。
- 旧派生的父条目已删除但两个剩余条目仍保留相同parent_entry_id，这是明确共同来源，不等同于按同文猜身份。对experience/detail验证迁移后仍同组；不可因为父正文已删就虚构或保留它。
- 同key同body但kind/trust/sourceKind/expiry不同目前仅sameBody就返回既有，需明确冲突；同角色同身份不同key的新remember/extraction也需核对是否重复插入。保留source控制优先，不让幂等复用绕过旧来源禁入。

09:25修订中的新增关注：memory_forget_slot_controls虽换了新表名，但hasForgetSlotControl仍只按character_id+fact_key_hash拒绝，forget/exclusive仍新写该表，因此依然错误封锁“原角色从全新来源获知同键不同主体”的新事实。这不是修复，也不是获准新增的产品槽位规则。请删除这层新建键级影子控制；不能为旧Case的按key假设保留该行为。真正不可恢复的旧孤儿控制保留既有兼容范围即可，新产生控制必须按身份与来源。

## 首轮执行边界与返修派发

Claude首轮session 2b57dbf6-b86b-40f4-b1ba-eae4584c44c7 / exec58113在20分钟内持续实现；Codex通过ps发现它违背“不GUI”规格，连续执行sharing-ui.spec.cjs。Codex因这一明确边界违规向自建PID69282发送SIGINT；并非因观察超时重启。exec58113随后exit0，但JSON terminal_reason=aborted_streaming/is_error=true，不能视为成功。对应测试子进程73228/73415/73419已不存在，ps未见Bayper/Electron应用残留（其他应用的crashpad不处理）。原输出保留evidence/claude-s03l-identity.json；不采纳这批自述或界面结果作验收。

已续用同session下发r2，exec34522，输出evidence/claude-s03l-identity-r2.json。明确只准node --check改动cjs及node --test tests/acceptance/memory-fact-identity.spec.cjs，禁止GUI/通配符/其他测试；最多两轮新测试修正后报告并停止。旧测试改动需另经Codex核对。原始业务Case和SEM Expected保持不变。修复重点详上文及plan末尾本角色删除指纹补充，当前仍未验收。

## Codex独立r2执行

exec34522正常终态，Claude报告14/14。Codex独立node --test tests/acceptance/memory-fact-identity.spec.cjs实际14/14（evidence/s03l-identity-codex-r2.log）。SEM原Expected不改，独立结果3PASS/5FAIL/0ERROR、50/75检查通过；SEM003/004已从FAIL转PASS，008仍PASS，001/002/005/006/007语义关联缺口保留。结果tools/memory-tuning/results/semantic-baseline-codex-identity-r2.json/.log。

Codex非GUI邻接9文件实际85tests，70PASS/15FAIL（exec64417、evidence/s03l-neighbor-codex-r2.log）。13项首先失败于旧control表计数/hash观察，不能据此推定后续业务断言通过；另2项需夹具修正如下。当前不接受整片完成。

### r3受托决定与派发

1. 允许旧验收测试技术接入迁移到新身份控制表/身份ID，包括故障注入、回滚对照、无明文检查和GUI夹具SQL；保留全部原业务拒绝、正文、FTS、上下文、原子性断言。旧迁移专用fixture仍用旧表，不机械替换。
2. chat-sharing-setting POL-SHARESETTING002原“旧来源之外的新说法”没有携带原事实语义，只是同key。其目标是恢复开关不能清除遗忘限制；改成真正被忘记的原文（读取Given常量），仍断言created=false/blocked=forget，并额外保留同key无关新主体放行的覆盖。不是把Expected改成允许回流。
3. memory-sharing POL-SHARING005冲突段误复用前面已纠正咖啡事实的旧/新指纹，新增条目实际幂等复用，因此旧version1先报MEMORY_CHANGED。该段换用与前半段无关的两条不同正文（如柠檬汽水/原味汽水），保持同key、接收者version2、SHARE_CONFLICT、零覆盖/零上下文变化及条数断言。目标仍是接收者不同内容不被覆盖，不改变产品同身份幂等要求。
4. 新增删除指纹只在insertFactIfAllowed检查，recipientForgetBlocked尚未检查它。experience/detail两角色独立同文不同身份时，A已忘原文后B share/relay回A会绕过本角色防回流。修复两种接收入口也核对原文删除指纹，补完整业务测试（原文阻止，同key不同正文依旧允许）；不得跨角色自动合并身份。
5. 迁移故障测试在外层ROLLBACK之后才比较schema，不能独立证明内层SAVEPOINT已回滚DDL。先在外层仍活跃时检查身份表/列不存在、业务行不变且外层probe仍存在，再ROLLBACK检查全恢复；另无外层事务运行故障/重试。不要只凭最终外层ROLLBACK宣称内层原子性。
6. missingParentGroups先筛fact_identity_id=null又计算existingIdentities分支永远为空，删去死分支；保留真实缺父派生链测试。不要为无实际数据路径的场景造防御框架。

r3运行只准明确非GUI领域集合；GUI测试仅迁移技术SQL，不启动。Codex稍后统一冻结/实际回归。原SEM Expected、PRD、Git版本和文档不由Claude改。

## r3独立结果与r4最后接入

Claude95572正常完成。Codex冻结evidence/s03l-r3-source-sha.json后exec3671独立100领域tests全部通过，evidence/s03l-domain-codex-r3.log。实际diff核对旧测试技术SQL迁移、两处fixture与新增原文回流/不同主体放行断言；业务Expected未弱化。GUI与真实模型此时未执行。

静态剩余风险：migrateFactIdentities内部registerAlias在conflicts.has(fingerprint)时直接return，第三个明确派生身份不会加入该歧义组。运行时registerAlias会追加，但迁移遗漏可能让第三身份的禁分享被其他同指纹持有者绕过。r4允许最小修复并补一个旧库三身份同指纹构造测试：用真实不同父派生链制造歧义，不同身份不强合并；限制第三身份后其他同指纹的share/relay必须拒绝，重启保持。保留原始失败证据再修。

r4同时允许迁移四GUI与三个live测试的技术存储观察点，以及chat.spec.cjs旧零控制哨兵；不得替换正式服务调用或删除业务断言。sharing-ui按实际identity_id对应关系观察，不能直接调用生产isShareRestricted给Oracle自证。live仅更新技术入口不在Claude端调用。所有GUI/live执行继续由Codex统一安排。其他领域回归旧改动保持，生产只限上述迁移别名遗漏与helper sourceKind字段名清晰传递，不扩大功能。

## r4独立冻结验收与实际GUI问题

Claude28833正常终态。源码/Runner冻结evidence/s03l-r4-source-sha.json，Codex35766实际119领域tests+19unit全通过；原SEM仍3PASS5FAIL0ERROR，50/75检查通过（r4结果独立保存）。GUI exec84603顺序四套10tests，9PASS1FAIL；失败POL-SHAREUI006，960×680原生窗口的长昵称+长正文场景#memory-save超出dialog。日志s03l-gui-codex-r4.log，截图s03e-sharing-ui/codex-s03l-r4/sharing-layout-1200x800.png已实际查看：单列560px宽面板的独属说明被长昵称挤成长段，最低尺寸缺高度。不是存储回归可忽略的问题，PRD要求单屏主要操作可达。

### 受托布局修复决定

限定memory-panel.js与styles.css的记忆面板区域，小型原生工具面板布局修正，保留完整功能、正文编辑和全部操作。优先合理加宽并重排列表/详情，保证长昵称不挤压说明，列表局部滚动；如用摘要预览，选中后的完整正文必须可访问。禁止缩小字号凑尺寸、删除说明或操作、全页滚动、把保存按钮藏进滚动区。正常1200×800及最低960×680均需真实几何和截图证据，不因困难放宽Expected。

允许sharing-ui的该Case将截图放到几何断言前并记录实际geometry，保证失败证据可观察；先捕获当前960失败，再修改CSS/必要极小markup，不改业务流程、后端、其他页面。Claude仅准该单Case的GUI命令（--test-name-pattern=POL-SHAREUI-006），每次独立batch、最多两轮修正后停；禁止其他GUI/live/model。Codex最终统一复验四套与截图。规模预期约100行以内，超出说明必要职责，不堆叠覆盖CSS或添加框架。

## 最终受托验收：S03l-a通过，完整语义关联仍待完成

Codex实际审查代码/diff、原业务断言及真实截图后接受本片。用户价值：同键不同主体/历史不再被纠正或删除误伤；真实派生与严格同文明确事实按独立身份管理；删除内容不经原文重学或转告回流；旧库迁移可回滚且歧义控制不遗漏。不是自动同义理解完成，也不是人类亲自体验通过。

| Contract v1 | 结果 | 实际观察与证据 |
| --- | --- | --- |
| POL-FACTID-001 | PASS | 同键用户/姐姐/历史正文、版本、FTS与上下文隔离；SEM003/004原Expected通过 |
| POL-FACTID-002 | PASS | 新库/旧库严格同文异键复用身份，纠正/删除同步，未知者不新增 |
| POL-FACTID-003 | PASS | 实际多跳派生及缺父共同来源保留身份，源删后剩余持有者可同步；SEM008通过 |
| POL-FACTID-004 | PASS | 自忘/独属/禁分享、别名歧义与第三迁移身份、新来源原文回流及share/relay回流受控；同键无关新主体允许 |
| POL-FACTID-005 | PASS | 迁移幂等、内层保存点与外层事务分别验证，DDL/行回滚；旧控制不重新归因，新控制无正文 |
| POL-FACTID-006 | PASS | 同键正文/元数据冲突拒绝覆盖，同身份异键幂等，正式聊天/管理UI保持可用 |

独立命令与结果：
- `node --test`明确11个非GUI文件（完整清单见s03l-domain-codex-r4.log及本批执行记录）：119/119，其中memory-fact-identity 16例，覆盖上述6组Contract。使用真实SQLite/正式memory/chat核心；模型返回由构造HTTP或fixture控制，不声称真实模型效果。
- `npm test`：19/19，evidence/s03l-unit-codex-r4.log。
- 原语义Runner未改Expected，r4结果3PASS/5FAIL/0ERROR，50/75检查通过；tools/memory-tuning/results/semantic-baseline-codex-identity-r4.json/.log。SEM001/002/005/006/007继续FAIL，是后续必做缺口，不能以本片关闭。
- GUI四套顺序执行（sharing-ui、memory-exclusive-ui、chat-memory-operations-ui、chat-relay-ui）：最终exec56832，10/10，evidence/s03l-gui-codex-final.log；隔离真实Electron/main/preload/renderer/SQLite，本机HTTP替代模型。覆盖管理、纠正、删除、转告、来源、独属、在途失效、重启及长内容两尺寸。
- 布局前失败证据与后修复均保留。最终仅22行CSS差异，用grid重排同一面板，不加框架、无业务逻辑改动。Codex实际查看codex-s03l-final的960×680布局、独属保留来源与聊天纠正截图；实际内容区960×648/1200×768，不能将窗口外框尺寸当内容区。按钮可见，完整正文仍可编辑，列表局部滚动，无全页滚动。
- 冻结核对：evidence/s03l-r4-source-sha.json → 布局轮只变styles.css和sharing-ui Runner；后端未变，因此119领域+19unit仍有效。最终evidence/s03l-final-source-sha.json逐文件复核零变化。四GUI批次在各自s03*-*/codex-s03l-final/run.json或cases.jsonl；cleanup全通过，记录的父/桌面子进程经ps核对无残留、HTTP关闭、临时目录删除。

复杂度审查：生产沿原memory/store职责增加身份与迁移、独立小型纯计算helper，无新后台框架。新测试较长，主要为16个独立业务场景和真实旧schema/迁移失败fixture；未压缩语句凑数或建立通用测试解释器。保留显式步骤和失败位置。三个live Runner仅迁移技术SQL且syntax通过，本轮未调用真实服务；不能记为live PASS。

没有发现需要修改Polaris规则本体的新矛盾。首轮Claude越界GUI按现有职责约束中止并收紧命令白名单，未把流程文档当权限隔离。正式PRD与全部Goal保持不变。按snap保存本片，PATCH169→170，不升级MAJOR/MINOR、不推送。
