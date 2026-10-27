# 本地记忆检索对照工具

S03a 自包含调优工具。它直接调用正式记忆业务入口 `app/memory.cjs`，使用真实 SQLite 与
`dataset.cjs` 中的虚构构造数据，比较本地召回策略。工具不调用模型、不打开 GUI，
也不另写一套“容易通过”的检索模拟器。

## 运行

在仓库根目录：

```bash
node tools/memory-tuning/run.cjs
node tools/memory-tuning/run.cjs --out /tmp/memory-tuning.json
```

默认结果写入 `tools/memory-tuning/results/latest.json`。临时数据库位于系统临时目录，
运行结束即删除；输出中只包含构造数据。`generatedAt` 是实际执行时间，`scenarioTime`
是构造数据使用的固定时钟，两者分开记录。

## 文件

- `run.cjs`：建立真实 SQLite 连接、构造数据、逐查询计时并汇总指标。
- `dataset.cjs`：构造记忆、删除/纠正/分享等前置操作，以及人工 Expected 与分组。
- `results/latest.json`：最近一次运行的完整逐条结果；可重建。
- `results/review-repro-before-fix.txt`：r1 审查缺陷修复前的失败复现日志。
- `results/review-r2-repro-before-fix.txt`：r2 业务复核修复前的失败复现日志。
- 本说明。

## 策略

| 策略 | 索引/查询方式 | 说明 |
| --- | --- | --- |
| `char` | 中文字符 + 英文/数字词 | 字符基线，用于对照 |
| `segment` | `Intl.Segmenter("zh-CN")` 分词 + 单字索引 | 严格分词基线 |
| `expanded` | `segment` + 小型概念词表 | 严格匹配 + 概念 OR 组 |
| `hybrid` | 严格 `segment` → 严格 `expanded` → 自然提问 `broad` | 当前候选默认，最终由 Codex 决定 |

`broad` 是 `hybrid` 内部的宽召回机制：只有严格检索无结果、且查询带自然提问标记时
才启用。它按命中概念组数量排序。查询里的“不/没/无”等否定词不再作为硬过滤；
正反候选都保留正文与来源，交给后续事实理解，检索分数不声明事实真值。角色隔离、
过期和已删除内容仍由 SQL 与删除控制硬过滤。

`app/memory-retrieval.cjs` 中的概念表只有十二组常见中文表达（如“摄影/拍照/相机”、
“放松/散心”、“我们/一起”）。这不是 embedding，也不是通用语义检索；未收录的
同义表达会漏召回。

## 数据集

- 38 条构造记忆、3 条删除控制记录、46 个查询：29 个 tune、11 个开发留出组、
  4 个 Codex 指定场景、2 个 r2 反问/否定场景。
- 覆盖中文 1～2 字、长句、同义无共同字、中英项目名、否定、临时偏好、相近无关事实、
  A/B 角色独属、纠正与共享派生、删除后重导入、明确重新许可。
- 纠正后派生持有者保留更新后的正文和来源；原分享来源记录在派生关系中，便于追溯。
- `Expected` 是人工标注，只用于事后评分；不会传给检索服务，检索服务也不读取
  `dataset.cjs`，因此不存在按查询返回固定答案的路径。
- `forbidden` 只标记角色隔离、过期或已删除内容；这些是硬门禁。相反措辞或相关但非
  目标记忆只计入“相关性误命中”，不再算门禁违规。
- 现有 `holdout` 由实现者同时设计，应视为**开发留出组**，不是盲测。
  `下雨天`、`单车`、`相机` 在概念表覆盖范围内，`影片` 未覆盖；通过率不能证明
  任意自然语言同义能力。

### Codex 指定与 r2 场景

| 查询 | 目标/候选 | 干扰与门禁 |
| --- | --- | --- |
| 还记得我平时喝什么咖啡吗 | 用户平时喝不加糖咖啡 | 糖果、咖啡机维修 |
| 我想骑车放松通常去哪里 | 用户喜欢骑自行车沿河散心 | 河流地图 |
| 我们上次在海边看到了什么 | 用户和角色一起在海边看过日落 | 日落壁纸、既有海边日出记忆 |
| 你还记得蓝鲸吗（角色 A 查询） | 无 | 角色 B 的私密暗号 |
| 我是不是不喜欢咖啡 | 喜欢咖啡与不喜欢咖啡两条都可作候选 | 已删除咖啡不返回 |
| 有什么不含糖的饮料 | 无糖茶类饮料与含糖饮料两条都可作候选 | 过期饮料、角色 B 的私密饮料不返回 |

这些场景用于开发复核，也不是 Codex 的独立盲测数据。

## 最近一次结果（构造数据）

| 策略 | 全量 Recall | tune | 开发留出 | Codex | r2 | 相关性误命中 | 隐私/时效门禁 | 平均延迟 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `char` | 0.691 | 1.000 | 0.250 | 0.000 | 0.000 | 3 | 0 | ≈0.09 ms |
| `segment` | 0.738 | 1.000 | 0.375 | 0.333 | 0.000 | 3 | 0 | ≈0.06 ms |
| `expanded` | 0.833 | 1.000 | 0.875 | 0.333 | 0.000 | 3 | 0 | ≈0.08 ms |
| `hybrid` | 0.976 | 1.000 | 0.875 | 1.000 | 1.000 | 11 | 0 | ≈0.10 ms |

