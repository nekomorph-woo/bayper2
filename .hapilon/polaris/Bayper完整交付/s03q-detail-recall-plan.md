# S03q 普通细节的可用上下文与自然淡化

2026-10-28，Codex master受托批准首个最小切片；增量开发。父级S03/MEMORY-006，来源memory-and-sharing.md：重要偏好与共同经历长期保留，琐碎细节可降低提及频率；不增加用户照料负担或额外模型调用。本片不是整个记忆整理完成。

## 现状与源码依据

`app/memory.cjs buildContext`只有core/preferences/experiences，detail永远不进入上下文；searchMemories用于管理定位和操作候选，不得直接对它做淡忘过滤。`app/chat.cjs memoryText`已按sections遍历，但没有details中文标签。现有SQL角色/时效/来源/删除控制必须复用。

实际读取LangChain MIT源码commit `0c09d024e0cec14f24b430c5fa9232227f3206a4`，文件`libs/langchain/langchain_classic/retrievers/time_weighted_retriever.py`（SHA256 c660fd00208251e55baf2e28f2d11de65d279cbf85bf47a1da8ce0a12987761a）。`_get_combined_score`区分时间、重要性与相关性；`_get_rescored_docs`会刷新last_accessed_at。只借鉴分离时间权重，不引入依赖/向量库，不复制代码；Bayper不会因后台查询刷新年龄。重要记忆保护与事实有效性由本项目约束决定，不能依靠相关性分数恢复失效事实。

## Part A：本片行为和接口

1. `buildContext`增加details分段，最多3条，仅从本轮非空query的正式检索有效候选里选取；空query不主动灌入琐事。原core/preferences/experiences及总字符预算不变，details最后入预算。聊天中添加“相关细节”中文标签与来源边界。管理列表、searchMemories和纠正/删除候选不因年龄而隐藏。
2. 年龄仅用于details上下文排序：正式检索混合池最多50条，筛出detail最多20条，保留细节之间的原检索相对顺序并在该列表内编号rank；score为`(1/(rank+1)) * retention`。普通detail retention=`max(0.1, 2^(-ageDays/30))`，ageDays来自max(0, now-updatedAt)。importance>=80的detail retention=1；identity/preference/experience完全不使用本策略。30天半衰期/0.1下限/80门槛/3条上限集中在小配置中，提供禁用衰减的基线选项；不把这些内部参数加入设置页。
3. 不物理删除、不改原importance、不写last_accessed，不新增定时器/API/迁移。读取和失败重试不更新条目日期；真实纠正沿原updatedAt生效。单条高度相关的旧细节仍可被明确问题召回；降低相对提及机会而非伪造已遗忘/从没说过。
4. 角色隔离、来源失效、删除防回流、temporary语义与总上下文预算在排序前后均保持；不把theme故事或助手表达写成用户事实。
5. 明确要求永久记住的自然语言接线、自动整理/归纳及真实模型体验为父级后续必做，本片importance>=80保护只证明已标重要条目，不能冒称已识别所有“请记住”。技术参数是master初始默认，需用对照验证收益，不向用户转嫁调参。

## Part B：Case与执行

| ID/v1 | Given / When | Expected / 独立Oracle |
| --- | --- | --- |
| POL-DETAIL-001 | 用公开remember保存本角色相关detail与无关detail；实际chat提出相关问题 | 构造HTTP捕获真实请求包含相关细节、正确来源/中文标签，无关条目不灌入；不需要额外请求；不是只测纯排序函数 |
| POL-DETAIL-002 | 同相关性至少4条普通细节，固定不同年龄；buildContext并与禁衰减基线对照 | 旧detail相对降位，fresh更易进入3条预算；采用人为标注的顺序/入选断言，不用生产公式算Expected；全部仍在管理检索中 |
| POL-DETAIL-003 | 远期重要detail与长期偏好/共同经历，时间推进/回拨 | 重要类不被时间降权，回拨不使权重超过1；无物理删除，无updatedAt/版本写入；真正同等相关旧detail在无竞争时仍能召回 |
| POL-DETAIL-004 | A/B独属、分享派生、纠正/删除、来源失效/temporary到期 | 实际buildContext和chat请求均不能出现非法旧正文；年龄策略不得绕过现有硬门禁，来源撤销按现行保留规则区分，不错误清除合法长期记忆 |
| POL-DETAIL-005 | 小字符预算、重开SQLite、重复构造上下文 | 总预算保持、核心段优先，结果稳定；读取不复活/不刷新日期，不新增后台请求；保存不受影响 |

真实SQLite和正式memory/chat服务；本地HTTP仅替代模型，构造角色/来源与固定时钟，隔离临时目录并清理。Runner位于tests/acceptance/，复用既有fixtures，不建测试平台。Evidence包含唯一attempt、命令、exit、源码SHA、逐Case及请求次数、对照结果。基线须先证明detail缺失，修后跑新场景与受影响memory/chat上下文、纠正删除回归；master独立复验，真实模型最终另验。

## 实施范围与规模

允许：app/memory.cjs、app/chat.cjs，必要一个小app/memory-retention.cjs（配置/纯选择职责约80行内），tests/acceptance/memory-detail-context.spec.cjs；受影响既有测试只修新增sections结构的正确预期，先报告。生产合计约100～180行，Runner约250～400行作为审查信号，不压行。首片不改SQL schema/CLI工具/GUI/其他业务，不大规模重构memory.cjs。

Claude先核对search结果混合类别截断是否会饿死details，必要在现有候选上有界筛选并报告；不得为凑3条绕过正式检索或角色过滤。若任何接口/核心事实与方案冲突，先反馈，不能自行扩张。无Codex子代理/Claude子代理；Git与文档最终接受由Codex负责。

## 首版审查后的受托细化

开发者真实25条经历＋4细节探针表明原混合limit20中detail=0；master接受同一正式检索有界池50，筛detail最多20，不改变经历原20条行为，也不声称覆盖50条以外的任意规模。需将混合类别场景并入Runner。POL-DETAIL-004必须包含有效期内权威来源正文变异导致temporary失效，不以到期替代。旧chat固定措辞断言已经HEAD隔离复现失效，允许仅调整为现行experience主体/参与者约束，保持业务Expected。相关细节prompt不得一概否定重要性。证据目录统一本工作evidence/s03q-detail-recall，原始日志不可重写。
