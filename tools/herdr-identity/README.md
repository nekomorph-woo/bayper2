# Herdr 插件身份验证

验证 macOS Herdr 插件 startup/action 的实际上下文、共享安装目录、server 端点代次与晚启动读取。此工具是隔离研究入口，不是正式连接器。

在项目根目录执行 `node tools/herdr-identity/probe.cjs`。需要本机 Node 与 Herdr（已验版本0.9.5/protocol22）；可通过 HERDR_BIN 指定可执行文件。只在明确授权的隔离实验中运行。每次创建随机具名 headless server 和临时 XDG，退出时清理，证据写入本目录 evidence/，失败批次保留。不连接默认或已有工作会话，不读取终端正文，不启动模型或GUI。

`node tools/herdr-identity/probe.cjs read <记录JSONL文件>` 是探针内部晚启动读取入口。生产协议复用项目共享的 app/herdr-transport.cjs；fixture、运行入口和证据均由本工具拥有。

## 已确认事实

两个 server 共享插件 config/state 目录，socket 与父 server PID 不同。workspace/tab/pane ID 可重复，不能独立当作全局身份。link 已运行 server 不补发 startup；首次 action 必须能建立登记。同一 server 多次 action 子进程 PID 变化，端点代次不变。同名端点重启生成新 socket 和父 server PID。

安装 UUID 只能作为命名空间，正式 instanceId 还须区分端点；runId 区分同端点的启动代次。端点丢失不等于证明 server 已停止。正式登记、发现、重连及通知由后续生产切片实现。

## 证据解释

Codex 独立批次 `2026-10-25T19-33-17-895Z-ccb066` 的事实与清理检查通过。该历史 JSON 的 recommendation 存在安装身份/实例混淆，已在代码中修正，历史文件不改写；应使用以上结论及正式规格，不照抄旧建议。详细验收见 `.hapilon/polaris/Bayper完整交付/s05c-review.md`。原始证据本地保留，不代表全部连接器已通过。
