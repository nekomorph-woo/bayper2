# S03h 独属保留服务审查

2026-10-27，Codex受托接受服务首片。CLI36138（e7c5c0b7-d704-4894-aa7e-4b578aa403e6）在/tmp/bayper-exclusive-em1C2Y隔离快照实现；实际diff仅memory.cjs新增keepExclusive及导出（约66行），memory-store未变；新增536行固定5Case，不搭框架。原报告声称唯一证据批次但没有给出落盘日志，副本也未发现对应文件；不采信为已存证据，以下以Codex独立运行落盘为准。

keepExclusive核对选中ID/版本，保留当前持有内容、清除同factKey其他持有者并写最小source/forget/share控制；同事务更新保留者条目版本与受影响上下文。已只有当前持有者且禁分享时幂等不变。来源使用既有派生表，不以父条目存在作为有效性的唯一条件。代码职责清楚，未改聊天、GUI、内容或全局设置。

独立隔离批次5+8+12=25/25通过，evidence/s03h-codex-domain-r1.log；选择性复制两文件后主项目65/65相关领域、18/18unit通过，evidence/s03h-codex-main-domain.log及s03h-codex-main-unit.log。memory-store内容与主目录完全一致，memory.cjs SHA b5ba9b6361d469be657a056460504d2c86a79af682d8f07e69784d2ef81c17a0；测试SHA effb90bfe69e1f944c3431a75263b619f21a9a4ee81ccc67a93194e93adec193。

| Case | 状态 | 实际独立观察 |
|---|---|---|
| POL-EXCLUSIVE-001 | PASS（服务） | A仍检索到，B正文/FTS清除，C无新增；A/B版本变，关系/名单/数值保持 |
| POL-EXCLUSIVE-002 | PASS（服务） | D→A→B中仅A保留，D/B清除；A仍听D说过，保留直接/原始来源，不能继续share/relay |
| POL-EXCLUSIVE-003 | PASS（服务） | 旧版本/未知条目/非持有者/缺少选中项拒绝，重复新版本调用幂等 |
| POL-EXCLUSIVE-004 | PASS（服务） | 中途删除与最后版本写注入失败均回滚正文/FTS/派生/控制/版本，移除故障后重试成功 |
| POL-EXCLUSIVE-005 | PASS（服务） | 旧来源、新来源历史提炼及转告不能回流，重开库仍受控，无关事实/控制保持 |

本轮只同factKey及既有派生链，未实现不同factKey语义归并；聊天和面板仍NOT_COVERED，在途完整对话失效另需接线测试。没有真实模型、GUI或人工体验，不以服务Case代表完整需求。后续须支持参与聊天外层事务、自然语言候选定位、本地面板与单次确认，再独立验收，不改原Expected。

## 聊天接线首轮审查（尚未接受）

36881 exit0，UUID55e26a03-0e2e-4170-b0f2-54e564fb5a6d，三生产净增52行、6固定test覆盖5Case；实施者自测45/45，已实际落盘evidence/s03h-chat-exclusive/claude-20261027-r1。Codex尚未独立接受：EXCLUSIVE_PATTERNS含“只有你/就你”，isBareCommand对keepExclusive直接true，可能把“只有你记得我的饮品偏好，其他人都忘了”这样的陈述当删除授权。78224已派正式入口修前复现、保持错误模型建议对照，修命令结构而不是堆黑名单；须保留原始失败再独立复验。

## 聊天接线独立接受

78224/r2先真实复现“只有你记得…/我发现就你记得…”在错误模型建议下删除B，再限制明确谓词；Codex独立45/45通过，但继续发现“他认为这件事只让你记得”因主题词旁路仍误删除，“我的饮品偏好只让你记得”反而被拒。59642/r3修前正式入口确认两问题，随后按陈述主语与所有格话题区分，移除主题词直接授权旁路，保留用户命令/真实话题指代。未扩大反例黑名单；原始失败三批保留。最初CLI误将日志放根evidence，Codex已原样迁到本工作evidence/s03h-chat-exclusive，r3开始正确落盘，历史run.json原路径仅作为迁移前记录。

Codex独立84811执行固定四Runner，45/45、0跳过、exit0；evidence/s03h-codex-chat-r3.log。四项源码SHA与r3 source.sha256逐项一致。生产净增57行，职责沿用既有命令/候选/事务，无新框架；较长Runner按5业务Case及明确分支展开，不把测试行数当通过依据。

