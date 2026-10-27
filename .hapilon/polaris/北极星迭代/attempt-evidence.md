# 执行证据 attempt 粒度修订

2026-10-27。真实触发：master 退回来源身份批次验收——执行者在同一批次用最终重跑覆盖了首次 after 的中间 FAIL，`after.log` 不再是不可变原件。本记录说明问题、归档、实际 diff 与验证边界，不宣称产品通过。

## 问题与影响

- 现行 `references/execution.md` 只要求“每批次写入独立证据位置”，未规定同一批次内重跑必须使用新 attempt 序号或唯一目录。该粒度不足以阻止同批次覆盖。
- 本次同时存在执行违约：执行者明知中间 FAIL，仍用同一路径 `tee` 覆盖，且未在开始前检查目标是否存在。不能把这次丢失归因于代码缺陷，也不能把最终 35/35 当作丢失的原件。
- 追溯仅限精确会话 `e977a9dc-5e99-4eb7-8260-8821c3a6573d` 的原始工具记录：tool_use 第 283 行、tool_result 第 284 行，失败为 `POL-ASSOC-002 ...`（actual `2f7d1b0b-...` / expected `385ae59a-...`）。命令以 `tail -60` 结束，只能恢复工具输出节选；完整 `after.log` 未找回。证据见 [../Bayper完整交付/evidence/source-identity-evidence-repair/summary.md](../Bayper完整交付/evidence/source-identity-evidence-repair/summary.md)。
- `baseline.log` 与现存 `after.log` 均未改动；最终 35/35 仍是开发结果，待 master 独立验收。

## 归档与修订

- 修订前完整归档：`.agents/skills/polaris/archived/20261027-131931-attempt-evidence/`，11 个有效文件（SKILL + 10 references，排除 `archived/` 自身，无隐藏文件）；路径清单与逐文件 SHA-256 已核对一致。
- manifest：[attempt-evidence-archive-manifest.json](attempt-evidence-archive-manifest.json)，`verified: true`。归档前 `references/execution.md` SHA-256 为 `d8aa7c28daaaa8dacc6227ffa25fbfa0a1c2c8eb87ba10dc1257df0f38b300f2`。
- 同一目的修订批次沿用已核对归档，不新建快照。仅修改 `references/execution.md` 执行证据节，原规范其余内容保留。新增段落：

> 证据位置按每次执行分配，而不是每个修复批次共用一个文件。同一批次重跑使用新的 attempt 序号或唯一目录；开始前确认目标不存在，或对实际写入者使用 noclobber/等价防覆盖，并保留退出码与原始失败。使用管道时须保留测试进程的实际退出码（如 `pipefail` 或独立捕获），不能把 `tee`/`tail` 成功当作测试成功；`noclobber` 不保护 `tee` 覆盖，防覆盖必须作用于实际写入者。`latest` 只能作索引，不能替代不可变原件；不依赖事后把最终结果复制成固定 `after.log` 来充当历史证据。

- 修订后 SHA-256：`bf4467392c1401492615ad6df361b73348c0154d9d8e33c06278412669b8c1ab`。实际 diff 仍为执行证据节一段新增，无其他 skill 文件改动。
- 本批追加两处窄修正：恢复节选的实际断言行是 `memory-association.spec.cjs:411`（原 tool result 原文），已更正 `summary.md` 与 `record-metadata.json` 的派生记载，原始 tool result 与 `source-records.jsonl` 未动；原命令为 `node | tee | tail` 且 `is_error=false`，管道会掩盖测试进程退出码，skill 已要求保留实际退出码，并说明 `noclobber` 不保护 `tee`、防覆盖须作用于实际写入者。

## 验证与边界

- `quick_validate` 返回 `Skill is valid!`，只校验 frontmatter、命名与脚手架结构，**不保证 skill 被实际遵循**。
- `git diff --check` 通过；归档 manifest 11/11 SHA 未变；现行 skill 11 文件路径一致，仅 `references/execution.md` 与归档不同。VERSION 保持 `0.1.183`。
- 本轮未按新规则实际重跑产品或证据批次；只有后续真实重跑使用新 attempt 目录/防覆盖、保留实际退出码与原件后，才可称行为验证。
- 未取得人类体验，未把流程修订记为用户亲自确认。

## 下一轮窄修正（本轮不动）

- master 已审查产品 diff，另发现 `POL-SOURCE-ID-003` 姐姐/同事夹具被混作已核实等价，以及 `memory-store` 中 `resolve` 旧注释仍写“退回严格同文”。两项只登记为下一轮窄修正，本批不改产品、测试或该注释。
