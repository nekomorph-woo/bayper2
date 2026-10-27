# 删除目标澄清：独立工具审查与真实调用

2026-10-28，Codex master 受托审查，非用户亲自体验。正式 Contract 为 POL-LIVE-CLARIFY-001，工具场景 C12。生产实现基线 0eb6d8a；验证时 HEAD 819fcc4 / 0.1.203 仅增加困倦素材与版本元数据，未改变生产记忆实现。

## 实现与审查

Claude Code 0864dbf0-0a77-4eba-969f-14cfa697c746 承担工具实现。初版 probe 净增359超过原约定且未提前报告，master 明确 SIGINT 停止并退回，原件保留于 `evidence/s03o-live-clarification/attempt-20261028-002148-review-reject-size/`。返修句柄20459已终态；最终 probe 净增280、数据46、README20，合计346。仅扩展现有工具，没有修改生产代码或建立新 Runner 框架。

首轮与回答请求分开绑定；快照、请求保留原件，摘要使用索引。移除生产澄清函数作为 Oracle，显式 null 与字段缺失/解析失败分开判断。独立身份 B 必须实际调用一次关系判定；命令和回答来源都检查排除及 proof 绑定。最后一轮修正直删路径被首轮零写断言误报的问题。改前基线、失败与修订批次均保留，不把退出码当业务结论。

## 独立结果

| 范围 | 状态 | 实际证据与边界 |
|---|---|---|
| 工具离线链 | PASS | `evidence/master-live-clarify-dry-P9yJVKWd/`：C12 L1/L2、全12 L1/L2四命令exit0；全部DRY-RUN。C12首回合memory表无变化，回答无聊天调用，关系一次，A/B删除，C无新增。所有临时库和fixture关闭。仅构造模型 |
| 旧场景与边界 | PASS | master核对C01～C11数据与0eb6d8a完全一致；开发旧11归一化对照差异0，master全量复跑。非法ID与覆盖已有输出exit1，原结果SHA不变、无非法结果文件；源SHA前后相同 |
| POL-LIVE-CLARIFY-001 / L1 | PASS | `evidence/master-live-clarify-api-uW0vc5cA/l1.json`：构造聊天明确null，真实DeepSeek关系判定equivalent；本地提问→“加糖那条”→两阶段删除，原位assistant更新；两个source排除与proof检查通过。1次models、1次真实relation，聊天4次fixture；exit0 |
| POL-LIVE-CLARIFY-001 / L2两轮 | NOT_COVERED | 同目录l2.json：真实聊天首轮返回forget/M1/all，直接执行；无第二轮输入，不强造null。1次models、4次真实chat、1次真实relation；工具exit1对应NOT_COVERED，不是环境异常 |
| L2直删观测 | INCONCLUSIVE（不替代两轮Contract） | master检查真实种子A“我平时喝咖啡一定要加糖”、B“我的咖啡都要甜的”；关系raw/effective equivalent，最终memory_entries为空，核验completed。工具保留首响应中的pending文字，最终assistant另见firstTurn.assistant.after及DB快照，不把首响应当最终显示。此路径未按独立完整Contract验收 |

两次live的models清单都确认 `deepseek-flash`，实际请求一致；调用现有用户授权配置，没有输出凭据。每模式仅一次，不重试到指定路径。真实批次源码SHA前后一致，两临时库均关闭并删除，cleanup.ok=true。

## 接受决定与剩余工作

受托接受工具切片及L1真实关系参与的两轮能力；L2全真实两轮仍未覆盖。自然语义泛化、其他纠正/删除场景、GUI、人类体验与完整S03均未据此通过。C02/C03/C07原Expected与历史失败不变。后续回到S03父切片，根据具体缺口选择下一项，不用反复重跑C12赌模型返回null。

Polaris复查：本轮暴露的是规模报告、独立Oracle和状态判定的执行偏差，现行skill已有相应要求；没有新发现必须修改skill才能执行的矛盾，故不为形式新增归档或修订。完整Goal仍包含S01～S08、正式素材与最终交付。
