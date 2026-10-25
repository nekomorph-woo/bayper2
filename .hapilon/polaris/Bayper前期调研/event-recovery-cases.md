# 事件恢复技术实验合同 v1

本轮由用户明确要求继续在隔离环境实测断连、重连、events_lost、快照对账与重复通知；沿用已授权的外部控制隔离会话方式。只做技术预研，不设计 Bayper 产品。

环境：Herdr 0.9.5、本机 macOS、全新 `/tmp/bayper-herdr-spike-8OhOrR`，独立 XDG_CONFIG_HOME、XDG_STATE_HOME、XDG_DATA_HOME，named session a。不连接原有工作会话，不安装插件或发出系统通知。自定义状态报告以持续前台 sleep 为载体，不冒充真实 AI。

“通知”在本实验中指研究用内存计数：只有 blocked/done 计数。对照组对每次观察都计数；去重组对权威快照中的 `(terminal_id, agent_status, state_change_seq)` 每个相同键只计一次。该键仅用于本批受控实验，不宣称通用 exactly-once。状态变化的独立真值来自控制端的已执行写入与最终权威查询，不由缓存或计数器自己生成。

| ID | Given / When | 预先固定的 Oracle 与证据 |
| --- | --- | --- |
| REC-01 | working 基线；主动断开；期间变 blocked；重订阅 ack 后取 snapshot | 恢复后当前状态为 blocked；重复读取同一快照不应使去重组多计；保留事件和快照 |
| REC-02 | working 基线；断连期间 blocked→working；重订阅与 snapshot | 最终状态恢复为 working；记录断连中间 blocked 是否缺失，不把恢复当前状态等同于恢复历史 |
| REC-03 | 订阅后捕获旧 working 快照；延迟应用，期间状态变 blocked→working→idle | 缓存需以新权威快照收敛到 done；陈旧事件只用于使缓存失效，不能覆盖新快照；保存对照组回滚现象 |
| REC-04 | 同一 blocked episode 被事件与重复快照观察 | 保留原始观察次数与去重计数；区分“客户端重复消费”与“Herdr 重复发事件” |
| REC-05 | 持有状态订阅；控制端停止并重启测试 server | 旧订阅失效；新订阅 ack 后重新读快照；检查 terminal_id 更替，旧状态不应成为新终端通知；不假定 Agent 自动恢复 |
| REC-06 | 慢订阅者不读；受限事件洪峰填满传输并超过历史保留窗口 | 必须实际捕获 error.code=events_lost 与连接关闭才记“已触发”；超时/普通 EOF 不能冒充该错误 |
| REC-07 | events_lost 后重新订阅并读取快照，持续消费事件 | 最终权威状态正确；重复快照不造成计数重复；断档中间状态若无法恢复如实记录 |
| REC-08 | 实验结束 | server、探针、前台载体均退出，保存脱敏证据后删除临时 XDG 环境；无插件、GUI、系统通知或用户配置修改 |

实现分片：先做主动断连和对账；再做有上限的真实 events_lost 触发；最后做 server 重启恢复。各脚本复用现有 socket 客户端，固定流程直写，不新建通用恢复框架。洪峰有时间/次数/载荷上限；不以无限加压掩盖无法复现。错误和失败批次原样保留。
