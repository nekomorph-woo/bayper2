# Bayper 桌面窗口原型

Electron产品方向的高保真可交互原型，供产品与体验讨论；不是Electron安装包或正式业务实现。窗口内使用系统中文字体，角色使用像素素材。用户已确定Electron，Tauri只保留历史研究证据。

## 打开

从仓库根目录执行：

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory prototypes/desktop
```

浏览器打开 http://127.0.0.1:8765/ 。无需安装依赖或构建。推荐1200×800，最小验收尺寸960×680；较矮窗口的内容区可滚动。使用同一地址以保留演示数据，换端口或浏览器会是另一份。

| 入口 | 内容 |
| --- | --- |
| index.html | 小窝、当前桌面角色、今日名单、聊天、最近见闻 |
| characters.html | 角色概览、昵称、衣橱、独属记忆 |
| stories.html | 日常故事、相遇邀请及接纳/暂缓/拒绝 |
| connections.html | 两个Herdr来源、独立Agent状态与通知历史 |
| settings.html | 模型、桌面与通知、陪伴节奏、来源隐私、数据 |
| comparison.html | 首轮两种视觉方向，仅保留设计追溯 |

角色支持 `?id=rin|hu|cheng&tab=overview|wardrobe|memories`；设置支持 `?section=model|desktop|rhythm|privacy|data`。`index.html?page=characters`等兼容跳转到对应页。模型页 `?state=error` 展示模拟连接错误；任意页 `?state=save-error` 模拟存储失败。

## 建议体验路径

1. 小窝点“聊一会儿”，发送文字，再关闭；角色切换后聊天归属独立。
2. 将琥珀设为固定位，凛仍在桌面；再点“请她陪我”，确认暂停探索后换人。
3. 在凛的记忆里纠正温茶偏好，再看澄的关联记忆；删除默认所有已持有者，也可限定当前角色。
4. 阅读绫的邀请并接纳：她加入角色册，当前桌面和今日名单保持不变。
5. 来源隐私打开外部分析后仍需单独选择模拟会话目录；授权失败不算成功，撤销授权不删除已有记忆。
6. 查看断连来源并模拟重连；各Agent仍独立呈现，不把断连当作全部完成。

## 模拟边界

- 所有名字、经历、消息与数值均为构造数据，素材不代表正式角色母版。
- 聊天只播放本地固定回应；无真实模型、Herdr、会话目录或系统设置接入。
- 模型表单只填写演示Key，Key不持久化也不发送；其它非敏感演示状态保存在当前浏览器localStorage。设置→数据与关于可确认清除。
- 绫没有正式立绘，仅有文字占位；不能拿此原型验证名单外角色的桌面立绘展示。可在角色册进行临时聊天。自动轮换、完整记忆引擎与后台调度未实现。
- 只有一套已穿服装素材，未解锁服装用线稿/故事说明，不冒充已完成多套换装。
- 顶部macOS窗口灯为外观示意，浏览器里的角色大小、开机启动等开关不操作OS。

## 制作与证据

Codex通过OpenDesign MCP调度明确选定的Claude Code执行器生成全部HTML/CSS/JS；Codex负责规格、图像、审查和Git。未使用Computer Use操作OpenDesign。源码从OpenDesign项目 `bayper-desktop-prototype-20261025` 原样导出，未带入运行日志、隐藏版本库或凭据。

[逐轮规格与实测记录](../../.hapilon/polaris/Bayper窗口原型/review.md)记录具体证据与限制。五个主页面已实拍两种尺寸，另有角色子页、设置分区、操作后结果及三组动效证据；通过原型检查不代表正式Electron集成通过。原始证据在本地 `.hapilon/polaris/Bayper窗口原型/evidence/`，由Git忽略；关键交付截图随本目录保留。
