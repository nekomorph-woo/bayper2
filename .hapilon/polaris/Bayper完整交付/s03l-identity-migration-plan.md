# S03l 存量误合身份组安全迁移（POL-MIG-001～006 v1，master 受托确认）

2026-10-27，HEAD `1783ec8`，VERSION `0.1.184`（本批同步 `0.1.185` 待 snap）。master 联合审查 r3 业务/Case/Part A-B 通过，受托确认 v1；不是用户亲自确认。本文件只正式化设计，不写代码/测试。r1 旧稿在 `evidence/s03l-identity-migration-plan-r1/`。

Polaris 联合审查捕获了 r1/r2 方案错误（只拆同指纹、allowSharing 跨组件解除、断根重建、逐旧 identity 分配互相覆盖等）；本轮已在 r3 修正，无需修改 skill。

## 1. 事实与退回结论

- `app/memory-store.cjs:887 migrateFactIdentities` 只处理 `fact_identity_id IS NULL`；已有旧误合 identity 不会再次拆分。
- `memory_derivations` 的 `entry_id` 为 `ON DELETE CASCADE`（`:111`），`deleteEntry` 先删该条目自身的派生行（`:560`）。删除 B 会删 B→A，但 C→B 因父 ID 无外键而保留；**不能据此重建 C→A**，历史缺失必须如实分开/待重核。
- `app/memory.cjs:1239 associateFacts` 只合并 identity/alias/control，无持久核实边；旧自动同文与旧显式关联在库内不可区分。
- `relatedIdentityIds`（`:260`）按同指纹别名/歧义整组检查控制；`allowSharing`（`:1212`）只删除选中身份的控制，但会被“多个相关受限身份”拒绝，旧设计靠删除/继承锚身份控制会造成跨组件放开或永久拒绝。
- 删除/独属/禁分享控制、删除指纹、正文/来源/FTS 的现状见 `memory.cjs:711/814/871/1196`；身份迁移必须不改正文/来源/FTS。
- 退回决定：**所有**旧 identity 中无可靠出处的关联都须按证明分组件，不能再用当前正文/kind 筛掉风险；旧无证据显式关联允许保守分开并标记后续重新核实，不伪造历史。

## 2. 业务规则

1. **候选范围**：任何含 ≥2 条目的旧 identity；与正文/kind 无关。按证明组件拆分，无证明条目各自独立。
2. **证明**：仅认可 (a) 仍存在的 `memory_derivations`/`derived_from_entry_id` 父子关系（以 `memory_derivations.parent_entry_id` 为主，缺失时用 `derived_from_entry_id`）；(b) 新的无正文 `share`/`relay`/`explicit` 关系边。正文、factKey、origin/narrator、来源字符串、时间戳不得用于推断。
3. **断根/多跳**：父条目存在则子跟随父组件；父 ID 缺失时，同缺失父 ID 的现存子条目归组；中间/根已删且连接记录不存在的，只能独立并标记 `needs_reverification`，不得补造关系。
4. **多指纹/类别变化旧组**：同样拆分，不因当前正文或 kind 一致/不一致保留；每条来源内容不变。旧显式关联没有边时拆开并标记待重新核实；后续只能经正式 `associateFacts` 重新核实并写 explicit 边，不能假称恢复历史。
5. **控制逐组件继承**：拆分产生的每个组件各自保留旧 share/forget 约束；不把控制留在单一锚上让其他组件绕过。删除指纹/source 控制不复制、不删除。
6. **精确解除**：拆分时旧 share 控制逐组件复制，每个组件都有自己的控制。拆分身份的 `allowSharing` 删除**选中身份自己的 share 控制**；迁移继承或用户主动 `restrictSharing`/独属形成的限制都可被用户明确 allow 解除；只清 share，不清除 forget/source/deleted fingerprint。其他独立事实控制不变；重新限制后再次明确 allow 仍可解除。`allowSharing` 只解除选中 identity 自己的 share 控制；未能核实归属的孤儿旧键限制不凭同键解除，作为既有兼容边界。不需要 origin/direct/inherited 区分。
7. **实际控制读取**：拆分身份（`legacy_identity_id IS NOT NULL`）的 share 检查只看自己的 share 控制 + 未能定位身份的孤儿旧键兼容检查；不在本次迁移按当前同 factKey 重新归因已经处理过的孤儿控制，保留原 `migrateLegacyControls` 的一次处理语义。非拆分身份保持现有同指纹整组检查，作为语义边界。forget 仍按相关身份组检查，旧 forget 控制逐组件复制，防回流指纹不变。
8. **新关系边**：新增无正文 `memory_fact_relation_edges(from_entry_id,to_entry_id,kind,created_at)`，kind 为 `share`/`relay`/`explicit`，无外键、条目删除不删边。分享/转告每跳、显式关联（含已同身份确认）都写入；只存不透明 ID/种类/时间，不存正文/来源内容，删除后边不能召回正文。
9. **版本与幂等**：一个旧 identity 的条目进入多个组件（实际拆分）、或跨 identity 证实合并使组件成员/身份改变时，递增该组件条目版本与角色上下文；只有旧 identity 的全部条目仍在同一组件且无外来条目时完全不改。正常重复启动由 marker 跳过，失败回滚后重试；**不承诺手动删除 marker 后的自愈或“无变化”**。
10. **原子**：DDL、拆分、控制/别名复制、版本/上下文、marker 同一保存点；失败整体回滚，marker 不写。

