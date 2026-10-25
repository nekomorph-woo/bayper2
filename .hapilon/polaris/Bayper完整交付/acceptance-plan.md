# S01 技术与自动验收计划

Codex 受托批准 v1，2026-10-25，依赖 s01-design.md 与 cases.md。

## Part A：实现

- 根 package.json 为正式应用入口，Electron 固定45.0.0（官方发布核实：https://www.electronjs.org/blog/electron-45-0），原生 CommonJS/浏览器模块，暂不引入前端框架、router、ORM或IPC框架。Playwright作为独立业务验收驱动，Node test用于必要局部逻辑。
- `app/main.cjs` 管理普通设置窗口、单实例及退出；`app/preload.cjs` 仅列出窄接口，sandbox/contextIsolation开启，Node关闭，阻止外部导航/新窗口，验证IPC来源。桌面panel在S02接入，不以本轮窗口证明不抢焦点。
- `app/onboarding.cjs` 负责配置验证、愿望推荐、接纳事务业务入口；`app/store.cjs` 使用node:sqlite实际文件，配置密文、关系、名单等必要表，不先建全部未来模型；`app/model.cjs` 最小OpenAI兼容chat/completions请求，timeout和错误分类。safeStorage由主进程注入，生产不以identity加解密代替。
- `app/content/characters.json` 明确开发候选身份、特征、配方引用，无模型临时造角色；`app/renderer/` 三步配置/许愿/小窝。视觉参考现有原型，不整包复制其模拟逻辑。资源暂用原型参考并明确待S07替换。
- 固定API：获取无密钥snapshot、验证并保存模型、按愿望获取候选、接纳候选；renderer无数据库/文件/任意网络权力。接纳校验角色存在且配置完成，并在事务内处理幂等。
- 数据默认用户应用目录，测试用命令行`--data-dir`显式隔离；生产禁止读工作会话。初始化运行中核实Electron node:sqlite/FTS5，若不支持向Codex报告而非静默换栈。

## Part B：验收

`tests/acceptance/onboarding.spec.cjs`通过Playwright Electron启动真实app、操作UI，独立临时数据目录与本机兼容模型Fixture；测试之后关闭app、server并移除临时数据。生产SQLite/safeStorage/业务入口均真实运行。受控模型只验证兼容协议与确定性失败流程，不冒称真实语义效果。

POL-ONBOARD-001～005按Case名实现，观察真实UI、服务请求计数、重开数据库、进程重启。每Case记录必要断言、独立Expected；不得用内部被测函数生成Oracle。专项入口`npm run test:acceptance`，默认`npm test`只跑tests/unit，不混合。截图和运行日志放本工作目录evidence（不含凭据），总结结果入库。

POL-ONBOARD-006由Codex安排真实服务的一次最小调用，配置可用前记录未覆盖，继续其他工作。UI截图独立审查1200×800和960×680，检查可读性、错误恢复、步骤清晰、不伪称已具备其他功能。实际受托体验记录操作者和限制。

## Claude Code 派发边界

仅S01。允许新增package.json/package-lock.json、app/、tests/；根VERSION及研究元数据由Codex管理。约8～12个生产小文件、生产逻辑预期700～1100行，测试约300～500行；超过预期解释原因，不压行。允许安装Electron45和Playwright，启动本切片隔离应用和本地测试server；不得修改全局配置、读取凭据、调用真实模型、改现有研究/原型/PRD、Git操作、再委派Agent。文档或工具扩张先报告。结果必须包括实际命令/事实/未覆盖，而非自称验收完成。
