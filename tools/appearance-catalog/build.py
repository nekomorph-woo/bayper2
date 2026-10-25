#!/usr/bin/env python3
"""将 appearance-catalog 的 CSV 编辑源构建为 SQLite 派生快照。"""

import argparse
import csv
import os
import sqlite3
import tempfile
from pathlib import Path

TOOL_ROOT = Path(__file__).resolve().parent
DATA_DIR = TOOL_ROOT / "data"
DEFAULT_OUTPUT = DATA_DIR / "catalog.sqlite"

TABLE_COLUMNS = {
    "styles": ("style_id", "label", "reference_path", "reference_cell", "approval", "notes"),
    "dimensions": ("dimension_id", "group_name", "label", "value_kind", "reference_basis", "pixel_policy"),
    "options": ("option_id", "dimension_id", "label", "definition", "status"),
    "recipes": ("recipe_id", "style_id", "label", "status", "notes"),
    "recipe_values": ("recipe_id", "dimension_id", "option_id", "value", "evidence"),
    "design_guidance": (
        "recipe_id", "dimension_id", "design_role", "reason", "coordination_basis"
    ),
    "constraints": ("constraint_id", "dimension_refs", "rule", "check_stage", "status"),
    "assets": ("asset_id", "recipe_id", "path", "locator", "kind", "status", "notes"),
}

SCHEMA = """
CREATE TABLE "styles" (
    "style_id" TEXT PRIMARY KEY NOT NULL, "label" TEXT, "reference_path" TEXT,
    "reference_cell" TEXT, "approval" TEXT, "notes" TEXT
);

CREATE TABLE "dimensions" (
    "dimension_id" TEXT PRIMARY KEY NOT NULL, "group_name" TEXT, "label" TEXT,
    "value_kind" TEXT, "reference_basis" TEXT, "pixel_policy" TEXT
);

CREATE TABLE "options" (
    "option_id" TEXT PRIMARY KEY NOT NULL,
    "dimension_id" TEXT NOT NULL REFERENCES "dimensions"("dimension_id"),
    "label" TEXT, "definition" TEXT, "status" TEXT,
    UNIQUE ("option_id", "dimension_id")
);

CREATE TABLE "recipes" (
    "recipe_id" TEXT PRIMARY KEY NOT NULL,
    "style_id" TEXT NOT NULL REFERENCES "styles"("style_id"),
    "label" TEXT, "status" TEXT, "notes" TEXT
);

CREATE TABLE "recipe_values" (
    "recipe_id" TEXT NOT NULL REFERENCES "recipes"("recipe_id"),
    "dimension_id" TEXT NOT NULL REFERENCES "dimensions"("dimension_id"),
    "option_id" TEXT, "value" TEXT, "evidence" TEXT,
    PRIMARY KEY ("recipe_id", "dimension_id"),
    -- SQLite 的复合外键在 option_id 为 NULL 时跳过，非空时须与同行维度配对存在。
    FOREIGN KEY ("option_id", "dimension_id")
        REFERENCES "options"("option_id", "dimension_id")
);

CREATE TABLE "design_guidance" (
    "recipe_id" TEXT NOT NULL REFERENCES "recipes"("recipe_id"),
    "dimension_id" TEXT NOT NULL REFERENCES "dimensions"("dimension_id"),
    "design_role" TEXT, "reason" TEXT, "coordination_basis" TEXT,
    PRIMARY KEY ("recipe_id", "dimension_id")
);

CREATE TABLE "constraints" (
    "constraint_id" TEXT PRIMARY KEY NOT NULL, "dimension_refs" TEXT,
    "rule" TEXT, "check_stage" TEXT, "status" TEXT
);

CREATE TABLE "assets" (
    "asset_id" TEXT PRIMARY KEY NOT NULL,
    "recipe_id" TEXT NOT NULL REFERENCES "recipes"("recipe_id"),
    "path" TEXT, "locator" TEXT, "kind" TEXT, "status" TEXT, "notes" TEXT
);
"""


def read_csv(path, columns):
    with path.open("r", encoding="utf-8", newline="") as file:
        reader = csv.reader(file)
        try:
            header = next(reader)
        except StopIteration as error:
            raise ValueError(f"{path.name} 没有表头") from error
        if tuple(header) != columns:
            raise ValueError(f"{path.name} 表头与固定列名不一致: {header}")
        rows = []
        for line_number, fields in enumerate(reader, start=2):
            if len(fields) != len(columns):
                raise ValueError(f"{path.name} 第 {line_number} 行列数不一致")
            rows.append(tuple(None if field == "" else field for field in fields))
    return rows


def validate_constraint_refs(constraints, dimensions):
    dimension_index = TABLE_COLUMNS["dimensions"].index("dimension_id")
    dimension_ids = {row[dimension_index] for row in dimensions}
    refs_index = TABLE_COLUMNS["constraints"].index("dimension_refs")

    for line_number, row in enumerate(constraints, start=2):
        refs = row[refs_index]
        if refs is None:
            continue
        for dimension_id in (part.strip() for part in refs.split(";")):
            if not dimension_id or dimension_id not in dimension_ids:
                raise ValueError(
                    f"constraints 第 {line_number} 行引用无效: {dimension_id!r}"
                )


def load_catalog():
    data = {}
    for table, columns in TABLE_COLUMNS.items():
        data[table] = read_csv(DATA_DIR / f"{table}.csv", columns)
    validate_constraint_refs(data["constraints"], data["dimensions"])
    return data


def insert_rows(connection, table, rows):
    columns = TABLE_COLUMNS[table]
    column_list = ", ".join(f'"{column}"' for column in columns)
    placeholders = ", ".join("?" for _ in columns)
    connection.executemany(
        f'INSERT INTO "{table}" ({column_list}) VALUES ({placeholders})', rows
    )


def write_database(data, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=target.parent, prefix=f".{target.name}.", suffix=".tmp"
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)

    try:
        connection = sqlite3.connect(temporary_path)
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.executescript(SCHEMA)
            for table in TABLE_COLUMNS:
                insert_rows(connection, table, data[table])
            connection.commit()

            violations = connection.execute("PRAGMA foreign_key_check").fetchall()
            if violations:
                raise RuntimeError(f"外键校验失败: {violations}")
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
            if integrity != "ok":
                raise RuntimeError(f"完整性检查失败: {integrity}")
        finally:
            connection.close()
        os.replace(temporary_path, target)
    except BaseException:
        for suffix in ("", "-journal", "-wal", "-shm"):
            Path(f"{temporary_path}{suffix}").unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description="由外观资料 CSV 构建 SQLite 派生快照。")
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="SQLite 输出路径；默认写入资料目录的 catalog.sqlite",
    )
    args = parser.parse_args()

    data = load_catalog()
    write_database(data, args.output)
    print(f"已生成 {args.output.resolve()}")
    for table in TABLE_COLUMNS:
        print(f"{table}: {len(data[table])} 行")


if __name__ == "__main__":
    main()
