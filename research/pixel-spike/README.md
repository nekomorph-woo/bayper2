# 独立像素动画探针

这是2026-10-25的技术研究样本，不是Bayper角色或产品原型。Codex使用当前Desktop内置imagegen生成原图；Claude Code实现素材处理及浏览器播放；Codex审查产物和实际效果。

原图：assets/views-raw.png（四视图）、assets/idle-raw.png（参考四视图生成的六帧呼吸/眨眼）。原始PNG、提示词和处理结果分开保留；生成过程没有可编辑分层工程文件。

运行环境：Python3 + Pillow（本机12.3.0），浏览器Canvas，无构建步骤和额外前端库。

```sh
python3 research/pixel-spike/process.py
python3 -m http.server 58491 --bind 127.0.0.1 --directory research/pixel-spike
```

打开 http://127.0.0.1:58491/，完成后Ctrl+C停止服务；也可直接在浏览器打开index.html。PNG图集为播放器入口；GIF仅作演示，120ms/帧，透明阈值会损失软边；浏览器默认8帧/秒。

assets/processed/含图集、四视图、接触图、GIF和测量JSON。六帧原图按3×2切分，使用脚部中心/底边平移、同一0.5 NEAREST缩放；四视图实际不等格，按实测空隙切成独立画布。原alpha保留，未做自动抠图、像素重画或颜色量化；所以流程可用不等于素材质量合格。

完整提示词见prompts.md。技术合同见 ../../.hapilon/polaris/Bayper前期调研/pixel-spike-cases.md，审查结论与失败记录见同目录pixel-spike-results.md；原始CLI/浏览器证据仅在本地保留。
