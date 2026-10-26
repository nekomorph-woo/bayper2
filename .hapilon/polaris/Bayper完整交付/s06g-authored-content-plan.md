# S06g 首批作者内容数据

Codex受托决定。唯一内容来源为app/content/maid-series-spec.md，三角色身份沿用characters.json；本轮将作者规格落实成既有story-progress可消费的目录，不扩充新故事、不接main、不发布未验收素材。

Claude允许新增app/content/maid-stories.json与tests/acceptance/authored-content.spec.cjs。必要时一个极小内容加载入口，但优先直接兼容现有catalog。禁止修改main/store/renderer/现有业务服务/角色资源/版本/Git/文档，与S06d和S05g隔离。目标数据约100～150行，测试约150～250行；不建内容CMS、manifest框架或新表。

正式数据包含主题maid.quiet-house，四条故事与每条两个节点，storyId、targetId、ownerCharacterId、nodeId、factId及作者事实精确对应规格，body采用本地表达。素材当前没有全量发布通过，四条assetAvailable均false。不要因文件存在就自动true，不把候选资源名当验收。后续正式资产验收时由独立切片更新此门。文本只表示版本虚构角色背景，不假称用户经历，不携带私有工作数据，不插入恋爱/签到/照顾惩罚。

验收用真实SQLite和既有story-progress/companionship，复用已有fixture模式保持可读：
- POL-CONTENT-001：实际读取正式文件，核对4条/8节点、稳定角色/服装归属、主题一致、每个必要fact与规格一致；交给正式story-progress接受，构造错误归属另行明确处理，不新增无需求泛用校验器。
- POL-CONTENT-002：实际正式assetAvailable=false目录经过真实completed活动，不能推进未发布目标/邀请或解锁；无关系/记忆/名单副作用。保持真实业务门，而非只断言布尔字段。
- POL-CONTENT-003：明确测试内复制目录并模拟已发布资产（不得写回正式文件），分别以rin/hu/cheng为首遇，走活动→两节点→相遇成熟；每一剩余角色有可达故事，已结识者不当发现目标。凛服装仅对已结识凛、身份保持；推进冷却与顺序使用正式规则，不直接SQL造mature来冒充流程。可复用discovery-outcomes核对接纳不改当日名单，避免复制整套旧Case。

唯一证据批次保留命令/结果/清理。无GUI、无真实模型请求。结论只为作者目录一致性与可达性，不称已完成正式动画或用户可见故事界面。
