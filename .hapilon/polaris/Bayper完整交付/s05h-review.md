# S05h在途审查

6997尚未终态。新增connected事实目前由startEntry第一次start成功和getState看见adapter.online时写入。若首次失败→adapter内部自动重试成功→下个scan/getState前又停止，runtime可能从未把connected设true，虽然服务实际成功连接却永远不产生offline。不能依赖UI频繁读快照才能记录曾连接这一业务事实。

终态核对并补Case：scan周期拉长，首次ping失败后同一adapter自动重试成功；用fixture端socket/ledger或外部进程Oracle判断真正握手，期间不调用runtime.getState/scan；随后停止端点+退出登记PID，再scan应只产生一次offline。如果getState副作用是唯一记录路径则返修，优先以明确连接成功回调或已可信的同appRun持久事实记录，不造高频poll。失去全部证据应保守unknown，但不能主动漏记已经经过本进程的成功握手。当前只是代码路径推断，不标已复现FAIL。

6997已终态，Codex独立67972运行runtime10+adapter8+ledger7，25/25无skip/exit0（evidence/s05h-codex-first.log）。首版成功路径与负向条件通过，但本页首次失败后快速重连/停止的曾连接事实缺口仍在，已交回补011真实时序，不接受提交首版。

## 已确认下线之后新run重启

最终diff再发现reconcile的启动门使用`instance.stoppedAt !== null`但没有核对`instance.runId === entry.registration.runId`。旧run已confirmStopped后，插件写同instance新run登记，entry虽然重置stopped，ledger仍指向旧已停止run，新adapter会在注册之前被旧stoppedAt挡住。现010是旧run尚未确认停止就登记新run，不能覆盖“真实下线→重启”。

补POL-HERDR-RUNTIME-012：先在线→确认offline一次→同路径新socket/newrun正式登记→scan→真实新握手。必须新run在线、Agent新身份、旧offline不重复、新online一次；无需用户enable/重启Bayper。先留失败再最小修，将停止门限定为同run，不弱化已停止旧run不得复活的规则。

## 最终独立验收与受托决定

Codex独立执行runtime、adapter、ledger共27项，全部PASS，无skip，exit0；日志 `evidence/s05h-codex-final.log`。011与012先失败再修复，最终回调只在完整握手后记录connected，新run不被旧run停止标记阻挡。getState不承担状态采集副作用。

真实Herdr隔离008批次 `2026-10-26T15-42-36-919Z-30efb5`：server PID96501，正常stop/exit0，socket删除、临时目录删除，offline恰好一次，Agent转unknown且保留lastKnownState。009覆盖证据不足不误判，010覆盖新run/disable/dispose。

受托接受本切片；仅接受runtime停止证据与重启行为，不宣称main集成、设置页或真实通知气泡已经完成。PID复用与权限不明时保守断连；该证据不区分正常停止和进程崩溃。