| Case | 状态 | 独立实际观察 |
|---|---|---|
| POL-EXCLUSIVECHAT-001 | PASS（服务） | 明确饮品仅A保留、B正文/FTS清除，C未知，一HTTP，数值/名单保持 |
| POL-EXCLUSIVECHAT-002 | PASS（服务） | 歧义/无真实话题/引用/假设/否定/问句/伪造M/错目标拒绝；近期唯一话题及所有格命令可用；陈述反例不删 |
| POL-EXCLUSIVECHAT-003 | PASS（服务） | 取消/来源版本变化/迟到失效；最后回复写失败回滚记忆/控制/版本；同请求重放不重复 |
| POL-EXCLUSIVECHAT-004 | PASS（服务） | B旧回复与A旧转告不发布；B新请求上下文无旧事实，不额外唤醒 |
| POL-EXCLUSIVECHAT-005 | PASS（服务） | 独属保留、自忘、禁后续分享三个范围保持；派生A仍保留来源，不冒亲历 |

受托接受聊天服务子片，模型为构造HTTP，实际GUI和真实DeepSeek仍未验；不以45条绿灯宣称自然语言普遍可靠。面板由33826另行实施，须冻结后独立GUI再接受。

## 独属记忆面板独立接受

2026-10-27，Codex受托审查。33826完成main/preload/memory-panel共83行接线及803行固定GUI流程；55728仅补旧memory-ui接口精确白名单中的keepExclusive，未删业务断言。首次相邻回归因遗漏新增接口而FAIL，原始s03h-panel-neighbor-ui.log保留；该失败不是产品独属行为失败，也不抹去。

Codex独立13067真实Electron GUI通过，证据evidence/s03h-memory-exclusive-ui/codex-20261027-r1/run.json与8张截图。九份源SHA与验收后文件逐项一致。查看琥珀选中、凛仍同屏的实际截图，按钮与范围说明明确指向琥珀，转述来源保留，面板完整显示。相邻回归7653执行memory-ui与chat-memory-operations-ui，全部通过；18单元通过，diff --check通过。详s03h-panel-neighbor-ui-r2.log、s03h-panel-unit.log。

| Case | 状态 | 实际观察 |
|---|---|---|
| POL-EXCLUSIVEUI-001 | PASS | 本地HTTP停服时点击保留凛饮品记忆，琥珀对应内容清除、澄未知；无聊天调用，版本/防回流控制更新；重复点击幂等 |
| POL-EXCLUSIVEUI-002 | PASS | 未保存编辑不能提交，外部版本更新拒绝旧项；选琥珀时只留琥珀饮食内容，保留“听凛说过”，不误以桌面凛为操作对象；无关事实保留 |
| POL-EXCLUSIVEUI-003 | PASS | 重启后正文、归属与禁分享保持；真实聊天入口一HTTP完成音乐独属命令，旧持有者清除，本地确认如实；关系/名单/数值保持 |

三个父进程正常exit0，各桌面子进程无残留，HTTP已关闭、临时目录已删除，fixtureErrors为空。此批为构造数据与本地HTTP，非真实DeepSeek、非用户人工体验；真实模型独属指令、异factKey语义归并等仍待独立闭环。

## 真实 DeepSeek 独属指令对照

2026-10-27，Claude78262仅新增403行固定三例Runner，14217仅修回复Oracle。Codex20993/r1实际1models+3chat：数据与操作均正确，LIVE003澄清问句“你是想把它只留在我这里吗？”被裸短语判据误判完成声明，机器FAIL，定性为Oracle误报。保留evidence/s03h-live-exclusive/codex-20261027-r1，不改原证据。修正只匹配明确完成语义，数据库/预算/版本断言不变，仍要求Codex逐句语义审查。

Codex27466/r2再次GET /models确认deepseek-flash存在，按相同三句实际1models+3chat，无自动重试，机器三例通过；五份源码SHA与run.json一致。证据evidence/s03h-live-exclusive/codex-20261027-r2及s03h-codex-live-exclusive-r2.log。两批共2次models、6次chat，各三临时库均dispose/close/删除成功。

| Case | 状态 | 独立实际与语义观察 |
|---|---|---|
| POL-EXCLUSIVE-LIVE-001 | PASS | 模型提出有效候选M1，本地事务保留凛饮品、清除琥珀正文/FTS，澄未知、住址保持；阻止后续转告且上下文失效；只一条实际完成确认，未改变数值/关系/名单 |
| POL-EXCLUSIVE-LIVE-002 | PASS | “我发现就你记得…”模型无操作建议，回复仅陈述已有饮品记忆，没有假报删除；持有者/版本/控制保持 |
| POL-EXCLUSIVE-LIVE-003 | PASS | r2模型错误建议keepExclusive且原始回复承诺独属，本地拒绝能力询问授权，最终仅“我这次没有改动任何记忆”；所有持有者/版本/控制保持，无额外调用 |

Codex受托接受这三个真实服务构造场景，不宣称全部自然语言可靠，也不是GUI与真实模型同批；异factKey语义归并、自动主题共享等依旧未闭环。模型原始建议与应用最终回复分开保存，后者才是用户实际看到的确认。
