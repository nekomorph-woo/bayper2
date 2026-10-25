# 新像素桌面接线审查待办

首版仍开发中，以下为Codex只读发现，须按完成版本复核并复现，不冒称已实测。

子进程reportBounds复用type=ready来发送每次尺寸/位置变化，但desktop-host的ready处理会清除rendererAssetError、lastNode、displayedKey等，并sendState。ready是进程启动语义，不宜用作几何更新。特别是既有加载失败后拖动/重新夹取边界，可能把尚未修复的素材错误清掉；展示就绪也会在几何变化时短暂丢失。先验证真实影响，再以独立bounds更新消息或等效最小方式保留生命周期语义；可按需要授权极窄desktop-host改动，不应仅靠重复displayState遮掩重置。不得削弱现有素材错误持续性Case。等首版结束后派发，当前不并发改动。

## 返修与Codex独立验收

Claude实际复现几何更新后assetState从error变成ready，失败证据s02b-r5-bounds-fail.log。修复将真实启动ready与只更新边界的bounds消息分开，删除用于掩盖重置的renderer重复displayState；不再清除错误、lastNode或displayedKey。

Codex读取最终diff后独立执行 `BAYPER_SCREENSHOT_PREFIX=codex-pixel-r2 node --no-warnings --test tests/acceptance/desktop.spec.cjs tests/unit/desktop-assets.test.cjs`，11/11通过，证据evidence/codex-pixel-r2.log。实际Electron/SQLite/导出帧，受控配置fixture，无真实模型调用。POL-DESKTOP-007正式入口实测Rin90×128、Hu87×128窗口，图片等比缩放并裁透明边，招呼收束回新版待机、角色切换和几何更新不丢错误/节点/展示。Codex查看本轮实际凛截图，轮廓/耳尾/脚可辨，无明显裁切；非人类连续观看。测试finally清理自建临时目录与进程，CLI退出0。

接受本体尺寸与新版资源接线这个切片；原生鼠标命中、Spaces/全屏合成、跨动作长期自然度和所有角色新版素材仍未完成，不据此标S02/S07整体通过。Hu旧风格标签明确保留。后续正式全局回归需要同时覆盖仍在返修的聊天窗口。
