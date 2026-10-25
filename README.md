# Bayper

Bayper正在按完整PRD分切片实现，技术栈为Electron。当前正式工程已具备模型配置、愿望推荐、首位接纳和重启恢复；桌面陪伴、聊天与记忆、Herdr连接、故事和完整动画仍在开发。研究探针、原型与正式实现分开管理。

## 协作入口

- [AGENTS.md](AGENTS.md)：项目协作规范。Codex 负责需求分析、任务拆解、调度、决策与独立验收，所有项目代码及测试代码由 Claude Code CLI 实现。
- [CLAUDE.md](CLAUDE.md)：Claude Code 的开发者入口，要求任务开始前读取 AGENTS.md，并按开发者职责执行任务。
- [.agents/skills/polaris](.agents/skills/polaris)：北极星 polaris skill 的项目内独立副本，用于业务设计、场景验收和交付。Codex 按项目授权担任 master。
- [VERSION](VERSION)：项目版本的唯一来源；每次非纯版本号的 snap 提交使 PATCH 加 1，MAJOR 与 MINOR 升级须由用户明确指定。

polaris 已从原 hapilon skill 目录完整复制到本仓库，保留 `.agents/skills/polaris/SKILL.md` 及全部参考文件，Codex 继续通过原入口识别。项目使用不再依赖同级 hapilon 仓库，后续调整可在本项目副本中独立进行。

## 运行当前工程

需要Node.js 24及npm。安装并启动：

```sh
npm install
npm start
```

首次在窗口配置OpenAI兼容服务Base URL、模型名和API Key，检查成功后许愿并确认接纳。Key由系统安全存储加密，业务数据存于Electron用户应用目录的`bayper.sqlite3`；不写入仓库。macOS为当前已测环境。当前关闭窗口即退出，托盘和独立桌面画布将在后续切片接入。

```sh
npm test
npm run test:acceptance
```

前者运行局部测试，后者运行隔离Electron窗口/真实SQLite与本机模型协议Fixture。`npm run test:live`为显式真实服务测试：从Git忽略的根`.env`读取`OPEN_AI_BASE_URL`/`OPEN_AI_API_KEY`，核对模型列表后使用`deepseek-flash`执行两次短连通检查，不读取工作会话。普通测试不会调用该服务。测试数据目录退出后清理，证据见交付工作记录。

## 开发与验收

提供业务目标与约束后，由 Codex 使用 polaris 形成任务范围、业务预期与验收标准，派发给 Claude Code 实现，再独立审查并运行验收。基于已确定的Electron技术栈组织代码及测试目录，并补充安装和运行说明。

本地分支为 `main`，远程仓库为 [nekomorph-woo/bayper2](https://github.com/nekomorph-woo/bayper2)。所有提交使用 snap 技能；提交不自动触发推送、发布或合并。

## 当前工作

产品依据见 [Bayper PRD](.hapilon/polaris/Bayper桌面陪伴/prd.md)，完整交付范围见 [切片安排](.hapilon/polaris/Bayper完整交付/scope.md)，实际结果见 [验收记录](.hapilon/polaris/Bayper完整交付/evaluation.md)。前期资料见 [静态调研](.hapilon/polaris/Bayper前期调研/research.md) 和 [Herdr运行时实测](.hapilon/polaris/Bayper前期调研/runtime-research.md)，研究脚本与复现说明位于 [research/herdr](research/herdr/README.md)。

桌面程序窗口的可交互原型见 [原型使用说明](prototypes/desktop/README.md)，包含小窝、角色、故事、连接、设置及本地模拟交互。OpenDesign通过MCP调度，Claude Code实现原型代码；真实模型、Herdr和系统控制尚未接入。
