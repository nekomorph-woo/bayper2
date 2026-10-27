# 交付验收记录

## 当前统一口径（2026-10-27）

本文件是当前唯一逐 Case 结果入口。各 review 保留原始判断、失败过程和长证据说明，本文只登记可定位的结果，不复制全文。状态仅用 execution.md 的五种：PASS、FAIL、ERROR、INCONCLUSIVE、NOT_COVERED；不使用 PARTIAL，也不把多个 Case 压成平均分或“最差状态”。

- 分组：仅当版本、状态、证据和执行边界相同时，一个精确 ID 范围可共用一行；任一 Case 或必需子项有差异即拆行。`001～003` 只表示这些 ID 满足本行，不覆盖范围外或未执行项。
- 版本：历史行以对应 review/evidence 的验收基线与源摘要定位，未记录 commit 的不补猜。已提交快照为 `1783ec8`（VERSION `0.1.184`）；本批准备 VERSION `0.1.185` 待 master snap。工作区未提交 memory 源码/测试的当前 SHA 见各 attempt 的 `code-sha256.txt`；[process-freeze.json](evidence/process-freeze.json) 仅保留流程补齐时点，不再作为当前实现基线。
- master 已受托验收 7 个最终 Contract v1/Part A-B，GAP-14 流程补齐通过；GAP-01～14 流程处置完成（GAP-06 仅流程记录、产品修复未完成；GAP-08 原证据未找回限制保留）。master 另于 2026-10-27 受托接受**来源身份 v2 有限能力**，非 S03/Goal 完成；产品未交付。
- 历史 PASS 只证明该验收基线，不证明当前未提交工作区。2026-10-27 master 最终 17 套件 163/163 已重跑对应领域/服务 Runner；未在该批执行的 UI、真实模型、holdout/source-live/pro 组保持历史状态与各自未覆盖边界，不写成当前通过。没有重跑就不写当前 PASS；当前工作区未验收也不能推断历史产品从未通过。
- Runner 退出码、编译成功、开发报告全绿或 review 中的切片受托接受，均不自动升级为父级或整 Case 通过。体验记录已标明实际操作者、方法与局限；Codex 受托体验不是人类亲自体验，已有授权不要求真人重新批准。

- Runner 入口统一相对仓库根；本表不逐行重复参数。领域默认 `node --test tests/acceptance/<file>.spec.cjs`；GUI/隔离串行默认 `node --test --test-concurrency=1 tests/acceptance/<file>.spec.cjs`；工具 `node <tools能力入口> --out <新文件>` 或 `python3 <工具脚本>`；真实服务/隔离 Herdr/环境变量按 [acceptance-plan.md](acceptance-plan.md) 对应父级行。历史未记录逐字参数的不补造。
- 多 Runner/多文件的组在证据列引用含逐 Case 映射的 review（如 s03e/s03j/s05j/s06j），不复制全文。

## 统一验收矩阵

### S01～S02

| Case（版本） | 结果 | 验收基线 / 当前适用 | Runner 入口 / 命令（模板见上） | 原始证据 | 未覆盖边界 |
| --- | --- | --- | --- | --- | --- |
| POL-ONBOARD-001～005（v1） | PASS | 2026-10-25 s01-review；当前未重跑，不涉本轮 memory 文件 | `tests/acceptance/onboarding.spec.cjs`；`npm run test:acceptance` | [s01-codex-acceptance.log](evidence/s01-codex-acceptance.log) 6/6 | 受控 HTTP/单机 Electron；不证明真实模型语义 |
| POL-ONBOARD-006（v1） | PASS | 同上真实服务单批 | `tests/acceptance/live-onboarding.spec.cjs`；`npm run test:live` | [s01-codex-live.log](evidence/s01-codex-live.log) 1/1 | 仅 DeepSeek 官方固定短请求；其他服务/模型未验 |
| POL-COMPANION-001～006（v1） | PASS | 2026-10-25 s02-review r3；当前未重跑 | `companionship.spec.cjs`、`companionship-ui.spec.cjs`；见 [acceptance-plan.md](acceptance-plan.md) | [s02-codex-r3-acceptance.log](evidence/s02-codex-r3-acceptance.log) 服务18/18＋GUI9/9 | 可控时钟；未做长期真实运行/进程崩溃注入 |
| POL-DESKTOP-001（v1） | PASS | 2026-10-26 s02b-review；当前未重跑 | `tests/acceptance/desktop.spec.cjs`；`node --test` | [s02b-codex-r2-gui.log](evidence/s02b-codex-r2-gui.log) 16/16 | 不证明 OS 屏幕合成与真实焦点 |
| POL-DESKTOP-002（v1） | PASS | S02b 批无 `desktop.spec` Runner；S07c 以 1 test 覆盖 HIT-001/002/003 的真实点击/穿透/焦点 | `tests/acceptance/s07c-transparent-input.spec.cjs`（GUI 串行模板） | [s07c-codex-r1-native.log](evidence/s07c-codex-r1-native.log) tests 1/pass 1，单测试覆盖 HIT-001/002/003；桌面 11/11 见 [s07c-codex-r1-desktop.log](evidence/s07c-codex-r1-desktop.log) | scaleFactor=1；Retina、物理多屏未验；计划入口已统一 |
| POL-DESKTOP-003（v1） | NOT_COVERED | 无自动化 Runner；须真实 Spaces/全屏切换与可见证据 | 无 | 无 | 真实 Spaces/全屏；后续 HIT 通过不能代替此项 |
| POL-DESKTOP-004（关闭/重开/重复启动/崩溃退出） | PASS | 2026-10-26 s02b-review 与 2026-10-27 s08a-review；当前未重跑 | `desktop.spec.cjs` 001/004 相关测试 | [s02b-codex-r2-gui.log](evidence/s02b-codex-r2-gui.log)、[s08a-codex-repair.log](evidence/s08a-codex-repair.log) | 托盘原生点击未单列覆盖；崩溃注入不等于用户真实退出 |
| POL-DESKTOP-004（原生托盘逐项点击） | NOT_COVERED | 测试内注明“托盘点击由 Codex 后验”，未找到独立原生点击结果 | 无（`desktop.spec.cjs` 只验证 `activate` 重显） | 同左 | 须真实托盘菜单点击与逐项行为 |
| POL-DESKTOP-005（v1） | PASS | 2026-10-26 s02b-review r3；当前未重跑 | `desktop.spec.cjs` 005 相关测试 | [s02b-codex-r2-gui.log](evidence/s02b-codex-r2-gui.log)、[s02b-codex-r3-related.log](evidence/s02b-codex-r3-related.log) | 原生连续动画视觉、全部动作与服装未覆盖 |
| POL-DESKTOP-006（受控系统事件路径） | PASS | 2026-10-26 s02b-review；当前未重跑 | 非独立 006 Runner：`desktop.spec.cjs` 测试“POL-DESKTOP-001/004 真实画布、管理窗口输入、关闭隐藏与退出清理”中的 `powerMonitor.emit` 子断言（约第368行） | [s02b-codex-r2-gui.log](evidence/s02b-codex-r2-gui.log) | 仅该子断言与时间结算，不是物理锁屏/睡眠 |
| POL-DESKTOP-006（真实锁屏/休眠/恢复） | NOT_COVERED | 无真实系统事件证据 | 无 | 无 | 用户机器真实锁屏/睡眠；不得用受控事件或截图冒充 |
| POL-DESKTOP-007（v1） | PASS | 2026-10-26 desktop-pixel-review；当前未重跑 | `desktop.spec.cjs`、`desktop-assets.test.cjs` | [codex-pixel-r2.log](evidence/codex-pixel-r2.log) 11/11 | 原生命中、Spaces/全屏、长期自然度、其他角色新版素材 |
| POL-RELATION-001～004（v1） | PASS | 2026-10-26 s02c-review；当前未重跑 | `relationship-effects.spec.cjs`、`companionship.spec.cjs` | [s02c-codex-first.log](evidence/s02c-codex-first.log) 23/23 | 有效互动精力、共同故事、日常/探索成本未接线 |

### S03

