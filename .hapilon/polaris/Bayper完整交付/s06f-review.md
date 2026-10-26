# S06f 独立审查

原61141句柄已缺失，完整JSON报告存在且进程核对无Claude在途；Codex独立运行discovery5+story5及通知回归合计25/25（evidence/codex-notify-discovery-final.log），没有skip。尚不据此宣布正式应用链路完成。

最终审查发现prepared邀请可defer/reject，reopen将displayed_at以当前时间COALESCE补齐并变pending；此前没有实际展示回执时，手动重开因此冒充已展示且accept可成功。这与首次展示以ack为准不一致。补006：prepare→未ack→defer/reject→reopen→accept，不能凭重开创造displayed_at或绕过展示确认；对已真实展示的历史邀请重开仍保持原时间与不新增自动额度。允许拒绝未展示状态转换或保留未展示等待真实ack，选择清晰最小规则，不修改已有真实展示后稍后/拒绝流程。还核对prepared期间目录不可用/目标冲突时ack不把不可用邀请确认成可展示。先保留失败再最小修复。

代码650行包含两类持久结果与事务，可以理解，不要求为行数拆出通用状态机。正式组装时需避免discovery-outcomes引入store的INITIAL_STATS与store再引入此模块形成循环依赖；本轮可保持，组装切片必须解决。GUI、分享预算与正式素材仍未覆盖。

## 受托接受领域切片

90506终态后，Codex独立discovery6+story5及通知/账本回归合计27/27，无skip、exit0；日志evidence/codex-notify-discovery-repair.log。006未展示重开保持prepared和空展示/额度、真实ack后接纳，以及素材下架/身份冲突阻止ack均通过。旧真实展示后的重开不改原时间。

001邀请首次展示及7天额度、002决定与不改名单、003衣装72h与不自动穿用、004目录身份/不可用、005事务/退出、006迟到展示来源复核均PASS；真实SQLite与正式活动/故事入口，目录时间为fixture。仅接受领域实现；main、共享分享预算、正式角色素材、GUI真实回执与体验NOT_COVERED，后续接线必须完成，不把11条领域Case当完整产品。规模增加来自明确两类结果和故障Case，可维护性接受，无通用状态机。
