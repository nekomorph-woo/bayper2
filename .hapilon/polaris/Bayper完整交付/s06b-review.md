# S06b 在途预审

90767仍在开发，以下仅只读疑点，待终态核对并补真实Case后才定FAIL，不打断开发或自行修改代码。

1. 构造器仅NEXT_KEY不存在时设置now+30分钟；已有过期NEXT_KEY时，应用关闭很久重新构造服务，首次evaluate可能立即抽签，与规格“首次启动和恢复从当前30分钟后，无欠账”冲突。需真实同SQLite重建+长时间离线验证。重建服务不可突破频率，也不应把旧到期工作当刚启动就必须做。
2. resume写clockNow()+30分钟未取旧next/last约束；在系统时钟回拨后pause/resume可能把next推早（evaluate只挡at<last，不保证距last满30分钟）。需已评估→时间回拨→pause/resume→回到last后的短间隔，不应提前再评估。保留真实时钟边界而非只测无pause的回拨。
3. transact对缺少runInTransaction静默退到work，会允许两条状态写部分成功。本项目真实store已通过companion导出事务能力，若实现依赖事务应显式要求，而非制造不必要fallback。验证生产store能力后决定是否收紧，不以抽象测试替代真实持久化。

## 独立验收与接受

90767终态后Codex独立原4Case通过，但未据此接受；77851按上述疑点补005～007，修前真实失败见evidence/s06b-opportunities/07-prefix-boundaries.log。返修后Codex独立7/7（evidence/s06b-codex-repair.log），核对nextTarget=max(now+30min,existingNext,last+30min)，构造与resume共用；runInTransaction为必需依赖，不再静默非原子执行。原004通过真实SQLite trigger验证写失败不部分推进。接受本模块阶段。

Case005重建的是同一SQLite连接上的服务实例，不是OS进程重启；实际main重启/暂停恢复仍需集成验收。真实companion、source-analysis/permissions/reader/budget/memory与HTTP fixture组合不等于正式GUI自动分析。当前未接心跳，不实现完整日常/探索代价、线索、服装。生产347行/测试699行超初始信号，主要为明确异步取消与真实依赖链路，未引入调度框架，接受并继续接线。
