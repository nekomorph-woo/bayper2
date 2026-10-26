# S05i在途审查

22530仍在执行，以下为实际源码发现，终态后以复现与独立验收决定，不抢GUI、不代写。

## 登记丢失不能显示已下线

main.connectorStatus当前条件为`instance.stopped || !instance.registered`即offline；UI映射“已下线/来源已下线”。PRD明确联系不上或登记异常不证明server stop。删除/损坏登记文件但真实server仍活时，runtime保留entry.current=false且Agent unknown，UI却会说已下线，跨层丢掉S05h正证据限定。

补006真实GUI Case：先成功登记在线；保持socket/PID活着，只暂移或损坏本轮隔离registry记录；等真实扫描后界面应“连接暂不可确认/重连中”，不得“已下线”，ledger无offline；恢复相同登记后自动在线，不重复online。然后真正stop+socket ENOENT/PID ESRCH才显示已下线。不得把UI状态等同通知完成。

## finished语义与主观成功

connector-settings.js当前finished文案“已完成”，而同类通知模块采用“已结束”。PRD来源done不等于业务验收成功，采用“本次工作已结束”或“已结束”更准确，保持结果待查看，不向用户暗示代码任务已验收。需同步UI断言但不改变ledger状态。

## 后续通知时效边界

当前onStateChange只在扫描或显式停用后推快照，周期5秒；可作为设置页刷新入口，但不可直接用这5秒节奏满足P0的1秒通知目标。后续气泡需消费实时ledger变化或有界更短通知tick，且只有真实可见内容才ack，不能将设置页或入队当完成。此项属于下一切片约束，不要求本轮搭建额外通知框架。

## 日志证据需覆盖运行至退出

Runner在launch后立即`trace.push(...launched.trace.consoleLines)`、`logs.push(...launched.logs)`，得到的是启动时数组副本。后续操作/错误/退出产生的日志继续写入原数组，未必进入writeCaseLog；003第二次launch同样。终态核实是否改为收集每个launch引用并在关闭后汇总，否则不能根据证据文件为空宣称没有renderer错误/退出异常。修正应简单持有会话记录，不引入日志框架；保留失败批次，至少让Case覆盖一个操作后可辨认的日志事实，不能只检文件存在。

## 已实际查看的开发画面

Codex查看run-20261026160543921-dfdf40/003-disabled-other-online截图：两个同名Agent归属不同实例短ID，一个停用且Agent未知，另一个在线且工作中；同屏操作清楚，面板没有全页滚动。此图只是开发批次视觉证据，不代替Codex最终独立运行。其日志操作/退出后段为空，与上述采集疑虑一致，不单凭空白称运行无异常。adapter新增item.agent显示名fallback需在最终回归中覆盖，并避免把名称当身份。

## 最终独立验收与受托决定

22530已终态。Codex31084独立运行UI6+runtime12+adapter8，共26/26无skip、exit0，日志evidence/s05i-codex-final.log；33913另跑来源设置3+原生窗口3+陪伴UI3，共9/9无skip、exit0，日志evidence/s05i-codex-shell.log。相关diff检查通过。

| Case | 独立结果 | 证据与边界 |
|---|---|---|
| UI001 | PASS | 无登记应用可用、模型请求0；未卸载Herdr二进制 |
| UI002 | PASS | 隔离真实Herdr两种启动顺序，逐Agent名与状态，online不重复 |
| UI003 | PASS | 两个真实Unix协议fixture，停用持久、另一实例不受影响；操作后日志marker实际进入证据 |
| UI004 | PASS | 真实server stop、unknown、同instance新run自动在线、各通知事实计数 |
| UI005 | PASS | 无效IPC、退出socket清理、小窗口局部滚动；实际查看多Agent截图，finished显示已结束 |
| UI006 | PASS | 真实Herdr保持运行仅移动登记文件，不误报下线；恢复登记不重复online，真正stop才offline |

独立UI批次run-20261026162059249-f11868全部正常退出/cleanup ok。006与日志修正已覆盖此前审查意见。新增代码职责清楚，约520生产行含243行局部面板；1136行Runner含两种真实环境的准备清理，规模偏高但未建立通用框架，不为凑行数压缩控制流。

受托接受正式连接器管理切片，通知气泡和插件安装入口尚未完成；5秒设置刷新不称满足P0时效。无需模型参与，关联不授权正文分析。没有人工用户体验声明。
