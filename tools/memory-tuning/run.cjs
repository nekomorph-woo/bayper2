#!/usr/bin/env node
/* 本地记忆检索对照工具。直接调用 app/memory.cjs 的生产入口，使用真实 SQLite 与
   demo 构造数据；不另写检索模拟器，不调用模型或外部服务。
   输出逐条命中、漏召回、误命中、门禁违规和本地延迟，供 Codex 决定默认策略。 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createMemoryService } = require("../../app/memory.cjs");
const {
  RETRIEVAL_CONFIG,
  CONCEPTS,
} = require("../../app/memory-retrieval.cjs");
const { BASE_MS, buildDataset } = require("./dataset.cjs");

/* broad 是 hybrid 内部的候选机制；这里比较生产候选与基线，不把裸 broad 当作默认可交付策略。 */
const STRATEGIES = ["char", "segment", "expanded", "hybrid"];
const SPLITS = ["tune", "holdout", "codex", "r2"];
const LIMIT = 5;

function parseOutputPath() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--out");
  if (index === -1) {
    return path.join(__dirname, "results", "latest.json");
  }
  const value = args[index + 1];
  if (!value) {
    throw new Error("--out 需要一个文件路径。");
  }
  return path.resolve(process.cwd(), value);
}

function createClock() {
  let current = BASE_MS;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
    current: () => current,
  };
}

function openDatabase(directory) {
  const db = new DatabaseSync(path.join(directory, "memory-tuning.sqlite3"));
  db.exec(`
    CREATE TABLE relationships (
      character_id TEXT PRIMARY KEY,
      accepted_at TEXT NOT NULL
    );
  `);
  const insert = db.prepare(
    "INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)",
  );
  for (const characterId of ["role-a", "role-b", "role-c"]) {
    insert.run(characterId, "2026-01-01T00:00:00.000Z");
  }
  return db;
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function summarize(rows) {
  const expected = rows.reduce((total, row) => total + row.expectedLabels.length, 0);
  const hits = rows.reduce((total, row) => total + row.hitLabels.length, 0);
  const falseHits = rows.reduce((total, row) => total + row.unexpectedLabels.length, 0);
  const violations = rows.reduce((total, row) => total + row.violations.length, 0);
  const latencies = rows.map((row) => row.latencyMs);
  return {
    queries: rows.length,
    expected,
    hits,
    recall: expected === 0 ? null : Number((hits / expected).toFixed(4)),
    top1Hits: rows.filter(
      (row) => row.returnedLabels[0] && row.expectedLabels.includes(row.returnedLabels[0]),
    ).length,
    top1Eligible: rows.filter((row) => row.expectedLabels.length > 0).length,
    falseHits,
    violations,
    cleanQueries: rows.filter(
      (row) =>
        row.missedLabels.length === 0 &&
        row.unexpectedLabels.length === 0 &&
        row.violations.length === 0,
    ).length,
    avgLatencyMs: Number((latencies.reduce((total, value) => total + value, 0) / rows.length).toFixed(3)),
    p50LatencyMs: Number((percentile(latencies, 0.5) ?? 0).toFixed(3)),
  };
}

function evaluateStrategy(service, dataset, strategy, labelById, nowMs) {
  const rows = [];
  for (const query of dataset.queries) {
    const characterId = dataset.characters[query.character];
    const expectedLabels = query.expected ?? [];
    const forbiddenLabels = query.forbidden ?? [];
    const forbiddenIds = new Set(forbiddenLabels.map((label) => labelById.get(label)?.id));
    const started = process.hrtime.bigint();
    const results = service.searchMemories({
      characterId,
      query: query.query,
      strategy,
      limit: LIMIT,
      nowMs,
    });
    const latencyMs = Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(3));

    const returnedLabels = results.map((entry) => labelById.get(entry.id)?.label ?? `unknown:${entry.id}`);
    const hitLabels = returnedLabels.filter((label) => expectedLabels.includes(label));
    const missedLabels = expectedLabels.filter((label) => !returnedLabels.includes(label));
    const unexpectedLabels = returnedLabels.filter((label) => !expectedLabels.includes(label));
    const violations = [];
    for (const entry of results) {
      if (entry.characterId !== characterId) {
        violations.push(`cross-character:${entry.id}`);
      }
      if (entry.expiresAt !== null && entry.expiresAt <= nowMs) {
        violations.push(`expired:${entry.id}`);
      }
      if (forbiddenIds.has(entry.id)) {
        violations.push(`forbidden:${labelById.get(entry.id)?.label ?? entry.id}`);
      }
    }

    rows.push({
      id: query.id,
      split: query.split,
      character: query.character,
      characterId,
      query: query.query,
      gate: query.gate ?? null,
      note: query.note ?? null,
      expectedLabels,
      returnedLabels,
      hitLabels,
      missedLabels,
      unexpectedLabels,
      violations,
      latencyMs,
      results: results.map((entry) => ({
        id: entry.id,
        label: labelById.get(entry.id)?.label ?? null,
        score: Number(entry.score.toFixed(6)),
        originCharacterId: entry.originCharacterId,
        derivedFromEntryId: entry.derivedFromEntryId,
        expiresAt: entry.expiresAt,
        terms: entry.matchReason.terms,
        concepts: entry.matchReason.concepts,
      })),
    });
  }

  const bySplit = {};
  for (const split of SPLITS) {
    bySplit[split] = summarize(rows.filter((row) => row.split === split));
  }
  return {
    strategy,
    overall: summarize(rows),
    splits: bySplit,
    rows,
  };
}

