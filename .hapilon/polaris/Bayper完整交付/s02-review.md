# S02a 独立审查与返修要求

2026-10-25，Codex审查首轮工作区；尚未接受。实际依据app/companionship.cjs与companion-store.cjs，正式Case及companionship-rules.md。

## 待核实/修正

1. 跨日：ensureDailyRoster只刷新资格，requestAutoRotation只看精力；旧current不在新名单且精力高时，completeNaturalNode没有交接待办。需在跨日刷新后留下明确交接原因，聊天继续归原角色，结束并完成自然节点后换到合资格角色。不可给旧角色继续自动资格。增加高精力旧current被换出名单的完整Case。
2. 临时聊天返回：chooseReturnCharacter仅检查名单/探索，未核对“状态适合”的精力、自动退场冷却。前任疲惫或冷却中应选择合格候场，否则安静休息。不得由返回逻辑绕过候场阈值。
3. 事务：applySettlement分两条独立写入精力和时间；setFixed分别替换名单/写fixed state；交接亦多条写入。进程异常或存储失败可能留下重复结算或身份不一致。按真实业务动作设轻量事务边界，不建复杂unit-of-work框架；保留失败时回滚Case。
4. 重复start：已启动分支applyStoredModes直接推进lastSettledAt，可能丢失尚未结算区间（正式accept会调用）。必须先结算旧模式再更新锚点，新增已运行一段时间后start不吞掉消耗的场景。

## S02b明确待接入

- 目前无主进程定时结算/跨日推进、powerMonitor锁屏休眠恢复和自然节点实际播放器信号；S02a服务测试不能据此称后台陪伴已运作。
- switchTo/rest当前立即切换，真实桌面及聊天短节点收束在S02b/S03b接入；不用假按钮声称实际聊天完成。
- 突然崩溃后的在线/离线区间只能依据持久化心跳判断，不能把上次UI读取以来所有时间当作离线奖励；主进程心跳需有界持久化，休眠明确切换模式。

首轮全部测试结果尚待Claude结束后独立运行。以上为具体行为问题，不以文件行数单独判不合格；当前业务/存储约930行，应优先清晰事务与消除重复，不压行。
