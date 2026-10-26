# S06j 审查记录

2026-10-27，Codex独立审查；实施CLI60669尚在途，本文件不表示终态验收。生产未提交、GUI未执行。

## 首轮代码审查关注项（须对最终diff复核）

1. `maybeAcknowledgeStoryInvitation`在同步renderStoryDetail后立即发ACK，`isStoryPanelVisible`只看tab/document状态。尚不能证明邀请区域已绘制且实际进入局部滚动视口；长故事可让邀请位于可见区域以下但照样ACK。应在实际绘制后检查邀请本身的可见布局/滚动视口，切页/隐藏/详情更换后丢弃迟到回执；自动化要包含长正文、滚到邀请之前/之后的SQLite displayed_at对照。
2. renderer/app.js净增约450行故事状态与渲染，和现有聊天/记忆/来源各自模块的组织不一致。本轮总生产代码已明显超过原规模提示；须按职责给出必要性说明，并将故事面板状态、DOM与异步生命周期收拢为独立story-panel.js，app.js只接导航和快照回调，不以压缩语句凑行数。
3. 新列表目前loaded后不刷新，需验证用户保持应用运行、后来真实活动产生节点，再回看故事是否能看到；不得靠重启应用更新。列表刷新不能自动创建或ACK邀请。
4. 主进程--story-catalog用于fixture，不得成为默认发布旁路；正常启动仍正式目录false。验收固定构造路径必须隔离，Case不得把fixture可用等同正式角色可用。

待CLI终态后按最终源文件确认哪些已修，再派发必要返修。所有Expected保持原plan，不用绿色测试替代实际可见与维护成本核查。

补充Runner审查（实施中观察，终态复核）：

- 隐藏Case在LATER_STORY仍later占位时读取另一HIDDEN_STORY，按唯一待决定邀请规则后者不会产生invitation；直接取detail.invitation.invitationId可能让测试在目标断言前报错。需要分开fixture或安排符合业务的不展示邀请，不能放宽唯一占位规则使测试通过。
- closeApp返回unconfirmed后若调用方先launched=null，再finally按空变量删除目录，会漏掉退出未确认；须以实际进程退出事实控制清理，且错误分支不先丢handle。此前S07b已发生同类审查，复用小而清楚的退出检查即可。
- 核对styles.css新增story样式后是否遗留孤立display:block/margin-top声明和多余花括号；若终态仍存在，修正结构。

## 首轮终态决定

60669 exit0，Claude session `3e3e9950-6750-4ca6-a1e0-786b9f732021`。报告纯Node5+20及unit18通过，GUI遵守禁跑；这些是实施者自测，Codex还未独立采信。终态仍无绘制/邀请viewport检查、列表loaded一次性缓存，确认前述1/3成立；GUI finally仍把launched置null再finalize，退出事实未守住。CSS孤立声明已修复，不再要求重复修。

生产净增863行有展示/业务分层的实际职责，允许本轮合理超出行数信号，但必须把439行renderer故事逻辑收拢为独立模块，避免主页面继续膨胀。禁止压缩行数、删业务断言或造通用框架。

返修后再运行GUI；新增长故事视口ACK、切页晚到ACK、运行中新增故事刷新证据。验收资料需唯一批次、源SHA、窗口截图、父子进程退出与清理结果，避免同名前缀覆盖失败。

GUI覆盖核对补充：POL-STORYUI-001的真实空态与运行中新节点需要通过页面入口验证，不能只由纯Node列表断言代表；当前GUI fixture ui.accept等并非正式character目录标识，应核对接纳后正式角色列表可见、初始数值和当前名单真实不变，避免只用SQLite关系行代表用户已能找到新角色。必要时使用hu/cheng等真实角色ID、仅fixture作者故事可用标记。

## Codex独立首批实测

返修23854 exit0后，Codex独立25/25纯Node通过，见evidence/s06j-codex-domain-r1.log。GUI32706独占运行，首两项均在首次配置页面等待home超时；读取seedData确认只acceptCharacter而未模型配置，属于Runner初始条件ERROR，未进入目标业务，不能记PASS或归因产品故事失败。证据保留evidence/s06j-story-window/codex-20261027-r1。源码摘要另存s06j-codex-r1-source.sha256（Runner的sourceSha只有HEAD，不包含未提交实现，不能单独识别本批源）。

