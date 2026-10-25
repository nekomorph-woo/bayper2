# Bayper Herdr 登记插件

这是正式连接器的端点登记部分。Herdr启动时以及用户调用“关联 Bayper”action时，短命Node进程写入一条可供Bayper读取的端点登记；不会启动Bayper、读取会话正文或调用模型。当前尚未接入Bayper安装界面、自动发现和通知。

依赖：macOS、Herdr≥0.9.5及Herdr环境PATH中的Node。插件只使用Node内置模块，不依赖项目node_modules。

插件配置目录中必须有 `bayper.json`，字段 `registryDir` 为明确的绝对目录路径；未来安装流程由Bayper配置。缺配置直接报错，不猜测用户目录。安装namespace保存在Herdr注入的插件state目录；不要删除它来修复普通断连，否则会改变安装身份。配置只用于端点连接，不授予Coding Agent会话分析权限。

同一安装namespace与规范socket路径派生稳定instanceId；socket元数据及观察父server PID派生runId。不同server不混用实例，同端点重启换run。重复action不新建run。registry写入原子JSON，应用读取核对字段派生与当前socket，不把登记文件存在当作上线或server停止。

隔离验收入口：项目根目录执行 `node --test tests/acceptance/herdr-registration.spec.cjs`。该手动集合会创建自己的临时socket与具名Herdr server，并清理；不要替换为现有工作session。001/002/004使用受控真实Unix socket，003用真实Herdr与正式transport。正式判断及边界见 `.hapilon/polaris/Bayper完整交付/s05d-review.md`。原始证据保留在该工作目录evidence/s05d-registration。
