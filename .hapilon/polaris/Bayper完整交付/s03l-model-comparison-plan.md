# S03l-b 同协议模型对照

2026-10-27，Codex受托确认。前轮结构化协议的holdout12仍错误合并。独立读取当前用户授权服务/models，实际返回deepseek-flash、deepseek-v4-pro。不能假设后者更准确，冻结现有生产协议、两数据集和Expected，以真实调用对比。此次不是修改用户全局配置或更换产品默认模型。

源代码检查同时发现：app/chat.cjs的parse候选流程实际保存用户evidence原文，而非模型生成body；sourceId=chat:<userMessageId>可关联chat_messages用户原始发言。后续生产核验可复用此来源，不必先复制敏感正文另建表。跨角色原始发言不能进入角色回答上下文；来源撤销/删除控制仍须检查。

## 最小实施与合同

Claude仅修改tools/memory-tuning/semantic-probe.cjs，增加--model <id>，默认deepseek-flash兼容，模型名非空/有长度上限/拒绝空白及重复参数。live先实际/models验证指定id，再最多1chat；所有模型存在性、请求与结果记录使用该id，不能仅改报告名。dry记录计划模型且不读env/不发网络；不改协议/提示/数据/Expected/其他生产代码。不建框架、不新增依赖，预计20行内增量，不压缩语句。

POL-MODEL-COMP-001：Given被冻结grounded协议及baseline/holdout各16对；WhenCodex指定实际已发现deepseek-v4-pro，每批1models+1chat；Expected同原逐项Contract，尤其holdout12必须uncertain而不能equivalent；Oracle原Expected、raw/effective、source SHA、延迟/调用数；Boundary真实服务+构造数据，无产品库/GUI/自动关联。错误仍FAIL/ERROR，不据模型名称宣称通过。

本轮已使用1次只读/models发现，允许后续对照最多2models+2chat，不重试。Claude只能syntax/dry，不能真实请求/Git/版本/文档。Codex审查默认输入兼容、指定model实际透传后独立执行，依据结果决定生产是否可选用；不为通过测试改变现有用户配置。
