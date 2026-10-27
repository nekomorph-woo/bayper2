# S03l-b 同协议模型对照结果

2026-10-27，Codex受托主持，依据s03l-model-comparison-plan.md。实际/models返回deepseek-flash与deepseek-v4-pro。Claude session7bc5cbf4-6449-4d69-9fce-0dcb45bf05f6、exec59859正常终态；仅工具--model选择及报告透传约十余行增量，默认flash不变，未修改全局/产品配置、协议、提示或Expected。

## 独立执行与Coverage

Codexsyntax/dry验证默认messages逐字兼容，指定pro的grounded消息与此前flash完全相同；dry0调用/不读凭据，结果model-compat-codex-dry.json与model-pro-codex-dry.json。真实exec65269/45239均终态，分别1models+1chat，无重试；加首次发现，本轮累计3models+2chat。实际请求modelName、/models存在性、生产protocol/model/工具/数据SHA均核对。实际Key不出现在4份live JSON/log；构造数据，无产品数据库/GUI/常驻进程。

| POL-MODEL-COMP-001 子组 | pro真实结果 | flash既有同协议对照 | 结论 |
| --- | --- | --- | --- |
| baseline16 | 13PASS3FAIL0ERROR，误合并0/正例遗漏0，uncertain6；总8106ms | 16PASS，误合并0，总3554ms | FAIL |
| holdout16 | 13PASS3FAIL0ERROR，误合并1/正例遗漏0，uncertain4；总7983ms | 14PASS2FAIL，误合并1，总3364ms | FAIL |

完整证据tools/memory-tuning/results/grounding-pro-baseline-live-codex.json/.log与grounding-pro-holdout-live-codex.json/.log，保留raw/effective及逐边描述。没有以更慢或名字更大推定更准确。

pro baseline08当前偏好与过去经历、11牛奶偏好与乳糖不耐受、14Vim与Neovim，均Expected different/actual uncertain；holdout07当前红茶偏好与过去品鉴、13爵士乐与音乐亦保守uncertain。holdout12“用户说她喜欢蓝色”仍错误equivalent：两边subject/quote均填用户，本地包含校验不能识别该解释错误。holdout15安静环境与独处恢复正确uncertain，但不抵消关键误合并。

## 受托取舍与接续

不采用pro替换产品默认、不以不同/uncertain均不合并而改Expected凑通过；保留工具可指定实际模型的能力及负结果。单次小样本不是全面模型排行，但本轮没有可靠性收益且延迟增加，因此停止同协议换模型尝试。

源码核查app/chat.cjs:408起validMemoryCandidates保存用户evidence原文，sourceId=chat:<userMessageId>可回到chat_messages的原始user消息及createdAt；不用假称memory.body是完整发言，也不另存第二套敏感正文。下一步从正式来源引用取得有界原话、说话者与时间上下文，明确未知指代，支持日期参照；来源失效/删除/派生归属与角色隔离必须先检查。此处仅源码依据，尚未完成来源解析服务，不提前标PASS。

完整Goal active。没有生产新代码，因此不无意义重复全应用/GUI验收；旧protocol不变。本轮已形成工具及真实对照可保存成果，按snap提交后继续来源链路，不将模型不可完美当作整个Goal阻塞。
