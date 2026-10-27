# S05 通知完整高度修复与阅读期诊断

2026-10-28，Codex master受托主持。来源：既有S05通知连续可读要求、S07邻近回归010偶发裁切；不是新的业务功能。生产修复由Claude Code实施，Codex已独立验收已测修复；最终结论及边界见末节。

## 契约与观察

复用POL-NOTIFY-UI-010/011；新增POL-NOTIFY-UI-012 v1。Given真实隔离Herdr、正式Electron/SQLite、420pt高度上限、真实长名称P0；When回执标签出现、三普通位进入；Expected标签变化不改变正文可用宽度与换行高度，来源与正文在完整6秒阅读期内可读，未达到上限时窗口和列表足够容纳实际内容，不缩短时间、不隐藏文字。Oracle为DOM内部采样时间、正文/来源/列表矩形、SQLite ack/holdUntil以及DOM computed边距和内容高度的独立求和，不调用生产naturalHeight自证。离散采样不是逐渲染帧证明。

## 已取得证据

- 旧010失败原件`evidence/s05j-desktop-notifications/run-20261027181501296-e08839/case-010.json`缺失败时timeline；保留未解决归因，不能靠后续绿色覆盖。
- master旧生产独立010/012共2/2通过：`evidence/master-notify-long-5IJ9pVmz/`；实际逐样本完整hold区间未见false，012确实2→3行。不能由此称旧失败已修复。
- 高度核算：`.items` marginTop4被pageListBudget计入，却被naturalHeight遗漏。实测窗口415，独立完整布局418.296875，需向上取整419。行底padding暂时吸收不足，文字仅余约1.25px。
- 开发者新增Oracle失败基线：`evidence/s07-sleep-runtime/attempt-20261028-height-oracle-baseline/`，真实报required418.296875/actual415；与旧010不同，是可复现的高度计算错误。
- 最小生产修复仅在naturalHeight读取并累加computed marginTop，两行；不改420上限、分页、阅读时间或resize阈值。聚焦修后012通过，`attempt-20261028-height-fix-r1/`，实际419、list client/scroll均74。
- 第一版完整通知回归`attempt-20261028-height-fix-full/`结果为11/12，下节保留真实失败；第二版及master独立结果见末节。

## 边界与处置

接入真实Herdr隔离server、Electron和SQLite，使用构造Agent名称/状态，不读取用户工作会话、不请求模型。012最初长名未进入真实DOM、普通位未到达属于fixture ERROR，保留原件；现已按真实working初始化来源，添加DOM长名断言。

历史偶发裁切与已证实4px漏算应分开描述：后者修后可以验收，前者缺原现场，不能证明唯一因果关系。继续保留timeline以便未来若再发生时定位。完整S05与全产品最终验收仍按父级范围执行。

本轮Polaris约束能覆盖先假设、再最小复现、失败基线与独立Oracle；问题是执行质量而非skill矛盾，不为凑迭代修改skill或建立新框架。

## 修后完整回归发现另一真实裁切（未接受）

height-fix-full实际11/12，012 FAIL。原件`evidence/s05j-desktop-notifications/run-20261027185223442-cb4343/case-012.json`保存完整现场：ack=1793127355412，DOM采样1793127355442（+30ms），来源3行高46.17、meaning底109.75、list底100、窗口116；文字已随“已显示”标签换行，但窗口仍是旧高度。随后419与内容74的高度Oracle通过，因此4px漏算修复有效但不足以解决阅读期内的异步resize裁切。连续性48样本maxGap153ms，不能以短暂瞬时忽略。

下一步须避免已回执内容先扩高而窗口尚未准备好。优先评估回执标签从首次布局即预留稳定宽度（保留语义、ack前视觉不显示但占位），使开始计时前就是最终换行高度；不提高窗口上限、不省略来源、不延迟标记冒充可见。需保持原Case再验证，具体实现仍由Claude完成，尚未授权自动扩大修复。

## 修复方案 v2（master受托批准，现已独立验收）

012原夹具用长名称证实旧版ack后2→3行，这是缺陷触发条件，不是必须保留的产品行为。现行Expected保持长名称、三普通位、完整6秒与高度Oracle，并增加ack前后正文宽度/行高稳定；不以取消长名称或裁短正文规避。CSS为3字状态标签从首次布局预留3em，未ack时visibility:hidden且文本为空；已ack时显示“已显示”，不表述用户已阅读。移除hidden属性以保留布局空间；来源文字仍全部展示。生产总差异小，无新抽象。

执行者Claude Code句柄80078，输出/tmp/bayper-notify-stable-ack-fix-20261028.json；先012，再完整12项。master已读生产diff与createItem/updateItem，确认未遗留hidden属性；当时未结束；最终独立结论见末节。

## v2开发者回归与master审查进度

- `attempt-20261028-ack-stable-r1` 012 1/1；`attempt-20261028-ack-stable-full` 12/12、0skip、exit0、223584ms。实际JSON目录`run-20261027185824759-f31174/`；master逐12份核实无failure、cleanupErrors均空、退出正常。不是master独立执行。
- master读diff：高度修复2行；标签固定3em、空文本且visibility:hidden，ack后可见；取消hidden属性。未改优先级、上限或回执时间。012保留连续性/完整高度并增加宽度和行高不变；旧010/011只增加时间/几何证据，不削弱断言。004改为等待真实窗口隐藏并复查实际isVisible，观测字段已随睡眠快照入库。
- master查看002三普通加急截图：来源、含义与状态标签清晰、未见遮挡；010手动展开图保留加急自身滚动与普通三位，手动列表部分行不在视口是已批准滚动行为，不混同自动阅读期裁切。静态图不是人类体验。
- master独立010/011/012已执行完成，`evidence/master-notify-stable-dDSg4ynh/`，句柄10431；最终3/3，详细采样核查见下节。

## master独立验收结论（2026-10-28）

master独立010/011/012为3/3 PASS、0skip、exit0、112731ms，`evidence/master-notify-stable-dDSg4ynh/`前后SHA一致。实际JSON `evidence/s05j-desktop-notifications/run-20261027190257359-0726dd/`：010完整hold区间166点、011为83点、012为49点，共298点无裁切/缺席，三份cleanupErrors均空。012实际需要418.296875、窗口419、list client/scroll均74，ack前后行高不变。离散采样不等同逐渲染帧或人类体验。

受托接受本次已证实高度漏算及ack后布局变化的修复，结合开发者完整12/12与master重点3/3；不宣称旧010缺现场那一次的唯一根因被证明，也不宣称全S05/全部Goal已完成。历史失败保留，新增timeline作为后续定位依据。此次未修改skill，执行既有失败分析和独立验收规则。
