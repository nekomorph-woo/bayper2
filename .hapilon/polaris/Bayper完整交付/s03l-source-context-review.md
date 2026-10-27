# S03l-b 聊天来源上下文审查

2026-10-27，Codex受托按北极星审查。r1 Claude session1fb18eec-bca1-44d3-828b-7d8bd274ca2d，exec76099正常终态，报告evidence/claude-s03l-source-context.json。仅新只读来源模块、store四行接线和专属测试，无新增表/外部读取/模型调用。

## r1返修

isCurrent只把新解析摘要与snapshot.digest比较，没有验证传入snapshot内容是否仍与其digest一致；保留旧digest却修改excerpt/messages/sourceCreatedAt/speaker/holder后仍可能返回true。该入口将支撑后续在途发布核验，不能让修改后的输入借旧摘要背书。要求先用真实chat来源快照复现，再补本地内容摘要自校验；digest覆盖实际给核验层使用的speaker、holder、sourceCreatedAt等所有语义字段（部分是sourceMessage的重复投影，也必须一致）。这不是密码学防恶意调用者的授权机制，不宣称有签名/权限隔离。

补一条真实用户发言包含“被谈论者”和较短记忆片段的场景，例如完整原话明确在谈姐姐、evidence只是“她喜欢蓝色”；resolve应保留完整原话与片段的区别，不能把speaker=user自动当成偏好主体。不在本片实现或断言语义分类。

可读性：不要为行数信号把try/catch/finally、reopen中的多个语句压成单行。展开控制流，保持业务顺序；规模略超出允许说明，不要求机械降至220/450。本次只改新模块及专属测试，保留既有Case Expected；日志允许evidence/s03l-source-context-r2-before.log。仍只本地白名单，无远程/GUI/Git/版本/文档。

## r2独立结果与Coverage

Claude r2 exec90543正常终态；修复前六种快照修改仍isCurrent=true的实际复现保留evidence/s03l-source-context-r2-before.log。返修后digest覆盖全部核验语义字段，isCurrent先检查传入内容摘要、再重读当前来源；不把它当签名或权限隔离。控制流压缩已展开，生产232行、测试554行，在明确职责和真实场景复杂度下接受，不为行数凑短。

Codex独立exec42960运行memory-source-context、chat-memory-operations、chat-exclusive、chat、chat-relay、memory-association六个领域文件：74PASS0FAIL，evidence/s03l-source-context-codex-r2.log。npm test独立19PASS，evidence/s03l-source-context-unit-codex.log。无修改Expected、无跳过；真实SQLite/store/chat/memory与本机HTTP模型Fixture，远程模型/GUI未执行。

| Contract | 独立观察 | 结论 |
| --- | --- | --- |
| POL-SOURCECTX-001 | 真实chat产生记忆后返回同角色user原话、片段、源时间，重启相同；请求数、表和行数不增加 | PASS |
| POL-SOURCECTX-002 | 同会话同角色最多前文；排除其他角色/会话/assistant/未来，分享转告及合成来源无正文unavailable | PASS |
| POL-SOURCECTX-003 | 正式correct/forget/keepExclusive与同源删除使旧snapshot失效，受控源不恢复 | PASS |
| POL-SOURCECTX-004 | 旧版本、过期、sourceVersion/角色/消息错误、缺失和body不匹配无正文拒绝；非法参数明确错误 | PASS |
| POL-SOURCECTX-005 | 长当前原话拒绝，前文/总预算有界且省略标记；seq排序及源消息修改后失效 | PASS |
| POL-SOURCECTX-006 | 实际聊天“我姐姐下个月要搬去杭州，她说她喜欢蓝色。”与片段“她喜欢蓝色”分别保留；九类旧摘要下内容修改均false，原快照true | PASS |

搜索app仅store初始化/内部导出与新模块存在引用，无IPC/HTTP/角色回复接线。模块只SELECT，未复制正文到表/日志/缓存；快照仅内存给后续中立核验使用。派生来源不追查其他角色原话；外部/主题/面板合成暂unsupported，不能据此宣称全来源核验完成。isCurrent按来源及记忆版本失效，未声称识别所有中文指代。

测试临时SQLite与本机服务器随fixture teardown退出；Codex核对bayper-source-context临时目录残留为0。最终源码摘要evidence/s03l-source-context-final-sha.json。本片不使用.env、不发真实模型请求。下一步以此正式来源快照适配关系协议，明确说话者与被谈论者、来源时间及不完整前文；再实测语义与预算/资格/事务链，原SEM尚未通过项继续保留。Goal active，未发现新的Polaris规则缺陷。