下一返修仅先修Runner的真实配置与角色fixture，使用本地构造HTTP完成配置或严格沿已验证正式测试启动方式，不读.env、不调用真实API。接纳Case需用正式可展示身份并核对角色列表，初始讲述者可用rin，target用hu；其它必要隔离fixture标识可保留但不冒称正式素材可用。空态Runner openStories不能等待首项出现，否则永远不能验空态。业务Expected不降级，保留失败与必要进程清理。

## 后续夹具失败与进程处置

37351批次在完成真实配置后，ui.char.accept定位超时；renderList未提供Runner所用的data-story-id。另finally中的`failure ??= await closeModelServer(...)`在已有错误时短路，HTTP未关闭，Node悬挂。Codex核对Electron父子已退出，仅终止本轮36981/36982及CLI35966（37351 exit143），保留run-20261026222331390-36982-bcc815d0，交70881修复定位与无条件清理；不是产品接纳规则失败。

70881随后首项通过；完整批次run-20261026222915591-37833-c856740f已产生接纳、稍后、长视口、刷新、隐藏的无failure证据。Codex查看story-window-accept.png确认正式hu进入角色列表，rin在场/固定及hu名单外。迟到详情Case超过120秒：测试拦截器每次ui.char.accept都建立未释放Promise，后续直接getStory再次挂起。Codex在超时后仅TERM自建测试Electron38020/38025让Runner展开清理，保留失败。必须修复一次性延迟夹具/恢复handler并加有界等待，再独立验收；不能据前五项通过宣称整批通过。

## 最终独立复验（2026-10-27）

70881正常exit0。Codex独占GUI执行`node --test tests/acceptance/story-window-ui.spec.cjs`（BAYPER_S06J_EVIDENCE_DIR指定codex-20261027-r2），64582 exit0：7/7通过、0跳过。独立领域25/25、unit18/18通过；日志s06j-codex-gui-r2.log、s06j-codex-domain-r2.log、s06j-codex-unit-r2.log。该批实际sourceDigest=dfc99d2c031908bb7a52f1997b95b4eae128a87ee8a1e0b37d82665b30a184a7（10项相关源码与Runner）。

| Case | 状态 | 独立观察与边界 |
|---|---|---|
| POL-STORYUI-001 / UI-001 | PASS | 仅已发生故事；接纳真实hu后角色列表可见，rin仍在场，固定/名单不变；重启同邀请/关系无重复 |
| POL-STORYUI-002 / UI-001、UI-003 | PASS | manual展示不写quota_at；长内容未进入视口/只有边框2px时不确认，标题正文可读后才写displayed_at |
| POL-STORYUI-003 / UI-002、UI-003B | PASS | 稍后/拒绝/重新打开复用身份；真实空态及主进程心跳新增节点后重进刷新，不自动准备邀请 |
| POL-STORYUI-004 / 两项UI-004 | PASS | 隐藏窗不ACK，其他邀请不误接纳；未发布资源不能接纳，原故事事实保留 |
| POL-STORYUI-005 / UI-005及领域Case | PASS | 迟到详情/ACK不覆盖当前故事；写失败回滚，重复接纳不建第二份关系 |

Codex已看接纳截图与独立长故事滚动后截图；左右分区清楚，故事在局部滚动，外围导航固定；长内容不强行挤进一屏。构造正文与ui.*名字仅属于隔离数据，不作正式剧情审美通过。所有7份JSON failure=null、server=closed、cleanup=ok、directory=removed，各父子退出已确认。模型仅本地HTTP配置，未调用真实DeepSeek；正式作者资源门未改，自动桌面邀请与服装解锁仍是后续切片，不据此宣称S06全部完成。

相邻正式GUI回归52344 exit0，见s06j-codex-neighbor-ui.log；源码10项摘要在独立验收后复核一致。Codex受托接受此故事窗口切片，保留上文未覆盖边界。
