# S05h 确认Herdr运行结束

Codex受托实现PRD的server stop后下线事实。S05g仅连接管理，不把socket失踪单独当停止；本轮在其之上补正向证据，不改写旧结论。依据s05c-review实际插件ppid与server句柄匹配、本机macOS `man 2 kill`（sig=0仅检查，ESRCH无该PID，EPERM不等于退出）。不需要常驻插件守护、native addon或shell ps遍历。

## 最小范围

仅app/herdr-runtime.cjs与tests/acceptance/herdr-runtime.spec.cjs，必要极小helper可留同文件。禁止main/store/adapter/renderer/版本/Git/文档。生产新增约50～90行，测试复用已有真实socket/随机Herdr fixture，不复制框架。用户已授权隔离测试，禁止用户默认或已有server。

判定必须同时满足：
1. 该instance/run由正式有效插件登记且本次Bayper运行已完成adapter真实连接；不凭历史旧文件或仅首次尝试失败判下线。
2. 当前ledger仍是同run、未禁用、运行管理未dispose；该实例已失去有效连接。
3. 同登记socket已经不存在（ENOENT）；stat权限/其他错误、被替换仍不等于消失。不得把reader统称missing当精确ENOENT，需要只对这条显式登记路径只读核实。
4. 对登记observedServerPid（正整数）进行process.kill(pid,0)，只有ESRCH为无进程证据。成功或EPERM/其他错误均不确认。它证明这代server已结束，不证明是用户正常stop还是崩溃，文案仅“已下线”。PID已复用时宁可保持断连，不能因为命令名变化就强断言。

条件满足则停止该adapter并用既有ledger.confirmStopped记录一次offline；Agent保持unknown，不制造finished。重复scan无重复下线。重新登记新run后正常建立新adapter；旧run检测晚结果不得停止新run。dispose只退出Bayper、不写Herdr offline。判定只在既有扫描周期做，不增加高频定时器，不启动外部命令或发送真实信号；同步probe避免异步跨run竞态。测试注入processProbe仅用于EPERM等不可安全重现场景，生产默认必须实际只读。

## Case

- POL-HERDR-RUNTIME-008：真实随机隔离Herdr+正式登记/运行管理，在线后server stop，由真实退出/socket消失/ESRCH触发一个offline；重复scan无重复；agents unknown且无假done。此Case可复用并增强既有REAL，独立执行应保存server句柄退出作为Oracle。
- 009：已连真实socket但socket被移走、登记PID仍活着，无offline；EPERM/未知错误无offline；仅坏登记、仅旧离线登记、首次握手从未成功即PID消失也无offline。fixture构造字段须注明，不把其声称为真实插件。
- 010：旧run检测条件成立前新run已登记/连接，旧事实不停止新run；显式disable与runtime.dispose不产生offline。必要复用现有Case断言。

保留唯一批次失败与结果，回归runtime+adapter+ledger，明确真实Herdr与fixture边界。此轮仅持久事实，不宣称气泡用户已收到。
