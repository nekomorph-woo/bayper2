"""SQLite 记忆存储最小实测：现行记录与审计分离，FTS5 字符索引同步。

仅用于研究。字符 token 是有限匹配手段，不是分词或语义理解；
其他文字（如日文假名）不保证被索引。
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from typing import Any

# 逐汉字 + 英文/数字/下划线词；正文原文保留在 memories.body。
TOKEN_PATTERN = re.compile(r"[\u3400-\u9fff]|[A-Za-z0-9_]+")

SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY,
    body TEXT NOT NULL,
    tokens TEXT NOT NULL,
    version INTEGER NOT NULL
);

-- 审计单独存放，只供检查历史；get/search 只读 memories。
CREATE TABLE IF NOT EXISTS revision_audit (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    old_body TEXT NOT NULL,
    new_body TEXT NOT NULL,
    old_version INTEGER NOT NULL,
    new_version INTEGER NOT NULL
);

-- FTS 外部内容来自 memories，不另存正文；触发器同步现行 token。
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    tokens,
    content='memories',
    content_rowid='id',
    tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, tokens) VALUES (new.id, new.tokens);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, tokens)
    VALUES ('delete', old.id, old.tokens);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, tokens)
    VALUES ('delete', old.id, old.tokens);
    INSERT INTO memories_fts(rowid, tokens) VALUES (new.id, new.tokens);
END;
"""


def tokenize(text: str) -> list[str]:
    """切出可索引字符；未覆盖的文字不会自动形成可检索 token。"""
    return TOKEN_PATTERN.findall(text.lower())


def phrase(tokens: list[str]) -> str:
    """拼成 FTS5 引号短语；空格表示 token 必须连续出现。"""
    return '"' + " ".join(tokens) + '"'


class MemoryStore:
    """磁盘 SQLite；memories 是唯一有效来源，revision_audit 仅供审计。"""

    def __init__(self, db_path: str | Path):
        self.path = Path(db_path)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)

    def add(self, body: str) -> int:
        """新增现行记录，初始版本为 1；FTS 由触发器同步。"""
        with self.conn:
            cursor = self.conn.execute(
                "INSERT INTO memories(body, tokens, version) VALUES (?, ?, 1)",
                (body, " ".join(tokenize(body))),
            )
        return cursor.lastrowid

    def get(self, memory_id: int) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT id, body, version FROM memories WHERE id = ?",
            (memory_id,),
        ).fetchone()
        return dict(row) if row is not None else None

    def search(self, queries: str | list[str]) -> list[dict[str, Any]]:
        """检索现行正文；多个短语由调用方显式给出并做 OR 展开。

        不做同义词或语义扩展。空 token 查询直接返回空列表。
        """
        if isinstance(queries, str):
            queries = [queries]
        matches = []
        for text in queries:
            tokens = tokenize(text)
            if tokens:
                matches.append(phrase(tokens))
        if not matches:
            return []
        rows = self.conn.execute(
            """
            SELECT m.id, m.body, m.version, bm25(memories_fts) AS score
            FROM memories_fts
            JOIN memories AS m ON m.id = memories_fts.rowid
            WHERE memories_fts MATCH ?
            ORDER BY score ASC, m.id ASC
            """,
            (" OR ".join(matches),),
        ).fetchall()
        return [dict(row) for row in rows]

    def correct(self, memory_id: int, new_body: str) -> dict[str, Any]:
        """按明确 id 纠正：正文、token、版本与审计同事务提交。

        未知 id 抛 KeyError；数据库写入失败时事务整体回滚。
        """
        row = self.conn.execute(
            "SELECT body, version FROM memories WHERE id = ?",
            (memory_id,),
        ).fetchone()
        if row is None:
            raise KeyError(f"未知 memory id: {memory_id}")
        new_version = row["version"] + 1
        with self.conn:
            self.conn.execute(
                "UPDATE memories SET body = ?, tokens = ?, version = ? WHERE id = ?",
                (new_body, " ".join(tokenize(new_body)), new_version, memory_id),
            )
            self.conn.execute(
                """
                INSERT INTO revision_audit(
                    memory_id, action, old_body, new_body, old_version, new_version
                ) VALUES (?, 'correct', ?, ?, ?, ?)
                """,
                (memory_id, row["body"], new_body, row["version"], new_version),
            )
        return self.get(memory_id)

    def revisions(self, memory_id: int) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT audit_id, memory_id, action, old_body, new_body, old_version, new_version
            FROM revision_audit WHERE memory_id = ? ORDER BY audit_id
            """,
            (memory_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def rebuild(self) -> None:
        """只用现行 memories 表重建 FTS；审计正文不会进入索引。"""
        with self.conn:
            self.conn.execute("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")

    def close(self) -> None:
        self.conn.close()
