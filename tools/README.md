# 项目专用工具

本目录只放 Bayper 项目专用脚本和工具，按用途建立小目录。业务数据、文档、图片不混放在脚本旁边；工具使用明确路径关联资料。代码实现仍由 Claude Code 完成，Codex 负责规格与审查。

## 造型元数据库

- 入口：`appearance-catalog/build.py`，Python 3 标准库，无需安装依赖。
- 默认命令：在项目根目录运行 `python3 tools/appearance-catalog/build.py`。
- 可从其他工作目录使用绝对脚本路径运行；`--output <路径>` 可生成独立核对副本。
- 输入与默认输出：`.hapilon/polaris/Bayper桌面陪伴/appearance-catalog/` 中7个 CSV 与 `catalog.sqlite`。
- [字段、来源与数据状态](../.hapilon/polaris/Bayper桌面陪伴/appearance-catalog/README.md)。修改先改 CSV，再构建快照，不直接维护两份不一致内容。
- 工具会替换指定输出文件，输出路径应是本库或本次核对的独立 SQLite 路径，不要指定其他文件。

这里只是设计资料导入，不是 Bayper 正式存储层、可视化捏人编辑器或记忆引擎。
