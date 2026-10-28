# 工作短反应中期审查（未接受）

2026-10-28，以下是Claude99291实施中的初次审查；该轮随后已被退回（见r153），实际复现见r154。静态推断与运行失败分开记录。

- 一次性host send路径不写latestState，主进程基于新回执事务触发，方向符合计划；待实际重建/重启验证。
- 重点复核POL-WORKREACTION-008：syncWorkReactionContext在聊天/隐藏/暂停时调用stopAnimation；applyState同key分支只syncActivity/syncRest后返回。若后续没有新播放入口，可能把画布停在happy帧并在恢复后仍不动。需真实happy中打开/关闭聊天、隐藏/显示和暂停恢复，不接受仅断言playingWorkReaction=false。
- 同一帧恢复使用剩余时间，应由实际帧时间序列验证，而非只读取保存对象；系统暂停/换人后不得恢复失效代次。
- 001～009必须从真实入口形成观察；P0/日常/探索门禁、子进程退出重启、点击和自然节点等待不可以源码字符串检查或假回执替代。
- 当前净改动规模已超过初始180～260行信号，终态审查职责必要性与重复；不靠压行满足，也不因功能可运行自动接受。

## r153 master退回与下一步（2026-10-28）

99291由master主动SIGINT终止，返回exit0但JSON明确is_error/aborted_tools，不是成功交付；此前r11/r12连续ack10超时，原失败保留。终止后ps未见本轮workreaction测试进程。生产及Runner未接受、未提交。

明确问题与受托处理：
1. Runner声称CLI不接受done因此用fixture替代完成事件，遗漏已存预研runtime-research.md：非焦点pane由working上报idle会投影done，event-recovery.md也已有实测。必须先核并恢复001/003真实Herdr转换；不改Expected迁就fixture。若当前版本行为不同，保留真实输出解释，而非凭CLI枚举推断不可测。
2. Runner943行，明显超过250～400信号，前半约500行大量设施；先核既有工具和fixtures复用。不能以分文件藏总量或压行解决，减少重复与多余真实server+同形server双栈。
3. 002只有恢复帧名、前后几何，没有剩余时长/反应中几何/自然节点断言；005/006显式未覆盖多门禁，仍不得整Case PASS。
4. 008 chat取消stopAnimation后同key返回有冻结happy的静态风险；先单独实际复现，随后修复并测聊天退出、隐藏显示、暂停恢复及换人旧代次不回流。
5. 下一批先仅诊断、复用方案与有效复现，最多两次目标执行，失败分流后报告；不继续盲目整组重试。master审核后再实施修复。

这是实现/测试偏离已明确契约，不是skill描述新矛盾；现行Polaris要求已足够，暂不机械归档改skill。

### master追加静态检查

- Runner trigger查询只按instance_id/state取最新，不约束agent_id/sequence或操作前id；新事件尚未入库时可返回旧finished，导致回执和冷却Oracle观察错事件。应按真实身份/新事件界限等待，保留严格业务断言。
- boundaryTimeoutFor只取max(idle总时长, happy总时长)+1200。当前idle1880ms+happy1790ms=3670ms，max+margin=3080ms；若happy刚开始且idle尚余较长时用户请求等待自然节点，存在有效播放尚未完成就超时的风险。需实际边界测试，不把happy末冒充idle-loop。
- 新回执ID来自presentation未ack项，与ledger是否首次presented的语义需复核窗口重建路径；当前重建关闭呈现且pending队列不再选presented，静态未证成重复bug，必须测试而非先增状态表。

## r154 定向复现已取得证据

Claude只读诊断54338执行两次既有渲染Runner，未改代码；master已读取两份原始日志与002记录，实际查看002截图。

- r153-diag-renderer-r1.log：exit1，CDP连接超时，ERROR，不是业务FAIL。
- r153-diag-renderer-r2.log：exit1，line883退出聊天后等待idle超时；008冻结问题实际复现，FAIL。测试finally清理检查没有报错；不等于人工体验。
- run-20261028084542494-f293f8/case-POL-WORKREACTION-002.json确实观察happy00～07后回idle03；前后窗口89×128、图像104.34375×156.53125、pixelated，master已看恢复截图。只接受这段观察，剩余时长/反应期间几何/节点未测，002整体仍NOT_COVERED。

001/003真实链路尚未恢复，005/006/007/009未完整独立验收。此审查文档可以独立保存，但生产和Runner仍不得随之提交。
