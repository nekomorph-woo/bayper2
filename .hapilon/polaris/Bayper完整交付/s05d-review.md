# S05d 在途代码审查

29550尚未终态，本文为Codex只读预审，不是验收结论。正式Case执行与审查以终态版本为准。

当前实现使用临时文件+hard-link建立唯一namespace，避免直接wx最终文件后其他进程读到半截；登记用rename。实例区分端点、run不含action PID，读取只给matches/missing/replaced，不宣称在线/停止，方向符合规格。

## 终态必须核对的边界

- `app/herdr-registry.cjs:validateRecord`当前只检查instance/run非空、文件名相同、socket字段类型。尚未重新计算runId与tuple关系，也没有namespace字段可核对instance派生；pluginId只要求非空。根据规格第5条“核对文件命名/实例字段/tuple一致”，须验证改动runId但保留真实socket的记录会否被当作合法可连接记录，避免损坏元数据制造新代次/重复上线。先补独立Case复现，按正式格式做最小修正，不建设签名/安全框架。
- 并发同run首次登记各读到不存在的旧记录时，firstRegisteredAt可能被后写覆盖；当前日期仅观测元数据，不能用它派生run或决定上线。是否需严格首时间稳定由下游实际用途判断，不为不可见微秒差扩大工作。
- 当前stat后readFile不是硬字节读取上限；本轮仅原子替换的小型本地插件文件，先核对测试是否把64KiB称作内存硬安全保证，避免过度承诺。
- plugin manifest创建时可能读取了0.1.99，Codex在接受提交前需同步当前PATCH，不能在其他并行提交里夹带未验插件版本修改。

计划Case003真实隔离Herdr仍需Codex终态后独立运行与清理核对。不得用fixture端点Case替代真实startup/action语义。尚未主应用安装/发现/adapter/通知。

## 首轮独立执行

29550终态后Codex执行 `node --test tests/acceptance/herdr-registration.spec.cjs`，exec19086 exit0，3/3且无skip；日志evidence/s05d-codex-first.log。原Case未覆盖字段派生一致性和100文件上限，因此不据此接受全部契约。

返修契约POL-REGISTER-004：受控真实socket、正式插件生成合法登记，分别仅改runId、pid、instanceId与匹配文件名、pluginId，仍保留有效socket；读取应拒绝不一致记录并保留另一合法实例，不能新造运行代次。对run与instance加入必要可核验字段和确定性派生校验，schema本轮未发布可修；不引入签名或权限框架。记录时间只作元数据，不用于run。再增加101个记录的实际边界检查，证明最多读取100条且明确truncated诊断，不声称任意数量都完整发现。先在修前运行并保存失败，再做最小修复，回归原3Case。测试规模已665行，不复制生命周期helper或扩成框架。

## 返修与受托接受

48886终态：新增004先在旧实现复现runId被改仍接收（2!=1），失败run-004-fail.log保留。正式登记schema2新增namespaceId，读取重新计算instance/run并限定pluginId；没有引入签名框架。Codex核对派生字段、004独立变异断言，并执行全部Case：exec10687 exit0，4/4无skip，evidence/s05d-codex-repair.log。001双端点重复登记、002并发/端点重建/损坏隔离、003真实Herdr首次action/重启startup/双server/transport ping、004坏字段及101文件截断均通过当前契约。

Codex受托接受“正式登记与只读读取”切片。生产383行，测试761行含真实socket子进程、Herdr双server生命周期、四场景和清理；职责清楚，没有通用框架，规模偏大但本次不为行数压缩断言或复写helper。首次登记时间仅观测、64KiB stat检查非硬内存保证；100上限明确截断。身份派生一致性不证明恶意本地进程真实性，不作此承诺。

仍未接主应用安装、自动发现、重连适配与通知；用户可用的完整Herdr连接器需求保持未完成。下一步使用本登记和既有transport/ledger接正式adapter，再接main与真实通知。插件依赖本机Node，macOS自用边界明确。
