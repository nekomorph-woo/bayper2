# 真实来源关系对照审查

2026-10-27，Codex独立执行，POL-SOURCE-LIVE-001整体FAIL。Expected见s03l-source-live-plan.md，未修改。CLI 24597e42-2272-4004-a5ac-736b35ad8cc3，exec71033/4504终态；报告evidence/claude-s03l-source-live*.json。生产代码未修改。

## 实际链路和审查

正式createStore/chat.sendMessage→真实SQLite→memorySourceContext.resolve/isCurrent→正式关系协议→真实DeepSeek→独立Expected评分。聊天提炼为fetch fixture，25次构造调用，不代表真实提炼效果；关系判定为真实服务。每对独立SQLite、角色a/b独立会话，避免相同正文身份复用使来源串扰。语义判断之外不执行associateFacts，不接自动预算/产品调度。

工具529行，自包含固定12对数据、严格输入、构造来源、单次网络/评分与证据/清理，超过预估但未引入框架，接受当前职责。r2按审查去除挤在一行的catch/清理变量；来源复核抛错也经内层finally清理；源码摘要补齐memory及身份模块。没有修改Expected或生产逻辑。

## Codex证据

- `node tools/memory-tuning/source-probe.cjs --dry-run --out tools/memory-tuning/results/source-dry-codex-v1.json`：DRY-RUN；24来源前后有效、24记忆条目不变；未读凭据、0网络。逐条核对原话/片段/前文、消息白名单和Expected未进入请求。
- `node tools/memory-tuning/source-probe.cjs --out tools/memory-tuning/results/source-live-codex-v1.json`：FAIL（有效语义执行，非ERROR），1次models+1次chat；实际/models包含deepseek-flash。models144ms、chat2490ms、总2991ms。
- 两轮12库均关闭并删除，临时来源清理完成；报告包含源SHA及请求/响应。日志为各JSON同名.log；开发者dry仅作为补充。

| 子项 | 实际 | Expected | 结论 |
|---|---|---|---|
| 01/02/03/05/10 | equivalent | equivalent | 关系标签PASS |
| 04/08/09/12 | different | different | 关系标签PASS |
| 07 | uncertain | uncertain | PASS |
| 06 | different | uncertain | FAIL：未知她未保留不确定性 |
| 11 | different | uncertain | FAIL：相关偏好被过早认定不同 |

总计10PASS、2FAIL、0ERROR，falseMerge0、missedEquivalent0。不能由零错误合并推定已适合自动纠正/删除：04主体仍返回null，尽管关系碰巧正确；10主体只写“我”，没有完整描述姐姐参与者。05利用前文输出小雨，但引用仅“她”，引用存在不证明推理充分。该固定小样本不代表泛化能力或抗注入保证。

## 新发现及下一步

构造时同一角色同片段“她喜欢蓝色”使用不同键，会经现有正文身份复用返回第一次条目，后续会话的前文和原话没有成为独立来源。这一行为由Claude构造失败暴露，Codex源码核对app/memory.cjs insertFactIfAllowed及identityFingerprint：指纹不含主体/语境，getEntryByCharacterIdentity会复用条目；跨角色也可能共用身份。此次独立库仅为测量不同上下文，不是产品修复，尚需Codex正式业务复现。

下一步先建立同片段不同来源/主体的真实聊天Case并修复正文身份推断，避免把错误事实组喂给后续核验或传播管理。明确派生链仍应继承身份，独立同义最终由有证据的核验关联；不得用代词黑名单硬编码规避。随后再完善关系证据和不确定性语义，接预算/资格/版本校验/原子关联。原SEM及全Goal未完成范围保持。