| Case（版本） | 结果 | 验收基线 / 当前适用 | Runner 入口 / 命令（模板见上） | 原始证据 | 未覆盖边界 |
| --- | --- | --- | --- | --- | --- |
| POL-MEMORY-001（核心归属） | PASS | 2026-10-26 s03a r4；当前待回归 | `memory.spec.cjs` | [s03a-codex-r4.log](evidence/s03a-codex-r4.log) 15/15 | 角色隔离/重复来源/昵称/重开通过；真实模型不在本 Case |
| POL-MEMORY-001（服装/身份保持） | PASS | 2026-10-26/27 S06g/S06j 衣装路径；非本 Case 记忆 Runner | `authored-content.spec.cjs`、`story-window-ui.spec.cjs` | [s06g-codex-final.log](evidence/s06g-codex-final.log)、[s06j-codex-gui-r2.log](evidence/s06j-codex-gui-r2.log) | 仅证明衣装不改变凛身份/名单/当前位，未直接断言记忆条目归属 |
| POL-MEMORY-001（服装切换后记忆归属） | NOT_COVERED | 现有已查来源无记忆与服装切换联动测试 | 无 | 无 | 不得用身份保持或服装故事替代 memory_entries 归属断言 |
| POL-MEMORY-002（v1） | PASS | s03a r4 构造集；当前未重跑 | `memory.spec.cjs`、`tools/memory-tuning` | [s03a-codex-r4.log](evidence/s03a-codex-r4.log)、[codex-r4.json](tools/memory-tuning/results/codex-r4.json) | 非盲测、有限词表；零字面同义仍可能漏；真实聊天另验 |
| POL-MEMORY-003（v1） | PASS | s03a 模块＋S03b/S03f 自然语言与在途；当前待回归 | `memory.spec.cjs`、`chat-memory-operations.spec.cjs` | [s03a-codex-r4.log](evidence/s03a-codex-r4.log)、[s03f-codex-r4-domain.log](evidence/s03f-codex-r4-domain.log) | 自然语言中文变体有限；真实模型语义不写为通用保证 |
| POL-MEMORY-004（v1） | PASS | s03a 模块＋S03b/S03c/S03f 实际接入；当前待回归 | `memory.spec.cjs`、`chat.spec.cjs`、`memory-ui.spec.cjs` | [s03a-codex-r4.log](evidence/s03a-codex-r4.log)、[s03b-codex-r2.log](evidence/s03b-codex-r2.log)、[s03c-codex-r3.log](evidence/s03c-codex-r3.log) | 原聊天原文保留、索引/展示清除、旧源不回流分层覆盖 |
| POL-MEMORY-005（v1） | PASS | s03a 模块＋S03f/S03h 用户语义入口；当前待回归 | `memory.spec.cjs`、`chat-memory-operations.spec.cjs`、`chat-exclusive.spec.cjs` | [s03a-codex-r4.log](evidence/s03a-codex-r4.log)、[s03f-codex-r4-domain.log](evidence/s03f-codex-r4-domain.log)、[s03h-codex-chat-r3.log](evidence/s03h-codex-chat-r3.log) | 异 factKey 语义归并仍未完成 |
| POL-MEMORY-006（长期/临时/门禁） | PASS | s03a r4＋`memory.spec.cjs` 当前用例；当前待回归 | `memory.spec.cjs` | [s03a-codex-r4.log](evidence/s03a-codex-r4.log) 15/15 | 长期保持、临时到期、时间不放开删除/权限门禁已断言 |
| POL-MEMORY-006（普通细节降权/整理） | NOT_COVERED | 当前 `memory.spec.cjs` 第341行后仅验到期与门禁，无降权/整理断言 | `memory.spec.cjs`（无对应测试） | 无 | 不把“普通细节可降权”写成已实现；真实活动使用亦未验 |
| POL-MEMORY-007（v1） | PASS | s03a 模块＋S03d/S03e/S03g 正式转告；当前待回归 | `memory.spec.cjs`、`memory-sharing.spec.cjs`、`sharing-ui.spec.cjs`、`chat-relay.spec.cjs` | [s03a-codex-r4.log](evidence/s03a-codex-r4.log)、[s03d-codex-domain.log](evidence/s03d-codex-domain.log)、[s03g-codex-main-domain.log](evidence/s03g-codex-main-domain.log) | 指定片段、来源、拒绝二次转发、接收不改名单/单次 HTTP 已断言；自动频率不属本 Case |
| POL-CHAT-001（v1） | PASS | 2026-10-26 s03b 服务/窗口最终批；结束返回资格由 COMPANION-003 覆盖；当前待回归 | `chat.spec.cjs`、`chat-ui.spec.cjs`、`companionship.spec.cjs` | [s03b-codex-r2.log](evidence/s03b-codex-r2.log) 32/32、[s03b-codex-window-r2.log](evidence/s03b-codex-window-r2.log) 18/18 | 构造 HTTP；真实模型上下文另由 CHAT-008 验证；不覆盖所有语言变体 |
| POL-CHAT-002（v1） | PASS | s03b 服务批＋第四轮真实模型语义；当前待回归 | `chat.spec.cjs`、`live-chat.spec.cjs` | [s03b-codex-r2.log](evidence/s03b-codex-r2.log)、[s03b-pol-chat-008-live-fourth.json](evidence/s03b-pol-chat-008-live-fourth.json) | 真实模型只覆盖四轮构造对话，不证明通用语义 |
| POL-CHAT-003（v1） | PASS | s03b 服务与窗口最终批；当前待回归 | `chat.spec.cjs`、`chat-ui.spec.cjs` | [s03b-codex-r2.log](evidence/s03b-codex-r2.log)、[s03b-codex-window-r2.log](evidence/s03b-codex-window-r2.log) | 关闭持久失败、退出取消、迟到隔离已覆盖；真实模型非本 Case |
| POL-CHAT-004（v1） | PASS | s03b 服务＋S03c/S03f 正式 GUI；当前待回归 | `chat.spec.cjs`、`memory-ui.spec.cjs`、`chat-memory-operations-ui.spec.cjs` | [s03b-codex-r2.log](evidence/s03b-codex-r2.log)、[s03c-codex-r3.log](evidence/s03c-codex-r3.log)、[s03f-codex-gui-r1.log](evidence/s03f-codex-gui-r1.log) | C 未获新事实已断言；真实模型语义不在本 Case |
| POL-CHAT-005（v1） | PASS | s03b 服务＋S03c/S03f 正式 GUI；当前待回归 | `chat.spec.cjs`、`memory-ui.spec.cjs`、`chat-memory-operations-ui.spec.cjs` | 同 CHAT-004 | 原聊天原文保留、索引清除、在途丢弃已覆盖；真实模型不在本 Case |
| POL-CHAT-006（v1） | PASS | s03b 单子项＋S03d/S03g/S03h 转告/独属；当前待回归 | `chat.spec.cjs`、`memory-sharing.spec.cjs`、`chat-relay.spec.cjs`、`memory-exclusive.spec.cjs` | [s03b-codex-r2.log](evidence/s03b-codex-r2.log)、[s03d-codex-domain.log](evidence/s03d-codex-domain.log)、[s03g-codex-main-domain.log](evidence/s03g-codex-main-domain.log)、[s03h-codex-chat-r3.log](evidence/s03h-codex-chat-r3.log) | 分散在多个切片 Runner；未以 CHAT-006 单名重跑；真实模型转告另有 S03g 三场对照 |
| POL-CHAT-007（v1） | PASS | S03f 多候选/歧义＋S03h 聊天指代；当前待回归 | `chat-memory-operations.spec.cjs`、`chat-exclusive.spec.cjs`、`chat.spec.cjs` | [s03f-codex-r4-domain.log](evidence/s03f-codex-r4-domain.log)、[s03h-codex-chat-r3.log](evidence/s03h-codex-chat-r3.log) | 多候选不猜、唯一条目不当证据、正文指令不执行已覆盖；有限中文语法 |
| POL-CHAT-008（v1） | PASS | 2026-10-26 s03b 第四轮真实服务；当前待回归 | `tests/acceptance/live-chat.spec.cjs` | [s03b-pol-chat-008-live-fourth.json](evidence/s03b-pol-chat-008-live-fourth.json) | 所有语言变体、自然语言定位/删除、外部源解析、UI 记忆管理 |
| POL-MEMUI-001～006（v1） | PASS | 2026-10-26 s03c r3；当前待回归 | `memory-ui.spec.cjs` | [s03c-codex-r3.log](evidence/s03c-codex-r3.log) 6/6、[s03c-codex-service-final.log](evidence/s03c-codex-service-final.log) 32/32 | 当时仍为旧管理页；不等同 S08 native |
| POL-SHARING-001～006＋REVIEW-S03D-1/2（v1） | PASS | 2026-10-26 s03d；当前待回归 | `memory-sharing.spec.cjs` 及相邻领域 | [s03d-codex-domain.log](evidence/s03d-codex-domain.log) 58/58 | 自然语言定位/转告、主题自动分享、全局禁分享未覆盖 |
| POL-SHAREUI-001～006＋REVIEW-S03E-1（v1） | PASS | 2026-10-27 s03e 最终独立批；当前待回归 | `sharing-ui.spec.cjs`、`memory-ui.spec.cjs`、`chat-ui.spec.cjs` | [s03e-codex-domain.log](evidence/s03e-codex-domain.log) 41/41、[s03e-codex-gui-r1.log](evidence/s03e-codex-gui-r1.log) 23/23 | 真实模型语义、自然语言控制、自动定向分享未覆盖 |
| POL-CHATMEM-001～006（v1） | PASS | 2026-10-27 s03f R4；当前待回归 | `chat-memory-operations.spec.cjs` | [s03f-codex-r4-domain.log](evidence/s03f-codex-r4-domain.log) 63/63、[s03f-codex-r4-unit.log](evidence/s03f-codex-r4-unit.log) 13/13 | R3 真实六场 PASS；R4 未冒称重跑真实模型；自然语言转告/自动共享未覆盖 |
| POL-CHATMEM-UI-001（v1） | PASS | 2026-10-27 s03f GUI 独立批；当前待回归 | `chat-memory-operations-ui.spec.cjs` | [s03f-chat-memory-ui/codex-20261027-r1/run.json](evidence/s03f-chat-memory-ui/codex-20261027-r1/run.json)、[s03f-codex-gui-r1.log](evidence/s03f-codex-gui-r1.log) | 构造 HTTP/Electron；不是真实模型或人工体验 |
| POL-CHATRELAY-001～006（v1） | PASS | 2026-10-27 s03g 主目录服务批；当前待回归 | `chat-relay.spec.cjs` 及相邻领域 | [s03g-codex-main-domain.log](evidence/s03g-codex-main-domain.log) | 真实模型另有三场构造对照；表达鲁棒性有限 |
| POL-CHATRELAY-UI-001（v1） | PASS | 2026-10-27 s03g 主目录 GUI；当前待回归 | `chat-relay-ui.spec.cjs` | [s03g-chat-relay-ui/codex-20261027-r1/run.json](evidence/s03g-chat-relay-ui/codex-20261027-r1/run.json) | 构造 HTTP；非真实模型窗口同批 |
| POL-EXCLUSIVE-001～005（v1） | PASS | 2026-10-27 s03h 服务首片；当前待回归 | `memory-exclusive.spec.cjs`、相邻领域回归 | [s03h-codex-domain-r1.log](evidence/s03h-codex-domain-r1.log) 25/25、[s03h-codex-main-domain.log](evidence/s03h-codex-main-domain.log) 65/65 | 只同 factKey/既有派生；异 factKey 语义归并未实现 |
| POL-EXCLUSIVECHAT-001～005（v1） | PASS | 2026-10-27 s03h 聊天服务 r3；当前待回归 | `chat-exclusive.spec.cjs` 及四 Runner | [s03h-codex-chat-r3.log](evidence/s03h-codex-chat-r3.log) 45/45 | 构造 HTTP；真实模型独属指令另由 LIVE 组验证 |
| POL-EXCLUSIVEUI-001～003（v1） | PASS | 2026-10-27 s03h 正式 GUI 独立批；当前待回归 | `memory-exclusive-ui.spec.cjs`、相邻 GUI | [run.json](evidence/s03h-memory-exclusive-ui/codex-20261027-r1/run.json)、8 张截图；相邻 [s03h-panel-neighbor-ui-r2.log](evidence/s03h-panel-neighbor-ui-r2.log) | 构造数据/本地 HTTP；非真实 DeepSeek、非人工体验 |
| POL-EXCLUSIVE-LIVE-001～003（v1） | PASS | 2026-10-27 s03h 真实服务 r2；当前待回归 | `live-chat-exclusive.spec.cjs` | [s03h-live-exclusive/codex-20261027-r2/run.json](evidence/s03h-live-exclusive/codex-20261027-r2/run.json)、[s03h-codex-live-exclusive-r2.log](evidence/s03h-codex-live-exclusive-r2.log) | 三句构造场景；r1 Oracle 误报原件保留；不称全部自然语言可靠 |
| POL-AUTOSHARE-CONTROL-001～004（v1） | PASS | 2026-10-27 s03i；当前待回归 | `memory-auto-share.spec.cjs`、`memory-auto-share-ui.spec.cjs` | [s03i-domain-codex-r2.log](evidence/s03i-domain-codex-r2.log)、[s03i-unit-codex-r1.log](evidence/s03i-unit-codex-r1.log) | 主题自动分享未接生产；24h 预算/名单选择未覆盖 |
| POL-THEME-SHARE-001～005、004B～004E、006（v1） | PASS | 2026-10-27 s03j；当前待回归 | `theme-memory-sharing.spec.cjs`、`story-runtime-ui.spec.cjs`、`memory-ui.spec.cjs` | [s03j-memory-codex-r2.log](evidence/s03j-memory-codex-r2.log)、[s03j-story-domain-codex-r2.log](evidence/s03j-story-domain-codex-r2.log)、[s03j-ui-codex-r1.log](evidence/s03j-ui-codex-r1.log) | 正式四故事 assetAvailable=false；发布后 GUI 投递 NOT_COVERED |
| POL-SHARESETTING-001～005（v1） | PASS | 2026-10-27 s03k；当前待回归 | `chat-sharing-setting.spec.cjs`、`chat-sharing-setting-ui.spec.cjs` | [s03k-domain-codex-r1.log](evidence/s03k-domain-codex-r1.log)、[s03k-ui-codex-r1.log](evidence/s03k-ui-codex-r1.log) | 有限中文命令集；其他自动设置讨论未扩展 |
| SEM-003、004、008（v1） | PASS | 2026-10-27 s03l identity r4；当前未重跑 | `tools/memory-tuning/semantic-baseline.cjs` | [semantic-baseline-codex-identity-r4.json](tools/memory-tuning/results/semantic-baseline-codex-identity-r4.json) | 构造场景；不等于通用语义理解 |
| SEM-001、002、005、006、007（v1） | FAIL | 同上 r4；当前未重跑 | 同上 | 同上（3 PASS/5 FAIL，50/75 检查） | 五处失败为后续必做缺口，不能以其他切片变绿抵销 |
| POL-FACTID-001、003（v1） | PASS | 2026-10-27 s03l-a r4；当前待回归 | `memory-fact-identity.spec.cjs`、领域回归 | [s03l-domain-codex-r4.log](evidence/s03l-domain-codex-r4.log) 119/119 | 构造 HTTP/fixture；真实模型语义未验 |
| POL-FACTID-002（v2） | PASS（有限能力） | 2026-10-27 master 17 套件最终批 163/163；v2 实现独立验收，真实模型语义未覆盖 | `memory-fact-identity.spec.cjs` 16/16；见上方来源身份矩阵 | [master-source-final-aYYduWmG/run.log](evidence/master-source-final-aYYduWmG/run.log) | 真实模型语义未完成；存量已有误合组未迁移；v1 同文复用机制 PASS 仍失效 |
| POL-FACTID-004～006（v1） | PASS | v1 业务 Expected 在 v2 实现下由 master 17 套件最终批通过；不称为 v2 Case | `memory-fact-identity.spec.cjs` 16/16 | [master-source-final-aYYduWmG/run.log](evidence/master-source-final-aYYduWmG/run.log) | 构造 HTTP/fixture；不改变 v1 业务约束；真实模型语义未验 |
| POL-ASSOC-001、003、004、005（v1） | PASS | 2026-10-27 s03l-b r3；当前待回归 | `memory-association.spec.cjs` 及 12 领域文件 | [s03l-association-codex-r3.log](evidence/s03l-association-codex-r3.log) | 模型语义核验/资格预算接线未完成 |
| POL-ASSOC-002（v1） | PASS | 2026-10-27 master 17 套件最终批；显式 associateFacts fixture 已迁移，v1 业务 Expected 不变 | `memory-association.spec.cjs` 9/9 | [master-source-final-aYYduWmG/run.log](evidence/master-source-final-aYYduWmG/run.log) | 构造等价 Fixture；模型语义核验/资格预算接线未完成 |
| POL-SEM-HOLD-001（01～16） | FAIL | 2026-10-27 holdout 真实模型单批；当前未重跑 | `semantic-probe.cjs --dataset holdout` | [semantic-holdout-codex-live-v2.json](tools/memory-tuning/results/semantic-holdout-codex-live-v2.json) | 14 PASS/2 FAIL（11、12）；falseMerge=2；固定样本不证明泛化 |
| POL-REL-001～003（v1） | PASS | 2026-10-27 grounding；构造输出边界 | `memory-relation-protocol.spec.cjs` | [s03l-grounding-codex-r2.log](evidence/s03l-grounding-codex-r2.log) | 不写库、不调模型；引用存在不等于解释正确 |
| POL-REL-004（baseline 子项） | PASS | 真实模型单批 16/16 | `semantic-probe.cjs` grounded | [grounding-baseline-live-codex-v1.json](tools/memory-tuning/results/grounding-baseline-live-codex-v1.json) | 单次构造真实模型；不证明生产可靠 |
| POL-REL-004（holdout 子项） | FAIL | 真实模型单批 14/16 | 同上 `--dataset holdout` | [grounding-holdout-live-codex-v1.json](tools/memory-tuning/results/grounding-holdout-live-codex-v1.json) | 11 uncertain、12 误 equivalent；不得改 Expected 凑绿 |
| POL-MODEL-COMP-001（v1） | FAIL | 2026-10-27 pro 对照；未采用 pro | `tools/memory-tuning/semantic-probe.cjs --model deepseek-v4-pro`（输出参数按模板） | [grounding-pro-baseline-live-codex.json](tools/memory-tuning/results/grounding-pro-baseline-live-codex.json)、[grounding-pro-holdout-live-codex.json](tools/memory-tuning/results/grounding-pro-holdout-live-codex.json) | baseline 13/16、holdout 13/16；延迟更高且无可靠性收益 |
| POL-SOURCECTX-001～006（v1） | PASS | 2026-10-27 source-context r2；当前待回归 | `memory-source-context.spec.cjs` 及 6 领域文件 | [s03l-source-context-codex-r2.log](evidence/s03l-source-context-codex-r2.log) 74/74 | 只读模块；未接角色回复上下文 |
| POL-SOURCE-REL-001～004（v1） | PASS | 2026-10-27 source-grounding r3；当前待回归 | `memory-source-relation.spec.cjs`、`memory-relation-protocol.spec.cjs` | [s03l-source-grounding-codex.log](evidence/s03l-source-grounding-codex.log) 18/18 | 构造模型输出；抗注入/主体推断未验 |
| POL-SOURCE-LIVE-001（01～12） | FAIL | 2026-10-27 真实 DeepSeek 单批；当前未重跑 | `tools/memory-tuning/source-probe.cjs` | [source-live-codex-v1.json](tools/memory-tuning/results/source-live-codex-v1.json) | 10 PASS/2 FAIL（06、11）；falseMerge=0、missedEquivalent=0；不证明泛化/抗注入 |
| POL-SOURCE-ID-001～004（v1 计划） | PASS（有限能力） | 2026-10-27 master 17 套件最终批 163/163；真实 store/chat 核心、模型 HTTP 构造 | `memory-source-identity.spec.cjs` 4/4；见上方来源身份矩阵 | [master-source-final-aYYduWmG/run.log](evidence/master-source-final-aYYduWmG/run.log) | 存量已有误合组未迁移；UI/真实模型/live未验 |
| POL-MIG-001（v1） | NOT_COVERED | 计划 master 受托确认 2026-10-27；实现未开始 | `memory-identity-migration.spec.cjs`（待实施） | 无 | 多指纹/类别旧组全量拆分；正文不变；未执行 |
| POL-MIG-002（v1） | NOT_COVERED | 同上 | 同上 | 无 | 旧根/中间端点已删、关系边、删除不召回正文；未执行 |
| POL-MIG-003（v1） | NOT_COVERED | 同上 | 同上 | 无 | 双组件解除隔离、重新限制再解除、forget 不解除；未执行 |
| POL-MIG-004（v1） | NOT_COVERED | 同上 | 同上 | 无 | 新显式关联、三角色 scope:self、防回流；未执行 |
| POL-MIG-005（v1） | NOT_COVERED | 同上 | 同上 | 无 | 跨 identity 证实/非卷入/原子重试/版本；未执行 |
| POL-MIG-006（v1） | NOT_COVERED | 同上 | 同上 | 无 | 派生环剔除环边、单组件不变；未执行 |

