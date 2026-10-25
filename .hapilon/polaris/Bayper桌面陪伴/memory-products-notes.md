# 记忆产品参考与停止测试记录

2026-10-25。用户提出比较记忆产品的效果、技术栈与集成易用性；随后明确要求停止测试，倾向吸收经验、独立研究和轻量本地实现。当前不继续安装或运行 Letta、Mem0、Graphiti，不将引入它们作为既定方向。用户并未禁止未来一切第三方组件；后续若重新考虑完整产品，应另有实际需求依据。

## 已有资料与可借鉴经验

- **记忆与存储分开**：SQLite 可负责本地持久化；来源筛选、偏好提炼、时间变化、纠正与遗忘仍需产品和记忆方案决定。前一轮 [SQLite 实测](sqlite-spike-results.md)只验证固定样本的存储行为。
- **核心身份与大量经历分层**：Letta 的概念资料区分常驻身份/偏好与按需检索的历史；其当前 [Agent SDK Memory](https://docs.letta.com/agent-sdk/memory)采用 MemFS 与背景整理的方向。可借鉴分层和整理思路，不引入整个 Agent runtime。
- **多种检索信号可组合**：Mem0 的[迁移说明](https://docs.mem0.ai/migration/oss-v2-to-v3)介绍 ADD-only 提炼及混合检索，OSS 与托管平台能力存在区别。追加保留历史并不自动意味着纠正失败，也不自动保证旧事实失效，仍须按我们自己的要求验证。
- **事实随时间变化**：[Graphiti](https://github.com/getzep/graphiti)将经历、关系和事实有效时间纳入表示；可借鉴时间与失效的概念，当前不引入图后端。

这些是参考原则，不是已确认的 Bayper 记忆规则。框架同样不能替我们决定角色成长、授权、重要经历保留或 Herdr 必需通知。

## 技术栈与集成方面的已查事实

公开资料显示 Mem0 有 Python/TypeScript OSS 接口并可配置 LLM、embedding 与向量存储；Graphiti 是 Python 库并依赖图后端和模型能力；Letta 当前推荐 TypeScript Agent SDK 与 App Server，旧 Python/Docker 资料不能直接代表当前路线。来源：[Mem0 配置](https://github.com/mem0ai/mem0/blob/main/docs/open-source/configuration.mdx)、[Graphiti 项目声明](https://github.com/getzep/graphiti/blob/main/pyproject.toml)、[Letta SDK](https://docs.letta.com/agent-sdk/quickstart)。

依赖声明和 API 存在只能说明接入前提，不证明容易使用、资源占用高低或效果优劣。此轮未完成真实集成，不给出产品质量或性能排名。

## 停止时的实际状态与清理

- SQLite 阶段已完成并以 b7230c1 保存，版本0.1.27；技术合同、代码、结果与必要本地证据保留。
- 第三方阶段只读公开资料、查询 npm metadata，并在专用临时 venv 发起两个 pip dry-run；没有安装候选包、启动其服务、注册账号或调用模型。
- 用户要求停止时，Mem0 dry-run 被终止、未生成完整报告；Graphiti 的纯 binary 依赖解析已结束，报告含27个依赖条目。这不是 Graphiti 运行成功，更不是记忆效果实测。
- 两条解析进程已结束，专用临时根 `/tmp/bayper-memory-products-96mjvv`（含 venv 与缓存）已删除；没有更改全局 Node/Python 配置。npm 查询只保留 metadata，没有安装 Letta。
- 原始材料在本地 `evidence/2026-10-25-memory-products/`，其中 stop-and-cleanup.json 记录边界与清理。没有依据宣称这些产品实际资源占用很大。

## 接续方向

回到 Bayper 记忆方案本身：研究直接互动和获准来源怎样形成初步了解，如何沉淀重要偏好与共同经历、及时纠正且避免旧推测复活，如何自然淡忘琐碎细节，以及三层性格怎样随相处成长。SQLite 继续作为轻量本地存储候选，FTS5/BM25 是已验证边界的一种检索组成部分；两者均不使完整记忆方案定案。
