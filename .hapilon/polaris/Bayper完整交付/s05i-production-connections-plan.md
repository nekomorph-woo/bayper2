# S05i 正式应用的Herdr连接管理

Codex受托选择下一最小产品切片：把已通过独立验证的ledger/runtime接入正式Electron应用与设置页。Bayper独立启动，Herdr前后启动均可发现；多实例和Agent各自展示，禁用持久，退出清理。不再增加孤立领域模块。通知气泡与插件自动安装为紧随其后的切片，不将本轮状态页当作必需通知已交付。

## 实施边界

Claude修改app/store.cjs、app/main.cjs、app/preload.cjs、app/renderer/index.html，以及单独的简短connector-settings.js与必要styles.css；必要runtime变化先说明。新增tests/acceptance/connector-ui.spec.cjs，沿既有真实Electron模式，不造测试框架。生产净增约300～450行、测试约400～650行作为审查信号。不得修改版本/Git/文档、其他活动与动画、用户Herdr安装与现有会话。沿AGENTS职责，由Claude编码，Codex独立验收。

store在唯一SQLite连接创建connector-ledger，appRunId本次进程稳定随机ID。runtime使用本应用数据目录下明确registry路径，启动一次、退出先dispose再关库；不另建数据库、不暴露db/Key到renderer。登记路径可在设置复制供插件配置；只在用户主动复制时写剪贴板，不泄漏到无关日志。测试隔离data-dir与具名Herdr，不读取用户registry。

设置新增“连接器”页签，沿原生紧凑布局。无实例说明尚未关联；列表显示实例稳定短标识/来源、在线/重连/下线/停用、各Agent具名状态及未知，不能把未知说成任务完成。提供明确停用/恢复操作，不因浏览或重启自动启用。面板用局部列表滚动应对多Agent，管理窗正文不因长列表无限增长。诊断技术细节不堆在主操作文案中；关联Herdr不授予会话分析权限。状态刷新复用应用快照/现有节奏，不建renderer高频扫描。

IPC严格校验sender和输入，只传可展示状态与明确操作，禁止任意路径/命令执行；故障反馈明确可恢复。Herdr未安装或没有registry不妨碍聊天/陪伴；模型API不参与必要连接状态。

## Case与判定

- POL-CONNECTOR-UI-001：无Herdr的真实应用正常启动、陪伴/设置可用，显示未关联；不会读来源正文或调用API。registry位置为隔离data-dir。
- 002：正式登记+隔离真实Herdr，Herdr先启动与Bayper先启动各一次；真实GUI显示在线和逐Agent状态，重复扫描不重复online。沿用正式插件登记入口，禁止在测试中直接伪造online数据库。
- 003：两个正式登记实例同名Agent仍独立；停用一个并重启Bayper仍停用，另一实例持续工作；明确恢复后重连。可用受控真实Unix协议fixture，但标明与002真实Herdr差别。
- 004：真实server stop后GUI下线、Agent unknown；同实例新run自动恢复，不需重启Bayper；下线上线账本次数符合S05h。仅此UI展示不称通知气泡已完成。
- 005：应用退出无残留socket客户端/timer；临时目录、server正常清理；renderer拒绝无效instance输入，读取状态无Key/正文。小窗口与多Agent截图审查可读、无全页滚动。

每批唯一证据目录，保留失败与修复批次；真实退出/清理和截图必须核对。不得将源码存在、CLI总结、返回成功当作产品通过。