## 3. Cases（POL-MIG-001～006 v1，P0，master 受托确认）

| Case | 覆盖 |
|---|---|
| POL-MIG-001 | 多指纹/类别变化旧组全量拆分，内容不变，标记重核 |
| POL-MIG-002 | 旧根/中间端点已删、未来关系边、删除不召回正文 |
| POL-MIG-003 | 两独立组件解除互不放开、重新限制再解除、forget 不解除、重启 |
| POL-MIG-004 | 新显式关联、`scope:self` 删 X（a/b/c 三角色）、Y/Z 仍同组、X 防回流 |
| POL-MIG-005 | 跨 identity 证实同组、无证据条目不被卷入、失败回滚、版本条件 |
| POL-MIG-006 | 派生环确定策略、单一已证明组件无变更 |

### POL-MIG-001 多指纹/类别旧组分组件

- **Given**：旧 identity 有 a/b/c，正文或 kind/trust 不同，无 derivation/relation 边；另有同文独立 d。
- **When**：打开旧库迁移，重启。
- **Expected**：a/b/c 各自独立（无证明），d 不变；正文/factKey/来源/FTS 原样；报告记录这些 identity `needs_reverification`；旧显式关联不写入为已核实。
- **Oracle**：迁移前后 entry/FTS/identity 快照、报告内容、重启快照。
- **Boundary**：真实 SQLite/构造旧库；无模型/GUI。

### POL-MIG-002 断根/中间端点已删

- **Given**：历史上 A→B share、B→C relay；A、B 已删，现只存 C→B 派生（B→A 已随 B 删除）；另有两个子条目共享缺失父 P；无 relation 边（旧数据）。再构造一个“未来形状”旧身份：两条条目仅由 relation 边连接、无 derivation。
- **When**：迁移、重启；另在迁移后的库真实 share/relay A'→B'→C'，删 B'，再重启。
- **Expected**：旧 C 不能与 A 重建同组，独立并标记重核；共享缺失父 P 的现存子条目同组；未来形状组按 relation 边保持同组；真实 share/relay 的边行在删 B' 后仍存在，A'/C' 保持合法同组；所有删除后 body/FTS 不召回，边不存正文。
- **Oracle**：identity、derivation、relation edge、list/search/FTS、重启快照。
- **Boundary**：真实 SQLite；无模型。

### POL-MIG-003 控制解除隔离与重新限制

