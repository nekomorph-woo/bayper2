# S05g在途审查

61211尚在运行，以下为源码路径疑点，最终版本与真实Case核对后才判定；不修改在途代码、不把推断写成已复现FAIL。

## 临时端点不可验证之后的自动恢复

adapter.connect新增verifyEndpoint失败时返回`{started:false,reason:STALE_ENDPOINT}`；重试timer目前只对reject调用handleConnectFailure。runtime保留已有adapter，并且同run扫描不会refresh它。因此一次临时无法stat（socket missing/权限读失败）恰逢重试，可能耗尽唯一retrytimer，后续同一端点重新可验证也不再自动连接。区别于确实换inode需要等待新run登记：临时不可验证不应永久卡住。

终态补核Case：正式runtime已连接，断开进入重试；校验入口一次false后再次true，socket元数据与run保持原身份，后续合法退避应实际重握手并恢复，不能手动refresh/重启runtime救活。可通过受控stat失败fixture模拟一次系统访问失败，保留真实transport/ledger；若直接adapter校验fixture补验，则另核runtime不会把失败adapter永久吞掉。停止/禁用/真正换端点仍不得复活旧run，不用每次scan重建订阅绕过。

## 替换窗口与回写门

当前只在connect起点验证socket，随后ping、preflight、订阅/对账之间端点可变化。终态检查002是否覆盖请求在途替换，且旧回调不会把新server快照记入旧run。尤其transport每个request是否新开socket，需要结合源码核对。只在scan换run时dispose不自动证明两次扫描之间身份门足够。

在途Runner进一步核对：002的第二段先写新登记并runtime.scan，再发送旧订阅状态；证明已dispose后的旧回调隔离，但未覆盖ping结束到preflight之间换socket且新登记未被扫描。004修复路径直接新run登记，也未覆盖同run一次临时stat失败恢复。终态应加入独立006/007，不以现有002/004标题作为覆盖证明。fixture可让旧server收到ping后移走旧socket并启动新socket，再返回pong，观察新server快照是否被旧run摄入；不需要真实用户server。

## 首版独立执行

61211终态后，Codex独立9851执行runtime6+adapter8+ledger7=21/21，无skip/exit0，日志evidence/s05g-codex-first.log。新增006/007仍未覆盖，已按本页交回Claude先复现再修正，当前不接受S05g。既有通过保留，不将新增检查失败覆盖掉。

## 返修与独立验收

69298终态，006/007修前真实失败保留`failure-s05g-006007-20261026T231626`：同run恢复超时、新server错误收到2次请求。修复为每次ping/snapshot/subscribe前身份校验，不可验证抛错走已有退避链，不再吞掉retry；未重写transport或每scan重建订阅。

Codex独立63455执行runtime8+adapter8+ledger7=23/23，无skip/exit0，evidence/s05g-codex-repair.log。独立runtime批次2026-10-26T15-18-47-767Z-e170b9。node --check两个生产文件及git diff --check通过。

| Case | 结果 | 实际观察 |
|---|---|---|
| POL-HERDR-RUNTIME-001 | PASS | 双向启动次序、多实例同名pane隔离、重复scan不重复订阅；单实例断连不影响另一实例 |
| 002 | PASS | 新socket无登记不被旧run重连，登记后新run握手；dispose后的旧回调不写入 |
| 003 | PASS | 禁用持久到关库重开，扫描不复活，显式enable恢复 |
| 004 | PASS | 登记损坏/目录不可读/缺socket不伪造offline，修复后可恢复，截断诊断保留 |
| 005 | PASS | 并发scan不重复adapter，挂起请求dispose后不写库，资源清理 |
| 006 | PASS | 隔离目录临时chmod导致stat失败，恢复权限后不调用scan/refresh仍自动退避恢复，同run不上线重播 |
| 007 | PASS | 旧ping在途替换端点，新登记前新server零request/subscribe；登记后正常握手 |
| REAL | PASS | 正式插件登记+隔离真实Herdr自动发现；server正常退出，socket/临时根清理 |

受托接受登记发现与多实例运行管理。角色GUI/主进程装配、插件安装入口、可信server stop判断和气泡呈现仍未完成。身份保护基于本机socket元数据，每请求边界核对；stat到内核connect仍不是原子认证，不声称对恶意瞬时替换提供协议级身份保证。真实stop目前仅断连，不冒报用户已收到下线。生产约355行运行管理及adapter窄扩展，测试1182行含实际socket/进程资源管理，未建通用Connector框架。
