# S02b 独立审查

Codex静态审查首轮进行中的实现，尚未接受，待开发者复现并修正。

1. 系统暂停原因不能只用一个布尔值：`lock-screen → suspend → resume`后屏幕仍锁定，应继续暂停；`unlock-screen`后才能恢复。反向交错与重复事件应幂等。当前绑定直接把两类resume转为恢复，可能提前恢复后台活动。测试不应只断言回调次数，应检查真实暂停状态。
2. 子进程报告`asset-error`后，`desktop-host.getStatus()`又用`lastPresentation.assetState`覆盖错误状态。主进程因仍看到ready而继续等永远不会来的自然节点。需保留实际加载状态，确认损坏PNG而不只是路径不存在时也有界结束等待。
3. 异步帧预载存在状态竞争：加载A未完成时收到空角色或pending角色，目前这些分支没有递增loadToken；A旧加载完成后仍可能显示并发送节点。任何展示身份变更都应使前一个加载失效，失败时停止旧播放器。节点需能关联当前展示，避免旧角色迟到信号提前完成新角色节点。
4. `waitForPresentationBoundary`未检查等待结果，超时即继续切换。应明确超时的失败恢复行为，不能把一个有效但较长的动作当作已经自然收束；当前短动作可有界等待，后续动作长度从manifest获得。

上述为源码推导，尚不是执行证据。修复需保留先失败后通过的回归结果。真实原生点击、Spaces、画布与管理窗同时运行的资源占用仍需独立验证。

## r2实施中观察

首轮r2 GUI回归出现多项节点等待失败。Codex检查到父宿主已发送`displayKey`，但`app/desktop/main.cjs`转发给renderer的state未包含该字段；renderer退回自造的全帧key，与父宿主的首帧key不同，所有正常节点会被当成旧身份丢弃。需要在完整IPC链路核对同一展示标识，不能只分别通过纯函数测试。此发现尚待开发者修复与复验。

## r2独立验收与继续审查

Codex独立unit10、服务19、GUI16全部通过，GUI日志`s02b-codex-r2-gui.log`。displayKey转发遗漏已修，旧段定位为历史风险，不再作为未修状态。

仍发现展示竞态：canvas-app.js在A已加载后切到B，invalidateDisplay隐藏sprite但保留currentKey=A；若B尚在加载时切回A，`key === currentKey`直接return，未增加loadToken/重启idle，随后B加载仍可能呈现，且displayKey被更新为A，身份与图片不一致。请先增加真实加载延迟A→B→A场景复现，再小范围修复缓存命中与失效逻辑；不要靠禁用切换或缩减断言绕过。也核对加载失败后返回已加载A。只改desktop播放器和专属验收，不碰其他在途文件，不运行全量GUI；只跑新场景及相关桌面回归。保持代码简洁。

r3 Codex独立相关桌面4/4通过，日志`s02b-codex-r3-related.log`；实际读取修复代码，缓存A重启时会失效B令牌，真实图片身份诊断同时核实。此前全量GUI16/unit10/service19通过，未为此再重复所有无关测试。

原生工具已返修并独立node --check通过。Codex运行batch-VMVxQK真实隔离app，fixture完成后关闭；CU按确切Bayper Electron路径读取底板，但窗口截图只含底板，不能显示独立子画布叠加。未模拟点击或凭代码坐标冒充原生点击，透明合成/穿透/Spaces仍NOT_COVERED。quit退出0，工具核实本轮子进程消失并清理data-dir；不可将此限制视为产品失败或已通过。
