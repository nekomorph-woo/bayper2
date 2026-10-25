# S04b 获准会话文件的只读适配

Codex受托确认，承接s04a权限基础与REQ-13。目标是将获准目录中的Claude Code/Codex会话转换为有来源标识的文本，供后续预算内分析使用；本轮不发模型请求、不写记忆、不接设置页，不能标S04整体完成。技术来源与内部格式变化风险见s04a-plan.md；首批明确支持这两种适配器，不声称解析所有Coding Agent或所有历史格式。

## 边界和接口

只新增app/session-sources.cjs及必要一个小适配模块、tests/acceptance/session-sources.spec.cjs。依赖已完成createExternalSources权限接口，不改main/store/renderer/chat/memory/desktop/权限模块、tools/资产/版本/Git/文档。当前其他开发者正在写聊天测试，禁止碰其文件。测试只构造临时目录，不读真实HOME/会话/.env，不GUI不网络。

createSessionSourceReader({permissions})提供listSessionFiles(permit)与readSession(permit,relativePath)。permit由调用方签发并在整个分析/发布流程finally释放；reader不把许可藏在全局缓存、不替调用者授权。每次开始与返回前验证许可，返回消息只是数据，不执行其中命令或指令。后续模型发布前仍需再次校验同一许可。

- 只枚举授权根中适配器支持的.jsonl会话；Claude通常project/session.jsonl，Codex通常YYYY/MM/DD/rollout-*.jsonl。不跨软链目录，不读任何配置/Key文件，不全盘递归。适配器名从许可provider取得（claude-code/codex），未知provider明确unsupported。目录枚举有明确深度/文件数量上限及truncated标志，不默默宣称发现全部/最近全部；默认最多500个候选、深度4足够这两种路径，返回相对路径/mtime/大小等必要元信息。
- 读取前使用resolveAuthorizedFile；打开文件后核对普通文件、dev/ino与解析后的目标一致，返回前重新校验根与路径身份。使用O_NOFOLLOW等现有Node能力降低路径切换风险，异常不返回部分正文；保留无法彻底消除本机恶意进程TOCTOU的边界，不写复杂跨平台原生安全层。
- 大文件只读最多末512KiB，丢弃开头被截断的半行；整条JSONL记录超限/尾部未写完/坏行应计入明确诊断，不能把截断文本当完整JSON。输出最多最近40条、每条最多4000字符、总文本最多16000字符，保持时间/文件顺序，并在实际发生裁剪时显式truncated。限制集中为小常量，不搭参数框架；UTF-8中文不能读出替换乱码后假装有效。
- Claude提取message.role=user/assistant及文本content，忽略thinking、tool_use、tool_result、元数据/system内容。Codex只从response_item/message的user/assistant文本块读取，不把event_msg的同一内容再计一次，也不提取系统/开发者指令、reasoning或工具结果。支持content文本数组及明确可识别的字符串形态；未知schema给出unsupported/ignored诊断，不猜测多层对象。
- 为每条文本保留provider、role、可用timestamp、稳定sourceId与来源相对路径。优先使用会话/消息显式ID；无ID时可用规范来源+原文件字节偏移产生稳定标识，追加同一文件不能改变旧条目标识；重复显式消息ID只保留一条，不按文本去重用户有意重复的话。不要把私有绝对路径或完整原始JSON复制到普通输出/日志。归一化内容仍是外部来源，不标成用户亲口告诉Bayper。
- 不支持压缩归档、附件图像、二进制数据库时明确标unsupported，不声称已扫描它们。关闭文件句柄用finally，文件变化/消失给清楚错误，不作为空记忆。

## 验收Contract（受托确认）

| ID | Given / When | Expected / Oracle |
| --- | --- | --- |
| POL-SOURCE-007 | 两种构造JSONL含用户/助手/工具/思考/system及重复Codex event → 获准枚举和读取 | 只有应保留的文本/角色/来源，顺序正确，工具/思考/系统/重复事件均不进入输出；真实fs+权限服务+SQLite，不替换核心 |
| POL-SOURCE-008 | 无授权、关闭分析、已撤销/已释放许可及外部软链 → 读/列目录 | 均拒绝或排除越界项，不返回文件内容；正常目录真实文件可读 |
| POL-SOURCE-009 | 大文件、半行尾、坏行、多字节中文、单条巨大记录 → 有界读取 | 不超字节/条数/文本限额，诊断明确，合法中文正确；有效完整行不被当损坏，半行不解析成事实 |
| POL-SOURCE-010 | 追加同一文件、显式ID重复、同文不同ID → 读取前后比较 | 旧消息sourceId稳定、同显式ID幂等、用户两次相同文本不被错误合并 |
| POL-SOURCE-011 | 枚举层级/数量越限、未知provider/格式/压缩文件 → 读取或发现 | 明确truncated/unsupported，不能静默回退到无权限或任意文件读取；测试finally清理目录/句柄 |

约250～350行生产、约200～300行测试作为规模信号。先完成真实基础流程和边界场景，超出说明必要职责；不自动扩展索引/文件watcher/任务队列/模型调度。Codex独立验收后再接实际设置和分析管线。
