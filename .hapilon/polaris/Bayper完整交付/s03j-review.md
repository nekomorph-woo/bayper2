# S03j 独立审查

2026-10-27，未完成、未接受。

## 接线前发现的归因缺口（必须纳入当前实现）

Codex读取app/chat.cjs memoryEntryLine和renderer/memory-panel.js sourceLabel：当前非derived/stated一律标“用户明确告知”/“本人直接告知”。若仅在body加“主题故事见闻”，会仍错误标注为用户事实。不能为了不改scope保留这种错误。

允许本轮额外最小修改chat.cjs、renderer/memory-panel.js和main记忆公开DTO，必要memory-store字段/迁移：可信主题来源需要明确持久标识，并在share、relay、correct保留或正确更新，删除防回流仍沿用原控制。选一个最小可维护方案（例如来源种类字段，现有记录保守默认；模型候选不能自行声明为主题）。不能仅凭body含“主题”判断，也不能把所有stated改成不确定来源。A标主题故事见闻、并非用户亲历；B仍保留听A说的主题性质，转告C也保留原性质；正常用户私聊和来源分析归因保持原规则。正文中的伪主题指令不取得可信属性。

请补Node场景检查模型实际发送上下文中不会把作者主题称为用户明确告知；复用本地HTTP fixture，不真实网络。UI来源DTO与标签需独立真实GUI验收（后续Codex安排），先留一个小固定GUI Case或在现有本能力Runner补片段，勿为一个标签复制巨型Runner。正式主题发布状态仍false。

## 实现中静态反馈

- theme-memory-sharing.identityKey用`${themeId}/${storyId}/${factId}`拼接会碰撞：合法ID含斜杠时，例如theme=a/b,story=c与theme=a,story=b/c产生同一raw。应使用明确无歧义元组编码（如JSON.stringify数组）后稳定hash或安全编码，不只处理超200长度；加入不同合法元组不混淆的固定断言。
- memory.share当前仅检查接收者forgetControl，没有检查显式sourceId对应的sourceControl。S03j已要求来源删除防回流：添加必要守卫/测试，不让相同旧源改factId恢复。保留其他调用方兼容，正常relay仍按独立授权规则。
- shareActivityResult目前memory.remember默认stated，归因缺口仍需按上一节解决；请勿只加正文前缀后结束。

Codex首轮独立领域执行：`node --test tests/acceptance/theme-memory-sharing.spec.cjs`，6/6通过，日志evidence/s03j-domain-codex-r1.log。仅为当前链路基础证据，不能覆盖上述归因/碰撞新增反例，尚不接受。002为隔离分享窗口将构造story_facts.learned_at后移前的旧值调整到25h前，强制另一合法故事节点可达；不声称生产允许突破原线索24h上限。004部分manualRepeat直接调用主题服务并构造result，验证低层防回流，不能替代正式runtime的真实新节点路径。

进一步核对：story-runtime.readShareContext注释说读取失败上抛供下次心跳重评，但调用仍位于evaluateActivity的catch(AppError)范围，会把快照读取抛出的AppError记成永久skipped。请把基础设施快照读取错误与recordNode业务拒绝区分，确保暂时读取失败不消费活动（不修改既有有效业务拒绝规则），补一个正式runtime场景：getShareContext一次抛AppError→无评估/分享/故事写入→恢复后成功且仅一次。不要宽泛吞错或无限内部重试。

## 独立复验（待最终图像检查）

r2 CLI55720终态，正式领域20/20、记忆/聊天/来源独立103/103、unit19/19、memory-ui6+story-runtime-ui1共7GUI全部通过。12份冻结源码摘要一致。原s03c-memory-ui目录已预先保存并恢复，本轮图在evidence/s03j-memory-ui-codex-20261027；正式story目录四项assetAvailable仍false。当前截图选中的是白茶，主题标签虽真实DOM断言通过，但尚无Codex可查看的主题选中截图，需要最小补拍，不夸称已看主题标签。

## 最终受托接受范围

Codex独立接受S03j代码链路，不代表正式内容发布或完整记忆交付。生产约488行增量含317行单职责主题模块，固定领域Runner约900行，超原估算主要来自归因、迁移、事务故障与不同拒绝场景；可顺序追踪，无通用编排框架，保留可读性不压行。

| Case | Result | 依据 |
|---|---|---|
| 001 | PASS | 真实store/companionship完成活动，story-runtime→recordNode事务→双方记忆/FTS/来源，第三方未知，名单/数值无额外变化 |
| 002 | PASS | 真实持久时钟、重启、回拨、边界及重复活动；为隔离分享额度在fixture调整故事额度，不改变生产规则 |
| 003 | PASS | 未发布、无对象/名单外、低精力、探索/忙碌、互动、暂停、全局关闭等各自跳过，无补发 |
| 004/004B | PASS | 私人/外部事实不随作者正文投递；禁分享、发送者/接收者遗忘、source控制与用户纠正不回流。部分重放为服务层构造，边界见前文 |
| 004C/004D | PASS | 合法元组分隔符不碰撞；明确转告给C保留主题种类、最初A与直接B |
| 004E（聊天Runner） | PASS | 本地受控HTTP实际请求上下文保留主题非亲历/转述；候选自带theme字段不获主题身份。非真实模型语义保证 |
| 005 | PASS | 接收者写入与共享额度记录SQLite故障都整笔回滚，修复后只成功一次 |
| 006 | PASS | 临时快照AppError不消费活动，无故事/记忆/FTS/共享写入，恢复后恰好一次 |
| 正式UI来源 | PASS | memory-ui真实DTO与DOM区分主题和用户告知；Codex补拍后查看theme选中截图，编辑区来源清楚、原操作可见 |

独立命令日志：s03j-memory-codex-r2.log 103/103；s03j-story-domain-codex-r2.log 20/20；s03j-unit-codex-r2.log 19/19；s03j-ui-codex-r1.log 7/7；仅补截图的POL-MEMUI-001重跑1/1，s03j-theme-ui-codex-r2.log。不把重复1例再算新覆盖。Claude45346/55720/45687全终态，独立52263/91609/62376/22512全终态。

冻结12文件核对一致；最后仅memory-ui Runner增加截图，另存runner.sha256，生产源码保持一致。新图evidence/s03j-theme-ui-codex-20261027-r2/memory-theme-source-1200x800.png；先前整批图s03j-memory-ui-codex-20261027；旧s03c目录两次均已恢复。正式story GUI批次s06i-story-runtime/run-20261027002018485验证真实daily→main消费、未发布门与重启不重放（因此该批不会真正分享主题）；exitConfirmed true、两次父exit0、HTTP closed、directory removed、cleanup ok。主题实际投递在领域真实业务链用构造已发布目录验证，不能称为正式发布后的GUI投递验收。相关临时目录独立核对无残留。

持续边界：自动分享来源限定已发布作者内容与现有活动结果；正式四故事仍assetAvailable=false。共享接收不新增API或气泡。自然语言全局关闭指令、异factKey语义关联纠正、正式内容发布后GUI全链仍待后续；当前不宣称全PRD完成。Polaris无新增实际缺陷，不做无依据修订。
