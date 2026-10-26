# S05g Herdr登记发现与多实例运行管理

Codex依据现行连接器PRD受托确定。既有正式登记插件、reader、transport、adapter及ledger已独立验收；本轮把它们组合为应用唯一可调用的连接运行入口，随后接main与设置/气泡。避免main自己维护第二套连接重试与实例身份。此轮不冒称用户可见通知完成。

## 最小实现范围

新增app/herdr-runtime.cjs及tests/acceptance/herdr-runtime.spec.cjs；仅发现实际集成缺陷时窄改herdr-adapter/registry。禁止main/store/renderer、插件安装、版本/Git/文档。复用显式registryDir与ledger，不新建SQLite连接。生产目标约200～300行、测试约400～600行是审查信号，不压缩语句凑行数，不造Connector SDK或通用任务框架。

- 启动立即扫描一次，之后低成本定期扫描（默认5秒，可注入测试调度），只读取正式registry有限目录。Herdr先开、Bayper后开以及反向顺序均自动连接。扫描结果只代表端点登记，online仍由adapter真实ping/snapshot确认。
- 每instance最多一adapter。同run重复登记/扫描不重建、不重复subscribe/上线；run换代先dispose旧实例再启新实例。所有实例使用同一ledger，Agent身份沿用instance/run/terminal。单实例失败不妨碍其他实例，禁止每次scan主动refresh已有adapter制造订阅风暴。
- 只启动endpoint matches的有效记录。缺失/坏登记记录不直接宣告服务端stop，不因一次读失败销毁仍在线实例。旧socket replaced且无新有效登记时，不允许旧adapter自动连上新server并沿用旧run；需明确暂停/销毁旧adapter并记断连，等待新登记。每次真正尝试重连也必须确认登记socket身份，避免两次扫描间旧run偷连新socket。若需adapter窄扩展校验入口，保持默认兼容现有调用。
- disable先持久ledger禁用并停止对应adapter；enable由用户动作恢复，扫描绝不自动enable。运行管理读取ledger实际disabled状态而非只存内存。重启后禁用仍生效。未登记对象拒绝无依据的enable/disable，不创建虚假连接。
- dispose有界停止扫描、所有adapter与在途连接；晚响应不落库。运行管理只dispose不写offline，不把关闭Bayper误记成Herdr下线。丢socket/PID不存在仍只断连；明确server stop确认链另行建立，不在此假造。
- 暴露最小start/scan/getState/disable/enable/dispose接口。快照只含连接状态及脱敏诊断，无会话正文、凭据和任意命令入口。保留reader截断诊断，不能声称100之外全部发现。不加文件watcher与备用扫描框架。

## Case合同

真实SQLite、正式registry reader/adapter/transport；真实本地Unix socket协议fixture控制响应与重启，不mock核心服务。唯一批次保留失败/后续结果。无需GUI，不操作用户Herdr进程或全局配置。

| Case | Given / When | Expected / Oracle |
|---|---|---|
| POL-HERDR-RUNTIME-001 | 登记先存在后启动runtime；runtime先启动后出现第二登记；两实例含同名局部pane | 真实握手与账本各自在线，Agent互不串联；重复扫描上线/订阅计数不增加；一个故障不阻塞另一个 |
| POL-HERDR-RUNTIME-002 | 原run在途响应时替换socket并更新新run登记；另组延迟新登记 | 旧adapter终止，旧回调不写新run；新run经正式握手建立；新登记前不把新socket当旧run连接，包括adapter自身重试时序 |
| POL-HERDR-RUNTIME-003 | 用户禁用、扫描、真正关库重开、再启用 | 持久disabled不偷偷连接；显式启用后一次恢复；无重复上线轰炸/另一实例不受影响 |
| POL-HERDR-RUNTIME-004 | 登记暂时损坏/目录不可读/丢socket，后续修复 | 不凭文件损坏或socket缺失生成offline；既有连接合理保留/断连，修复可恢复；有限读取与诊断可见 |
| POL-HERDR-RUNTIME-005 | 连接挂起、并发scan、dispose后晚响应并关库 | 同实例无重复adapter，退出有界、无timer/socket泄漏、无迟到数据库操作；重复dispose安全 |

另外用现有隔离Herdr方法做一项真实端点自动发现与清理验证，可并入001；只能创建随机具名session和隔离XDG，绝不触碰默认或已有工作server。遵守已授权隔离范围，不伪造HERDR_ENV。最终报告标明fixture与真实Herdr边界，主进程/UI/安装/可信stop尚未接入。