Codex 场景 top1：`char` 0/3、`segment` 1/3、`expanded` 1/3、`hybrid` 3/3。
`hybrid` 的 r2 两个查询都保留了正反候选，Recall 为 1.000，隐私/时效门禁为 0；
相关性误命中为 6（其他咖啡/糖类记忆），不再被算作违规。

实际数字与延迟以重新运行后的 `results/latest.json` 为准。当前开发留出漏召回包括：

- `char`：下雨天、单车（两条自行车记忆）、相机、北方的雪、影片；
- `segment`：下雨天、单车（两条自行车记忆）、相机、影片；
- `expanded` / `hybrid`：影片（概念表未收录“电影/影片”）。

所有策略均未出现角色隔离、过期、删除或派生回流门禁违规。`hybrid` 仍是候选默认，
正式默认由 Codex 结合独立场景、真实聊天数据与维护成本决定。

## 指标口径

- `Recall = 命中的人工 Expected 数 / 全部 Expected 数`；无 Expected 的查询不进入分母。
- `top1` 只统计有人工 Expected 的查询。
- `相关性误命中`：返回结果中不属于该查询 Expected 的条目数；不视为隐私或有效性违规。
- `隐私/时效门禁`：返回其他角色条目、过期条目或 forbidden 的已删除条目；必须为 0，
  不能被召回收益抵消。
- 延迟是本地 `searchMemories` 调用的实测墙钟时间，不含 SQLite 首次打开与数据构造。

## 边界

- 上述本地检索对照不使用 embedding、向量库、外部检索服务或模型请求；下面的独立语义 probe 会显式调用已配置模型。
- 本地检索对照不实现自然语言语义定位；明确管理由业务层提供 `factKey` 或条目 ID，传播范围按正式记忆服务的事实身份判断。
- 不自动判断否定或事实真值；否定词保留在候选正文与来源中，交后续理解。
- 派生持有者可以发起纠正和默认删除；自动二次分享仍拒绝，用户明确转告留给 S03b。
- 不验证真实模型提炼、真实聊天取消、桌面 UI 或权限目录。
- 工具全部通过也不等于 S03a 整体验收通过，最终结果由 Codex 独立运行和审查。

## 语义关联真实服务基线（S03l 首步）

`semantic-baseline.cjs` 使用正式 `createMemoryService` 和真实 SQLite，逐个独立执行
SEM-001～SEM-008，观察各角色最终条目、FTS、版本、重启和控制表摘要，并捕获禁分享
场景的真实 `relay` 拒绝或成功。它不调用模型、不修改产品实现、不 mock 记忆操作；
`Expected` 只用于事后评分。实际不符合规格记为 `FAIL`，执行异常单独记为 `ERROR`。
输出包含 Git HEAD、生产服务与 Runner 源文件的 SHA-256、每场景实际临时路径及清理校验；
清理失败记为 `ERROR`，未知异常不会被当作业务拒绝。

```bash
node tools/memory-tuning/semantic-baseline.cjs
node tools/memory-tuning/semantic-baseline.cjs --out /tmp/semantic-baseline.json
```

默认写入 `tools/memory-tuning/results/semantic-baseline-latest.json`，不覆盖检索基线
`results/latest.json`。临时数据库位于系统临时目录，每个场景结束后删除并记录清理结果。

Codex 独立基线（生产版本0.1.168）：`results/semantic-baseline-codex-r2.json`及同名`.log`，
8个场景为1 PASS、7 FAIL、0 ERROR；表示发现了当前产品缺口，不是修复通过。
源文件内容摘要与每场景临时路径/清理结果在报告内，旧轮结果不覆盖；技术决策由项目Polaris记录承接。

## 真实语义关系 probe

`semantic-probe.cjs` 只对 `semantic-pairs.json` 的16组构造事实做关系判定，不修改产品记忆，不读取真实会话。Expected留在本地评分，模型只见事实和允许的元数据。它与上面的正式服务SEM基线是两个不同观察层：关系分类正确不等于纠正/删除链路已经接通。

```sh
node tools/memory-tuning/semantic-probe.cjs --dry-run
node tools/memory-tuning/semantic-probe.cjs --out tools/memory-tuning/results/semantic-probe-local-001.json
```

实际模式使用根 `.env` 的 `OPEN_AI_BASE_URL` / `OPEN_AI_API_KEY`，只在执行时读取；先通过一次 `/models` 验证 `deepseek-flash` 存在，再最多一次 chat，无自动重试。禁止把Key作为命令参数或写进结果。必须显式指定输出文件，已有文件不会覆盖；dry-run不读取凭据、不联网。没有embedding或额外服务依赖。

结果包含实际调用次数、延迟、严格响应结构检查、逐项关系、错误合并/漏关联/不确定统计及源文件摘要。ERROR表示配置、网络或结构未形成有效判定，FAIL表示实际关系违背Expected；不能只看退出码。策略提示位于脚本的SYSTEM_PROMPT，修改策略时同步策略版本，并用同一数据与新的独立结果文件对照。少量固定样本不代表生产可靠性，接入预算、隔离、取消与事务需另行验证。

2026-10-27 独立真实对照：策略v1与v2各15/16符合Expected，均0错误合并、0同义正例遗漏；v1错把未知参与者的共同经历判为不同，v2修正为不确定，但把“喜欢牛奶/乳糖不耐受”保守判为不确定。保留两轮FAIL，v2仅作为后续候选，尚未接入产品。证据为`results/semantic-probe-codex-live-r2.json`、`results/semantic-probe-codex-live-v2.json`；两轮总计2次models+2次chat，各批约1秒，不代表稳定延迟或生产效果。
