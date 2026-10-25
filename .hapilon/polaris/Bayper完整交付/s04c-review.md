# S04c 来源分析审查

2026-10-26。CLI18811终态completed。Codex独立运行node --test tests/acceptance/source-analysis.spec.cjs，5/5通过（evidence/s04c-codex-first.log）。真实SQLite/权限/reader/预算/HTTP服务链有证据，模型与资格为fixture，未接GUI/名单/真实模型。

## 尚不能接受的边界

- 无显式消息ID时reader以字节偏移标识。同一外部旧会话前置插入一行后，旧已删除用户消息可能获得新sourceId进入请求。现有004只有显式ID且追加消息，不能证明本场景。先补独立失败Case，不改Expected或把重新授权当解除删除。Codex依据真实读接口与最小必要防回流数据再选修法，不能把所有来源停掉冒充完成。
- finally吞掉budget.finish/cancel异常，遗留占位只能重启恢复，可能让同一进程之后所有自动用途停摆；不得返回不带任何失败线索的正常结果。需要构造budget收尾SQL故障，明确已提交记忆/已发次数/未释放占位的实际事实，再决定保留结果加错误状态或可控恢复，不做网络重试。
- listProcessed每次加载角色全部历史sourceId，随着长期会话增长无界；后续应针对本轮最多40个候选作存在性查询，避免全量扫描/内存集合。当前生产644行和测试766行超过信号，但职责链真实，优先消除重复检查/无界读取，不为凑行数压缩控制流。

请先新增source-analysis测试中上述前两类针对性复现，复用fixture，不修改生产、不运行GUI/私人数据/远程API，保留独立failure日志。报告实际Observed及建议，Codex再派修复。现有5项PASS仍只代表现有覆盖，完整S04 NOT_COVERED。

## 复现终态与先修预算收尾

CLI8238 completed，仅新增006/007，未改生产。006真实前插assistant记录使已删user正文再次进入HTTP；007真实trigger阻止finish/cancel更新，遗留in_flight即使2小时后仍BUSY。日志08-offset-refeed-failure.log、09-budget-cleanup-failure.log保留。Codex先受托派最小预算修复，006保持已知失败，随后单独解决来源身份，不同时扩大两条数据协议。

预算修复限定source-analysis.cjs、automatic-budget.cjs及source-analysis/automatic-budget专属测试。预算层只追踪本进程调用finish/cancel失败的确切token与收尾操作，下次reserve前允许重做这一数据库收尾（不重发HTTP）。故障持续则明确存储失败且禁止新发送；故障解除后能收尾并释放占位。不能扫描/释放任意in_flight，不得另构造budget工厂去回收仍运行请求，不改已发送次数、冷却或requestId幂等。成功/重复终态清理待收尾信息；进程崩溃仍沿已有启动恢复。

source-analysis不得吞掉收尾失败。返回本次业务结果并附cleanupError稳定码，明确created真实数量/是否已发布；已提交记忆不能谎称回滚，也不因上层重试再发请求。取消同样附收尾错误。只做有界本地恢复，无定时轮询或无限重试，不依赖内存替代数据库事实。

007补核：故障仍在时无新HTTP；解除trigger后同一budget实例下一次reserve自动完成旧token收尾，可按已有频率规则获得新占位；次数不回退，原requestId仍重复，真实活跃未请求finish的另一请求不能被清。先按007修复与原001～005/预算全回归验证；006明确FAIL保留，不改变原Expected。

## 预算返修独立审查r2

CLI36113 completed，Codex独立预算6+来源001～005/007共12/12通过，s04c-codex-budget-r2.log（006明确排除为已知FAIL）。但recoverToken在事务内立刻cleanupNeeded.delete，reserve随后INSERT若trigger失败会整笔回滚，数据库旧token回到in_flight，内存却失去恢复标记。recover本身COMMIT失败同样存在。且recoverPending吞异常后把存储失败混作BUSY，与已派规格不符。

要求仅automatic-budget及专属测试修：在COMMIT成功后才清对应内存记录；事务失败完整保留。持续恢复SQL故障需明确BUDGET_STORAGE_FAILED，不假报普通BUSY；成功finish/cancel含重复终态也清准确token，仍不碰真实活跃请求。补POL-BUDGET-007：先finish失败，再解除UPDATE故障但让下一reserve INSERT失败；检查旧token仍in_flight，去掉INSERT故障后再reserve能够恢复、sent不丢、HTTP不重发。既有006补持续故障准确错误，保留原失败日志，不削弱Expected。来源006继续留待单独修复。

## provenance 独立复验与收束意见

61123已终态；Codex实际执行source-analysis/session-sources/automatic-budget三个Runner，25/25通过，evidence/s04c-codex-provenance.log。已核对范围内区段身份、只读授权复用、发送后重新校验、发布事务映射及旧offset失效Case。不能据此宣称完整自动调度/设置已接入。

收束前修一项有实际长期资源影响的问题：source-provenance.listProtected当前先.all本文件所有历史行，再hash/filter，8段限制发生在大数组构造后。表已有source_id_hash索引，应直接按角色/文件/被排除hash索引查询，并惰性返回/迭代，让protectedRegions发现第9个不同区段就停止，不先装载全部文件历史。无需新框架、新策略或修改memory排除接口；保留同区段去重和8段/4MiB原约束。补大量无关来源映射时仅核验受保护区段的构造场景，正常追加及超限仍原语义。不把现有25/25削弱以迎合修改。现有初始全量排除集合是另一层已知接口边界，不在本轮伪称已优化。

## 索引收束接受

69057 completed。listProtected现按既有(character_id,file_key,source_id_hash)索引，每批200 hash、statement.iterate惰性返回；protectedRegions第9个不同区段停止消费。Codex检查实际控制流，POL-ANALYSIS-011验证无关来源映射不参与核验；资源优化依据主要为索引查询与迭代实现，非仅凭这一业务Case推断内存性能。初始排除hash集合接口仍全量返回，未虚称完全有界。

Codex独立运行source-analysis、session-sources、external-sources、automatic-budget四个Runner，32/32通过，evidence/s04c-codex-index-final.log。受托接受S04c服务切片：POL-ANALYSIS-001～011及POL-SOURCE-013均PASS，分别覆盖授权有界来源→inferred记忆、预算/资格门、撤销/取消/纠正/删除、输出校验、事务回滚、无ID改写防回流、正常追加与历史区段校验、校验上限和无关历史隔离。各Case均使用真实临时文件/SQLite/本机HTTP，模型响应和资格为fixture。既有失败证据保留。

本轮不证明真实模型语义质量、跨不同文件同义内容防回流或正式自动调度/GUI。旧版本无checkpoint来源的迁移边界保留，当前该新服务尚未接生产，无既有生产提炼记录需要迁移。下一步S04d设置页及S06机会调度接线后再次做整链路验收。代码规模超初始信号但按reader/来源流程/协议/SQLite映射职责直接分层，不为减少行数删必要校验。
