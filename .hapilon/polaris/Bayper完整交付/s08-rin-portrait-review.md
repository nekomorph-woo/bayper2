# 凛主窗口像素母版同步

2026-10-27，Codex受托纠正既有画风迁移遗漏。Claude12824仅将app/content/characters.json中rin.image从旧原型立绘改为已获用户认可的master-pixel-v2.png；身份、昵称、个性、其他角色、candidate标识与发布开关保持。Codex同步STYLE当前尺寸与迁移边界，不改原型历史。

Codex5563实际执行既有POL-NATIVE-001：三页、1200×800和960×680均无整页滚动，主要操作在屏内，浏览不改当日名单或同屏者。1个所选Case PASS，无新增测试或扩大实现。查看小尺寸小窝及大尺寸角色页截图，凛两处及列表缩略图均为新版像素母版，未见裁切或拉伸，页面留白与按钮仍可达。主窗口预览可放大，不改变桌面约128pt规范。

证据evidence/s08a-rin-portrait-codex-20261027及rin-portrait-native-codex.log。旧Runner写固定路径，执行前暂存原s08a-native-shell，结束后把本轮结果移到上述唯一目录并恢复原路径，历史证据未覆盖。测试finally关闭app/HTTP并删除临时目录，exit0。构造模型，不代表真实模型/完整动画库或用户人工体验。
