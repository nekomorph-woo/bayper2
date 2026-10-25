# 多动作调度独立技术探针

2026-10-25。只验证多动作、非 Herdr 事件与中断恢复，不是 Bayper 产品原型。

素材由 Codex Desktop 内置 imagegen 生成：`assets/actions-raw.png` 是新增 wave/alert 各四帧；`assets/idle-atlas.png` 逐字节复制自 `../pixel-spike/assets/processed/atlas.png`，原始六帧与处理过程保留在原探针。新动作身份参考为原四视图，提示词见 [prompts.md](prompts.md)。

Claude Code 实现处理脚本、共享动作控制器、播放器和测试；Codex 制定技术合同、审查代码并独立验收。四个代码文件约 600 行，没有引入框架或构建依赖；保留必要的测量证据、可见状态与边界断言，未为凑行数压缩实现。

## 复现

需要 Python 3 + Pillow（本机实测 12.3.0）和 Node.js。无须 npm install。

```sh
python3 research/action-spike/process.py
node research/action-spike/controller.test.mjs
python3 -m http.server 58437 --bind 127.0.0.1 --directory research/action-spike
```

打开 `http://127.0.0.1:58437/`。点击画布、wave 按钮或 W 播放挥手；alert 按钮或 A 触发警觉；计时按钮使用真实 1 秒 setTimeout；reset 同时取消待触发计时器。验证后 Ctrl+C 停止服务。

## 已核实结果

- 素材共 14 帧：idle 6×150ms 循环；wave 4×600ms 播一次；alert 4 帧分别 200/250/250/200ms。
- alert 打断 wave 后保留精确播放位置，完成后继续剩余 wave，再回 idle；重复或低优先级请求忽略，不排队。
- Node 断言通过；真实浏览器的画布点击、按钮、W/A 和计时器触发通过。计时器实测在 wave 1013.9ms 处中断，恢复记录同为 1013.9ms；重复一轮为 1284.4ms。
- 新八帧统一缩放，脚底中心 128±0.5px、底边 y=248，高 alpha 内容无裁切；原六帧 idle 图集未改动。
- **技术流程通过，正式素材质量未通过**：脸、尾巴与身材比例存在漂移，四帧动作节奏仍粗，跨素材切换仍能看出造型跳变；没有人工体验通过结论。

结果与边界见 [验收记录](../../.hapilon/polaris/Bayper前期调研/action-spike-results.md)，固定技术合同见 [检查项](../../.hapilon/polaris/Bayper前期调研/action-spike-cases.md)。原始 CLI、DOM、截图和命令证据保存在该研究目录的本地 evidence/ 下，默认不纳入 Git。此次测试页、HTTP 服务与 Claude Code 进程均已退出。
