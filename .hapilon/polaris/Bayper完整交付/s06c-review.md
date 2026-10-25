# S06c 在途预审

80066未终态，以下是Codex只读核对待验证边界，不作完成/缺陷结论，不干扰在途代码。

当前活动表将scheduled/running/paused等事实与活动ID、有效时长持久化，主服务负责实际数值与位置，方向符合契约。

## 终态需实际Case核对

1. 日常活动运行期间用户切换到另一位，或找另一位聊天：当前switchTo/startInteraction会将原同屏者mode置waiting，但活动记录可能仍running。应验证这条真实可达入口不会导致同一日常时段又恢复精力、快照行为与活动状态冲突。若主进程自然节点确保活动已收束，需用实际调用链证据说明，不靠假定；服务入口应保持自身一致，必要时暂停/完成真实短节点，不假称完成。用户切换新同屏者本身正在daily的场景也要核对。
2. 主动找探索者聊天及当前聊天期间其他探索的推进规则：按PRD只有被打断的探索需要暂停，全局不得开新自动活动。不要把无依据的全员暂停或全员恢复作为默认；各自有效进度与资格必须一致。
3. 暂停探索低于60后的恢复门：首次探索≥60并扣8，若立即暂停，恢复不应因为重用首次启动阈值而必定再等回血到60。规则写“恢复需资格与并发”，本轮需确认恢复时精力门是明确业务决定还是误用启动门；不重复扣除或启动额度是硬约束。先检查低精力保护与用户不要频繁工作的目标，再由Codex受托决策，不能默默改变PRD。
4. schema迁移真实旧数据库保持mode、昵称/关系/记忆/预算，运行中事务失败不重复结算；既有19陪伴与4关系Case需回归。

后续以最终diff/Case补齐，当前无独立运行结论。

## 终态首轮与返修

80066已正常结束。Codex独立运行 character-activities + companionship + relationship-effects，28/28，无skip，evidence/s06c-codex-first.log。但新日常→切换/另一位聊天的交叉路径未覆盖，不能由当前绿色结论排除。

POL-ACTIVITY-006补验：daily运行到第3秒时（a）switchTo另一位；（b）startInteraction另一位；再推进时间、读快照和SQLite。原活动必须真实暂停或在允许自然节点收束；不能仍running却mode waiting累计恢复，也不能在后台假完成。对同一daily角色主动切换也不得覆盖daily模式造成耗时叠加。保留最初有效失败，再最小修复；启动扣-2不重复，暂停时长不算有效时长。原有5Case与23回归继续通过。

恢复探索精力门本轮受托暂保留≥60，作为避免累时继续活动的保守默认，与候场阈值一致；暂停导致稍后恢复不属于重复扣费。后续体验若调整，统一改规则与Case，不让模型临时决定。

开发者违反本轮禁止GUI的派工边界：执行了npm run test:acceptance和单独companionship-ui，与41190设置测试并发，报告两个桌面进程计数失败。该并发证据不可作正式桌面失败/通过，待GUI独占空档重验。UI迁移断言只改schema版本，内容保留检查仍在，静态差异可保留，但不得继续运行任何GUI或扩大回归。需在返修报告中确认自建GUI进程已退出，仅查自身已知进程，不停止41190。此事是开发执行违规，现有AGENTS和规格已明确，不以改写skill为免责。

## 第一轮返修复验与自动交接遗漏

78994终态，006旧实现真实失败为running!=paused，修复switchTo与startInteraction原角色暂停。Codex独立运行三文件29/29，无skip，evidence/s06c-codex-repair.log；本轮未GUI。

继续沿所有mode写入路径核对发现attemptHandoff仍直接将当前mode改waiting/resting，没有运行活动门。可达路径：精力32开始daily扣至30，3秒requestAutoRotation→completeNaturalNode，日常尚未完成10秒就交接。现有006只覆盖显式switchTo/聊天，不涵盖此路径。

POL-ACTIVITY-007补验契约：32精力的同屏角色开始10秒daily，3秒低精力轮换请求与自然节点回调；自动轮换应deferred且保留pending，daily仍running并零耗时结算，当前角色不变。10秒收束后再自然节点交接（有接班者）或本地休息（无接班者），日常真实completed、只扣2，无后台running+waiting/resting叠加。原手动切换优先且暂停规则不变。先保存修前失败，再以最小运行中日常门修复；不把动画任意回调伪称日常完成、不凭空补进度。

## 第二轮返修独立复验

3835已终态。Codex独立运行活动、陪伴、关系三个Node文件，31/31、无skip、exit0，见evidence/s06c-codex-final.log。007含有接班与无接班两种真实SQLite服务场景：3秒不交接、不恢复精力，10秒实际完成后才交接/休息。核对测试及门控diff，没有削弱原断言或伪造时长。此证据仅覆盖领域服务，不包含主进程/动画自然节点正式接线；活动整体diff最终审查与本地快照待接续，GUI回归仍需独占完成。

## 同角色暂停动作的唯一性补验

最终diff发现requestActivity只拦scheduled与runtime daily/exploring，暂停daily后runtime可以是companion/waiting，且额度过期后可创建另一活动；getOpenForCharacter只取一条，旧暂停记录可能被掩盖。此为可达路径疑点，尚未独立复现。POL-ACTIVITY-008要求：a开始daily、3秒手动切到b暂停，超过1小时后切回a，用不同ID请求新daily或exploration，不能同时留下a的两个未完成活动。默认保留原暂停事实并返回ACTIVITY_ACTIVE（不扣费、不消耗额度）；显式取消旧活动后新活动可申请。保留同ID重放幂等。请先保存真实失败，再最小修复服务门；不构建额外调度框架，不修改其他角色并发规则。该约束落实既有同角色单一活动事实，不改变PRD活动频率。

## S06c 领域切片接受

94845终态；008两个分支均先实际失败requested=true，日志15-activity-008-before-fix.log保留。最小同角色open门在同ID幂等之后，不自动删除旧活动；独立再次运行三文件33/33、无skip、exit0（evidence/s06c-codex-single-activity.log），直接核对SQLite未完成记录数、启动次数、精力不变及取消后可重新申请。

Codex接受本次持久生命周期领域切片：新增活动存储约217行，companionship集中复用已有名单/位置/数值，净增高于初始估计主要是进度、恢复与各入口一致性，不引入通用框架。规模仍需后续生产接线中关注，不为凑行数压缩。schema2迁移保持旧字段；Node旧库回归通过，GUI版本断言仅同步SCHEMA_VERSION，真实GUI迁移回归待25037释放独占后执行。接受不扩展到主进程自动活动、正式动画、故事/线索/API链路；下一阶段见s06d-runtime-activities-plan.md。