- **Given**：旧 identity 拆成组件 A/B，两者各有同一旧 share 控制复制和 forget 控制；A 有删除指纹。
- **When**：A 调 `allowSharing`；B 再 share/relay；A 再 `restrictSharing` 后尝试 share，再显式 `allowSharing`；重启；A 用同正文新来源重学。
- **Expected**：A 解除 share 只删除 A 的 share 控制，B 仍 `SHARE_BLOCKED`；A 重新限制后 share 再次被拒，再次明确 `allowSharing` 仍可解除；`allowSharing` 不清除 forget/source/删除指纹，A 重学仍被阻断，explicitConsent 才可通过；重启状态保持；B 的控制/防回流不受 A 解除影响。
- **Oracle**：控制表计数、返回码、列表/FTS、重启快照。
- **Boundary**：真实 SQLite；无模型/GUI。

### POL-MIG-004 新显式关联与 self 删除

- **Given**：迁移后 X（角色 a）、Y（角色 b）独立，显式 `associateFacts`；X 派生子 Z（角色 c）。
- **When**：重启；`forget({characterId:'a',entryId:X,scope:'self'})`；重启。
- **Expected**：X/Y/Z 同组；`scope:self` 只删角色 a 的 X，角色 b 的 Y、角色 c 的 Z 正文/FTS/身份仍在；X 的删除指纹/来源控制阻止 X 原文回流，且不召回 X 正文；relation 边保留但不重建 X；不得使用默认 `all`（默认会删全组）。
- **Oracle**：identity/edge/entry/FTS/删除指纹、重学结果、重启快照。
- **Boundary**：真实 SQLite；无模型。

### POL-MIG-005 跨 identity 证实、非卷入、原子与版本

- **Given**：旧 identity I={i1,i2}、J={j1,j2}，真实 relation/derivation 只连接 i1-j1；i2/j2 无证明；另有自足完整派生组件。另有同一布置的故障 fixture，注入 entry 更新失败与 marker 写入失败。
- **When**：迁移、重启；检查 i2/j2 是否被卷入；在故障 fixture 上打开失败、快照、移除故障重试、再次正常启动；比较版本/上下文。
- **Expected**：i1/j1 最终同 identity（跨 identity 证实合并）；i2/j2 不被卷入，各自独立/标记重核；自足组件不变；失败时 DDL/entry/control/alias/version/context/marker 全回滚；重试成功；实际变化组件条目版本各 +1 一次、上下文各 +1 一次，未变化组件不加；正常重复启动无额外变化；不承诺删 marker 后无变化。
- **Oracle**：identity/edge/version/context/marker、失败前后全表快照、restart。
- **Boundary**：真实 SQLite + trigger；无模型/GUI。

### POL-MIG-006 环与单组件

- **Given**：旧 identity 内条目形成派生环 X→Y→X；另有一组所有条目都有完整派生链、已是一个组件。
- **When**：迁移、重启。
- **Expected**：环边不作为证明，环内无其他证明的条目各自独立并记录 `derivation_cycle`；不得一边 union 环边一边声明独立。完整派生链的单组件不拆、不改版本/上下文。重启稳定。
- **Oracle**：identity/version/上下文/报告、重启快照。
- **Boundary**：真实 SQLite；无模型。

## 4. Part A：最小改动与迁移顺序

### 4.1 数据变更

- `memory_fact_relation_edges(from_entry_id,to_entry_id,kind,created_at)`：kind `share|relay|explicit`，主键 `(from_entry_id,to_entry_id,kind)`，无外键；无正文/来源内容；条目删除不删边。
- `memory_fact_identities.legacy_identity_id TEXT`：拆分产生的所有组件写原 identity（锚组件写自身），非拆分 NULL；只表示拆分作用域，不表示等价。
- 迁移 marker/报告写 `app_state` 键 `memory.identity.migration.v2`：`{version:2, appliedAt, splitIdentities, splitEntries, createdIdentities, needsReverification:[identityId...], cycles:[...]}`；不存正文/事实键/角色名。

### 4.2 入口改动