function printSummary(report) {
  console.log("Bayper 本地记忆检索对照（构造数据，非验收通过）");
  console.log(
    "策略          全量召回  tune召回  开发留出   codex召回  r2召回  相关性误命中  隐私/时效门禁  平均延迟ms",
  );
  const format = (value) => (value === null ? "n/a" : value.toFixed(3));
  for (const strategy of STRATEGIES) {
    const entry = report.strategies[strategy];
    console.log(
      `${strategy.padEnd(13)} ${format(entry.overall.recall).padStart(8)}  ` +
        `${format(entry.splits.tune.recall).padStart(9)}  ` +
        `${format(entry.splits.holdout.recall).padStart(8)}  ` +
        `${format(entry.splits.codex.recall).padStart(9)}  ` +
        `${format(entry.splits.r2.recall).padStart(7)}  ` +
        `${String(entry.overall.falseHits).padStart(12)}  ` +
        `${String(entry.overall.violations).padStart(14)}  ` +
        `${String(entry.overall.avgLatencyMs).padStart(10)}`,
    );
  }

  console.log("\n开发留出组（非盲测）漏召回与误命中：");
  for (const strategy of STRATEGIES) {
    const rows = report.strategies[strategy].rows.filter(
      (row) => row.split === "holdout" && (row.missedLabels.length > 0 || row.unexpectedLabels.length > 0),
    );
    if (rows.length === 0) {
      console.log(`- ${strategy}: 无`);
      continue;
    }
    for (const row of rows) {
      console.log(
        `- ${strategy} ${row.id} "${row.query}" 漏=[${row.missedLabels.join(",")}] ` +
          `误=[${row.unexpectedLabels.join(",")}]`,
      );
    }
  }

  console.log("\nCodex 指定检索场景（开发复核，非盲测）：");
  for (const strategy of STRATEGIES) {
    const entry = report.strategies[strategy].splits.codex;
    console.log(
      `- ${strategy}: top1=${entry.top1Hits}/${entry.top1Eligible} recall=${format(entry.recall)} ` +
        `误命中=${entry.falseHits} 违规=${entry.violations}`,
    );
    const rows = report.strategies[strategy].rows.filter(
      (row) => row.split === "codex" && (row.missedLabels.length > 0 || row.unexpectedLabels.length > 0),
    );
    for (const row of rows) {
      console.log(
        `  ${row.id} "${row.query}" 返回=[${row.returnedLabels.join(",")}] ` +
          `漏=[${row.missedLabels.join(",")}] 误=[${row.unexpectedLabels.join(",")}]`,
      );
    }
  }

  console.log("\nr2 反问/否定表达（正反候选与门禁分开统计）：");
  for (const strategy of STRATEGIES) {
    const entry = report.strategies[strategy].splits.r2;
    console.log(
      `- ${strategy}: recall=${format(entry.recall)} 相关性误命中=${entry.falseHits} ` +
        `隐私/时效门禁=${entry.violations}`,
    );
    const rows = report.strategies[strategy].rows.filter(
      (row) => row.split === "r2" && (row.missedLabels.length > 0 || row.unexpectedLabels.length > 0),
    );
    for (const row of rows) {
      console.log(
        `  ${row.id} "${row.query}" 返回=[${row.returnedLabels.join(",")}] ` +
          `漏=[${row.missedLabels.join(",")}] 误=[${row.unexpectedLabels.join(",")}]`,
      );
    }
  }
}