POL-MIG-001～006 全部 NOT_COVERED：计划 v1 已由 master 联合审查受托确认（不是用户亲自确认），实现未开始，不得写 PASS 或宣称存量误合组已迁移。

#### 来源身份 v2 有限能力验收矩阵（2026-10-27 master 最终批）

master 最终运行 **17 套件 163/163 PASS、0 skipped、真实 exit 0**，原始记录 [master-source-final-aYYduWmG](evidence/master-source-final-aYYduWmG/run.log)；命令/摘要见 [source-identity-v2-acceptance-20261027](evidence/source-identity-v2-acceptance-20261027/master-final-summary.md)。本组只证明真实 SQLite/chat 核心、缺身份迁移与显式关联传播；聊天模型 HTTP 为构造，未取得 UI/真实模型/live 证据。

| Case | 结果 | Given / When / Expected 摘要 | 实际观察与证据 | 未覆盖边界 |
|---|---|---|---|---|
| POL-SOURCE-ID-001 | PASS | 同角色两个独立 chat 会话含同片段、不同 key；各建条目/身份，管理一个不改另一个，重启保持 | `memory-source-identity.spec.cjs` 4/4，master 17 套件批次 | 构造 HTTP；真实模型/GUI未验 |
| POL-SOURCE-ID-002 | PASS | 两角色独立 chat 分别谈姐姐/同事，同片段不同 key；未显式关联时管理 A 不改 B 正文/版本/来源/FTS | 同上 | 构造 HTTP；不证明通用语义 |
| POL-SOURCE-ID-003 | PASS | b 来源为同一姐姐的等价表述；先显式 `associateFacts`，随后 correct/share/relay 传播；未知角色不新增 | 同上 | 等价由 Fixture 明确提供，不冒称模型判断 |
| POL-SOURCE-ID-004 | PASS | 缺身份旧库同文独立来源各自建身份；明确派生链保留；旧控制与正文保留 | 同上 | 已持久化旧误合组未拆解；迁移另批 |
| POL-FACTID-002（v2） | PASS（有限能力） | 独立同文来源不自动同组；显式核实后同步/删除/未知 C 保护按身份传播；v1 同文复用机制 PASS 仍失效 | `memory-fact-identity.spec.cjs` 16/16，master 17 套件批次 | 真实模型语义核验未完成；旧误合组未迁移 |

