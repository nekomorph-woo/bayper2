# Bayper

项目已完成本地 Git 初始化与协作流程验证，准备开始正式开发。当前尚未确定业务功能、技术栈或运行方式，验证用的示例代码与测试已清理。

## 协作入口

- [AGENTS.md](AGENTS.md)：项目协作规范。Codex 负责需求分析、任务拆解、调度、决策与独立验收，所有项目代码及测试代码由 Claude Code CLI 实现。
- [CLAUDE.md](CLAUDE.md)：Claude Code 的开发者入口，要求任务开始前读取 AGENTS.md，并按开发者职责执行任务。
- [.agents/skills/polaris](.agents/skills/polaris)：北极星 polaris skill 的项目级软链，用于业务设计、场景验收和交付。Codex 按项目授权担任 master。
- [VERSION](VERSION)：项目版本的唯一来源；每次非纯版本号的 snap 提交使 PATCH 加 1，MAJOR 与 MINOR 升级须由用户明确指定。

polaris 软链指向同级仓库中的 `../hapilon/.hapilon/agents/skills/polaris`。在其他机器使用时，应保证该目录存在，或将软链重新指向实际的 skill 目录。

## 开始开发

提供业务目标与约束后，由 Codex 使用 polaris 形成任务范围、业务预期与验收标准，派发给 Claude Code 实现，再独立审查并运行验收。根据实际需求选择技术栈、组织代码及测试目录，并补充安装和运行说明。

本地分支为 `main`，尚未配置远程仓库。所有提交使用 snap 技能；提交不自动触发推送、发布或合并。
