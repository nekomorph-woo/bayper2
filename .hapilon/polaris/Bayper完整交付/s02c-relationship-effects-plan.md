# S02c 关系数值事件与心情恢复

Codex受托确认，依据state-and-rhythm.md“三项数值默认”。已有companionship只结算精力，亲密/心情仍静态；先使实际可信事件的数值结算与心情时间恢复可用，再在后续聊天/活动接线，不把本模块当全部关系成长交付。

## 范围

新增app/relationship-effects.cjs；允许app/companion-store.cjs用现有同一db构造并暴露窄接口，app/companionship.cjs在真实start/prepare/离线恢复等已有结算位置调用心情结算。新增tests/acceptance/relationship-effects.spec.cjs；仅必要扩展已有companionship测试，原Expected不弱化。禁止app/store.cjs/main/preload/renderer（S04d独占）、chat/memory/其他服务/预算/Herdr/素材/Git/版本/文档。不需要GUI，不调用模型，不读.env。

约新增生产200～300行，接线50行内，测试300～450行信号；不建事件总线、通用rule engine、可视化调参平台。优先直接SQLite事务和明确业务方法。不要压缩代码凑行数。先读AGENTS/CLAUDE、state-and-rhythm、已有companion-store/companionship/store测试，确认export合并不会覆盖既有方法。

## 接口与规则

1. 新factory使用既有db与显式时间。可信主进程内部recordRelationshipEvent({eventId,characterId,kind,at})只支持：meaningful_interaction、shared_activity、pleasant_interaction、interesting_activity、activity_setback。不开放renderer任意数值写入。复合真实事件可由明确事实映射到亲密与心情类别，但同一ID重复绝不再计；若需要同时表达亲密与愉快，用一个event带明确布尔事实而非两次重用ID，最终接口请选择清楚一种并报告。不能把收到一条消息/HTTP成功自动推断为愉快或共同经历。
2. meaningful_interaction每角色本地自然日首次+1，shared_activity同日首次再+1，亲密每日最多+2且0～100。没有负向亲密；重复点按、被忽略邀请、普通陪伴、拒绝、纠正、模型失败不调用此奖励入口。日期按可信本机结算时间，不接受模型给任意日期；旧event重放跨日仍不奖励，事件ID去重必须持久化。时间回拨不使同一已奖励自然日再次获奖。
3. pleasant_interaction与interesting_activity分别按实际类别30分钟最多+1；activity_setback同类1小时最多-1，心情-2～2。失败模型/Herdr错误不是activity_setback。先恢复旧心情，再应用新有效影响。没有实际数值影响（如触顶/冷却拒绝）的事件不推迟自然恢复。重复事件不推迟任何锚点。
4. 无新影响每30分钟向0回归一档，保留不足30分钟的余量；例如+2经过45分钟为+1，再15分钟为0。新有效影响从其发生时刻重新计算恢复间隔。离线也恢复，不触发模型/活动/扣亲密。不因回拨负恢复或将未来锚点拉早。已有库无锚点时从首次接入时刻建立，不臆测过去心情来源。
5. 事件记录/每日类别额度/冷却/数值/恢复锚点同一事务；失败无部分变更，后续合法重试可执行。eventId同值但角色或内容不同应明确冲突，不默默把不同事实当成功；合法未知角色拒绝。不接受调用者自由intimacyDelta/moodDelta。
6. 与真实companion共用库和同一事务语义；调用getSnapshot/生命周期现有入口能看见心情恢复，重复快照不重复收益。不能新增第二套角色数值表当真相。精力已有耗时与聊天逻辑保持；有效互动精力、daily/exploring成本与实际事件生成是后续任务，不在此假装通过。
7. 记录可保留最少事件ID、角色、类别、实际时间及结果，不保存私聊原文。参数集中在该业务模块的命名常量，默认值来自PRD，禁过度配置。不得因运行每次tick无限生成事件记录；仅实际事件入账。

## Acceptance Contract

真实createStore/SQLite/companionship；仅时钟fixture，无模型。

- POL-RELATION-001：已接纳两角色→多次有意义互动/共同活动/重放/更名/跨日→每角色类别+1每日总+2，独立数值，重放跨日不再加，无负亲密。原始事件与DB数值为Oracle。
- POL-RELATION-002：真实愉快/有趣/受挫事件与冷却/触顶→正向30min、负向1h限制；+2经45min为+1再15min归0，冷却拒绝/重复/触顶不续命。getSnapshot实际反映恢复。
- POL-RELATION-003：关闭store并重开服务、长离线、回拨、已有无锚点库→恢复至0，亲密保留，无补做奖励，去重和冷却保留，不倒退锚点。必须实际关闭重开DB，不仅重构对象。
- POL-RELATION-004：真实SQLite写入故障、eventID冲突、未知角色/非法输入→全部原子回滚，无错误归属或跨角色改动；移除故障同ID可合法重试，正常重复幂等。

保留evidence/s02c-relationship/原始失败与最终日志，完成后报告接口、SQL迁移/规模、真实场景结果、未接聊天活动事实来源边界。禁止自行改PRD规则以过测试。
