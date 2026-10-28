# S06k 服装成熟结果自动入库

2026-10-28，Codex master受托批准v1，增量开发。父级S06/S07，依据PRD与clues-and-discovery.md的成熟自动解锁、滚动72小时、无需领取、不自动穿用和内容不可用保留规则。前序S06j只交付故事回看/手动相遇；正式服装UI、自动提示、换装和资源发布仍未完成。

## 当前最小切片

生产已有discoveryOutcomes.unlockNextOutfit，但无正式调用方。通过既有storyRuntime.evaluate在活动评估完成后调用一次既有解锁事务；即使本次无新活动也检查成熟待解锁故事，使72小时到期无需刷活动/点击领取。只用实际运行时钟，不补离线活动、线索或份额；每轮最多一套，重启仍遵守数据库额度和幂等。保留evaluate原返回类型，不能破坏现有调用者。首次启动基线只跳过历史活动，已成熟故事事实保留且后续正常心跳可检查。

storyWindow只读summary为outfit故事附带当前outfitOwnership（character故事为null）；读取不得解锁或ACK。pending提示保留，不在此轮伪造已展示或消耗分享额度。同步运行无新增API/队列/schema/框架，不改变记忆、关系、名单、当前角色、数值或穿着。SQLite解锁失败保留成熟故事，下一次心跳安全重试，不消耗新活动。正式目录assetAvailable=false继续保持，构造发布目录通过不算正式素材验收。

允许app/story-runtime.cjs、app/story-window.cjs、tests/acceptance/story-runtime.spec.cjs、tests/acceptance/story-window.spec.cjs；若构造stub因新增依赖不兼容，先定位，不随意可选跳过真实依赖。生产预计20～45行增量，测试复用既有fixture约120～200行；不新造大Runner、不压缩控制流。

|Case|Given / When|Expected / Oracle|
|---|---|---|
|POL-OUTFITRUN-001|已接纳角色、构造可用服装故事，经正式活动完成及storyRuntime.evaluate形成成熟|同次运行自动产生唯一所有权，来源活动/故事归属正确；无手动unlock调用；不改关系/名单/记忆/数值、pending提示仍在；无新API。|
|POL-OUTFITRUN-002|第二故事成熟，已有一次解锁；在72h前后运行evaluate，无新增活动|前不解锁，边界后解锁一次；重复、重开与再次evaluate不重复解锁/改变时间，不补活动或线索。|
|POL-OUTFITRUN-003|不可用素材或未结识归属；随后资源/资格满足；解锁事务写失败后重试|未满足不解锁且进度保留；满足后下一正常运行解锁；写失败不产生半记录、不丢成熟进度，重试仅一次；正式未发布门仍有效。|
|POL-OUTFITRUN-004|读取故事列表和详情，服装未解锁/已解锁/角色故事|只返回事实及outfitOwnership/null，读取不解锁、不ACK、不改展示时间/额度；解锁后无需重启即可查询。|

Case使用真实SQLite、storyRuntime/活动业务入口，时钟/内容fixture构造；不宣称GUI、真实发布服装或整体换装通过。Claude先复现缺接线，实施后运行story-runtime、story-window、discovery-outcomes、story-progress及受影响theme-sharing回归；不运行GUI/真实API、不改文档/版本/Git。master独立diff和检查后snap，下一切片接正式服装展示/换装与素材身份，保留父级未闭环。
