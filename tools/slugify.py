"""把文本转换为 URL slug 的命令行工具。"""

import argparse
import re

# 连续的“非 ASCII 小写字母或数字”字符整体替换为一个连字符。
_SEPARATOR_RUN = re.compile(r"[^a-z0-9]+")


def slugify(text: str) -> str:
    """返回文本对应的 slug。

    先转小写，仅保留 ASCII a-z 和 0-9，其余连续字符合并为一个连字符，
    再删除首尾连字符；不做音译，因此结果可能为空字符串。
    """
    return _SEPARATOR_RUN.sub("-", text.lower()).strip("-")


def main() -> None:
    """解析单个位置参数，向 stdout 输出 slug。"""
    parser = argparse.ArgumentParser(description="把文本转换为 URL slug。")
    parser.add_argument("text", help="要转换的文本")
    args = parser.parse_args()
    print(slugify(args.text))


if __name__ == "__main__":
    main()