本次实际运行范围（17 文件，163 项）：`chat-exclusive` 6、`chat-memory-operations` 23、`chat-relay` 12、`chat-sharing-setting` 4、`chat` 18、`memory-association` 9、`memory-auto-share` 5、`memory-exclusive` 5、`memory-fact-identity` 16、`memory-relation-protocol` 8、`memory-sharing` 8、`memory-source-context` 6、`memory-source-identity` 4、`memory-source-relation` 4、`memory` 15、`source-analysis` 11、`theme-memory-sharing` 9。表中这些文件的领域/服务行以该批为当前执行证据；历史基线保留，但“当前待回归”对这些实际运行的领域/服务范围不再适用；其 UI/live/真实模型子项未在本次执行，仍以各行未覆盖边界为准。

说明：s03b-review 是首版服务退回记录，不作为 CHAT 最终状态来源；上表以最终服务/窗口日志及后续切片 Runner 定位。CHAT-001～007 的 v1 业务 Expected 仍有效，缺证只限各行“未覆盖边界”所列子项。

### S04～S05

| Case（版本） | 结果 | 验收基线 / 当前适用 | Runner 入口 / 命令（模板见上） | 原始证据 | 未覆盖边界 |
| --- | --- | --- | --- | --- | --- |
| POL-SOURCE-001～006（v1） | PASS | 2026-10-26 s04a r2；当前未重跑 | `external-sources.spec.cjs` | [s04a-codex-r2.log](evidence/s04a-codex-r2.log) 6/6 | 构造临时目录；真实用户会话/设置页当时未接线 |
| POL-SOURCE-007～012（v1） | PASS | 2026-10-26 s04b r2；当前未重跑 | `session-sources.spec.cjs`、`external-sources.spec.cjs` | [s04b-codex-r2.log](evidence/s04b-codex-r2.log) 12/12 | 本机 TOCTOU 最终检查后仍存在；只支持已核实 Claude/Codex 格式 |
| POL-ANALYSIS-001～011、POL-SOURCE-013（v1） | PASS | 2026-10-26 s04c 最终索引批；当前待回归（写入 memory） | `source-analysis.spec.cjs`、`session-sources.spec.cjs`、`external-sources.spec.cjs`、`automatic-budget.spec.cjs` | [s04c-codex-index-final.log](evidence/s04c-codex-index-final.log) 32/32 | 模型响应/资格为 fixture；真实语义、跨文件同义防回流未验 |
| POL-SOURCE-UI-001～003（v1） | PASS | 2026-10-25 s04d 最终独立批；当前未重跑 | `source-settings.spec.cjs`、`native-shell.spec.cjs`、`companionship-ui.spec.cjs`、`external-sources.spec.cjs` | [s04d-codex-final.log](evidence/s04d-codex-final.log) 16/16 | 原生目录 dialog 为 fixture；无真实人工点击；单屏布局为自动化+截图审查 |
| POL-SOURCE-AUTO-001～005、002b/002c、004a～004e（v1） | PASS | 2026-10-26 s04e 最终独立批；当前待回归 | `source-automation.spec.cjs`、`source-settings.spec.cjs`、聊天/系统回归 | [s04e-codex-chat-final.log](evidence/s04e-codex-chat-final.log) 25/25 | 本地 HTTP/加速时间/原生 dialog/powerMonitor fixture；未读用户真实会话、未锁屏 |
| POL-CONNECTOR-001～007（v1） | PASS | 2026-10-26 s05a r2；当前未重跑 | `connector-ledger.spec.cjs` | [s05a-codex-r2.log](evidence/s05a-codex-r2.log) 7/7 | 未接真实 Herdr 时序/UI；无服务端事件 seq |
| POL-TRANSPORT-001～004（v1） | PASS | 2026-10-26 s05b r2；当前未重跑 | `herdr-transport.spec.cjs` | [s05b-codex-r2.log](evidence/s05b-codex-r2.log) 4/4 | 只覆盖传输模块；正式 adapter 持久身份另验 |
| POL-HERDR-LIVE-001～003（v1） | PASS | 2026-10-26 真实隔离 Herdr 0.9.5；当前未重跑 | `herdr-live.spec.cjs`（隔离手动） | [s05b-live-codex.log](evidence/s05b-live-codex.log) 3/3 | 构造 report-agent 状态；不证明插件安装/真实模型工作/正式恢复对账 |
| POL-HERDR-ID-001～003（v1） | PASS | 2026-10-25 s05c 身份探针；当前未重跑 | `tools/herdr-identity/probe.cjs` | [s05c-codex-identity.log](evidence/s05c-codex-identity.log) | 仅身份/生命周期事实；不等于正式架构或主应用接线 |
| POL-REGISTER-001～004（v1） | PASS | 2026-10-26 s05d 返修；当前未重跑 | `herdr-registration.spec.cjs` | [s05d-codex-repair.log](evidence/s05d-codex-repair.log) 4/4 | 恶意本地进程真实性未承诺；100 条上限明确截断 |
| POL-ADAPTER-001～008（v1） | PASS | 2026-10-26 s05e 返修；当前未重跑 | `herdr-adapter.spec.cjs`、`connector-ledger.spec.cjs`、`herdr-transport.spec.cjs` | [s05e-codex-repair.log](evidence/s05e-codex-repair.log) 19/19 | 无共同事件 ID；跨连接历史不可恢复；不声称 exactly-once |
| POL-HERDR-RUNTIME-001～012（v1） | PASS | 2026-10-26 s05h 最终批；当前未重跑 | `herdr-runtime.spec.cjs`、`herdr-adapter.spec.cjs`、`connector-ledger.spec.cjs` | [s05h-codex-final.log](evidence/s05h-codex-final.log) 27/27 | 真实 Herdr 隔离；main 集成/设置页/真实通知气泡当时未完成 |
| POL-NOTIFY-001～009（v1） | PASS | 2026-10-26 s05f 最终批；当前未重跑 | `notification-presentation.spec.cjs` | [s05f-codex-repair.log](evidence/s05f-codex-repair.log) 14/14、[codex-notify-discovery-repair.log](evidence/codex-notify-discovery-repair.log) 27/27 | 计时/可见性为 fake presenter；真实用户阅读、4/6 秒物理体验 NOT_COVERED |
| POL-CONNECTOR-UI-001～006（v1） | PASS | 2026-10-26 s05i 最终批；当前未重跑 | `connector-ui.spec.cjs`、`herdr-runtime.spec.cjs`、`herdr-adapter.spec.cjs` | [s05i-codex-final.log](evidence/s05i-codex-final.log) 26/26、[s05i-codex-shell.log](evidence/s05i-codex-shell.log) 9/9 | 通知气泡、插件安装入口未完成；5 秒刷新不等于 P0 时效 |
| POL-NOTIFY-UI-001～011（v1） | PASS | 2026-10-26 s05j 最终两批；当前未重跑 | `desktop-notifications.spec.cjs` | [s05j-codex-gui-r2.log](evidence/s05j-codex-gui-r2.log) 5/5、[s05j-codex-gui-r3.log](evidence/s05j-codex-gui-r3.log) 6/6 | 420pt 受控窗口；非物理小屏/人工阅读；大突发只保证有界延迟审计 |

