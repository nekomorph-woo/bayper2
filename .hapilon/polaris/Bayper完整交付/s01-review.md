# S01 独立审查与返修记录

2026-10-25，Codex。实现仍在进行，本页不代表最终验收。

## 真实模型授权与诊断

用户明确授权读取根`.env`中的OPEN_AI_BASE_URL/OPEN_AI_API_KEY并用于需要的地方。已核对`.env`被Git忽略；不在日志、截图、文档写入Key。来源为官方api.deepseek.com/v1。GET models实际返回deepseek-flash和deepseek-v4-pro；选flash进行轻量构造数据验证。

调用当前app/model.cjs真实checkModelConnection，得到INVALID_RESPONSE（有效助手文本缺失）。这只是模块诊断，不是POL-ONBOARD-006 UI验收。官方文档https://api-docs.deepseek.com/guides/thinking_mode/说明默认开启thinking；现有32 token上限不适合此默认。请求不能仅凭HTTP成功通过，当前拒绝无效回复正确，但产品需要提供可用配置。

返修目标：官方DeepSeek短连通检查显式关闭thinking，足够短文本预算与合理超时；通用兼容服务不要无条件发送DeepSeek专有字段，依配置/服务host明确处理，不搭供应商框架。真实窗口配置→接纳→重启，并通过主进程安全解密再次验证一次固定短请求。禁止输出Key或reasoning_content。运行测试可从根.env在独立测试进程读取，不向用户索取明文。

## 审查风险待核实

- HTTP请求默认跟随重定向可能偏离用户选择的服务，应拒绝重定向并给出明确错误，防止HTTPS策略被跳转绕过；增加受控server重定向场景验证无下游请求。
- schema目前只支持单个fixed槽位，符合S01局部；S02改结构时必须处理已有数据库迁移，不只改CREATE IF NOT EXISTS。
- 角色内容为开发候选，后续替换正式资产与完整设定，不得把此切片等同S07完成。

## 返修与独立复验

官方host限定关闭thinking，短请求64token/30秒超时；其它服务不发送私有参数。重定向已拒绝且受控下游0请求断言通过。真实窗口选择deepseek-flash，完成配置/接纳/退出重启/主进程解密再连通；真实test独立入口不混入普通回归。最后发现live测试第二轮日志数组被提前复制，已交Claude修正为保留实时数组、退出后统一检查。

Codex随后独立执行npm test（6/6）、test:acceptance（6/6）和test:live（1/1）全部通过，后者实际2次真实短请求。已审阅真实成功截图。当前切片决定与未验证边界见evaluation.md。
