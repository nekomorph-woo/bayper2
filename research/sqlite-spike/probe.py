"""SQLite 存储与检索最小实测合同 SQL-01..06 的固定探针。

用法：python3 probe.py --work-dir <调用方提供的空临时根>
结果 JSON 写 stdout，进度写 stderr；不删除数据库，留给 Codex 独立检查。
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

from store import MemoryStore

SEEDS = [
    "写代码时喜欢安静",
    "家里养了一只猫",
    "喜欢热闹，欢迎主动招呼",
    "SQLite 是嵌入式数据库",
    "我用 Python 写代码，也喜欢 SQLite",
    "别来烦我",
    "保持安静",
    "安静地写代码，不要打扰",
    "安插静默",
    "今天想喝咖啡",
]
CORRECT_ID = 3
FAIL_ID = 10
OLD_BODY = SEEDS[CORRECT_ID - 1]
NEW_BODY = "需要安静，请减少主动招呼"


def log(message: str) -> None:
    print(f"[probe] {message}", file=sys.stderr, flush=True)


def ids(hits: list[dict[str, Any]]) -> list[int]:
    return [hit["id"] for hit in hits]


def searches(store: MemoryStore, *queries: str) -> dict[str, list[dict[str, Any]]]:
    """同一批查询在纠正前后重复取样，保留真实命中与分数。"""
    return {query: store.search(query) for query in queries}


def raw_phrase(text: str) -> str:
    """直接使用原文，避免套用本实验的字符 tokenizer。"""
    return '"' + text.replace('"', '""') + '"'


def raw_fts_hits(db_path: Path) -> dict[str, list[int]]:
    """建立独立原文 FTS 表，记录 unicode61/trigram 的真实查询结果。"""
    conn = sqlite3.connect(db_path)
    try:
        tables = {"unicode61": "spike_raw_unicode61", "trigram": "spike_raw_trigram"}
        for tokenizer_name, table in tables.items():
            conn.execute(f"DROP TABLE IF EXISTS {table}")
            create_sql = (
                f"CREATE VIRTUAL TABLE {table} USING fts5("
                f"body, tokenize='{tokenizer_name}')"
            )
            conn.execute(create_sql)
            conn.executemany(
                f"INSERT INTO {table}(rowid, body) VALUES (?, ?)",
                list(enumerate(SEEDS, 1)),
            )
        conn.commit()
        lookups = {
            "unicode61_安静": (tables["unicode61"], "安静"),
            "trigram_安静": (tables["trigram"], "安静"),
            "trigram_写代码": (tables["trigram"], "写代码"),
            "unicode61_写代码时喜欢安静": (tables["unicode61"], "写代码时喜欢安静"),
        }
        hits = {}
        for label, (table, query) in lookups.items():
            sql = (
                f"SELECT rowid FROM {table} "
                f"WHERE {table} MATCH ? "
                f"ORDER BY bm25({table})"
            )
            rows = conn.execute(sql, (raw_phrase(query),)).fetchall()
            hits[label] = [row[0] for row in rows]
        return hits
    finally:
        conn.close()


def case_sql_01(store: MemoryStore, db_path: Path) -> dict[str, Any]:
    log("SQL-01：字符 token 与原文 unicode61/trigram 对照")
    raw = raw_fts_hits(db_path)
    char_hits = searches(
        store, "猫", "安静", "写代码", "安插静默", "SQLite", "sqlite", "Python"
    )
    assert ids(char_hits["猫"]) == [2], char_hits["猫"]
    assert set(ids(char_hits["安静"])) == {1, 7, 8}, char_hits["安静"]
    assert 9 not in ids(char_hits["安静"]), "‘安插静默’中的安静不连续，不应命中"
    assert ids(char_hits["安插静默"]) == [9], char_hits["安插静默"]
    assert set(ids(char_hits["写代码"])) == {1, 5, 8}, char_hits["写代码"]
    assert set(ids(char_hits["SQLite"])) == {4, 5}, char_hits["SQLite"]
    assert set(ids(char_hits["sqlite"])) == {4, 5}, char_hits["sqlite"]
    assert ids(char_hits["Python"]) == [5], char_hits["Python"]
    assert raw["unicode61_安静"] == [], raw
    assert raw["trigram_安静"] == [], raw
    assert set(raw["trigram_写代码"]) == {1, 5, 8}, raw
    assert raw["unicode61_写代码时喜欢安静"] == [1], raw
    assert store.search("🙂") == [], "无 token 查询应返回空"
    return {
        "given": "10 条固定构造记录；另建原文 unicode61/trigram 独立 FTS 表",
        "when": "用单字、连续词、非连续字、英文字词（含大小写）及原文短语查询",
        "result": {
            "sqlite_version": sqlite3.sqlite_version,
            "fts_config": "外部内容表 memories_fts，tokenize=unicode61，正文取自 memories",
            "character_scheme": "逐汉字（U+3400–U+9FFF）+ 英文/数字/下划线词，见 store.TOKEN_PATTERN",
            "limitation": "逐字符 token 是有限字符索引，不是分词；其他文字不保证召回。",
            "raw_fts": raw,
            "char_hits": char_hits,
            "empty_token_query": [],
        },
        "expected": "单字与连续词命中；原文短词可漏；非连续字不冒充连续词；英文大小写归一",
    }


def case_sql_02(store: MemoryStore) -> dict[str, Any]:
    log("SQL-02：同义改写与人工 OR 展开")
    direct = searches(store, "保持安静", "别来烦我")
    expanded = store.search(["保持安静", "别来烦我"])
    assert ids(direct["保持安静"]) == [7], direct
    assert ids(direct["别来烦我"]) == [6], direct
    assert set(ids(expanded)) == {6, 7}, expanded
    return {
        "given": "构造“别来烦我”与“保持安静”，两者没有相同字词",
        "when": "分别直接查询，再由人工给出展开表做 OR 查询",
        "result": {"direct": direct, "manual_or": expanded},
        "expected": "直接查询不互相召回；人工展开可召回，但不冒充模型语义能力",
    }


def case_sql_03(store: MemoryStore) -> dict[str, Any]:
    log("SQL-03：真实 bm25 排序")
    hits = store.search("写代码")
    scores = [hit["score"] for hit in hits]
    assert len(hits) >= 2, hits
    assert all(score < 0 for score in scores), "SQLite bm25 返回负值"
    assert scores == sorted(scores), scores
    return {
        "given": "多条记录含查询词“写代码”，长度不同",
        "when": "通过 store.search 执行 FTS5 MATCH 并读取 bm25",
        "result": {"query": "写代码", "hits": hits},
        "expected": "结果非空，分数为真实 bm25 且升序；分数不代表可信度或重要性",
    }


def case_sql_04(store: MemoryStore) -> dict[str, Any]:
    log("SQL-04：明确 id 纠正与旧内容失效")
    before = {"get": store.get(CORRECT_ID), **searches(store, "热闹", "安静", "招呼")}
    assert before["get"] == {"id": CORRECT_ID, "body": OLD_BODY, "version": 1}, before
    assert ids(before["热闹"]) == [CORRECT_ID], before
    assert set(ids(before["安静"])) == {1, 7, 8}, before
    assert ids(before["招呼"]) == [CORRECT_ID], before

    updated = store.correct(CORRECT_ID, NEW_BODY)
    assert updated["body"] == NEW_BODY and updated["version"] == 2, updated
    after = {
        "get": store.get(CORRECT_ID),
        **searches(store, "热闹", "安静", "招呼"),
        "旧全文": store.search(OLD_BODY),
        "审计": store.revisions(CORRECT_ID),
    }
    assert after["get"]["body"] == NEW_BODY, after
    assert after["热闹"] == [], "旧词不应再命中"
    assert set(ids(after["安静"])) == {1, 3, 7, 8}, after["安静"]
    assert ids(after["招呼"]) == [CORRECT_ID], after["招呼"]
    assert all(hit["body"] != OLD_BODY for hit in after["安静"]), after["安静"]
    assert after["旧全文"] == [], "旧正文完整短语不应命中"
    audit = after["审计"]
    assert len(audit) == 1, audit
    assert (audit[0]["old_body"], audit[0]["new_body"]) == (OLD_BODY, NEW_BODY), audit
    assert (audit[0]["old_version"], audit[0]["new_version"]) == (1, 2), audit
    unknown_id_error = False
    try:
        store.correct(9999, "不存在的记录")
    except KeyError:
        unknown_id_error = True
    assert unknown_id_error, "未知 id 应报错"
    return {
        "given": "id=3 的现行记录“喜欢热闹，欢迎主动招呼”",
        "when": "用明确 id 纠正为“需要安静，请减少主动招呼”",
        "result": {"before": before, "after": after, "unknown_id_error": unknown_id_error},
        "expected": "新正文、新版本与审计同事务提交；旧词和旧正文不再由 get/search 重现",
    }


def case_sql_05(store: MemoryStore, db_path: Path) -> dict[str, Any]:
    log("SQL-05：重开磁盘库并重建 FTS")
    reopened = store.get(CORRECT_ID)
    assert reopened["body"] == NEW_BODY and reopened["version"] == 2, reopened
    store.rebuild()
    state = {
        "get_3": store.get(CORRECT_ID),
        "get_2": store.get(2),
        **searches(store, "热闹", "安静", "招呼"),
        "旧全文": store.search(OLD_BODY),
        "审计": store.revisions(CORRECT_ID),
    }
    assert state["get_3"]["body"] == NEW_BODY, state
    assert state["get_2"]["body"] == "家里养了一只猫" and state["get_2"]["version"] == 1, state
    assert state["热闹"] == [], "旧词不应回到索引"
    assert set(ids(state["安静"])) == {1, 3, 7, 8}, state["安静"]
    assert ids(state["招呼"]) == [CORRECT_ID], state["招呼"]
    assert state["旧全文"] == [], "旧正文不在现行表"
    assert len(state["审计"]) == 1, "审计仍保留旧正文供检查"
    return {
        "given": "SQL-04 纠正已提交，随后关闭数据库连接",
        "when": "从同一磁盘文件重开连接并执行 FTS rebuild",
        "result": {"reopened_from": str(db_path), "after_rebuild": state},
        "expected": "只能取回新正文；旧审计正文不重返索引；其他记录不变",
    }


def case_sql_06(store: MemoryStore) -> dict[str, Any]:
    log("SQL-06：审计触发器中止纠正并整体回滚")
    old_body, new_body = "今天想喝咖啡", "今天想喝茶"
    store.conn.execute(
        f"""
        CREATE TRIGGER spike_block_audit_v2
        BEFORE INSERT ON revision_audit
        WHEN NEW.new_version = 2 AND NEW.memory_id = {FAIL_ID}
        BEGIN
            SELECT RAISE(ABORT, '实验：阻止该记忆第二版审计写入');
        END
        """
    )
    store.conn.commit()
    error = None
    try:
        try:
            store.correct(FAIL_ID, new_body)
        except sqlite3.IntegrityError as exc:
            error = str(exc)
        assert error is not None, "触发器未阻止纠正"
    finally:
        store.conn.execute("DROP TRIGGER spike_block_audit_v2")
        store.conn.commit()
    failed = {
        "get": store.get(FAIL_ID),
        **searches(store, "咖啡", "茶"),
        "审计": store.revisions(FAIL_ID),
    }
    assert failed["get"]["body"] == old_body and failed["get"]["version"] == 1, failed
    assert ids(failed["咖啡"]) == [FAIL_ID], "旧词仍应由旧正文命中"
    assert failed["茶"] == [], "新 token 不应残留"
    assert failed["审计"] == [], "审计应回滚"

    retried = store.correct(FAIL_ID, new_body)
    success = {
        "get": store.get(FAIL_ID),
        **searches(store, "咖啡", "茶"),
        "审计": store.revisions(FAIL_ID),
    }
    assert retried["version"] == 2 and success["get"]["body"] == new_body, success
    assert success["咖啡"] == [], success
    assert ids(success["茶"]) == [FAIL_ID], success
    assert len(success["审计"]) == 1 and success["审计"][0]["new_version"] == 2, success
    return {
        "given": "id=10 的现行记录；临时 BEFORE INSERT 触发器阻止其第二版审计",
        "when": "先执行纠正触发真实 SQLite 错误，再移除触发器重试",
        "result": {"failed_error": error, "failed_state": failed, "retried_after_drop": success},
        "expected": "首次失败完整回滚正文/版本/FTS/审计；移除障碍后同一纠正成功",
    }


def run(result: dict[str, Any], db_path: Path) -> None:
    store = MemoryStore(db_path)
    try:
        result["seed"] = {"bodies": SEEDS, "ids": [store.add(body) for body in SEEDS]}
        log(f"已在 {db_path} 构造 {len(SEEDS)} 条记录")
        result["SQL-01"] = case_sql_01(store, db_path)
        result["SQL-02"] = case_sql_02(store)
        result["SQL-03"] = case_sql_03(store)
        result["SQL-04"] = case_sql_04(store)
        store.close()
        store = MemoryStore(db_path)
        result["SQL-05"] = case_sql_05(store, db_path)
        result["SQL-06"] = case_sql_06(store)
    finally:
        store.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="SQLite/FTS5 最小实测合同 SQL-01..06")
    parser.add_argument("--work-dir", required=True, help="调用方提供的专用临时根目录")
    args = parser.parse_args(argv)
    work_dir = Path(args.work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    db_path = work_dir / "sqlite-spike.db"
    if db_path.exists():
        print(f"数据库已存在，请改用新的临时根: {db_path}", file=sys.stderr)
        return 2
    result: dict[str, Any] = {"db_path": str(db_path)}
    try:
        run(result, db_path)
    except AssertionError as exc:
        print(json.dumps({"status": "FAILED", **result}, ensure_ascii=False, indent=2))
        print(f"[probe] 断言失败: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"status": "PASSED", **result}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
