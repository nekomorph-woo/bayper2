# S05d 正式Herdr插件的端点登记

Codex受托确认。依据PRD连接器规则、s05b-protocol-review与s05c真实身份证据。一个server端点对应一个稳定实例，同端点重启进入新run；共享插件安装身份不是实例。此切片提供正式插件与可消费登记，不接main/通知UI，随后接自动发现与adapter。

## 实现边界

新增plugins/herdr/herdr-plugin.toml、register.cjs（必要时一个小registry-io.cjs）；新增app/herdr-registry.cjs与tests/acceptance/herdr-registration.spec.cjs。仅这些路径，禁止main/store/renderer（S04d占用）、现有账本/transport、其他工具、版本/Git/文档。正式插件不能依赖research/tools或项目node_modules才能写登记。macOS本机Node可作为明确运行依赖，不宣称已完成可分发安装包。manifest先取当前VERSION，Codex提交前统一同步。

预计生产250～350行、测试300～450行信号，先核对职责分配，不建通用插件SDK/daemon。插件是短命startup与“关联Bayper”action，同一入口，登记后退出；不启动/关闭Bayper、不读取会话正文、不发模型、不控制pane。runtime目录由插件config目录中的bayper.json明确指定registryDir，缺配置明确失败不猜测其他用户目录；后续正式安装UI负责写配置，本切片隔离fixture提供。

## 身份与持久化

1. 插件只用Herdr实际注入的SOCKET_PATH/PLUGIN_STATE_DIR/PLUGIN_CONFIG_DIR和自身ppid，验证socket存在且isSocket。state目录内一次性安装UUID用原子独占创建，重复进程读取同一值，不能每action重建。
2. instanceId由安装命名空间+规范socket路径稳定派生，不含工作区标签或局部pane；两个server不同实例，同session同端点重启保持实例。namespace记录损坏明确报错，不悄悄换身份。registry文件以instanceId为名，单次原子写临时文件rename，文件权限仅本用户。
3. runId由同端点的socket dev/ino/birthtime与hook父server PID等已验证代次证据确定性派生；不含每次调用时间/随机UUID/action PID。startup与首次action都能登记，无startup记录也不阻塞已运行server关联。重复登记同tuple复用runId；同端点替换为新socket不复用旧代次。证据字段原样保留，不能把派生ID描述成Herdr原生ID。
4. 登记中仅保存schema版本、plugin/instance/run标识、socket规范路径/元数据、观察server PID、首次/最近登记时间。无需保存workspace/会话正文或Key。不用ps秒精度或pid存活单独证明同run，更不能把socket消失直接当server stop。
5. app/herdr-registry只读取显式registryDir的有限JSON文件（上限100、单文件64KiB），不递归用户目录；缺目录返回未发现，损坏/不支持schema明确诊断，不让一条坏记录阻止其他实例。核对文件命名/实例字段/tuple一致，重新stat当前socket：匹配标记可尝试连接，缺失/替换标记不可确认或旧端点失效；是否online由后续transport ping/snapshot确认。读取登记本身不播报上线，不把mtime/文件存在当live。
6. 同一registry重复读取不制造新身份；同时两server记录不能互相覆盖。插件配置仅授予建立连接，不授予Coding Agent会话目录分析权限。读取器不修改权限数据库。

## Acceptance Contract

- POL-REGISTER-001：隔离registry/state/config、真实Unix socket与两个独立命名端点，用正式register入口不同子进程重复登记→两个instance、同端点同run不变，内容无秘密/会话正文；文件与app读取结果独立核对。受控socket只验证登记文件，不冒充Herdr集成。
- POL-REGISTER-002：端点停用后同路径重建socket→instance稳定、run更新；旧记录读取时不判online/stop；损坏namespace不换身份，半截/超限/错误schema记录不影响合法实例；并发同端点action不生成不同namespace/run，原子文件始终可读。
- POL-REGISTER-003：真实新Herdr具名server、隔离XDG，link正式插件后手动action（此前无startup）→登记成功；同server重复action稳定；stop后同session重启由startup登记新run；另一server并存不混合。app读取后用正式transport ping当前记录验证；所有server/socket/目录退出清理。使用本轮自建配置信任授权，不访问默认session/真实HOME配置，不GUI/真实模型。

原生socket fixture和真实HerdrCase分明，真实Case显式手动运行且不加入默认npm test。若复用现有隔离生命周期代码需要先报告可复用位置，不复制五百行探针作为正式业务。证据evidence/s05d-registration；先保留原失败再修，不改Expected。最终报告运行依赖、已验事实、清理及main安装/发现/adapter/通知尚未接入边界。
