# S03f 真实服务 R2：六场机器结果

- 批次：`.hapilon/polaris/Bayper完整交付/evidence/s03f-live-chat-memory/claude-20261027-live-r2`
- 上一批失败保留：`.../claude-20261027-live-r1`
- 调用：GET /models 1/1；chat 6/6；无自动重试。
- 模型：`deepseek-flash` 由 /models 返回。
- 机器结论：`MACHINE_PASS`。语义自然度：`PENDING_CODEX`。
- 清理：5 个 fixture 均 dispose/close/tempDirRemoved=true，cleanup errors 为空。

| 场景 | 机器 | 安全操作建议（白名单） | 关键 DB/上下文结果 |
| --- | --- | --- | --- |
| LIVE-1 “我喜欢咖啡，不是茶，请纠正一下。” | PASS | correct / M1 / evidence “请纠正一下” / excerpt “我喜欢咖啡，不是茶” | 偏好正文 `我喜欢咖啡，不是茶`；旧正向茶消失；猫事实保留 |
| LIVE-2 “我不是喜欢茶，而是喜欢咖啡。” | PASS | correct / M1 / evidence 完整原句 / excerpt “喜欢咖啡” | 偏好正文 `我不是喜欢茶，而是喜欢咖啡`；猫事实保留 |
| LIVE-3 “能帮我忘记之前说的住址吗？” | PASS | forget / M1 | 住址删除；工作事实保留；forget control 1 |
| LIVE-4 同 conversation “我住在哪里？” | PASS | 未提出操作 | 实际 messages 无旧住址；回复“想不起来了…愿意告诉我的话”，未猜 |
| LIVE-5 “我喜欢热茶这件事不要再告诉其他角色了。” | PASS | restrictSharing / M1 / evidence 完整原句 | share control 1；热茶内容保留；后续 relay 被 SHARE_BLOCKED |
| LIVE-6 “我忘了带钥匙，能帮我想想怎么办吗？” | PASS | 未提出操作 | 钥匙事实保留；无 forget control；回复自然帮助想办法 |

本轮只读取/保存安全 messages、最终回复、结构化 operation 白名单字段、DB 快照、源 SHA；未保存 Key、Authorization、原始响应或 reasoning。

生产源固定后运行本批；源摘要见 `source.sha256`。本地构造对照与 41 回归见 `evidence/s03f-chat-memory/claude-20261027-s03f-r3/`。
