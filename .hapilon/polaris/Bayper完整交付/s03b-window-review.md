# S03b窗口首版审查待办

Codex在开发进行中只读审查，以下不是最终缺陷统计；开发完成后按实际代码确认并复现。不得覆盖其他工作，不能削弱原Case。

## 规模与职责

目前renderer/app.js新增约529行，混入首次引导、小窝和完整聊天状态，接近千行；main新增约250行聊天协调。规格允许独立chat UI小模块且用户强调有序组织。应将聊天视图/状态/事件绑定放到renderer/chat.js等明确模块，仅以必要的现有接口与app接合；main的聊天协调可独立小模块，但不搭通用IPC框架，不压行。删重复setChatSubtitle调用等无实际意义的重复代码。功能断言保持，先完成最小场景再结构整理。

## 异步归属

1. loadArchivedConversation仅判断chat.epoch，没有同一角色内“最近一次选择”的请求标识。快速选历史X再Y，X的慢响应可能最后覆盖Y；点击继续新聊天后，同epoch的旧历史也可能把mode改回readonly。使用明确的查看请求代次/目标核验，并覆盖延迟结果倒序与切换到新聊天两条场景，不用随机等待掩盖。
2. openChatFor加载历史后无再次核验epoch就focus continue；handleChatResult completed分支await refresh后无核验就focus输入。关闭/换角色恰好发生在await期间时，不得用旧操作抢新页面焦点。检查所有await后的DOM/焦点副作用，验证关闭后焦点回到发起按钮且迟到处理不再夺走。
3. closeActiveChat清空activeChat后，closeConversation/endInteraction失败都被吞掉仍返回closed true。需要复现SQLite失败，明确返回失败或维持可恢复的协调状态，不能出现UI已关闭而持久互动锁永久残留。退出可最佳努力清理，但普通关闭不应假报成功；按实际错误边界最小修复。

真实模型协议另见s03b-live-review.md，优先修该已确认FAIL；上述窗口问题先复现后修。UI验收与真实模型测试分开执行，禁止默认触发live-chat；当前允许文件范围继续遵守s03b-window-plan第一切片。

开发中复核：已出现独立renderer/chat-panel.js，原app.js聊天增量降为约20行，前述“集中千行”风险已由开发者自行拆分；最终审查按新文件，不要求重复搬迁。历史读取仍仅epoch核验，其他行为风险需按最终版本复现。

## 协议修复后的本地反馈

实际memoryApplied来自本地事务，窗口应以简短、可辨的本地保存结果反馈（例如“已保存1条记忆”），不依赖模型自由文案。没有写入时不能显示已保存；不要因正常闲聊无候选制造错误警报或额外模型请求。该反馈应只作用当前请求/角色，关闭/切换后的迟到回包不得改新面板。协议r1只用prompt约束自由文本，未形成语义保证，验收时应如实保留边界。

返修后Codex独立18/18通过，见evaluation.md最新批次。main关闭失败保留协调状态，实际SQLite触发器故障及恢复已在UI验证；memoryApplied反馈与关闭焦点/迟到隔离通过。历史代次只完成helper单测和代码检查，后续补实际IPC倒序响应与继续新聊天的UI证据；不以小模块单测冒称完整场景。