### S06～S08

| Case（版本） | 结果 | 验收基线 / 当前适用 | Runner 入口 / 命令（模板见上） | 原始证据 | 未覆盖边界 |
| --- | --- | --- | --- | --- | --- |
| POL-BUDGET-001～008（v1） | PASS | 2026-10-26 s06a 与 s04c 预算返修；当前未重跑 | `automatic-budget.spec.cjs` 及来源相邻回归 | [s06a-codex-r2.log](evidence/s06a-codex-r2.log)、[s04c-codex-budget-r3.log](evidence/s04c-codex-budget-r3.log) | 未接真实自动活动网络/取消/发布权限；预算模块接受不等于自动活动接受 |
| POL-OPPORTUNITY-001～007（v1） | PASS | 2026-10-26 s06b 返修；当前未重跑 | `automatic-opportunities.spec.cjs` | [s06b-codex-repair.log](evidence/s06b-codex-repair.log) 7/7 | 同 SQLite 服务重建，不是 OS 进程重启；未接心跳 |
| POL-ACTIVITY-001～008（v1） | PASS | 2026-10-26 s06c 最终；当前未重跑 | `character-activities.spec.cjs`、`companionship.spec.cjs`、`relationship-effects.spec.cjs` | [s06c-codex-single-activity.log](evidence/s06c-codex-single-activity.log) 33/33 | 领域服务；主进程自动活动/正式动画/故事链当时未接 |
| POL-ACTIVITY-RUNTIME-001～004（v1） | PASS | 2026-10-26 s06h 最终真实 Electron；当前未重跑 | `activity-runtime.spec.cjs`、`desktop.spec.cjs`、unit | [s06h-codex-runtime.log](evidence/s06h-codex-runtime.log) 6/6、[s06h-codex-desktop.log](evidence/s06h-codex-desktop.log) 11/11 | 其他角色 daily、探索正式离场/返回、全动画库未覆盖 |
| POL-STORY-001～005（v1） | PASS | 2026-10-26 s06e 最终；当前待回归 | `story-progress.spec.cjs` | [s06e-codex-public-final.log](evidence/s06e-codex-public-final.log) 5/5 | 未接正式作者目录/邀请/服装解锁/main/GUI/模型 |
| POL-DISCOVERY-001～006（v1） | PASS | 2026-10-26 s06f 返修；当前待回归 | `discovery-outcomes.spec.cjs`、故事/通知回归 | [codex-notify-discovery-repair.log](evidence/codex-notify-discovery-repair.log) 27/27 | main、共享分享预算、正式素材、GUI 回执未覆盖 |
| POL-CONTENT-001～003（v1） | PASS | 2026-10-26 s06g 最终；当前未重跑 | `authored-content.spec.cjs` | [s06g-codex-final.log](evidence/s06g-codex-final.log) 3/3 | 仅领域；正式四条故事 assetAvailable 均 false；无正式 main/GUI/动画发布 |
| POL-STORYRUN-001～005、004B、UI-001（v1） | PASS | 2026-10-26 s06i 最终独立批；当前待回归 | `story-runtime.spec.cjs`、`story-runtime-ui.spec.cjs` | [s06i-codex-gui-r2.log](evidence/s06i-codex-gui-r2.log) 7/7、[s06i-codex-domain.log](evidence/s06i-codex-domain.log) 54/54 | 正式内容未发布；自动准备/展示未接 main 窗口 |
| POL-STORYUI-001～005（v1） | PASS | 2026-10-27 s06j 最终独立批；当前待回归 | `story-window-ui.spec.cjs` | [s06j-codex-gui-r2.log](evidence/s06j-codex-gui-r2.log) 7/7 | 自动桌面邀请、服装解锁窗口、正式素材发布后全链 NOT_COVERED |
| POL-ASSET-001（v1） | PASS | 2026-10-25 asset-pilot；当前未重跑 | `tools/sprite-pipeline/test_sprite_pipeline.py` | [asset-pilot.md](asset-pilot.md) | 切帧/静态边缘；不证明动态质量 |
| POL-ASSET-002（v1） | INCONCLUSIVE | 播放器能力通过，但仅 idle/wave 试样与关键帧审查 | `verify-player.cjs` | tools/sprite-pipeline/evidence/codex-idle-v3.json、codex-wave-v2.json | 长期自然度、桌面实际尺寸连续播放、全部动作 |
| POL-ASSET3-001（v1） | INCONCLUSIVE | 导入/尺寸/裁剪子项 PASS；透明命中子项 NOT_COVERED | `s07b-three-character.spec.cjs`、`desktop-assets.test.cjs` | [s07b-codex-isolated-r3.log](evidence/s07b-codex-isolated-r3.log) | 透明像素不抢点击；整体不得因几何通过写 PASS |
| POL-ASSET3-002～005（v1） | PASS | 2026-10-27 s07b 最终隔离批；当前未重跑 | `s07b-three-character.spec.cjs` | [s07b-codex-isolated-r3.log](evidence/s07b-codex-isolated-r3.log) | Hu/Cheng 仍为候选；正式素材发布、更多动作与衣装未完成 |
| POL-RESTUI-001～003（v1） | PASS | 2026-10-27 s07-rest r2；当前未重跑 | `desktop-rest.spec.cjs` | [s07-rest-runtime-codex-r2.log](evidence/s07-rest-runtime-codex-r2.log) 3/3 | 仅凛 D01/D02；其他角色休息资源、D03/D04、真实睡眠/Retina 未覆盖 |
| POL-HIT-001～003（v1） | PASS | 2026-10-27 s07c 主目录整合；当前未重跑 | `s07c-transparent-input.spec.cjs`、桌面回归、unit | [s07c-codex-r1-native.log](evidence/s07c-codex-r1-native.log) tests 1/pass 1，单测试覆盖 HIT-001/002/003；桌面 11/11 见 [s07c-codex-r1-desktop.log](evidence/s07c-codex-r1-desktop.log) | scaleFactor=1；Retina/Spaces/全屏未验 |
| POL-NATIVE-001～003（v1） | PASS | 2026-10-27 s08a 收束与凛母版同步；聊天/记忆部分当前待回归 | `native-shell.spec.cjs`、`desktop.spec.cjs` | [s08a-codex-repair.log](evidence/s08a-codex-repair.log) 14/14、[rin-portrait-native-codex.log](evidence/rin-portrait-native-codex.log) 1/1 | 仅已实现三页/两尺寸；全部设置、真实服务、最终原生体验未完成 |

