# 项目专用工具

本目录组织 Bayper 项目专用能力。每项工具在 `tools/<能力名>/` 内聚合入口、数据、参考素材与使用说明，按需要分层，并向外提供明确命令或可读取产物；不依赖某个 PRD 工作目录才能运行。代码实现仍由 Claude Code 完成，Codex 负责规格与审查。

## 造型元数据库

- 入口：`appearance-catalog/build.py`，Python 3 标准库，无需安装依赖。
- 默认命令：在项目根目录运行 `python3 tools/appearance-catalog/build.py`。
- 可从其他工作目录使用绝对脚本路径运行；`--output <路径>` 可生成独立核对副本。
- 输入：`appearance-catalog/data/` 中8个 CSV；默认输出：同目录的 `catalog.sqlite`；参考图在 `appearance-catalog/references/`。
- 对外能力：重建/校验快照，以及读取 SQLite 造型资料。完整工具目录可复制后独立使用，不再从 `.hapilon/` 读取输入。
- [字段、来源与数据状态](appearance-catalog/README.md)。修改先改 CSV，再构建快照，不直接维护两份不一致内容。
- 工具会替换指定输出文件，输出路径应是本库或本次核对的独立 SQLite 路径，不要指定其他文件。

这里只是设计资料导入，不是 Bayper 正式存储层、可视化捏人编辑器或记忆引擎。
