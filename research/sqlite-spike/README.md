# SQLite 存储与检索最小探针

独立技术研究，使用10条构造文本；不是 Bayper 的正式记忆实现。Claude Code 编写 store.py/probe.py，Codex 制定实验合同并独立审查运行。

只需 Python 3 标准库 sqlite3，运行时须支持 FTS5 与 trigram；本机实测 Python 3.13.3 / SQLite 3.49.2，无需安装依赖。

```sh
sqlite_spike_root=$(mktemp -d /tmp/bayper-sqlite-spike-XXXXXX)
python3 research/sqlite-spike/probe.py --work-dir "$sqlite_spike_root"
```

JSON 输出到 stdout，执行进度到 stderr；已有同名数据库时拒绝覆盖。正常运行，不使用会移除同目录导入路径的 `python3 -I`。检查后仅删除本次 `sqlite_spike_root`，不要删除其他工作目录。探针不自行删除 DB，以便独立读库。

store.py 保留原文与现行版本，FTS5 只索引现行字符 token，修订审计独立存放；事务同步修订与索引。probe.py 对照原文 unicode61/trigram、有限字符方案与人工 OR 展开，检查明确纠正、重开/rebuild及真实写入失败回滚。

结果：中文短词在字符对照中可检索，原文默认方案有漏召回；无自动同义理解；固定明确 ID 纠正后旧内容退出有效查询。字符 token 不是中文分词，人工展开不是模型语义能力，审计保留不是物理遗忘。未覆盖并发、崩溃、自动记忆冲突识别及生产兼容。

[固定合同](../../.hapilon/polaris/Bayper桌面陪伴/sqlite-spike-cases.md) · [验收结果与证据](../../.hapilon/polaris/Bayper桌面陪伴/sqlite-spike-results.md)
