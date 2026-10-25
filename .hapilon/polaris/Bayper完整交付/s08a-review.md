# S08a 正式窗口独立审查

## 在途视觉预审（非最终接受）

Codex已查看本轮真实Electron截图native-home-960x680.png、native-characters-960x680.png、native-long-chat-960x680.png。固定左导航与紧凑页标题清楚，角色页左右列表/详情关系明确；长聊天在消息区局部滚动，输入与发送按钮可见。小窝角色预览大于桌面128pt属于主窗口预览，不替代桌面本体尺寸验收。图片仍有开发候选素材标签，Hu/Cheng正式素材接入未完成。

尚未执行本轮独立GUI回归，CLI56406仍拥有GUI；截图由开发者Runner产生，不能单凭截图或退出码接受整体。待终态后：独立运行3个native Case及受影响旧UI；核对两尺寸三页与长记忆/连接错误；审查导航不改变当日名单或当前Bayper、临时聊天不改名单、草稿与焦点、纠正/删除异步保护不退化。核对代码规模与重复布局，不以隐藏溢出掩盖不可达功能。

## 待终态复核：已打开记忆面板时的角色入口

当前memory-panel.open(trigger, characterId)在state.open时直接return；新增openFor调用此函数。因此在A的记忆面板保持打开时，导航角色页选择B再点击B的“本地记忆”，可能仍显示A，新的明确角色入口被静默忽略。终态后先真实UI复现：若背景导航/入口可操作，则必须切换到B并使A的在途响应过期，或明确关闭旧面板再打开B；不能让用户误以为正修改B而实际仍操作A。保留当前清楚标题、已有异步epoch控制与取消编辑语义，不能单改标题冒充换了实际归属。若背景完全不可操作，以实际交互证据排除此疑点，不按代码猜测记FAIL。

## 开发终态与桌面回归缺口

56406 completed，Claude session56d8e8d1-d958-46ec-8b27-11335075c83b。报告native3、onboarding/companion9、chat10、memory6通过；desktop9/10，POL-DESKTOP-004极快第三次SIGKILL后仍running/restarts3。Codex独立综合GUI Runner句柄68229，日志s08a-codex-independent.log；运行期间独占GUI。

只读定位desktop-host：start在restarting且child=null时会直接spawnChild，spawnChild将restartTimer引用置null而未取消此前800ms回调。于是旧回调失去引用，可能在连续失败上限后再次spawn，绕过failed保护。须由Claude先复现再修：start尊重待重启定时器；所有过期定时器/旧子进程消息不能跨代次更改当前状态；达到上限后只有显式restart可恢复。不能以增加ready后等待规避。仅当独立GUI结束后派发desktop-host与专属desktop Case修复，保留原零延迟失败与断言。

## Codex独立回归完成

68229终态exit0，28/28：native3、chat10、memory6、companion3、onboarding6（含两尺寸视觉Case），evidence/s08a-codex-independent.log。Codex查看本轮960设置/长记忆、1200小窝截图，操作区与局部滚动清楚；前述记忆openFor疑点由真实遮罩hit-test、12轮Tab与Shift+Tab、角色归属确认排除，不记缺陷。

设置页发现产品文案泄露“本切片”且指向已接纳后不可达的首次配置入口，需删除误导说明。与桌面004一同派CLI14297，spec s08a-repair-plan.md，GUI交开发独占。修复后的desktop/new native证据到齐后才收束，不将28/28覆盖到未通过的004。

## 收束接受（Codex受托决定）

14297修复终态后，Codex独立运行desktop11+native3，39139 exit0，14/14通过；证据evidence/s08a-codex-repair.log。此前受影响聊天/记忆/名单/首次配置综合28/28已独立完成。查看最新960×680设置截图，误导说明已移除，控件可见；该截图模型为本机fixture，不冒充真实服务。desktop-host diff核对：待恢复timer由单一入口管理并取消，start尊重等待，旧进程消息按身份过滤，达到上限后只有显式restart恢复。真实失败及修后无复活/显式恢复Case均保留。

生产布局改动超过初始规模信号，但为既有三页HTML/CSS整合、导航及焦点归位，未引入通用路由/状态框架；允许此范围。git diff --check通过。接受S08a这批真实现有能力整合及恢复修复，不代表全S08完成：来源授权、连接通知、故事/衣橱、全部素材及最终原生体验仍按全PRD继续。
