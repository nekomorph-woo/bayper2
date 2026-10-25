"""通过真实 CLI 子进程验证 tools/slugify.py 的七个场景。"""

import subprocess
import sys
import unittest
from pathlib import Path

# 由测试文件位置定位仓库根目录，不依赖当前工作目录或临时记录。
_REPO_ROOT = Path(__file__).resolve().parents[2]
_TOOL_PATH = _REPO_ROOT / "tools" / "slugify.py"


class SlugifyCliTests(unittest.TestCase):
    """以固定字面量校验 CLI 的退出码、stdout 与 stderr。"""

    def test_POL_SLUG_001_hello_world_123(self):
        # Given：含空格和数字的普通英文文本。
        # When：通过真实 CLI 传入 "Hello World 123"。
        result = subprocess.run(
            [sys.executable, str(_TOOL_PATH), "Hello World 123"],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

        # Result：进程退出码与输出流。
        # Expected：退出码 0，stdout 为固定 slug 加换行，stderr 为空。
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "hello-world-123\n")
        self.assertEqual(result.stderr, "")

    def test_POL_SLUG_002_separator_runs(self):
        # Given：前后有空格、中间夹杂多组下划线和连字符的文本。
        # When：通过真实 CLI 传入 "  A___B---C!! "。
        result = subprocess.run(
            [sys.executable, str(_TOOL_PATH), "  A___B---C!! "],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

        # Result：进程退出码与输出流。
        # Expected：退出码 0，stdout 为固定 slug 加换行，stderr 为空。
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "a-b-c\n")
        self.assertEqual(result.stderr, "")

    def test_POL_SLUG_003_non_ascii(self):
        # Given：包含中文和带重音字符的文本，不做音译。
        # When：通过真实 CLI 传入 "你好 Café 123"。
        result = subprocess.run(
            [sys.executable, str(_TOOL_PATH), "你好 Café 123"],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

        # Result：进程退出码与输出流。
        # Expected：退出码 0，stdout 为固定 slug 加换行，stderr 为空。
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "caf-123\n")
        self.assertEqual(result.stderr, "")

    def test_POL_SLUG_004_empty_argument(self):
        # Given：显式传入的空字符串参数。
        # When：通过真实 CLI 传入 ""。
        result = subprocess.run(
            [sys.executable, str(_TOOL_PATH), ""],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

        # Result：进程退出码与输出流。
        # Expected：退出码 0，stdout 只有一个换行，stderr 为空。
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "\n")
        self.assertEqual(result.stderr, "")

    def test_POL_SLUG_005_only_separators(self):
        # Given：只包含非字母数字字符的文本。
        # When：通过真实 CLI 传入 "!!!"。
        result = subprocess.run(
            [sys.executable, str(_TOOL_PATH), "!!!"],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

        # Result：进程退出码与输出流。
        # Expected：退出码 0，stdout 只有一个换行，stderr 为空。
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "\n")
        self.assertEqual(result.stderr, "")

    def test_POL_SLUG_006_missing_argument(self):
        # Given：不提供任何位置参数。
        # When：仅通过真实 CLI 调用工具本身。
        result = subprocess.run(
            [sys.executable, str(_TOOL_PATH)],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

        # Result：进程退出码与输出流。
        # Expected：退出码 2，stdout 为空，stderr 非空。
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertNotEqual(result.stderr, "")

    def test_POL_SLUG_007_extra_argument(self):
        # Given：提供两个位置参数。
        # When：通过真实 CLI 传入 "one" 和 "two"。
        result = subprocess.run(
            [sys.executable, str(_TOOL_PATH), "one", "two"],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

        # Result：进程退出码与输出流。
        # Expected：退出码 2，stdout 为空，stderr 非空。
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertNotEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
