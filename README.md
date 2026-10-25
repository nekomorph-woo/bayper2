# Bayper

项目已完成本地 Git 初始化、协作流程验证和多项基础技术预研，当前进入 PRD 讨论。产品范围与正式工程方案尚未冻结，研究探针与正式实现分开管理。

## 协作入口

- [AGENTS.md](AGENTS.md)：项目协作规范。Codex 负责需求分析、任务拆解、调度、决策与独立验收，所有项目代码及测试代码由 Claude Code CLI 实现。
- [CLAUDE.md](CLAUDE.md)：Claude Code 的开发者入口，要求任务开始前读取 AGENTS.md，并按开发者职责执行任务。
- [.agents/skills/polaris](.agents/skills/polaris)：北极星 polaris skill 的项目内独立副本，用于业务设计、场景验收和交付。Codex 按项目授权担任 master。
- [VERSION](VERSION)：项目版本的唯一来源；每次非纯版本号的 snap 提交使 PATCH 加 1，MAJOR 与 MINOR 升级须由用户明确指定。

polaris 已从原 hapilon skill 目录完整复制到本仓库，保留 `.agents/skills/polaris/SKILL.md` 及全部参考文件，Codex 继续通过原入口识别。项目使用不再依赖同级 hapilon 仓库，后续调整可在本项目副本中独立进行。

## 开始开发

提供业务目标与约束后，由 Codex 使用 polaris 形成任务范围、业务预期与验收标准，派发给 Claude Code 实现，再独立审查并运行验收。根据实际需求选择技术栈、组织代码及测试目录，并补充安装和运行说明。

本地分支为 `main`，尚未配置远程仓库。所有提交使用 snap 技能；提交不自动触发推送、发布或合并。

## 当前工作

正在讨论有生命感、可互动并能感知 Herdr Agent 状态的桌宠，当前草案见 [Bayper PRD](.hapilon/polaris/Bayper桌面陪伴/prd.md)，尚未进入正式开发。前期资料保留在原研究目录，见 [静态调研](.hapilon/polaris/Bayper前期调研/research.md) 和 [Herdr 运行时实测](.hapilon/polaris/Bayper前期调研/runtime-research.md)；研究脚本与复现说明位于 [research/herdr](research/herdr/README.md)。
