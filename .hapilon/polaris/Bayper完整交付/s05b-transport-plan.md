# S05b-1 Herdr只读Socket传输

Codex受托确认。承接s05b-protocol-review.md；此切片建立正式只读传输，不连接用户现有会话、不实现插件安装/发现或把测试socket当真实Herdr。代码不能依赖research探针。生产能力后续由正式adapter调用。

## 范围

只新增app/herdr-transport.cjs与tests/acceptance/herdr-transport.spec.cjs。Node内置net，无外部依赖，无通用RPC框架，无GUI。默认macOS Unix socket路径由上层显式传入，不猜测默认用户socket、不扫描HOME、不执行Herdr命令；tests只建立自有临时Unix socket fixture。

提供小型工厂或独立request/subscribe接口，方法名可由开发者明确；只允许ping/session.snapshot/plugin.list三个读请求，加events.subscribe固定订阅入口。不可暴露任意方法发送、命令执行、pane内容或private会话全文读取。请求和事件通道分离，实例级dispose关闭自有连接、取消定时器并阻止迟到回调。

## 行为契约

- 请求格式以本机0.9.5 schema为准：一行JSON包含id/method/params。解析匹配id的result/error，chunk可跨UTF8字符/JSON边界，可一次多行。返回明确业务错误/EOF/timeout/invalid protocol，不能把无响应当server stopped。响应上限建议4MiB/行，超过即关连接且报错，不无限积累Buffer。
- 每次只读请求独立短连接，完成/失败/取消后关闭。显式request timeout默认3秒，可注入测试较短超时；AbortSignal能取消等待与连接，重复清理幂等。
- subscribe接收明确subscriptions数组。pane.agent_status_changed必须有pane_id，拓扑事件可无pane_id；至少支持pane.created/closed/moved/exited/agent_detected与状态订阅。不要使用不存在的“所有Agent状态”通配符；上层需先拓扑发现并维护订阅。
- 必须收到相同请求id的result.type=subscription_started才resolve ready。此前不能声称在线；解析正常事件并按到达顺序投递原始事实及本地subscriptionId/localIndex，后者仅本地观测身份，不能叫Herdr sequence。
- error.code=events_lost立即将订阅终止为明确gap错误，即使后续EOF再来只终止一次；普通EOF为连接丢失，不冒充server.stop。恢复策略由上层重新订阅+快照，此模块不隐藏丢失、不自动重放或悄悄重连。
- 外部close/dispose/Abort结束只调用一次onClose，无僵尸socket、句柄/未处理Promise拒绝。主动取消不再接收数据；失败返回稳定code并保留必要诊断，不打印完整消息/路径/数据。
- 未知事件可以原样作为unknown交上层，不直接映射为成功；非法JSON/异常协议形状终止通道。响应匹配与事件分类清楚，不能把不匹配ID的响应当事件或完成自己的请求。

约200～300行生产、250～350行测试，职责直接，不为一条socket协议引入状态机框架/重试库。用JSON.stringify组包，不拼字符串注入。

## Acceptance Contract

| ID | Given / When | Expected / Oracle |
|---|---|---|
| POL-TRANSPORT-001 | 临时真实Unix socket fixture拆分UTF8/JSON并合并多行发送snapshot/result/error | 正确匹配返回/错误、无乱码、不串ID；fixture逐字核对请求白名单与格式 |
| POL-TRANSPORT-002 | 延迟ack→两条状态/拓扑事件→events_lost+EOF | ready只在ack，事件顺序与本地编号稳定、gap一次，不把EOF二次通知/伪造stop |
| POL-TRANSPORT-003 | timeout/主动abort/dispose、迟到响应、server主动EOF、超限或非法JSON | 相应明确结果，回调至多一次，主动结束无迟到事件，全部socket关闭/临时目录清理 |

真实net与计时/本地fixture，外部Herdr server模拟，未覆盖真实安装启动顺序、重连、Agent身份、账本与可见气泡。独立日志evidence/s05b-transport/，先按3Case自验再由Codex复验。真实Herdr隔离实验在下一切片，当前不得擅自连接现有会话。
