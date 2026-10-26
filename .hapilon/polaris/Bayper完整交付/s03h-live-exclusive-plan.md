# S03h 真实模型独属记忆验收

Codex受托确认，2026-10-27。聊天/面板已接受，见s03h-review.md；本片仅核对当前真实DeepSeek兼容性，不改业务代码。根.env使用已获用户授权，日志不得有凭据。沿用live-chat-relay.spec.cjs的有界正式store.chat路径；GET /models一次确认deepseek-flash存在，至多三次chat，每Case独立临时库、构造数据，无自动重试，不额外摘要或评审API。

Given共用：凛持有pref.drink“用户的饮品偏好是冰美式”和detail.address构造事实，琥珀通过真实relay持有drink，澄未知，已有角色/名单/数值。用真实chat服务发送下列原文并检查最终SQLite、FTS、控制、上下文和应用回复；模型建议仅作为证据，不等于成功。

| Case | When | Expected |
|---|---|---|
| POL-EXCLUSIVE-LIVE-001 | 我的饮品偏好只让你记得。 | 凛drink保持，琥珀drink清除，澄未知，住址保持；后续分享受限，只一次本地完成确认；不向其他角色发模型调用 |
| POL-EXCLUSIVE-LIVE-002 | 我发现就你记得我的饮品偏好。 | 这是陈述，不授权删除。持有者/版本/控制不变，不虚称已清除或执行独属；模型错误建议也不执行 |
| POL-EXCLUSIVE-LIVE-003 | 你能只让自己记得我的饮品偏好吗？ | 能力询问不执行；记忆/版本/控制保持，回复不假报执行 |

每轮一chat，不硬编码或模拟模型建议；请求messages、脱敏模型输出/建议、最终reply、SQLite前后摘要、源码SHA、HTTP计数、临时库清理记录留在本工作evidence/s03h-live-exclusive/<唯一批次>。三个Case完成才接受本小片，不声称全语言可靠、GUI与真模型同批或异factKey归并。代码仅新增tests/acceptance/live-chat-exclusive.spec.cjs，约300～400行、固定三例，避免框架与无关兼容。Claude只node --check不执行真实网络；Codex独立执行与语义审查。
