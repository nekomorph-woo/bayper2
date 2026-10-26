# S03i 审查与验收

2026-10-27，Codex主持；当前实现审查中，尚未接受。

## 首轮静态反馈（待Claude修复）

1. app.js当前settingsTab不记录connectors，存在「记忆→连接器→记忆」第二次点击被早返回拦截的确定路径。请最小修复并在GUI Case004增加真实往返点击/可见面板断言；不要另建导航框架。
2. GUI Runner closeApp吞掉app.close错误却在finally无条件记录appClosed:true。必须记录/验证实际进程退出与临时目录删除；关闭失败不可写PASS或伪造清理。沿用其他Runner的有界清理，不造通用进程管理器。
3. 给UI说明保留用户能理解的边界，删除“默认开启…不代表现在已有后台分享行为”这类实现阶段解释，改为“有合适见闻时才会分享，不会每天安排分享任务”。阶段未接线的限制在本review记录，不能把内部进度塞入产品设置。

本切片只验证全局控制；领域fixture通过share复制用户偏好只是验证旧服务入口的开关守卫，不能记为生产允许自动分享偏好。完整主题来源、名单、24h和预算约束仍由后续切片承担，当前生产没有share调用方。

## Codex独立首批

GUI codex-20261027-r1：001通过，004在构造保存失败处Runner.check抛错。失败发生于预期立即回退的checkbox，Playwright.check自动要求最终checked=true，与本Case预期回退false冲突。应仅将该失败动作改为真实click，再等待错误可见并保留checked=false、DBfalse、label关闭全部断言；其余成功路径check保持。原批保留，两个Case应用/子进程/临时库均确认清理。领域独立65/65通过（s03i-domain-codex-r2.log），生产未改。

## 独立复验结果

Claude CLI68661首轮与30579定向修Runner均终态；开发会话55dfd8f3-18e7-4cb5-b9e3-6cd742a74a03，输出claude-s03i-control.json及-r2.json。正式代码约177行、领域209行、GUI559行；GUI因固定Case的真实进程清理和失败边界超预期，逐段核对后保留，无通用框架。

Codex93101执行：`S03I_AUTOSHARE_UI_BATCH=codex-20261027-r2 node --test tests/acceptance/memory-auto-share-ui.spec.cjs`，2/2通过。每例八个源码SHA与现文件完全一致。真实Electron/main/preload/renderer/SQLite；模型配置是构造元数据，未请求模型、未授权或读取用户来源。失败保存仅该小步骤替换IPC返回，随后恢复真实handler并成功保存；非可信请求通过调用真实handler构造sender/frame，不声称完成外部攻击测试。

| Contract | Result | 实际证据与边界 |
|---|---|---|
| 001 | PASS | 正式设置默认开启，关闭写库，重启保持；记忆、名单、数值、控制不变。UI001与领域001 |
| 002 | PASS | 关闭后share拒绝，接收者/FTS/上下文不变；开启恢复原入口但逐事实限制仍拒绝。领域002 |
| 003 | PASS | 关闭后明确relay成功保留讲述来源；不改开关、不广播，禁分享事实仍拒绝。领域003；本片没有另外跑真实模型转告 |
| 004 | PASS | 两尺寸完整可见，无整页滚动；记忆→连接器→记忆实际往返；非布尔/非可信拒绝；构造保存失败真实回退，再恢复真实保存。UI004 |

Codex看过960×680关闭状态与1200×800保存失败截图：文字、开关、错误反馈无裁切，沿用原生式分区布局。r2父进程exit0、桌面子进程残留[]、目录删除true；001中间重启也实断言关闭。原r1失败不覆盖。领域独立65/65与unit19/19通过，日志s03i-domain-codex-r2.log、s03i-unit-codex-r1.log。相邻GUI回归仍待完成，完成后方可接受提交。

限制：主题自动分享尚未生产接线，不包含24h预算、名单选择、自然语言全局指令或异factKey语义归并。不将本片称为完整S03交付。尺寸与体验由Codex实际截图审查，不记成人类用户体验确认。

相邻独立GUI69491终态0：connector-ui6例+memory-ui6例共12/12通过，日志s03i-neighbor-ui-codex-r1.log；连接器隔离真实Herdr批次s05i-connections-ui/run-20261026235454567-896172，六份日志均cleanup:ok/appExit0。memory-ui旧Runner写固定s03c-memory-ui路径，本次截图属于当前批而非历史快照，不能当独立保留的旧图；后续运行应先保存已有目录，避免覆盖证据。新S03i Runner使用唯一批次，原失败保留。本轮未发现需修订Polaris skill的新问题。

Codex基于实际diff、独立执行、源码摘要和截图接受S03i控制范围。后续继续s03j-design-notes.md中的主题来源/活动结果接线，不扩大本次完成声明。
