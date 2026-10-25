# S06a 全应用自动模型预算

Codex受托确认。依据PRD及state-and-rhythm.md“自动活动与API节奏默认”，建立来源分析、故事、共享共同使用的持久化调用预算。S04后续接线必须使用它，不建立独立无限后台。本轮只做预算服务和真实SQLite场景，不把调度或自动活动整体标完成。

## 接口与边界

仅新增app/automatic-budget.cjs及tests/acceptance/automatic-budget.spec.cjs；禁止改main/store/renderer/chat/memory/sources/其他测试/资产/版本/Git/文档。构造createAutomaticBudget({db,now})，与正式SQLite显式共享，不创建第二数据文件；统一AppError。无GUI、网络、真实HOME/.env，全部临时构造。

- 提供reserve({requestId,characterId})、beginAttempt(token)、finish(token,outcome)、cancel(token)、status(characterId)等小而具名接口，允许自行精简命名。名单、状态、聊天优先、30分钟抽签由上层负责；不能把本模块当资格检查。
- 全局自动发送尝试滚动1小时最多1次、8小时4次、24小时6次；同角色相邻至少2小时。所有自动用途共用，不按purpose分额度；显式聊天不走此模块。时间边界以 now-window < timestamp <= now 计数，即恰好到期释放；时钟回拨采用持久化不回退逻辑时间，不能抹掉未来记录或绕过冷却。说明恢复时钟的含义，不修改系统时钟。
- 全局最多一个自动预留/在途令牌。reserve检查预算并预留但不计发送；beginAttempt在真正交给transport前重新核对预算并事务记一次发送，调用方不得在其失败时仍发网络。重复相同requestId或begin不产生第二个发送许可；接口返回明确是否首次可发送，不能因为幂等成功就让调用方重发。令牌只主进程使用。
- 成功、失败、超时、发送后取消都保留已消耗尝试，finish幂等，释放并发位；发送前取消不占次数。无自动重试、补发或后台定时器。调用方finally结束生命周期，实际网络取消由后续协调器负责。
- 重建服务会恢复上次未终结记录为interrupted并释放占位，已发送尝试保留；未发送预留不虚构请求。服务约定每个运行实例只构造一次，构造恢复不得用于随意释放活跃请求。requestId已用过不能再次获发，即使重启。
- 事务失败不提前更新内存、不发许可或假报成功；记录最少字段（id/角色/时间/状态/是否发送），不存正文/key。历史不必本轮建立清理框架，后续按保留策略处理。约200～300行生产、200～300行测试为规模信号，禁止通用任务引擎或层层包装。

## Acceptance Contract

| ID | Given / When | Expected / Oracle |
| --- | --- | --- |
| POL-BUDGET-001 | 真实SQLite五个角色 → 跨角色申请发送、同角色重试，推进构造时钟 | 全局1h/8h/24h与角色2h边界全部真实阻止；用具体时间序列和独立SQL尝试数核对，不读内部常量自证 |
| POL-BUDGET-002 | 一次预留 → 并发申请、取消、发送、成功/失败/超时、重复begin/finish | 全局只一占位；发送前取消不耗、发送后任何结局均耗；重复ID绝不返回第二次发送许可 |
| POL-BUDGET-003 | 已发送或未发送占位 → 关闭SQLite/重建服务，跨自然日或时钟回拨 | 释放遗留占位但已发送滚动额度保留，无离线补发；旧ID不可重发，午夜不清额度、回拨不释放冷却 |
| POL-BUDGET-004 | SQLite trigger强制记录/更新失败 → reserve/begin/finish/cancel | 状态不部分更新，不发可发送许可；解除故障可显式恢复，相关其他记录不破坏 |

Runner调用真实模块+SQLite+构造时钟；不Mock计数/事务，不发送HTTP。未来真实网络调用、优先级抢占、日常/探索额度与30分钟机会分别接线验收。所有临时目录与数据库finally清理，保存真实日志到本工作evidence/s06a-budget。
