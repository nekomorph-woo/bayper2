# Bayper

本仓库当前保留一个用于验证 Codex 调度、Claude Code 开发和独立验收流程的小工具。

## 文本转 URL slug

要求 Python 3，无第三方依赖。在项目根目录运行：

```sh
python3 tools/slugify.py 'Hello, World!'
```

输出为 `hello-world`。工具先转小写，仅保留 ASCII 字母和数字，将连续其他字符替换为一个连字符，并去掉首尾连字符。不做中文音译或重音折叠，例如 `你好 Café 123` 输出 `caf-123`。空字符串或纯标点输出空行；缺少参数或提供多个位置参数时，返回退出码 `2`，错误写入 stderr。

## 场景验收

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/scenarios -p 'test_*.py' -v
```

七个独立场景通过真实 CLI 子进程检查正常文本、连续分隔符、Unicode、空字符串、纯标点、缺少参数和多余参数。Expected 使用固定字面量，同时核对退出码、stdout 和 stderr，不使用 Mock。

协作职责见 [AGENTS.md](AGENTS.md)，Claude Code 的开发者入口见 [CLAUDE.md](CLAUDE.md)。
