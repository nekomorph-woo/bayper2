# S05c 身份探针独立审查

Codex 受托接受本切片的事实验证，不接受其原始推荐文字为正式架构。独立执行 `node tools/herdr-identity/probe.cjs`，exec60603 exit0；日志 evidence/s05c-codex-identity.log。权威批次 tools/herdr-identity/evidence/report-2026-10-25T19-33-17-895Z-ccb066.json，记录文件同批次。

| Case | 实际观察 | 结论 |
|---|---|---|
| 001 | 两server共享config/state；不同socket与父PID；两边局部ID均可为w1/w1:t1/w1:p1；link没有startup | PASS，仅身份事实 |
| 002 | 重复action子PID变化、端点tuple不变；同session stop/start新PID与inode；正式transport ping成功 | PASS，仅真实生命周期事实 |
| 003 | 独立reader读取持久化记录并ping端点；三代server退出0，当前socket删除、fixture无存活、临时根删除 | PASS，仅晚读取与清理 |

初始批次错误假设局部workspace ID不同，失败保留，不用早期混杂report作通过依据。独立批次的recommendation误将共享安装UUID写为instanceId，且仅依赖startup、把端点替换等同退出，已退回Claude修正字符串。79514正常结束，Codex核对当前recommendation与 `node --check tools/herdr-identity/probe.cjs` 通过；不重复真实实验、不改写历史记录。

正式决策：instanceId必须由安装命名空间与具体端点共同派生；runId依据真实端点代次，不随action生成；首次action无startup也能登记；socket消失或替换仅支持断连/端点失效，不能单独证明server停止。下一步规格s05d-registration-plan.md承接正式插件与读取入口。主应用发现/安装/适配/通知尚未接入，完整连接器需求仍未验收。
