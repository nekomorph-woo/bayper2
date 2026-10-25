# S05b-2 正式传输与真实Herdr隔离互通

Codex受托确认。前置：s05b-review.md返修独立接受。用户已明确允许从会话外创建、控制并清理独立Herdr测试会话，覆盖Herdr skill环境入口限制仅限自建隔离环境；不得伪造HERDR_ENV或连接现有会话。此计划先准备，未运行即不标PASS。

## 目的与边界

正式herdr-transport必须实测本机0.9.5协议，不能仅靠自写fixture自证。测试使用生产模块，不能重写一份socket客户端来替它成功。只验证只读传输与真实事件格式，不把它当插件安装发现、状态账本对账或GUI气泡端到端完成。

新增tests/acceptance/herdr-live.spec.cjs（显式手动运行的隔离集成集合，不加入默认npm test）；若需要项目专用辅助能力，放tools/herdr-integration/内自包含，优先一个可读测试文件完成。不得把正式代码依赖research探针；可读取此前隔离配置和报告作为证据。具体执行在Codex确认transport修复后派发。

## 隔离纪律

每轮新建tmp根，显式XDG_CONFIG_HOME/XDG_STATE_HOME/XDG_DATA_HOME/HERDR_CONFIG_PATH，配置禁登录shell/更新检查/通知/Agent自动恢复；不能修改HOME或全局配置。具名随机session，绝不使用默认session。所有Herdr控制命令由同一已验证隔离env和session发出；必要socket路径必须来自本轮实际server状态/创建结果，不能猜测用户socket。测试只创建自己的workspace、pane与短期sleep载体，使用构造report-status作为状态事件，不启动真实付费模型或把构造agent冒充真实AI状态。

只通过既有CLI变更自有fixture；生产transport只能执行读请求/订阅，不能为测试暴露任意RPC写入口。结束finally先停自有server/fixture，核实pid已退与socket清理，最后删临时目录；有错误先保存证据。禁止pkill/killall或按进程名广泛清理。默认每Case有限期限，避免无界等待。

## Acceptance Contract

| ID | Given / When | Expected / Oracle |
|---|---|---|
| POL-HERDR-LIVE-001 | 一个全新隔离server，生产request调用ping、snapshot、plugin.list | 真实版本/响应shape正确；workspace/pane结构来自实际CLI创建结果，未泄漏私人目录或数据；只读白名单没有控制能力 |
| POL-HERDR-LIVE-002 | 两个自建pane，经生产subscribe订阅各自状态及全局拓扑，CLI对fixture上报状态/创建关闭pane | ack先确认为ready；各pane事件保留真实data无自造type，归属/本地序号独立；真实working→blocked→working过程都记录，不只最后快照；拓扑也可收到。保存脱敏原始协议样本 |
| POL-HERDR-LIVE-003 | 关闭第一次生产订阅→新建同pane订阅→产生新变化→server stop | 新订阅组合本地身份不复用，不把既往历史重放当存在；真正收到新事件；EOF仅断连不伪造所有Agent完成。dispose无迟到回调，所有自建资源清理 |

真实events_lost已在前期探针复现，本传输的gap分支已有fixture覆盖；本切片不额外对生产机制造洪峰。真实events_lost与正式adapter的恢复对账仍为下一切片独立验收。生产停止检测、运行身份、持久化插件登记仍需后续实现，不能从EOF推出server stop。

证据放evidence/s05b-live/，至少保存每Case实际执行命令概要、生产模块结果、必要脱敏事件、开始/结束pid与临时目录清理。断言以实际业务字段及观察过程为依据，不只命令exit0。测试约250～400行是信号，不复制已有大型research框架。

## 独立验收结果与边界

Claude46589终态后，Codex先审查隔离启动、显式session/XDG、生产transport调用及finally清理，再独立执行25952：3/3通过，evidence/s05b-live-codex.log。开发者001/002/003原证据先保存developer-final/，当前三份JSON为本轮独立运行。三个server PID21333/21369/21474均正常exit0，无强制kill，socket与临时目录均清理。真实0.9.5/protocol22验证两pane各自working→blocked→working、拓扑、重订阅新身份、停止EOF；状态由构造report-agent触发，不冒称真实模型工作。接受此传输互通切片。

619行超过预估，主要为三套独立生命周期、显式清理与字段断言，未引入框架，允许本切片保存。未证明插件安装/稳定run身份/自动发现/正式恢复对账/通知气泡或真实events_lost。EOF不得推断server stop。启动失败路径清理仅为best-effort，成功场景均核对真实退出；后续扩展不依赖该失败路径证明可靠清理。

开发者自报探查CLI时曾误读默认session status一次，未控制或使用其结果；这超出本次仅隔离环境的派发边界，不据此采纳任何证据。独立Runner所有会话命令均显式自建session，后续禁止默认session的只读探查，CLI语法仅用help/schema确定。
