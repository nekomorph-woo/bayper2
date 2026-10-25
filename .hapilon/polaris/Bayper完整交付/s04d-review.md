# S04d 来源设置在途审查

41190尚未终态，下列为代码审查与待验点，不记最终缺陷或PASS，不干扰开发写入。

## 已核对的实现方向

- provider使用claude-code/codex，与session-source-adapters相符；store通过同一SQLite构造externalSources，没有把db/Key/permit送入renderer。
- listGrantsWithValidity复用verifyGrantRoot，读取有效性不切换分析开关或签发读取许可。
- 主进程以已配置候选或原生选择结果确定路径，确认前后对照realpath与dev/ino，renderer没有自由传路径的授权API。
- renderer接收结果使用epoch/active，切出settings使旧回包不能直接覆盖新页面；renderAll并不每次触发sourcePanel.activate，避免心跳不断重置面板请求。

## 待终态场景核实

1. source-settings.confirmAndGrant当前等待showMessageBox后直接grant，只有目录身份校验，没有发起窗口/请求存活校验；chooseDirectory也可能在选择返回后才另开确认。需要真实或明确标注fixture覆盖关闭/隐藏窗口、退出时的迟到确认，确认不会新开无父对话框或落库失去有效用户意图的授权。原生sheet自身取消是否足够应由实际证据判断，不能仅从缺guard推断必然发生。
2. cleanup仅sourceSettings=null并不会取消已经持有该对象的异步调用；核对退出时旧回调处理和实际资源清理，不把置null描述为主动取消。
3. 同一个settings导航再次activate会load并清busy/增epoch；待验证原生modal是否完全挡住重复动作，以及失败/迟到响应后控件和真实授权状态是否一致。不要为了测试构造用户实际无法触发的路径而扩大修改。

下一步以开发最终diff与3Case终态重新核对，再独立运行。当前只读观察，不接受，不提交仍写入的代码。

## 已有实际截图确认的布局问题

Codex查看evidence/s04d-source-settings/source-default-960x680.png：模型、来源、桌面状态纵向堆叠，右侧settings-page滚动条，桌面角色区仅露标题。styles.css .settings-page overflow-y:auto；Runner assertNoDocumentScroll只检查document/body且assertVisible先scrollIntoViewIfNeeded。这可证明控件滚动后能访问，不能证明主要设置单屏。

此项为实际视觉FAIL，待41190终态交回修复：设置用模型/会话来源/桌面等紧凑分段，导航及当前页主要开关/反馈持续可见，来源目录列表才局部滚动。960×680与1200×800检验settings-page自身无整体滚动；测首屏关键控件时不得预先scrollIntoView掩盖。不缩字号或裁切解决，不增加假功能。保留真实截图失败依据，原授权业务断言不弱化。

## 实际测试卡住与调度介入

Codex从Claude会话记录与ps确认：命令为三次POL-SOURCE-UI-003的循环，第一轮node PID32294及worker32296/Electron32297持续8分49秒，超过Case自身90000ms。最后已有failure:none日志不能证明进程正常退出；closeApp直接await app.close且无有界清理，具体根因待开发者确认。

Codex保留evidence/s04d-hung-test-stop.json，核对父shell32293命令确为本轮测试，向此shell及其确切子树发送SIGTERM；未停止Claude主任务41190，也未碰其他Electron/用户工作会话。测试Electron明确data-dir bayper-source-data-Se5ho3。此批标为退出未完成，不作PASS。返修必须修测试与实际应用退出路径并保留原日志；禁止过滤掉超时/清理错误后只看绿色Case计数，也不重复无界测试循环。

## 返修在途视觉与证据审查

Codex实际查看新版source-default-960x680.png：模型/会话来源/桌面分段，当前来源开关与两目录操作在首屏，无settings整页滚动；这是新版布局方向的静态初审，不替代终态独立GUI验证。

test-hang-investigation.log明确承认一次openHome click超时的原始失败日志被后来成功运行覆盖。保留这一事实，不能把文字追述当原始证据；原Codex hung-stop证据仍在。终态后必须让本轮Runner证据写入唯一批次目录（重用既有简单时间/随机批次约定即可，不做通用框架），并在失败/成功/cleanup记录中写真实批次与退出。可从本次Claude任务日志找回已有失败输出原文时保存并标明来源，找不到就明确缺失，不能补造。禁止再用同名Case日志覆盖历史失败。新增有界退出方向正确，独立验收仍需观察实际正常退出和失败路径清理。

## Codex 独立验收与受托接受

独立命令：`node --test --test-concurrency=1 tests/acceptance/source-settings.spec.cjs tests/acceptance/native-shell.spec.cjs tests/acceptance/companionship-ui.spec.cjs tests/acceptance/external-sources.spec.cjs`。日志 `evidence/s04d-codex-final.log`：16/16、无跳过，退出0。

| 范围 | 结果 | 证据与边界 |
| --- | --- | --- |
| POL-SOURCE-UI-001 | PASS | 默认关闭、发现候选与授权/开关分离；真实Electron/SQLite，构造目录 |
| POL-SOURCE-UI-002 | PASS | 取消、确认、持久化与撤销隔离；系统dialog为明确fixture，非真实人工点击 |
| POL-SOURCE-UI-003 | PASS | 失效目录、存储故障、窗口关闭/退出后迟到确认、非可信IPC |
| Native与companionship UI回归 | PASS | 六项实际窗口/数据库Case，含S06c此前待验schema迁移 |
| External sources回归 | PASS | 七项权限领域Case |

独立批次 `evidence/s04d-source-settings/run-20261025203252667-0267a1` 三项cleanup均appExit code0、signal null、errors0。Codex已查看该批次960×680模型/会话来源/桌面三张截图：主要操作单屏可达，仅目录列表局部滚动；两尺寸布局断言通过。不将自动化视为用户亲自体验。历史失败/缺失原图保持如实记录，不覆盖。

受托接受本轮来源设置切片；尚未接生产分析、尚未直接体验macOS原生目录对话框，完整Goal不通过。确认提示目前“允许Claude Code分析”容易误解执行主体，下一轮窄改为“允许Bayper分析Claude Code会话目录”，不改变权限语义。
