# 交付验收记录

## S01 首次相遇：受托接受当前切片

2026-10-25，Codex独立执行并审核。授权来源：用户要求Codex安排全部调度、体验和交付决定直至完整Goal完成。此处不是人类用户亲自体验记录，也不是全部Bayper验收通过。

实现：`app/main.cjs`、`preload.cjs`、`model.cjs`、`store.cjs`、`onboarding.cjs`、`renderer/`与开发候选内容。Electron45.0.0 / Node24.22.0 / SQLite3.53.4，实际运行确认内置SQLite及FTS5可用。正式存储由主进程持有，Key使用safeStorage密文，不给renderer返回。

### Coverage Matrix

| Case | Runner/实际入口 | 结果 | 观察与证据 |
| --- | --- | --- | --- |
| POL-ONBOARD-001 | tests/acceptance/onboarding.spec.cjs同名测试；npm run test:acceptance | PASS | 空输入不发请求；有效请求进入许愿；SQLite无明文Key、快照/DOM清理与日志断言通过 |
| POL-ONBOARD-002 | 同上 | PASS | 401/非助手文本/超时均可修正；失败不创建关系，不自动重试 |
| POL-ONBOARD-003 | 同上 | PASS | 真实UI改变愿望/换候选；确认前退出仍零关系；确认及重复提交只保存1关系、初值10/100/0和安排 |
| POL-ONBOARD-004 | 同上 | PASS | 模型服务关闭后真实进程重启仍进入同一角色小窝，身份/时间/数值不重置 |
| POL-ONBOARD-005 | 同上 | PASS | 非安全地址及非法模型拒绝；重定向不跟随、下游0请求；窄IPC、CSP、导航与新窗口限制通过 |
| POL-ONBOARD-006 | tests/acceptance/live-onboarding.spec.cjs同名测试；npm run test:live | PASS | 用用户授权.env真实GET models并选deepseek-flash；真实UI配置/接纳/退出重启/安全解密再连通，2次构造短请求，无重试 |

Codex独立执行日志：本目录`evidence/s01-codex-unit.log`（6/6）、`s01-codex-acceptance.log`（6/6，含视觉采集）、`s01-codex-live.log`（1/1）。自动化通过不是只看退出码，已审阅请求计数、关系/数值/安排数据库断言、Key不泄漏与真实重启入口。原始证据本地保留且Git忽略，可用相同命令重跑；真实测试仅显式入口调用服务。

### 受托体验与反馈

- Codex查看实际Electron在1200×800与960×680的错误配置、许愿和接纳后页面，以及真实deepseek-flash重启复验页面。层级/按钮/错误恢复清楚，关键内容未被裁切。
- 真实调用最初INVALID_RESPONSE：官方服务默认thinking与32token短检查不匹配；已改为官方host限定关闭thinking、64token与30秒超时，其他兼容服务不发送私有字段。返修后真实窗口通过。
- 独立发现live测试复制空日志数组导致重启日志未覆盖；Claude已改为保留两轮实时数组并在关闭后检查，Codex重跑通过。
- 实现者曾遇一次输入干扰（字段多一个字符/缺少Key断言超时），后续实现者回归及本次Codex独立执行未复现。根因尚未定位，记录为回归稳定性跟进，不能称彻底消除；后续原生GUI验收按时段串行安排。
- 当前角色图片明确为开发候选，主页面也注明聊天/桌面动画待后续接入。本切片接受首次流程，不据此接受角色资源、桌面陪伴或聊天效果。

决定：**Accept（S01当前首次相遇范围）**，进入S02。真实兼容核实仅为DeepSeek官方固定短请求，不宣称所有模型服务/模型语义通过。名单日界刷新、桌面原生窗口、聊天/记忆、连接器、故事与动画均继续后续切片，不计已完成。

## S07 素材试样

POL-ASSET-001实际切帧及静态合成通过；POL-ASSET-002播放验收进行中。范围与证据见asset-pilot.md，不把静态通过当完整动作库通过。

## S02a 陪伴安排与本地数值：受托接受当前切片

2026-10-25，Codex独立审查与执行。实现包含真实SQLite名单/昵称/运行状态迁移、陪伴业务服务及小窝安排操作；真实桌面画布、模型聊天、系统休眠事件与自动活动仍由后续切片完成。

| Case | 实际Runner/结果 | 独立核对 |
| --- | --- | --- |
| POL-COMPANION-001 | companionship.spec.cjs，PASS | 同日5位唯一名单复用、跨日较少参与优先、新接纳不重抽；高精力旧同屏离开新名单后在节点交接 |
| POL-COMPANION-002 | 服务＋companionship-ui.spec.cjs，PASS | 固定替换不重抽其他槽；昵称身份稳定；实际GUI操作并重启；SQLite trigger失败时名单和fixed一起回滚 |
| POL-COMPANION-003 | 服务＋真实UI，PASS | 临时互动不改资格，返回检查精力/冷却；跨日不中断互动；同一在屏角色55精力聊天结束继续陪伴，真正暂离后返回仍需60 |
| POL-COMPANION-004 | 服务，PASS | 手算100→94、40→50/60、离线恢复、回拨/clamp、重开/重复start不重复或丢结算；精力与结算锚点事务失败回滚 |
| POL-COMPANION-005 | 服务，PASS | 节点前/聊天中不交接、候场阈值与冷却、无人休息、完成信号幂等；失败保留原同屏与待办 |
| POL-COMPANION-006 | 服务＋真实旧库GUI启动，PASS | 实际S01 schema迁移不丢密文/关系/accepted_at/数值，随机槽唯一约束可用、重复启动保持 |

Codex独立日志：`evidence/s02-codex-unit.log`6/6；返修r2的`s02-codex-acceptance.log`服务17/17＋GUI9/9；最终r3的`s02-codex-r3-acceptance.log`服务18/18＋GUI9/9。GUI9项包括S02a3项与S01回归6项。相关JS逐文件node --check通过。未重复调用真实模型，本批受控HTTP只作为首次配置依赖。

独立审查退回并修复：跨日高精力旧角色不交接、临时互动返回绕过候场门槛、多表写入半更新、重复start吞结算，以及返修引入的同角色聊天结束误用60阈值。具体依据见s02-review.md。测试使用真实SQLite trigger制造存储失败，不声称做过进程崩溃注入。服务时间使用可控时钟，实际后台时间推进未接入，不冒称长时间真实运行通过。

Codex查看实际窗口截图并核对真实GUI测试操作。当前1200×800及960×680的安排区需要滚动，控件可达、昵称/固定/休息重启保持；这是开发切片小窝，不作为全量原型还原或最终视觉验收。没有人类亲自体验记录。业务/存储约1000行、测试约1500行，高于首估；职责围绕迁移、名单、时间与互动，没有泛用框架，保留可读断言，不为压行删覆盖。

决定：**Accept（S02a本地规则与安排操作范围）**。进入S02b原生画布与生命周期；聊天接口仍只是服务边界，S03b需真实模型和在途行为。S02整体未完成，不能以本批通过结束Goal。