- `share`/`relay`：插入 child 后同事务写一条 `share`/`relay` 边（from=来源条目，to=新建派生条目）；不写正文。
- `associateFacts`：合并成功或已同身份确认时写 `explicit` 边（两端排序幂等）；返回结构不变。
- `deleteEntry`：**不删除** relation 边；forget/独属删除正文/FTS/派生行，边只留不透明 ID，不召回正文。
- `isShareRestricted`：拆分身份只看自身 share 控制 + 未能定位身份的孤儿旧键兼容检查；不在迁移中按同 factKey 重新归因；非拆分身份保持现有同指纹组检查。
- `allowSharing`：拆分身份删除自身 share 控制；无自身控制返回 false，不删除其他 identity 的控制；holders 只返回选中身份。非拆分身份保持现有行为。迁移继承和用户新限制都可由选中身份的明确 allow 解除，不影响 forget/source/deleted fingerprint。
- `restrictSharing`/`keepExclusive`：写入自身 share 控制；重新限制后再次明确 allow 仍可解除，不保存许可状态。
- `mergeFactIdentities`：保存两组当前自身 share 限制并取并集（任一组受限则 canonical 受限），不因某组限制已解除而复活；forget 控制按角色取并集；任一组带 `legacy_identity_id` 时 canonical 保留拆分作用域，以保持精确解除范围；不引入 origin/许可列。
- `createMemoryStore`：在现有保存点内 `migrateFactIdentities` 之后调用新迁移。按约 200 行信号拆出专责模块 `app/memory-identity-migration.cjs`，不再硬塞 `memory-store.cjs`；该模块只负责本次一次性迁移，不建通用框架。

### 4.3 事务顺序

1. 读 marker：`version >= 2` 跳过拆分；不承诺手动删 marker 后无变化。
2. 读全部 entries/derivations/relation edges；计算候选（含 ≥2 条目的 identity，不按正文/kind）。
3. 先建**有效证明图**：有向派生环边先剔除并记录；保留的派生父子边（含缺失父 phantom）与 `share`/`relay`/`explicit` 关系边（无向等价）一起 union，得到全局组件；此阶段不分配 identity。全体 entries 都进入图，不因单条目 identity 无候选而过滤；跨 identity 的边只按证明合并组件并记录。
4. 组件全部求完后一次性分配 identity，禁止逐旧 identity 处理时互相覆盖：
   - 每个旧 identity 的“首选组件”= 含其最早条目的组件；每个组件选一个“目标旧 identity”= 所有首选该组件的旧 identity 中最早条目者。
   - 每个旧 identity 最多成为一个组件的目标；其余组件新建 UUID。最终每个组件恰有一个 identity，同一旧 identity 不被两个组件复用。
   - 建立“旧 identity → 接收其条目的目标 identity 集合”映射，供控制/alias 复制；组件跨多个旧 identity 时，其他旧 identity 的条目迁入目标并记录。
   - 实际变化的组件给最终 identity 写 `legacy_identity_id`（目标旧 identity；新建时取组件最早条目的旧 identity），自足未变化组件不写。
5. 控制/别名：按上述映射，把每个旧 identity 的 share/forget 控制复制到所有接收其条目的目标 identity。**只有非空旧 identity→目标集合确实存在，且该旧 identity 的控制与全部历史 alias 指纹都已完整复制时，才可清理空源控制/alias**；本来无条目的孤儿 identity、控制、alias 没有映射目标，必须原样保留，不能以空壳为由删除防回流。复制 alias 使用该 identity 的全部历史 `memory_fact_aliases`/`memory_fact_alias_conflicts` 指纹，不只当前 body。本次迁移不按当前同 factKey 重新归因已处理过的孤儿旧键控制；未能定位身份的孤儿控制/alias 原样保留，沿用 `migrateLegacyControls` 一次处理语义。删除指纹/旧键行不动。
6. 版本/上下文：若一个旧 identity 的条目进入多个组件（实际拆分），或跨 identity 证实合并改变组件成员/身份，则递增该组件内条目版本一次，并按角色各递增上下文一次；即使锚条目 id 不变，只要组件成员变化也递增。只有旧 identity 全部条目仍在同一组件且无外来条目时才不递增。
7. 写 marker/report（最后）；RELEASE SAVEPOINT。任一步失败 ROLLBACK TO SAVEPOINT，不写 marker，旧库原状；下次重试。

### 4.4 控制读取与解除小结

