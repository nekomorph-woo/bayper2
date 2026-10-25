# 记忆实现的源码依据与调优约束

2026-10-25，Codex只读审查；接续既有memory-research.md、memory-products-notes.md与memory-and-sharing.md。用户要求停止完整记忆产品测试仍有效，本轮只克隆源码阅读，不安装、不运行其服务，不据源码宣称效果通过。

## 锁定来源

| 来源与许可 | 实际阅读文件/函数 | 借鉴与边界 |
| --- | --- | --- |
| [Mem0](https://github.com/mem0ai/mem0/tree/2c81af3bbe27d9bccb09c772d583df9e9be72ee5)，Apache-2.0 | `mem0/memory/main.py`：search、_search_vector_store、_delete_memory；`mem0/memory/storage.py`：SQLiteManager历史和消息保存 | 搜索先要求身份过滤；参数含top_k、threshold、rerank与explain。此版候选来自语义检索，关键词仅增加候选评分，不能简单称“关键词结果与向量结果并集”。Bayper无embedding前不抄其向量流程。 |
| 同上 | `_delete_memory`与`add_history` | 删除向量记录后仍把prev_value写入history.old_memory；此处是审计设计，不符合Bayper删除正文的约束。Bayper只保留无正文的最小防回流控制，不把被删文字换个表保留。 |
| [Graphiti](https://github.com/getzep/graphiti/tree/5c27edfa8d3e0f49b2571bcebb4261bcc89ee037)，Apache-2.0 | `graphiti_core/search/search_config.py`、search.py、search_utils.py的rrf、search_filters.py | 召回方法与排序策略分离，配置有limit/阈值；RRF按各路排名融合，不要求不同路分数同尺度。可借鉴小配置与解释结果，不引入图数据库、Pydantic或完整策略框架。 |
| 同上 | `utils/maintenance/edge_operations.py`：_apply_temporal_invalidation、resolve_edge_contradictions | 区分事实有效时间和记录过期时间，并按时序处理冲突。Bayper需要当前偏好失效与真实过去经历可并存；删除则不能只标expired并保留可用正文。 |

源码commit来自本次实际git rev-parse，许可文件已读。仅记录机制，不复制实现；将来确需代码摘用须保留许可与归属。临时克隆目录不作为产品依赖，正式记录保留可复查commit链接。

## S03拟定方案：先满足约束，再调检索

SQLite为唯一事实来源，FTS5为可重建索引。以稳定角色ID确定持有范围；来源与派生关系显式记录。先过滤角色、有效版本、来源权限和删除控制，再排序，最后组装上下文与提交模型结果时再检查版本。相关性分数不能恢复失效记忆。

将角色固定设定、少量重要偏好与按需经历分开取用；核心身份不依赖搜索偶然命中。模型提炼与回答尽量合并一次既有交互调用，结果必须有来源、类别与置信性质，不能把自己的回复当作用户事实。选中记忆的纠正/删除本地立即生效；自然语言无法定位时只澄清，不猜着清空。

先比较三种轻量检索候选：中文字符基线；Intl.Segmenter中文分词加短字符兜底；保留原查询并加少量可解释同义概念的候选。不能用丢掉否定词的同义替换决定偏好真假。没有embedding服务时不虚称语义检索已实现；是否增加额外查询改写调用需以收益与预算决定。

## 小调优工具与验收安排

由Claude实现`tools/memory-tuning/`，入口、构造数据、参数候选、结果及说明自包含；直接调用正式记忆业务入口，不另写一套“容易通过”的检索模拟器。生产参数集中为小配置，保留默认策略和回退。

同一批构造集包括中文1～2字、长句、同义无共同字、中英项目名、否定/临时偏好、相近但无关事实、A/B独属、纠正与共享派生、删除后重导入、明确重新许可。另留一组未参与调参的样例作复查，不能凭固定答案硬编码。

每次记录策略版本、参数、Recall@k、误召回、删除/隔离违规数、实际本地延迟、模型次数和失败样例。违规数必须为0；召回提高不能抵消泄漏或旧记忆复活。先有基线，再选一项改进复验；收益不足就保留简单方案。事实语义、真实聊天效果和本地检索分别记录，离线样例全绿不等于真实模型永远可靠。

本文件是S03实施前依据，尚无正式记忆实现或对照结果。正式Case与技术计划将在派发前补齐，不把源码研究当交付验收。
