# S03k 审查与验收

2026-10-27，Codex受托接受本切片；整体Goal仍未完成。

## 首轮静态反馈

1. chat-sharing-setting.stripQuoted把引用直接删除后再拼接剩余文本，可能把非授权语句变成命令。例如`关闭自动分享“是错误的”`删引号后成明确关闭。不要重组原文来制造授权；设置指令含引用时保守澄清，或解析时保留明确语法边界。加入该反例及带引用片段的完整句验证，禁止靠扩大黑名单修补词汇。
2. completeLocalSettingRequest保存失败返回error.code（SQLite常为ERR_SQLITE_ERROR）或LOCAL_SETTING_FAILED，但RETRYABLE_ERRORS没有这些值。直接调用retryRequest或许成功，真实UI却不会显示重试按钮。给本地设置失败稳定的业务错误码并列入可重试范围，只作用于该分支；GUI验证失败后能实际点击重试。保留事务回滚和无网络断言，别把所有未知错误都全局放开。
3. disabled确认中的“明确让你转告时”主语不自然，改成用户对当前角色明确转告仍可用的表述；不要改变授权含义。

范围仍按s03k-plan.md，不扩张全部中文语法，不侵入单事实限制。失败/反例修复后才允许独立冻结GUI。

4. SUBJECT_SOURCE首项把“自动”设为可选，会让`关闭角色之间的转告`被执行为只关闭自动分享；这句话没有区分明确转告和自动分享，不能静默缩小成另一个操作。全局设置执行语法要求明确自动范围，未明确时澄清；单事实路径不受影响。补该反例（全局不变、无虚报执行）。

5. 设置话题入口SETTING_MENTION目前只要求方向词加“自动/角色之间”，没有分享语义，`关闭自动更新会有什么影响？`、`请打开自动保存`会被本地分享澄清接管。请补分享话题边界，普通其他自动设置讨论应kind=none；加入反例，保留既有真正分享歧义的本地澄清。GUI请同时记录父进程退出及独有临时路径，截图至少含聊天确认/失败重试，而不只有设置页。

## 返修记录与独立检查安排

首轮CLI3874结束，session cfa52973-c44c-4271-9955-bf4680ee4041；r2 CLI38615完成反馈1～4，原反馈及两次报告保留。第5条追加晚于r2启动，因此明确续派r3 CLI21538，不假定执行者自动读到新增内容。

冻结后由Codex执行POL-SHARESETTING-001～004及相邻聊天/记忆领域回归、unit；POL-SHARESETTING-005走正式Electron并检查失败重试、聊天确认、设置读回、重启后未恢复前的关闭状态，再明确恢复。此批构造数据、不可达模型配置，不读取真实.env、不宣称真实模型语义验收。原话有限语法之外不保证理解，不能据此称全部自然语言控制已覆盖。

## 独立验收结果

代码全部由Claude Code实现，Codex审查并实际执行。r3 CLI21538终态，修正第5条；代码冻结后未再修改。冻结四文件摘要见evidence/s03k-frozen-source.sha256；GUI另记录十文件SHA，全部复核一致。

| Contract | Runner / 状态 | 实际观察与证据 |
|---|---|---|
| POL-SHARESETTING-001 | chat-sharing-setting.spec.cjs / PASS | 真实SQLite持久关闭、同request幂等、零fetch/凭据读取、不新增记忆和数值；重开数据库保持 |
| POL-SHARESETTING-002 | 同上 / PASS | 恢复后逐事实禁分享、遗忘和来源控制不变，受限share/relay仍拒绝 |
| POL-SHARESETTING-003 | 同上 / PASS | 引号/假设/否定/问句/过去/混合/未明确自动范围不执行；自动更新/保存、单事实与闲聊回原路径 |
| POL-SHARESETTING-004 | 同上 / PASS | SQLite真实触发器故障分别阻止设置和确认写入；事务回滚，稳定可重试错误码；恢复后一次完成，冲突和取消不额外写入 |
| POL-SHARESETTING-005 | chat-sharing-setting-ui.spec.cjs / PASS | 真正Electron聊天失败→按钮重试→确认→设置关闭→退出重启仍关闭→明确恢复；记忆/关系/数值保持 |

独立命令与原始日志：
- node --test tests/acceptance/{chat-sharing-setting,chat,chat-memory-operations,chat-relay,memory-auto-share,theme-memory-sharing,memory-sharing,memory}.spec.cjs：94/94，evidence/s03k-domain-codex-r1.log，执行81819。
- npm test：19/19，evidence/s03k-unit-codex-r1.log。
- S03K_SHARING_UI_BATCH=codex-20261027-r1 node --test tests/acceptance/chat-sharing-setting-ui.spec.cjs：1/1，执行92321，evidence/s03k-ui-codex-r1.log。
- S03I_AUTOSHARE_UI_BATCH=codex-s03k-neighbor-20261027 node --test --test-concurrency=1 tests/acceptance/chat-ui.spec.cjs tests/acceptance/memory-auto-share-ui.spec.cjs：12/12（含1项view-gate非GUI检查及11项GUI），执行82347，evidence/s03k-ui-neighbors-codex-r1.log。

Codex实际查看专属截图：失败只有用户消息且重试可见、成功只一条确认、恢复说明窄范围与限制有效、重启设置仍关闭和恢复后开启，文字未截断，布局无本轮明显回退。图与事实位于evidence/s03k-chat-sharing-setting/codex-20261027-r1/；这是Agent自动化与截图审查，不是人类体验。截图文件名保留Runner约定，实际图像为1200×768，不据文件名推定1200×800验收。

清理：两次专属Electron父进程64449/64464均exitCode0、signalCode null，Codex另核对PID已退出、独有临时目录已删除，进程列表未见残留Electron。相邻历史固定截图目录先保留、执行后新图移到evidence/s03k-chat-history-neighbor-codex-20261027，再恢复旧目录；未覆盖旧证据。

## 接受边界与后续

接受有限中文命令集的本地全局开关、事务/幂等/失败重试及正式GUI。GUI使用构造已接纳角色与不可达模型配置，不连接真实模型；零调用由领域计数验证，不把不可达地址本身视为完整网络审计。其他自动功能的讨论仍交原聊天模型，未因此新增自动更新/保存功能。生产增量约三百行，两个Runner总计约千行，内容为完整真实数据库/GUI场景，未引入通用框架；规模超初始提示的原因明确，Codex接受该边界。

不同factKey语义关联、正式主题素材发布后的共享GUI、全部动画与故事邀请仍待完成。开源源码补读记录见memory-source-review.md，本轮只有研究依据，不称已实现关联。Polaris未发现需改skill的实际缺陷，本轮不修改skill。
