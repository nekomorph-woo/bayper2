# S06g作者内容审查

65507终态，Codex独立执行authored-content.spec.cjs为3/3，无skip/exit0，证据evidence/s06g-codex-first.log。正文逐条对照作者规格，4故事/8节点/主题与归属一致，正式资产门均false。测试使用真实活动服务、同SQLite文件两连接与故事/相遇服务，不是生产main链路。

## 003可达性覆盖缺口

当前targetByFirst只有rin→hu、hu→rin、cheng→rin；另一剩余目标只断言selectNextStories候选存在，没有完成两节点与接纳，因此maid.meet.cheng从未实际推进。计划要求每一剩余角色有真实可达链，不能将候选存在当整条可达通过。

请在003按三首位×两个不同目标的独立harness执行六种路径，至少覆盖每条正式相遇故事的两节点及ack/接纳，维持接纳不改当日名单/当前/固定位的断言。凛服装对不同首位最终结识凛后也推进两节点/解锁，或者清楚独立验证相同服务前提但不可只检查候选。无需生产代码修改，不引入框架，不增加外部资源；保持fixture发布与正式false严格分离。该缺口是NOT_COVERED，不造失败业务结论。

## 最终独立验收与受托决定

48815补覆盖终态，Codex独立执行`node --test tests/acceptance/authored-content.spec.cjs`，evidence/s06g-codex-final.log实际3/3、无skip/exit0。003源码核对为六个独立首位/目标harness，三个衣装解锁路径；每条相遇均由真实活动推进两节点、ack与接纳，数据库断言无名单/当前/固定位变化。衣装三路径保持凛身份、app_state和名单，通知待展示，不自动穿用。

| Case | 结果 | 证据与边界 |
|---|---|---|
| POL-CONTENT-001 | PASS | 4故事/8节点、主题/角色/衣装归属与作者规格一致，正式服务接受目录；正文由Codex逐条核对 |
| POL-CONTENT-002 | PASS | 正式false资产门经真实completed活动仍无进度/邀请/衣装，关系/记忆/名单不变 |
| POL-CONTENT-003 | PASS | 三首位×两剩余角色全部两节点接纳，三个首位的凛衣装可达；只有内存fixture模拟素材发布 |

受托接受作者目录与领域可达性切片。正式JSON四条assetAvailable仍false；没有正式main加载、可见故事/邀请UI或动画发布结论。现有活动领域服务只验证数据流，不能替代S06d真实动画节点验收。测试用同SQLite文件两连接，均关闭并清理临时目录；无GUI/网络/真实模型。

开发本轮重用了case-001/002/003日志名称，原批次总日志01-first-run与02-final-three以及本次05-six-paths仍在；不能把被覆盖的单Case文件称为不可变原始历史。Codex独立日志分别first/final保留。本次未遇业务FAIL，不伪造失败历史。