- 拆分组件：只看自身 share 控制 + 未能定位身份的孤儿旧键兼容检查；`allowSharing` 只解除选中 identity 自己的 share 控制，不凭同键解除未核实孤儿限制；这是既有兼容边界。
- 非拆分/新独立身份：保持现有同指纹整组保守检查，并如实标为语义边界，不把整组检查说成“同一事实已证实”。
- `allowSharing` 删除选中拆分身份自己的 share 控制；迁移继承、用户 `restrictSharing`、独属形成的限制都可由该身份的明确 allow 解除；只清 share，不清 forget/source/deleted fingerprint；其他独立事实控制不变；重新限制后再次明确 allow 仍可解除。
- 合并时保存两组当前 share 限制并取并集，任一组受限则 canonical 受限；不因某组限制已解除而复活；保留任一组拥有的精确拆分作用域，不丢失解除范围。

### 4.5 后续实现范围与顺序

- 允许改动：`app/memory-store.cjs`、`app/memory.cjs`、专责 `app/memory-identity-migration.cjs`、新 `tests/acceptance/memory-identity-migration.spec.cjs`；不改 skill/PRD/版本以外文件。
- 实施顺序：先写新 acceptance Runner 并运行，保存失败基线；再实现迁移/控制/关系边/版本；修改后重跑该 spec 与受影响旧套件。失败原件不覆盖，使用新 attempt 目录与真实退出码。
- 本轮不执行实现；`evaluation` 中 POL-MIG 全部 NOT_COVERED，不写 PASS。

## 5. Part B：验收计划

- 新增 `tests/acceptance/memory-identity-migration.spec.cjs`；复用 `memory-fixtures.cjs`，构造旧 identity/entry/alias/control/derivation 表；Driver 为 `createMemoryDatabase`/`openMemoryDatabase` + `createMemoryService`，迁移在真实 store 打开时触发；不启动 GUI/模型。
- Setup：Case 001 多指纹；002 删除根/中间与缺失父；003 双组件解除/重新限制/forget；004 三角色 scope:self；005 跨 identity 证实+非卷入+trigger 注入 entry/marker 失败；006 派生环+单组件。
- Observation：identity、entry/version、body/factKey/source、FTS、derivation、relation edge、alias/conflict、share 控制计数、forget/删除指纹、marker、context version。
- Oracle：迁移前后 SQLite 快照 + 真实 correct/forget/share/relay/associateFacts/allowSharing 业务结果；不以实现内部函数自证。
- Failure/restart/cleanup：triggers 注入后断言全回滚、无 marker；移除后重试；关闭重开断言正常重复启动无额外变化；每个 Case 关闭 DB、删临时目录。
- 证据：实现批次使用全新 attempt 唯一目录、直接重定向完整 stdout/stderr、真实 node 退出码、code SHA；禁止 tee/tail；失败原件不覆盖。实现需 master 另行授权。
- 既有影响：FACTID-005 DDL rollback 测试需纳入新表/列；既有 alias/control、allowSharing 歧义测试必须保持；新迁移只影响旧库，新建库业务 Expected 不变。

## 6. 状态

- 已接受：持久关系边删除不消失；旧缺失边不恢复；有向派生环先剔除环边再 union 有效边；无证据旧组全量拆分且正文不变；拆分身份 own-identity share 读取；非拆分身份保留现有保守检查并标为语义边界。
- r3 修正：`allowSharing` 对选中身份自己的 share 限制（迁移继承或用户新限制）均可明确解除，只清 share，不清 forget/source/deleted fingerprint；不引入 origin。合并取两组当前 share 限制并集、保留精确作用域。先全局求组件再一次分配 identity，旧 identity 不被两个组件复用；跨 identity 证实合并也递增版本/上下文。
- Cases 003/004/005 已按退回意见调整。
- **master 联合审查通过并受托确认 POL-MIG-001～006 v1（不是用户亲自确认）**。本文件正式化供 snap；仅在有非空旧 identity→目标映射且全部控制/历史 alias 已复制时清理空源，孤儿原样保留、不按同键重新归因；复制别名含全部历史指纹；全局图含全部 entries；成员变化即递增版本/context。
- 实现未开始：evaluation 中 POL-MIG-001～006 全部 NOT_COVERED，不写 PASS；后续按 4.5 先失败 Runner 基线再实现。
