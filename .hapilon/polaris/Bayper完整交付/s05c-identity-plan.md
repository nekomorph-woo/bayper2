# S05c 插件登记前的运行身份验证

Codex受托确认。目标是为正式Herdr插件的稳定instanceId/runId与晚启动发现选择有证据的方案，不重复一般传输探针。s05b-protocol-review.md已证明snapshot无server run ID；官方https://herdr.dev/docs/plugins/（2026-10-26核对）说明startup仅server启动/接管运行，link/enable不触发；插件state目录跨session共享。需核实运行上下文及可用进程身份，不能把每次action UUID当server重启。

## 范围和纪律

仅新增tools/herdr-identity/下的probe.cjs、fixture/herdr-plugin.toml、fixture/record.cjs及证据子目录；工具自包含。允许额外一个小配置数据文件若确有必要。生产app、现有测试、research、版本、Git、其他工具不得修改。代码Claude Code；说明和最终接受Codex。总可执行代码约250～350行信号，直接步骤，不搭日志/生命周期框架。可读已有herdr-live隔离方式，不复制整个619行集合。

仅新短/tmp根，显式XDG_CONFIG_HOME/STATE_HOME/DATA_HOME/HERDR_CONFIG_PATH与随机具名session，同一隔离XDG下两个自建server。不修改HOME/全局配置，不读取.env，不GUI、不模型、不读取任何用户会话正文。所有CLI运行态命令必须显式本轮session或已确认本轮socket；禁止对默认/已有session作status等只读探查。上一任务自报一次默认status超范围，本轮不得重复。help/schema可用于语法，不连接运行态。

允许信任并link本轮自己创建审查过的fixture，仅隔离XDG；安装登记全用户语义须确认实际文件只在隔离目录。fixture不生成长期daemon，不打开GUI，不改变系统偏好。Herdr自身注入HERDR_ENV合法，外部调度不得伪造。finally停止自建server并等待退出，核对socket与全部自建目录清理；禁止pkill/killall。失败不得覆盖证据。

## 采集与判断

fixture仅记录白名单：HERDR_SOCKET_PATH/BIN_PATH/PLUGIN_ID/ROOT/CONFIG_DIR/STATE_DIR/EVENT/ACTION_ID，context的字段名及必要会话身份（不记录selected_text/终端内容等）；自己的pid/ppid；socket stat dev/ino/birthtime/ctime（BigInt转字符串）；对自己直接父PID用ps读取pid/ppid/comm/lstart（不读env/完整敏感参数）。若有本轮server拥有的pid文件可记录其路径与pid，先确认位于本轮根。结果只存工具evidence，临时payload脱敏根路径。

真实启动server句柄PID作为独立Oracle；观察startup与action父PID是否对应它，比较socket生命周期。不以ps秒精度或kill(pid,0)单独宣称能排除PID复用；结论区分可靠事实、局限及下一实现选择。若无可靠证明则保持disconnected/unknown，不能假称server stop。

## Acceptance Contract

- POL-HERDR-ID-001：两server使用同隔离配置安装fixture；首次link已运行server时不应假定startup，显式action取得上下文；两server的socket与所属运行PID可区分，共享plugin state目录事实可确认。保留真实命令与字段。
- POL-HERDR-ID-002：同server连续两次action、重新建立生产transport ping：观察到的server运行身份保持一致，不能每次action算新run；stop后同名session重启，startup发生且新server PID/socket代次能区分。对旧身份只能在实际进程退出/端点替换证据下判结束。
- POL-HERDR-ID-003：Bayper侧尚未运行时fixture记录仍存在；以独立读取者读取登记样本后使用生产herdr-transport ping验证。该Case只证明上下文可持久保存并被晚到读取，不冒充正式自动发现或完整插件。两个server退出后核对无fixture进程、socket及临时目录残留。

输出保留实测证据、实际运行命令、已证事实、无法排除情况。仅本机macOS0.9.5，不扩Windows，不实现通知/账本/正式installer。本次记录将决定紧接的正式插件登记方案，不以探针作为最终交付。
