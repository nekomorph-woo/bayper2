# S03j 已完成主题活动的定向记忆共享

2026-10-27，Codex受托确认范围/Case/方案。依据memory-and-sharing.md及state-and-rhythm.md，承接S03i。独立开发切片，但必须接正式生产链，不能只造孤立服务。

## 业务与技术约定

从story-runtime当前新消费的真实已完成daily/exploration活动接入。在storyProgress.recordNode的onResult同步事务中处理仅本次applied新节点，不处理merged、skipped、历史baseline或重复activity。使用同一SQLite连接，故事结果、共享成功记录、双方记忆与FTS/上下文同时提交；异常全部回滚，不能故事先成功而共享处于未知半状态。可用一个小theme-memory-sharing.cjs集中业务与最小持久结果表；不新增机会抽签、计时器、模型请求、气泡或系统通知，不消耗虚构API次数。该分享是既有活动的一项本地结果，活动已经受正式机会/频率管控。

主题目录每个story可选shareWithCharacterIds（作者显式关联的角色ID数组，省略为空），保留/验证到normalized story与只读节点描述；不能以整份目录主题相同作为所有角色互相关联。正式maid-stories可填写符合故事背景的关联角色，但assetAvailable仍false，禁止为跑通而发布。相关角色也必须已结识且当日名单内、排除讲述者；按作者顺序取第一位自然对象，仅一位。讲述者必须仍是当日合资格成员，精力>30且非休息/探索/聊天；用户聊天、待轮换、锁屏/休眠/退出期间不分享。接收者仅本地记入，无需唤醒/扣精力/调用模型，不授予名单外API资格。

对每个新applied活动结果只评估一次，成功最多全应用滚动24h一次（边界满24h允许），持久最大逻辑时钟防回拨绕过；跳过不占成功额度，不延迟补发或重启补发。共享记录只保留活动/节点/角色ID、时间与结果，不复制正文做审计记忆。

正文只能由可信已发布作者节点读取并标明“主题故事见闻”性质，不使用模型自由文本/聊天/外部会话，不能宣称真实现实亲历。稳定factKey和sourceId由theme/story/fact身份构成（长度>200时稳定hash而非截断碰撞）。使用memory.remember(inTransaction)写讲述者必要片段，memory.share同事务投递保留narrator/origin/derived关系；为share加入与既有remember一致的inTransaction支持，默认仍自有事务。全局开关、逐事实禁分享、发送者/接收者forget与source控制必须生效；不通过重新造ID/正文绕过。既有相同factKey正文若被用户纠正，不把旧作者文案覆盖或自动再传播，保守跳过，不删除用户纠正。

自动share的全局开关检查移入实际写事务内。分享目标已持有同一有效事实时不新增、不占名额；派生不可自动再转发。明确relay路径不变。没有天然目标时不为了分享再生成角色、线索或记忆。读取陪伴getSnapshot会写库并开启事务，必须在story事务外获取最新快照；随后同步无await写入，无并行状态窗口。不要在onResult里嵌套调用getSnapshot。

## Acceptance Contract（正式领域链，无GUI）

| ID | Given / When | Expected / Oracle |
|---|---|---|
| POL-THEME-SHARE-001 | 构造已发布作者目录指定关联B；A/B当日合资格，真实companionship完成活动，runtime.evaluate | 正式故事、A主题见闻、B听A说的派生记忆和共享记录一致落库；C未知；记忆页可用现有list入口读来源；名单/数值不因分享额外变化，无模型/气泡 |
| POL-THEME-SHARE-002 | 两次合法新节点间隔不足24h，重启与时间回拨，再到边界 | 最多一次新投递；重启/回拨无绕过；满24h新活动可分享，历史被跳过活动不补发；已持有/重复activity不占名额 |
| POL-THEME-SHARE-003 | 未发布/无关联对象/名单外/低精力/互动/暂停/开关关闭 | 各自跳过，无越权记忆、模型和新名单；切回允许后不补发旧结果。正式目录assetAvailable=false不被测试修改 |
| POL-THEME-SHARE-004 | 私聊/来源分析内容与作者相近，或用户纠正/删除/禁分享主题事实后重复旧源 | 只允许可信作者节点；私人事实不出现在B；逐事实限制与forget/source防回流有效，用户新正文不被旧作者文案覆盖或转发 |
| POL-THEME-SHARE-005 | 在接收者写入/共享额度落库阶段注入SQLite失败 | 故事progress/result、双方记忆/FTS/上下文、共享记录全部回滚；恢复后一次成功，重试不重复 |

真实SQLite/store/companionship/storyProgress/runtime/memory，全构造作者数据（只在内存发布），可控时钟用于24h，暂停快照入口明确边界。不测试真实模型语义或正式素材发布，不冒充GUI全链。独立Runner固定Case与真实入口；原失败保留，结束关闭DB删除临时目录；源码摘要与命令结果留evidence。

## 派发范围与规模

Claude读取AGENTS/CLAUDE及本规格后实现。允许app/theme-memory-sharing.cjs（一个小模块）、story-progress.cjs、story-runtime.cjs、memory.cjs、store.cjs/main.cjs最小组装、content/maid-stories.json及maid-series-spec.md作者关联约定，tests/acceptance/theme-memory-sharing.spec.cjs与必要现有fixture调整。不要改版本/Git、PRD、无关UI或动画。生产增量预期250～400行、固定Runner约400～600行；超过先说明必要性，不压缩语句/不堆fallback，不建框架。只跑Node领域与unit，不GUI、不.env/外网。遇到歧义或影响超出范围先报告，不静默扩大任务。

追加：Codex静态审查发现原有聊天上下文和记忆页将所有stated/non-derived标为用户直接告知，主题来源必须区分。实施前读取s03j-review.md并纳入最小修正与场景断言；这是原本“主题故事见闻”归因约束的必要接线，未新增业务概念。