### S08 最终验收入口（GAP-14，流程补齐已受托验收，未执行；跨链 S02/S03/S04/S05/S06/S07）

本组 Contract 见 [final-acceptance-contract.md](final-acceptance-contract.md)；S08 是既有最终验收入口，不新增 S09 父级。master 已受托验收 7 个 v1 Contract 与 Part A/B；Contract 执行结果均未产生，全部记 NOT_COVERED。历史证据仅作边界引用，不升级为这些 Contract 的 PASS。本批 snap 后接回 S03 来源身份工作。

| Case（版本） | 结果 | 验收基线 / 当前适用 | Runner 入口 / 命令（模板见上） | 原始证据 | 未覆盖边界 |
| --- | --- | --- | --- | --- | --- |
| POL-FINAL-CATALOG-001（v1） | NOT_COVERED | 只登记；历史工具自检仅引用 | `tools/appearance-catalog/build.py` | README 历史构建记录；本轮未执行 | 独立副本重建/数据一致性、配方追溯与发布边界未验 |
| POL-FINAL-ANIM-001（v1） | NOT_COVERED | 只登记；ASSET-002 INCONCLUSIVE、ASSET3-001 子项 NOT_COVERED、RESTUI/HIT 为部分 PASS | 待实施 | 历史 ASSET/ASSET3/RESTUI/HIT 日志仅边界 | 24＋12 逐角色/服装覆盖、过渡中断、探索离桌与正式素材未验 |
| POL-FINAL-STORY-001（v1） | NOT_COVERED | 只登记；STORY/DISCOVERY/STORYRUN/STORYUI 为切片证据 | 待实施 | 历史 story 系列日志仅边界；正式 `assetAvailable=false` | 正式发布→邀请→ACK、服装 72h 告知/穿用与重启幂等未验 |
| POL-FINAL-NATIVE-001（v1） | NOT_COVERED | 只登记；NATIVE-001～003 仅三页/两尺寸 | 待实施 | 历史 s08a 日志仅边界 | 全页面/全设置、原生目录授权、模型修复与最终单屏未验 |
| POL-FINAL-DESKTOP-001（v1） | NOT_COVERED | 只登记；002 有 S07c 真实点击，003/006 真实系统事件与 004 托盘点击缺证 | 待实施 | s07c 1 test/3 Case；desktop powerMonitor 子断言 | Spaces/全屏、真实锁屏/睡眠、Retina、托盘逐项未验 |
| POL-FINAL-E2E-001（v1） | NOT_COVERED | 只登记；内层 Case 原样引用，无单条最终链 | 待实施 | 历史 CHAT-008/HERDR-LIVE 等仅边界 | 真实模型＋隔离 Herdr、突发/重连、断模型、撤权在途与跨重启未合并验收 |
| POL-FINAL-DELIVERY-001（v1） | NOT_COVERED | 只登记；交付文档/snap/清理由 master 主持 | 待实施 | 无最终交付证据 | 启动/配置/数据说明、全需求映射、环境清理与工具抽查未验 |

下一最小步骤（只设计、不编码）：存量误合身份组安全迁移——区分可证明派生与无持久关联证据的旧组，控制不得丢失，不臆测旧关联来源；随后接回 S03 语义纠正/删除/共享闭环。

