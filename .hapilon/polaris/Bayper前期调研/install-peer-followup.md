# 本机安装链路与同类实现交叉检查

2026-10-25，macOS27.0.1 arm64、Herdr0.9.5。仅个人使用所需的安装/运行机制研究，不验证签名、公证、自动更新分发，也不做产品设计。窗口与自有GUI生命周期补测另见macos-followup-results.md。

## 真实安装实验

在独立XDG根`/tmp/bayper-herdr-spike-L1A7ib`的a/b测试server中，执行真实`plugin install hmu332233/herdr-pets --yes`，不是将本地link冒充安装。安装前读取manifest与相关源码，build命令只有`swiftc -O -swift-version 5 src/*.swift -o bin/pets`；实际安装成功，记录commit `710883b89ea1d101aceab290b971eb86e4a7e872`，插件版本0.1.0。没有启动它的GUI。

安装完成立即disable，并在该隔离配置中放置stopped标记，防止随后server重启或状态事件启动参考应用。没有调用参考插件的stop动作，因为该动作包含`pkill -x pets`，作用范围不是某个隔离PID。

| 操作 | 实际结果 | 依据 |
| --- | --- | --- |
| GitHub install + build | 注册为github来源，出现Herdr管理的checkout，resolved_commit与只读clone一致 | install-peer.log、peer-installed.json |
| 定向update同一插件 | 提示already up to date；本轮没有制造远端新版本 | peer-update.log |
| uninstall | registry列表为空，但旧checkout仍存在；config/state仍在 | peer-after-uninstall.json及目录观察 |
| 停止两个测试server | 旧checkout仍在，未把server退出等同即时垃圾清理 | managed-after-stop.txt有1项 |
| 重启测试server | 旧checkout清除；config里的stopped和state目录保留 | managed-after-restart.txt为空，现场路径核对 |

这说明个人使用也要区分安装源目录、持久配置/状态和正在运行的进程。不能依赖uninstall自动关闭脱离GUI，更不能把持久状态放在可能被回收的旧checkout里。[Herdr官方安装与清理规则](https://herdr.dev/docs/plugins/#install-and-link)

本轮没有覆盖“远端源码变更后的update”“新旧版本GUI同时运行”或安装失败回滚，不据无变化update宣称升级流程已验证。

## 少量同类实现核对

| 对照 | 直接读到的实现 | 可提醒本研究的遗漏 |
| --- | --- | --- |
| [herdr-pets](https://github.com/hmu332233/herdr-pets)，上述commit | NSPanel非激活样式、全Spaces/fullScreenAuxiliary；全局flock单实例；通过注入Herdr命令读取状态，连续失败后退出；显式处理显示器变化 | 窗口focused与应用激活要分开验证；全局锁会使多个session互相排斥；退出策略与socket归属需要明确 |
| [herdr-](https://github.com/ikundasdas/herdr-)，commit `d3b7cdf5b14d376f4c8d5bc52937957100552e9e` | manifest仅Windows；短命ensure入口+长期GUI、命名mutex、事件inbox、状态读取；代码将配置固定到LOCALAPPDATA而非注入目录 | 入口和长期进程应拆开；固定全局目录/锁与隔离、多会话可能冲突；不是macOS运行能力证明 |
| [tauri-nspanel v2](https://github.com/ahkohd/tauri-nspanel/tree/18ffb9a201fbf6fedfaa382fd4b92315ea30ab1a) | 将Tauri窗口转换为NSPanel；此版本RawNSPanel的canBecomeKeyWindow返回YES，show还会makeKey | 原生适配不能只看名称；即便不激活应用也可能拿走键盘焦点，必须独立测底板key状态 |

以上是源码观察，未将作者的“never takes focus”等说明当作本机验收。两个参考插件未直接照搬为Bayper架构，Windows插件未在macOS执行；本轮也未研究第三种候选技术栈。

证据位于本地`evidence/2026-10-25-macos-followup/`，安装原始文件将在全轮收尾时归档。代码来源保留commit/path索引与必要摘录，不把完整第三方仓库纳入本项目。