function main() {
  const outputPath = parseOutputPath();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-memory-tuning-"));
  const clock = createClock();
  const db = openDatabase(directory);
  try {
    const service = createMemoryService({ db, now: clock.now });
    const dataset = buildDataset(service);
    clock.advance(2 * 3_600_000);
    const queryNow = clock.current();

    const labelById = new Map();
    for (const [label, memory] of Object.entries(dataset.memories)) {
      labelById.set(memory.id, { label, characterId: memory.characterId });
    }
    for (const [label, memory] of Object.entries(dataset.removed)) {
      labelById.set(memory.id, { label, characterId: memory.characterId, removed: true });
    }

    const strategies = {};
    for (const strategy of STRATEGIES) {
      strategies[strategy] = evaluateStrategy(service, dataset, strategy, labelById, queryNow);
    }

    const report = {
      generatedAt: new Date().toISOString(),
      scenarioTime: new Date(queryNow).toISOString(),
      defaultStrategy: RETRIEVAL_CONFIG.defaultStrategy,
      strategies,
      dataset: {
        characters: Object.keys(dataset.characters).length,
        memories: Object.keys(dataset.memories).length,
        removed: Object.keys(dataset.removed).length,
        queries: dataset.queries.length,
        tune: dataset.queries.filter((query) => query.split === "tune").length,
        holdout: dataset.queries.filter((query) => query.split === "holdout").length,
        codex: dataset.queries.filter((query) => query.split === "codex").length,
        r2: dataset.queries.filter((query) => query.split === "r2").length,
        holdoutLabel: "开发留出组（由实现者同时设计，非盲测）",
        holdoutKind: "development",
      },
      config: {
        limit: LIMIT,
        maxQueryChars: RETRIEVAL_CONFIG.maxQueryChars,
        maxQueryTokens: RETRIEVAL_CONFIG.maxQueryTokens,
        concepts: CONCEPTS.length,
      },
      boundaries: [
        "仅本地 FTS5/BM25 召回，不含 embedding 或模型语义检索",
        "Expected 为人工标注，未参与查询构造或服务调用",
        "否定词不作硬过滤；正反候选都保留，检索分数不代表事实真值",
        "相关性误命中与隐私/时效/删除门禁分列统计",
        "holdout 由实现者同时设计，仅作开发留出组，不是盲测",
        "Codex 指定场景为开发复核，不能替代独立验收数据",
        "工具结果不能替代真实模型聊天、纠正定位与 GUI 验收",
      ],
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    printSummary(report);
    console.log(`\n结果已写入：${outputPath}`);

    const violations = STRATEGIES.reduce(
      (total, strategy) => total + report.strategies[strategy].overall.violations,
      0,
    );
    if (violations > 0) {
      console.error(`门禁违规 ${violations} 条；召回结果不能抵消隔离/删除/时效违规。`);
      process.exitCode = 1;
    }
  } finally {
    try {
      db.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