## 当前失败、未验证与待回归（不得写成通过）

- **来源身份 v2（有限能力已受托接受，2026-10-27）**：master 最终 17 套件 **163/163 PASS、0 skipped、exit 0**，接受新独立来源同文不归组、缺身份迁移按明确派生、显式 `associateFacts` 传播、相关回归通过。历史开发报告 35 项 29 PASS/6 FAIL、首次独立 35/35 与前次 128/125/3 均保留为时点记录，失败原件未覆盖。POL-FACTID-002 v1 机制 PASS 仍失效；存量已有误合组未迁移；语义模型闭环、正式主题自动分享 GUI 与正式资源未完成；不得据此宣称 S03/Goal 通过。
- **语义与真实模型（分层）**：SEM 是真实 SQLite/正式 memory 的本地构造 Runner，不使用真实模型，r4 为 3 PASS/5 FAIL；holdout、source-live、REL-004 与 pro 对照才是真实模型工具层，使用构造数据（holdout 2 FAIL：11、12；source-live 2 FAIL：06、11；pro FAIL）。SEM 本地失败不能由模型 probe 变绿抵销；单次 probe 也不证明生产语义。
- **正式内容**：`app/content/maid-stories.json` 四个故事 `maid.meet.rin`、`maid.meet.hu`、`maid.meet.cheng`、`maid.outfit.rin-warm-tea` 的 `assetAvailable` 均为 `false`；CONTENT 领域 PASS 不等于正式发布、可见故事或动画完成。
- **素材候选**：ASSET-002 仍 INCONCLUSIVE；ASSET3-001 透明命中 NOT_COVERED；Hu/Cheng 仍为候选；36 动作、正式服装、过渡与中断、其他角色日常未完成。
- **原生边界**：DESKTOP-003（Spaces/全屏）与 DESKTOP-006 真实锁屏/休眠 NOT_COVERED；托盘原生点击 NOT_COVERED；HIT 仅 scaleFactor=1。测试截图、受控 powerMonitor 事件不能冒充物理操作或 Retina 硬件证据。
- **当前工作区回归**：未提交实现含 `app/memory.cjs`、`app/memory-store.cjs`、`app/memory-fact-identity.cjs` 与 `memory.spec.cjs`、`memory-fact-identity.spec.cjs`、`memory-association.spec.cjs`、`memory-source-identity.spec.cjs`。master 2026-10-27 最终 17 套件 163/163 已重跑对应领域/服务 Runner；未在该批执行的 UI、真实模型、holdout/source-live/pro 与 story GUI 组仍保持历史状态和未覆盖边界，旧 commit 结果不证明这些未重跑组。

---

## 历史批次记录（原文保留，逐项结论以上方矩阵为准）

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

## S03a本地记忆模块：接受基础实现，应用接入尚未完成

2026-10-26，Codex源码审查、四轮具体返修与独立执行。当前是显式传入真实SQLite连接的生产模块，尚未接入正式createStore、模型或UI，不宣称应用已经会记忆。

| Case | 模块执行证据 | 整体边界 |
| --- | --- | --- |
| POL-MEMORY-001 | 角色过滤、来源/批次幂等、昵称稳定、重开通过 | 正式窗口、服装切换后链路未覆盖 |
| POL-MEMORY-002 | 46条构造查询，4策略，逐条命中与误命中；角色/时效/删除门禁0违规 | 非盲测、有限词表；零字面同义仍会漏，真实聊天未覆盖 |
| POL-MEMORY-003 | 原始/独立/分享持有者纠正、来源排除、未知角色不新增、事务通过 | 自然语言定位和在途模型发布待S03b |
| POL-MEMORY-004 | 正文/FTS/相关持有者删除、旧来源防回流、索引重建与重开通过 | 最近聊天拼接与屏幕展示清除待实际接入，不能标全Case PASS |
| POL-MEMORY-005 | 只A忘记、B保持来源身份且可被用户管理、A不自动恢复、新许可通过 | 用户语义入口待S03b |
| POL-MEMORY-006 | 长期内容保持、临时到期过滤、时钟构造通过 | 普通细节自然降权/整理与真实活动使用尚未完成 |
| POL-MEMORY-007 | 定向必要片段、原讲述来源、拒绝自动二次分享通过 | 用户明确再次转告、停止分享/仅自己保留入口待S03b，自动预算待S06 |

注：上表为 2026-10-26 模块阶段快照；后续已补子项、仍未覆盖的服装联动与普通细节降权，以统一矩阵的逐子项拆分为准，不再用 15/15 推断七项全 PASS。

独立证据：`evidence/s03a-codex-first.log`8/8；`s03a-codex-r2.log`12/12；`s03a-codex-r3.log`14/14；最终`s03a-codex-r4.log`15/15（约1.17秒）。其中第10001条记录重建前/后及重开均能检索。七个相关JS分别node --check通过。工具独立输出`tools/memory-tuning/results/codex-r4.json`；此前失败复现与r2对照保留在同工具results内，不覆盖。

返修解决：纠正没有排除原聊天来源、删除原记录导致接收者派生身份丢失、同源提炼批次重复、自然问句全AND漏召回、错误限制接收者的用户管理权限、把查询否定词当真值硬过滤，以及重建索引10000条截断。r3改变了一个错误测试Oracle：PRD允许用户管理当前已知的分享记忆，不需回原讲述者；这是恢复业务预期，不是放宽权限门禁。来源记录不保存被删正文。

检索暂采用hybrid作为候选召回默认：严格分词→有限概念扩展→自然问句宽召回；保留其他基线与可解释理由。开发构造集Recall约0.976、误命中11、门禁0，不能称通用语义理解；结果仅为候选，不能据分数执行纠正删除或断定事实。词表部分依据新增样例调整，已明确不是盲测。生产约1500行分存储/检索/业务三职责，规模高于首估但未建泛用框架；后续不为新样例无界扩大词典。

决定：**接受本地模块与调优工具作为可保存基础；S03a整体仍未完成**。待S02b共享文件释放后接入现有store，S03b补真实聊天与控制入口。没有实际模型提炼或人类体验证据，不冒称完成整个记忆系统。

## S02b原生画布与生命周期：保存已验证实现，原生体验尚有缺口

2026-10-26，Codex三轮源码审查及独立执行：unit10/10、companionship服务19/19、GUI16/16；随后缓存A→慢加载B→A竞态新增修复，独立相关桌面4/4。证据`s02b-codex-r2-{unit,services,gui}.log`与`s02b-codex-r3-related.log`。实际SQLite、主子Electron、正式Rin/Hu资源、真实解码与播放节点覆盖；受控fixture模型只用于隔离onboarding，不冒充DeepSeek。

| Case | 当前证据 | 尚未覆盖 |
| --- | --- | --- |
| POL-DESKTOP-001 | 真实独立画布进程，非激活panel属性、有限IPC、模型Key未传入子环境 | OS实际屏幕合成与焦点未验 |
| POL-DESKTOP-002 | S02b 本批未测原生点击/穿透；后续由 S07c HIT-001～003 真实 CGEvent 覆盖，见统一矩阵 | Retina/物理多屏未验；不得用 DOM 点击代替 |
| POL-DESKTOP-003 | 无自动化 Runner，须真实 Spaces/全屏切换 | 真实 Spaces/全屏；后续 HIT 通过不能代替本项 |
| POL-DESKTOP-004 | 管理窗关闭隐藏、重复启动、画布崩溃有界恢复、父退出子结束 | 原生托盘逐项点击 |
| POL-DESKTOP-005 | Rin→Hu真实待机、自然节点等待、损坏PNG错误、旧加载/节点与A→B→A竞态 | 原生连续动画视觉、全部动作与服装 |
| POL-DESKTOP-006 | 受控 powerMonitor lock/suspend 交错原因集与时间结算 | 用户机器真实锁屏/睡眠未触发 |

工具`tools/desktop-review`仅构造真实app的普通底板，不复制业务。Codex运行batch-VMVxQK，fixture关闭、quit退出0、子进程核实清理，独立语法通过。CU接口按确切app路径只能取得底板单窗口截图，未能观察独立画布叠加；没有使用DOM点击冒充原生输入。不操作用户锁屏或全局设置。工具证据只证明本次启动与清理。

