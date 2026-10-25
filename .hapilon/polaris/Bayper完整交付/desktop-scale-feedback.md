# 桌面角色尺寸反馈

2026-10-26用户实际反馈：“桌面的角色尺寸太大了，至少缩小一半，测试的角色图，像素感不够”。

Codex决定：默认桌面画布线性尺寸降到0.5，当前256×384导出帧显示为128×192 CSS点；保持源图与manifest原始尺寸，不破坏像素素材。窗口边界、拖动命中与落脚点一致缩放；不要只缩图片保留大片不可穿透空白。主应用角色详情插图尺寸不随之硬减半。后续显示大小设置围绕此默认值接入。

Claude仅实现尺寸：app/desktop/main.cjs、必要画布CSS、明确相关tests/，不改store/model/chat/正式资产/文档/版本/Git。小改动，无新通用缩放框架。image-rendering:pixelated保持；不能把CSS滤镜或机械缩图宣称解决素材画风。素材重做由Codex imagegen承担。

先最小实现并针对性验证画布初始/角色切换/屏幕边界的尺寸正确，测试不再断言旧尺寸。不削弱透明、不抢焦点与自然节点要求。允许针对桌面GUI，禁止全量无关重跑。交付报告说明变更和执行证据。

## 独立结果与画风基准

Codex读取实际diff并独立执行两项相关真实Electron验收，2/2通过，日志evidence/s02b-codex-size.log。初始画布与Rin→Hu后均128×192，窗口在workArea内；真实OS拖动/合成仍沿S02b边界未验证，不借尺寸断言冒称完成。

用户随后认可master-pixel-v2并要求同步。已建立assets/characters/STYLE.md，更新AGENTS/CLAUDE、PRD/动画计划/初选记录、catalog源数据与SQLite派生库。Codex独立运行build.py，8张表行数与CSV一致，310维不减少、48候选不扩张、assets增加到2，当前参考路径存在，integrity_check=ok。数据库仍是造型资料，不是运行时自动生成或全部素材完成。
