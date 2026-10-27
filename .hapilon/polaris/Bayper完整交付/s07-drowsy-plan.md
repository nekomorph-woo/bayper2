# S07 凛困倦素材：提取与衔接审查

2026-10-28，Codex master 受托选择并批准此制作切片。来源：PRD引用 animation-plan.md 的 D03困倦、D04睡眠，角色画风 STYLE.md，本体128pt、同角色同服装一致性。完整 S07 仍包含三角色、服装与36项动作语义，本片不能替代全部。

## 业务与范围

让凛从已批准静坐姿态进入困倦，再自然衔接已生成睡眠候选，避免只有站立待机或坐姿静帧。此次先交付可审查的真实位图帧和播放证据；没有通过衔接审查前不修改正式运行路由或内容发布状态。

Codex已生图并记录 source/drowsy-pixel-notes.md：v1触格失败；v2网格留白完整但源帧尺寸与提示词不同，必须以实际图像为准。Claude Code负责使用现有sprite-pipeline提取、统一缩放与对齐；Codex独立检查产物和真实播放器。不会用CSS位移、逐帧拉伸或滤镜代替动作素材。

## 技术与制作

- 输入 assets/characters/rin/source/drowsy-pixel-v2.png；参考 sit-pixel-v2-canvas256/frame-07.png 与 sleep-pixel-v2-canvas256。
- 使用显式regions/接地锚，256×384画布，padding8，地面128,376。共同缩放以已批准坐姿223源像素高为初值；不能逐帧单独fit，不因困倦变矮而放大头部。锚点以头部稳定结构与实际地面核对，不按含尾巴的整体bbox中点猜测。
- 八帧一次性动作，初始建议时长400/240/220/420/300/240/300/500ms；最终节奏由实际小尺寸播放审查决定。不是循环睡眠。
- 仅新增 tools/sprite-pipeline/data/rin-drowsy-v2-regions.json、assets/characters/rin/animations/drowsy-pixel-v2-canvas256/ 导出产物，更新source制作记录，独立工具证据放tools/sprite-pipeline/evidence/本批目录。现有CLI可满足时不写新代码；缺能力先报告，不另造播放器。
- 允许一张衔接对照图作为证据；如需新脚本，先报告最小方案、规模与归属，不散放到文档目录。不得修改生产代码、版本、Git、skill、其他素材或依赖。

## 验收 Contract

| ID | Given / When | Expected / Oracle | 边界 |
|---|---|---|---|
| POL-DROWSY-ASSET-001 | 固定v2源图与显式region，执行现有导出CLI | 8个完整透明帧、统一比例与地面锚，无触边/裁切；源SHA不变，记录配置/产物SHA、实际尺寸与透明像素检查 | 真实PNG与现有工具；不靠提示词声称尺寸达标 |
| POL-DROWSY-ASSET-002 | 导出帧在现有Electron播放器，display-scale=128/314 | 一次性动作依顺序播放并停末帧、可重放；暂停/逐帧/慢速/深浅背景/导航拦截与退出清理；审查真实小尺寸而非放大立绘 | 自动验证只证明播放行为；Codex观看图像序列与截图，不冒称人类连续体验 |
| POL-DROWSY-ASSET-003 | 同比例比较坐姿末帧→困倦首尾→睡眠首帧 | 脸部尺度/发型/服装/耳尾不突变，地面漂移可说明且不明显，手势顺序合理；有问题保留失败并返修 | 静态对照只能支持初审；正式运行时触发/中断与跨动作连续播放未执行即NOT_COVERED |

先执行001和002，master审查后决定003后续。进入正式路由前另补明确触发、自然节点、中断及通知不抢占规则的Case，不以候选存在自动发布。
