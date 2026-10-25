# S08a 收束与画布有界恢复修复

Codex受托确认。独立GUI回归68229已结束，28/28，evidence/s08a-codex-independent.log。GUI现在交本任务独占。其余Claude任务是transport与automatic-opportunities，不触碰。

## 两项必要修正

1. 正式设置页index.html第335行“本切片不新增…需要重新配置时仍走首次启动…”：产品不展示内部阶段术语，也不能提示已接纳用户使用不可达的首次配置入口。删除此段无操作价值的说明，不新增模型修改业务；未实现能力留在交付记录。旧素材候选标识保留，不能假称正式素材。
2. POL-DESKTOP-004原零延迟快速SIGKILL第三次重启应到failed，但观察到running/restarts3。审查根因候选：start在restartTimer等待时直接spawn；spawnChild把timer引用清null，未取消旧timer，旧回调后来绕过failed保护。请先在真实Electron保留失败，修根因，并核查旧子进程延迟ready/exit等消息不能更新新进程状态；ready超时/停止/显式restart也要清理所属timer。不要添加“等1.2秒再kill”的延时来掩盖，也不要扩大允许重启次数。

仅允许app/renderer/index.html删除说明，app/desktop-host.cjs，tests/acceptance/desktop.spec.cjs必要新增场景/断言，以及evidence/s08a-native-shell日志。禁止main/其他renderer/services/版本/Git/文档。保持现有生产结构，直接控制timer与子进程归属，不引入新框架。

验收：原桌面10Case不弱化，新增或扩展004证明确切最多2次自动恢复；快速连续ready后kill达到上限、等待旧回调可能触发时段仍保持failed且无新pid；用户显式restart恢复且此前孤儿timer不再干扰；重复start/状态心跳不能跨过恢复等待和上限。必要等待用于观察“没有偷偷复活”，不能用在kill前避开触发条件。真实自建隔离进程与目录清理，禁止杀用户已有程序；检查并清理你之前自建desktop-repro残留，保留记录。完成后native3及相关desktop回归，Codex再独立复验。
