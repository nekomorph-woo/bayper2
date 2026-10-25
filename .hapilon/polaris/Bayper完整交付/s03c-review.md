# S03c 记忆管理界面审查

## 开发中静态发现（尚未终态）

2026-10-26，Codex读取当前diff。版本核验在事务内、分页和独立memory-panel方向符合规格。以下待开发终态复核，不冒称已完成缺陷统计。

- `chat-panel.handleMemoryChanged`当前仅清除保存提示，没有清理当前可控旧聊天显示；注释还明确“只清理提示”。这与s03c-memory-ui-plan的已确认约束不符。POL-MEMUI-003构造仅从无助手历史的会话开始，验证迟到新回复不显示，却无法证明已在屏旧理解被移除。应补已有助手陈述/当前历史显示的实际UI场景，纠正与删除后清理受影响角色当前旧显示，并以简短说明区分之后主动打开的历史原文；无关角色不清空，数据库原聊天保留。不能为了通过而将原Expected改成只清保存提示。
- 后续独立验收需覆盖分页超过200、离线修改/删除与共享持有者、失败输入保持、旧版本冲突、两尺寸实际布局，并回归旧聊天流程。若主界面仍旧S01布局，不将局部面板验收记作完整native窗口通过。

另一个待终态核对点：submitCorrect/submitDelete等待结果后只检查state.open，而close会允许立刻再次open。若旧提交回包跨越关闭重开，新面板可能被旧结果刷新/标成功/清除新输入。应以本次打开代次与提交角色快照校验，沿已有loadSeq/简单epoch处理，不另建通用框架。补真实IPC延迟返回的关闭重开场景；已提交的数据库变更保留，但旧界面回包不能覆写新编辑或归属。

## 首轮终态审查

CLI10967已exit0，JSONcompleted。开发者报告4项GUI、10项聊天UI、17项聊天服务、10项单元通过；Codex另行运行中，日志s03c-codex-first.log，不沿用开发者结果当独立PASS。终态仍保留上述两处遗漏，不能以“历史原文保留”为由豁免当前可控展示清理：数据库原文保留与移除屏上旧回复不矛盾。补测删除与纠正、已显示与迟到历史、无关角色不清空；显式重看历史时显示原文标识。保留用户尚未发送的草稿，不因为清理旧理解而删除用户输入。

返修仅chat-panel、memory-panel和必要相关测试/UI说明，沿现有简单代次门，不改变模型/记忆策略。增加约2个针对性GUI场景，复用fixture，避免重复制套测试设施。首轮组合验证曾反复运行，返修日志需用独立文件名保存失败与重跑，不覆盖失败证据。所有测试仍用真实Electron/SQLite+本机fixture，不使用真实模型或私人数据。

Codex首轮独立GUI回归4/4通过，日志evidence/s03c-codex-first.log。上述两个审查缺口未被首轮Case覆盖，仍要求补测/修复，不因既有Case全绿关闭。

## r2 独立验收与第二个等待边界

CLI55225终态completed。Codex独立执行`node --test tests/acceptance/memory-ui.spec.cjs`，6/6通过，证据evidence/s03c-codex-r2.log；实际查看chat-memory-cleared-1200x800.png，旧内容收起、草稿与说明可见。仍为旧管理页面，不能认作S08 native通过。

发现applyChange只在await request后校验openEpoch/characterId。其后成功及MEMORY_CHANGED分支还会await loadPage；若在这一等待中关闭并重开，loadPage的loadSeq可拦住旧列表，但调用方仍会setNotice(successText)，冲突分支还会state.stale=true/renderEditor/showAlert，污染新面板。要求用同一简洁代次判定在第二处await之后复核，补006中的延迟list回包场景（成功与冲突分支），先失败后修，不再复制整套fixture；原数据库修改仍保留。这是实际控制流遗漏，不是无限追加假设场景。

## r3 独立结果

Claude69948 completed；同一samePanel判据在提交回包与两条loadPage后重核，已读代码及006真实IPC三阶段断言。Codex独立memory-ui6/6（s03c-codex-r3.log），chat+memory服务32/32（s03c-codex-service-final.log）。查看960×680记忆面板与清理旧聊天截图：角色/正文/范围/保存删除可见，列表局部滚动，聊天草稿保留。旧主页面仍有整页滚动，留给S08，不冒充native完整体验。

| Contract | 当前结果与证据 |
| --- | --- |
| POL-MEMUI-001 | PASS：角色隔离、超过200条分页与两尺寸实际UI，s03c-codex-r3.log |
| POL-MEMUI-002 | PASS：真实聊天来源、离线纠正/共享持有者默认删除、重启与原文保留，同日志 |
| POL-MEMUI-003 | PASS：在途context失效与下一轮不恢复旧可控显示，同日志 |
| POL-MEMUI-004 | PASS：版本冲突/SQL故障不假成功、输入可恢复，同日志 |
| POL-MEMUI-005 | PASS：已显示旧理解收起、草稿保留、无关角色不清空、迟到历史隔离，同日志 |
| POL-MEMUI-006 | PASS：提交及二次list成功/冲突三条等待边界隔离，同日志 |

规模审查：memory-panel443行为直接面板/控制/请求生命周期，无通用框架；GUI测试1304行包含六个完整业务场景、真实IPC延迟控制与SQLite/HTTP/应用清理，超初始信号但新增断言对应已复现缺陷，保留可读区段，不压行。暂不因文件行数搬成多个隐式fixture文件。自然语言定位/语义同项/主动共享/完整原生页面仍不在本轮PASS范围。

聊天UI受影响回归另由Codex执行10/10通过（evidence/s03c-codex-chat-ui-final.log），未沿用开发者自述。Codex据本轮范围受托接受S03c条目式管理，原始失败日志保留；尚不代表整个S03完成。
