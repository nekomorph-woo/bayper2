# S03e 正式转告窗口审查

92090仍在实施，以下为当前实际diff/截图检查，不冒称独立FAIL或全部通过。生产当前约330净增，集中在已有memory-panel及主进程窄IPC，未引入通用表单或权限框架；独立UI套件约1200行，后续检查这些场景/fixture是否确有必要，不以行数单独判定。

## 已查看的实际画面

Codex查看开发阶段s03e-sharing-ui/sharing-layout-960x680.png：对话框位于屏内，角色选择、转告、禁止分享、保存/删除可见，长正文只在列表与textarea滚动。截图含只有一位角色的禁用转告和原因说明。该图不能代替全部互动/草稿错误态/延迟回包独立验收。

## 终态后须明确反馈的验收缺口

1. sharing-ui.spec.cjs当前EVIDENCE_DIR固定为s03e-sharing-ui，capture覆写相同文件名。正式新suite须按唯一批次子目录保存，并记录对应Case实际结果/必要事实、截图、执行边界；既有固定目录产物保留为历史，不覆盖搬丢。保持小型直接日志，不造通用证据框架，不复制旧suite的弱点。
2. closeApp当前捕获app.close异常后静默继续，finally直接rmSync用户目录，不能证明进程已退出后清理。请沿已有可靠验收做法：检查本次启动进程退出、必要时只清理本次拥有的进程，真实失败记入清理结果并影响测试结论；原始业务失败优先保留，同时记录清理失败。不能让清理代码假通过，也不大包一套资源管理框架。核对测试HTTP server关闭和独立临时目录移除。

UI/业务本轮尚未独立验收，不因上述截图可见就接受S03e。源码差异和终态结果核实后再进行Codex独立Case与回归。

3. **共享来源给模型的身份应可解释。** 当前chat.memoryText仅写“听hu说，最初来自rin”，而systemPrompt只含当前角色设定，没有把其他角色ID映射到人类可理解名称；GUI展示琥珀/凛，但测试通过fixture预设“我听琥珀说”不能证明模型知道hu对应谁。请在来源上下文保留稳定ID的同时提供已知角色名称（有已持久昵称时沿既有角色资料解析，不新建第二份昵称来源），未知直接讲述者仍不猜。补真实构造请求断言：B改昵称后A→B→C的来源含正确B名称及原始A身份；不得依赖fixture回复替模型解释裸ID。只改现有来源投影与必要窄取名接口，不扩大到新聊天人格系统。

## 2026-10-27 第一轮终态与独立审查

92090退出0，报告claude-s03e-sharing-window.json；开发者最终批次batch-20261027-040503-s03e-final的23项GUI、41项领域全绿是开发自测。实际diff已补按批次证据、持久昵称读取与真实请求断言，未知来源保持未知。生产新增集中于既有面板、窄IPC和chat-store取名，约359净增略超规模信号，未建通用框架；测试约1476行含完整七项独立场景和真实Electron/SQLite fixture，按职责审核，不以行数直接接受或拒绝。

Codex独立领域回归41/41，工具33024退出0，evidence/s03e-codex-domain.log；相关生产文件SHA记录于s03e-codex-source.sha。实际查看1200×800的C来源截图，显示听琥珀说过、最初来自凛，主要控件在屏内；GUI独立回归尚待清理证据修订。

二次反馈已通过CLI62671明确派发：七项Case在finally清理前就写PASS，失败清理可能让cases.jsonl仍显示PASS；要求最终结果同时包含业务和真实清理结果，记录持有PID/退出、HTTP关闭和目录删除。关闭异常时只处理本次拥有进程，确认退出再移除临时目录，不能确认则保留并报告失败。仅修改测试，不改生产；不因审查增加资源框架。开发原始删除后错误码及数据库读锁失败日志继续保留，未放宽业务Expected。

分享限制的界面一致性：当前只有一个记忆面板，每次换持有者/重开都重新从服务取事实级限制，领域每次投递再校验；不为只影响分享权限的修改广播旧聊天失效。相关Case必须证明跨持有者和重启后限制一致。

## 最终独立验收与受托接受

62671退出0，仅修测试约95行净增；最终Case在清理后记录业务与清理状态，保留每次本进程退出事实，无法确认退出时保留目录。Codex核对实际实现后运行：

- `node --test tests/acceptance/memory.spec.cjs tests/acceptance/memory-sharing.spec.cjs tests/acceptance/chat.spec.cjs`：41/41，33024退出0，s03e-codex-domain.log；生产SHA在最终验收前核对一致，未因测试修订失效。
- `S03E_EVIDENCE_BATCH=codex-20261027-s03e-r1 node --test --test-concurrency=1 tests/acceptance/memory-ui.spec.cjs tests/acceptance/sharing-ui.spec.cjs tests/acceptance/chat-ui.spec.cjs`：23/23，2313退出0，s03e-codex-gui-r1.log。
- 独立共享批次`evidence/s03e-sharing-ui/codex-20261027-s03e-r1/`包含run.json、cases.jsonl与12张截图。七项最终business/cleanup均PASS，HTTP closed、tempDir deleted；每次Electron退出码0。Codex另按批次PID核对进程确实不存在。

| Case | 独立观察与结论 |
|---|---|
| POL-SHAREUI-001 | 名单外B只收到指定条目、C未知，重复无副本，无额外HTTP/名单/数值变化；PASS |
| POL-SHAREUI-002 | B自忘记后C保留B直接讲述+A来源；昵称小琥实际进入请求且保留hu稳定ID，旧B聊天保持；PASS |
| REVIEW-S03E-1 | 旧记录未知讲述者没有猜为A，展示及请求准确；PASS |
| POL-SHAREUI-003 | 禁止跨持有者/重启保持，既有副本保留，独立解除才可继续转告；PASS |
| POL-SHAREUI-004 | 脏稿阻止转告、过时/已删条目/真实SQLite故障不假成功，可信sender校验；PASS |
| POL-SHAREUI-005 | 旧提交回包不污染重开后的角色/草稿，接收者在途旧回复失效，无关聊天保持；PASS |
| POL-SHAREUI-006 | 960×680、1200×800主要操作在屏内，局部列表滚动，无对象提示和键盘操作可用；PASS |

Codex实际查看本独立批次的960×680长内容、1200×800多次转告来源与脏草稿截图：按钮可见、来源层级明确，禁用转告有原因、取消修改入口明确。结合真实交互与SQL/请求观察，受托接受此切片；这是Codex审查和自动化操作，不冒称人类亲自体验或真实模型语义全面正确。

最终代码未新增泛用框架或并行记忆存储。自然语言定位/操作、独立不同factKey的语义纠正、自动定向共享与全局开关仍NOT_COVERED，完整Goal继续；本轮没有发现需要修订polaris的实际流程缺陷。