决定：保存可运行的阶段实现；**S02b不标整体PASS**。将明确原生体验缺口保留到集成验收，后续服务/设计可独立继续。首版预估偏低，现有代码按宿主/画布/托盘/系统暂停/自然节点拆分，未建立通用框架；最终窗口样式需按用户最新native要求返工，不沿用开发页作为设计验收。

## S03b聊天服务基础：独立回归通过，窗口与真实模型未接线

2026-10-26 Codex审查后接受服务层可保存实现。真实createStore同一SQLite连接接入memory/chat；受控HTTP只提供响应，不Mock核心检索、来源控制、事务及请求状态。独立r2为32/32，恢复修复后36/36，证据s03b-codex-r2.log、s03b-codex-recovery.log；包含聊天15、记忆15、相关单元6。

| Case | 已验证服务范围 | 整体状态与缺口 |
| --- | --- | --- |
| POL-CHAT-001 | 已结识资格、角色上下文隔离、持久化顺序、幂等冲突、启动遗留请求显式恢复 | NOT_COVERED：真实窗口/名单/互动接线 |
| POL-CHAT-002 | 词面证据约束、原话保存、普通助手建议不直接成为用户事实 | INCONCLUSIVE：真实模型提炼与语义未验证 |
| POL-CHAT-003 | 取消/关闭/失败、事务回滚、dispose后无迟到写入、明确重试 | NOT_COVERED：真实窗口和主进程退出接线 |
| POL-CHAT-004/005 | 版本失效、旧来源排除、重试前排除原消息、延迟结果不发布 | NOT_COVERED：本地窗口纠正删除和可控展示清理 |
| POL-CHAT-006/007/008 | 本批不覆盖 | NOT_COVERED：完整共享控制、语义定位、真实DeepSeek |

注：本表是 2026-10-26 服务阶段快照；NOT_COVERED/INCONCLUSIVE 指当时窗口或真实模型尚未接线。后续切片完成情况以统一矩阵为准；s03b-review 仅为首版退回记录，不作为最终状态。

两轮独立审查修复五项首版风险和消息同毫秒UUID排序、启动遗留pending、退出收束问题，见s03b-review.md与s03b-recovery-review.md。启动恢复是显式选项，main下一轮必须开启；dispose必须在关闭数据库之前await，不能把服务存在说成主进程已经使用。构造关闭重开数据库不是真实操作系统崩溃，后续需进程级证据。

记忆提炼采用保守词面grounding：保存引用原话，不直接信任模型改述；不宣称事实判断或稳定语义键已解决。生产chat约700行、chat-store约300行、测试约1100行，按请求/持久化职责分开，没有通用框架。服务阶段可保存；整个聊天记忆系统尚未验收，继续s03b-window-plan.md第一切片。

## POL-CHAT-008真实服务首轮：FAIL

Codex显式执行`node --no-warnings --test tests/acceptance/live-chat.spec.cjs`。2026-10-26本地时间，实际GET /models确认deepseek-flash；独立临时SQLite、真实生产chat/memory服务，未经过GUI。真实chat只发1次，无自动重试、无测试seed。模型回应“温茶。好，我记着了。”，但memoryApplied=0，活动记忆为空，测试在学习环节正确失败；重开回忆、纠正和删除后三步未执行，不记为通过。

证据`s03b-codex-live-chat-first.log`及`s03b-pol-chat-008-live-first-failure.json`只包含构造内容与必要计数，不含Key/Authorization/reasoning_content。独立语义判断同样FAIL：口头承诺与保存事实不一致；回复中的虚构茶壶动作也不能作为共同经历入库。失败规格见s03b-live-review.md，待窗口开发释放共享文件后修复并复验。该测试入口属于有效的失败检测成果，不表示生产功能已通过；保留明确单独执行入口，避免默认回归消耗真实API。

## S03b窗口首版独立执行（2026-10-26）

Claude窗口首版CLI23750已退出0。Codex独立执行 `node --no-warnings --test --test-concurrency=1 tests/acceptance/chat-ui.spec.cjs tests/acceptance/onboarding.spec.cjs tests/acceptance/companionship-ui.spec.cjs`，14/14通过，证据evidence/s03b-codex-window-first.log。真实Electron/SQLite与本地受控HTTP；不含真实模型。聊天5项覆盖角色归属、重启历史可达、尺寸可操作、取消、显式重试、跨角色迟到回复和退出互动锁清理；既有配置6项、陪伴UI3项回归通过。

本批不判整个POL-CHAT通过：同角色历史请求倒序、关闭失败协调状态及await后焦点归属仍待按s03b-window-review.md复现；窗口隐藏/系统暂停和有效互动数值仍未完整覆盖。首版生产增量约1140行、测试500行，由独立chat-panel分担renderer；后续审查保留规模与可维护性关注，不通过压行降数。真实模型记忆缺陷仍FAIL；已派同开发者依s03b-live-review.md先修协议，禁止自动真实请求。

## POL-CHAT-008真实第二轮语义审查

协议补全后的独立服务回归37/37（s03b-codex-protocol-r2.log），真实DeepSeek实际GET models确认deepseek-flash；4次聊天，无自动重试，测试exit0。证据s03b-pol-chat-008-live-second.json及s03b-codex-live-chat-second.log。来源为构造数据，未seed偏好；首次实际落库1条，SQLite关闭重开后全新对话召回，明确本地纠正影响后续回答，删除后活动记忆为空且不再称知道旧/新饮品。存储/隔离/纠正/删除子断言PASS。

Codex读取逐轮原文后判来源归因语义FAIL：模型将“我喜欢温茶”扩写成“你上次说过，茶放到温热才喝”，无该行为来源；删除后“你还没跟我说过”把当前无记录推为历史未说过。故整体POL-CHAT-008仍不PASS，不改原始machineVerdict或伪造人工结果。下一修正是通用来源忠实与未知表达约束，不能用测试饮品词后处理；本地删除为选择条目操作，不证明自然语言删除功能完成。

### 第三轮：事实扩写改善，未知表达仍未通过

Codex独立服务37/37（s03b-codex-attribution.log），真实四轮机器通过（s03b-pol-chat-008-live-third.json）。学习实际保存1条，重启回答原话“温茶”，纠正回答热可可且不再扩造旧饮茶行为；三阶段语义本批可接受。删除后说“我还没听你提过”，仍将无可用记忆当作过去没有交流；该语义子项FAIL，整体POL-CHAT-008不记PASS。无变化不继续重复真实调用；后续有明确策略变更再复验，原始三批结果全部保留。

## S03b窗口返修与真实记忆第四轮（2026-10-26）

Codex独立窗口回归18/18通过（s03b-codex-window-r2.log）：含8项真实聊天GUI、1项视图代次单测、6项配置GUI、3项陪伴GUI。新增验证实际SQLite关闭故障时面板/互动保留、解除故障后成功重试；关闭在途后的焦点与迟到隔离；真实本地memoryApplied反馈不由模型文案驱动。历史请求倒序的token判定仅在小模块单测覆盖，尚缺实际IPC延迟的完整UI场景，不能把这项冒称GUI实证。

最新上下文策略独立服务38/38（s03b-codex-unknown.log）。第四轮真实DeepSeek GET models1/chat4，无自动重试；evidence/s03b-pol-chat-008-live-fourth.json保存完整构造文本与本地状态。Codex逐轮阅读：初次“我记下了”对应实际1条记忆；重启新会话“你喜欢喝温茶”有原话来源；本地纠正后回答热可可；删除后“这个我还不清楚”不再断言从未交流。后续留茶是角色未来提议，不计为真实经历。该构造链路机器与语义均PASS，接受POL-CHAT-008的当前服务边界，不推为所有语言变体、自然语言定位/删除、外部源解析或UI记忆管理完成。

受托接受聊天窗口首个可用切片与固定回复协议：正式管理窗可按角色聊天、取消、显式重试、历史只读及重开；存储和源事实归因改进已实测。仍待本地记忆管理入口、自然语言控制、精力有效互动接线、IPC历史延迟完整UI、native整体视觉和全产品验收。前三批失败证据保留，不覆盖或删除。
