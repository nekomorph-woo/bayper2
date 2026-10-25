/* S04b 正式验收：真实 SQLite 权限服务与临时文件系统上的两种会话格式。
   覆盖 POL-SOURCE-007～011；不读取真实 HOME/会话，不联网、不启动 GUI。
   只证明获准目录的只读适配基础，不覆盖设置页、预算、模型分析或记忆写入。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { AppError } = require("../../app/errors.cjs");
const { createExternalSources } = require("../../app/external-sources.cjs");
const { createSessionSourceReader } = require("../../app/session-sources.cjs");

function throwsCode(code, fn) {
  assert.throws(
    fn,
    (error) => error instanceof AppError && error.code === code,
    `预期业务错误 ${code}`,
  );
}

function makeContext(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-sessions-"));
  const db = new DatabaseSync(path.join(root, "state.sqlite3"));
  const permissions = createExternalSources({ db });
  permissions.setEnabled(true);
  const reader = createSessionSourceReader({ permissions });
  const ctx = {
    root,
    db,
    permissions,
    reader,
    dir(name) {
      const target = path.join(root, name);
      fs.mkdirSync(target, { recursive: true });
      return target;
    },
  };
  t.after(() => {
    try {
      db.close();
    } catch {
      // 测试已主动关闭时仍要清理临时目录。
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return ctx;
}

function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function claudeUser(uuid, text, timestamp = "2026-10-26T10:00:00.000Z") {
  return { type: "user", uuid, timestamp, message: { role: "user", content: text } };
}

function textLength(text) {
  return Array.from(text).length;
}

/* 仅在测试内短时替换 fs.readSync，在首次读取后制造确定性竞态；
   不向生产代码加入测试开关，finally 恢复原函数。 */
function runWithMutation(mutate, fn) {
  const original = fs.readSync;
  let fired = false;
  fs.readSync = (...args) => {
    const result = original.apply(fs, args);
    if (!fired) {
      fired = true;
      mutate();
    }
    return result;
  };
  try {
    return fn();
  } finally {
    fs.readSync = original;
  }
}

test("POL-SOURCE-007 Claude/Codex 只输出允许的角色与文本", (t) => {
  const ctx = makeContext(t);
  const claudeRoot = ctx.dir("claude");
  const codexRoot = ctx.dir("codex");
  const claudeFile = path.join(claudeRoot, "project", "session.jsonl");
  writeJsonl(claudeFile, [
    claudeUser("c-u1", "用户甲"),
    {
      type: "assistant",
      uuid: "c-a1",
      timestamp: "2026-10-26T10:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "THINKING-SECRET" },
          { type: "text", text: "助手甲" },
          { type: "tool_use", id: "tool-1", name: "shell", input: { command: "TOOL-SECRET" } },
        ],
      },
    },
    {
      type: "user",
      uuid: "c-u2",
      timestamp: "2026-10-26T10:00:02.000Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "TOOL-RESULT-SECRET" },
          { type: "text", text: "继续" },
        ],
      },
    },
    { type: "system", uuid: "c-s1", content: "SYSTEM-SECRET" },
    { type: "summary", summary: "SUMMARY-SECRET" },
  ]);

  const codexFile = path.join(codexRoot, "2026", "10", "26", "rollout-abc.jsonl");
  writeJsonl(codexFile, [
    {
      timestamp: "2026-10-26T11:00:00.000Z",
      type: "session_meta",
      payload: { id: "session-1", instructions: "SYSTEM-SECRET" },
    },
    {
      timestamp: "2026-10-26T11:00:01.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "用户乙" }] },
    },
    {
      timestamp: "2026-10-26T11:00:01.500Z",
      type: "event_msg",
      payload: { type: "user_message", message: "用户乙" },
    },
    {
      timestamp: "2026-10-26T11:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "助手乙" }],
      },
    },
    {
      timestamp: "2026-10-26T11:00:02.500Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "助手乙" },
    },
    {
      timestamp: "2026-10-26T11:00:03.000Z",
      type: "response_item",
      payload: { type: "function_call", name: "shell", arguments: "TOOL-SECRET" },
    },
    {
      timestamp: "2026-10-26T11:00:04.000Z",
      type: "response_item",
      payload: { type: "function_call_output", output: "TOOL-RESULT-SECRET" },
    },
    {
      timestamp: "2026-10-26T11:00:05.000Z",
      type: "response_item",
      payload: { type: "reasoning", summary: ["THINKING-SECRET"] },
    },
    {
      timestamp: "2026-10-26T11:00:06.000Z",
      type: "turn_context",
      payload: { instructions: "SYSTEM-SECRET" },
    },
  ]);

  const claudeGrant = ctx.permissions.grantDirectory("claude-code", claudeRoot);
  const codexGrant = ctx.permissions.grantDirectory("codex", codexRoot);
  const claudePermit = ctx.permissions.issueReadPermit(claudeGrant.id);
  const codexPermit = ctx.permissions.issueReadPermit(codexGrant.id);

  const claudeList = ctx.reader.listSessionFiles(claudePermit);
  assert.deepEqual(claudeList.files.map((file) => file.relativePath), ["project/session.jsonl"]);
  assert.equal(claudeList.truncated, false);
  assert.equal(claudeList.files[0].size, fs.statSync(claudeFile).size);
  assert.equal(typeof claudeList.files[0].mtimeMs, "number");

  const claude = ctx.reader.readSession(claudePermit, "project/session.jsonl");
  assert.deepEqual(
    claude.messages.map((message) => [message.role, message.text]),
    [
      ["user", "用户甲"],
      ["assistant", "助手甲"],
      ["user", "继续"],
    ],
  );
  assert.equal(claude.messages[0].provider, "claude-code");
  assert.equal(claude.messages[0].sourcePath, "project/session.jsonl");
  assert.equal(claude.messages[0].timestamp, "2026-10-26T10:00:00.000Z");
  assert.equal(new Set(claude.messages.map((message) => message.sourceId)).size, 3);
  assert.equal(claude.diagnostics.ignoredRecords, 0);
  const claudeJson = JSON.stringify(claude);
  for (const secret of ["THINKING-SECRET", "TOOL-SECRET", "TOOL-RESULT-SECRET", "SYSTEM-SECRET", "SUMMARY-SECRET"]) {
    assert.equal(claudeJson.includes(secret), false);
  }
  assert.equal(claudeJson.includes(claudeRoot), false);

  const codexList = ctx.reader.listSessionFiles(codexPermit);
  assert.deepEqual(codexList.files.map((file) => file.relativePath), [
    "2026/10/26/rollout-abc.jsonl",
  ]);
  const codex = ctx.reader.readSession(codexPermit, "2026/10/26/rollout-abc.jsonl");
  assert.deepEqual(
    codex.messages.map((message) => [message.role, message.text]),
    [
      ["user", "用户乙"],
      ["assistant", "助手乙"],
    ],
  );
  assert.equal(codex.messages.filter((message) => message.text === "用户乙").length, 1);
  assert.equal(codex.diagnostics.ignoredRecords, 3);
  const codexJson = JSON.stringify(codex);
  for (const secret of ["THINKING-SECRET", "TOOL-SECRET", "TOOL-RESULT-SECRET", "SYSTEM-SECRET"]) {
    assert.equal(codexJson.includes(secret), false);
  }
  assert.equal(codexJson.includes(codexRoot), false);
});

test("POL-SOURCE-008 无授权/关闭/撤销/释放与外部软链均拒绝", (t) => {
  const ctx = makeContext(t);
  const rootA = ctx.dir("a");
  const rootB = ctx.dir("b");
  writeJsonl(path.join(rootA, "project", "session.jsonl"), [claudeUser("ok-1", "正常")]);
  fs.writeFileSync(path.join(rootB, "secret.jsonl"), "SECRET-BODY");

  throwsCode("PERMIT_INVALID", () => ctx.reader.listSessionFiles("no-permit"));
  throwsCode("PERMIT_INVALID", () =>
    ctx.reader.readSession("no-permit", "project/session.jsonl"),
  );

  const grant = ctx.permissions.grantDirectory("claude-code", rootA);
  const permit = ctx.permissions.issueReadPermit(grant.id);
  assert.equal(
    ctx.reader.readSession(permit, "project/session.jsonl").messages[0].text,
    "正常",
  );

  ctx.permissions.setEnabled(false);
  throwsCode("ANALYSIS_DISABLED", () => ctx.reader.listSessionFiles(permit));
  throwsCode("ANALYSIS_DISABLED", () =>
    ctx.reader.readSession(permit, "project/session.jsonl"),
  );
  ctx.permissions.setEnabled(true);
  throwsCode("PERMIT_INVALID", () => ctx.reader.listSessionFiles(permit));

  const released = ctx.permissions.issueReadPermit(grant.id);
  assert.equal(ctx.permissions.releaseReadPermit(released), true);
  throwsCode("PERMIT_INVALID", () => ctx.reader.listSessionFiles(released));
  throwsCode("PERMIT_INVALID", () =>
    ctx.reader.readSession(released, "project/session.jsonl"),
  );

  const revoked = ctx.permissions.issueReadPermit(grant.id);
  ctx.permissions.revokeDirectory(grant.id);
  throwsCode("PERMIT_INVALID", () => ctx.reader.listSessionFiles(revoked));

  const regranted = ctx.permissions.grantDirectory("claude-code", rootA);
  const fresh = ctx.permissions.issueReadPermit(regranted.id);
  fs.symlinkSync(path.join(rootB, "secret.jsonl"), path.join(rootA, "link.jsonl"));
  fs.symlinkSync(rootB, path.join(rootA, "linked"));

  const listed = ctx.reader.listSessionFiles(fresh);
  assert.equal(listed.files.some((file) => file.relativePath.includes("link")), false);
  throwsCode("SYMLINK_ESCAPE", () => ctx.reader.readSession(fresh, "link.jsonl"));
  throwsCode("SYMLINK_ESCAPE", () =>
    ctx.reader.readSession(fresh, "linked/secret.jsonl"),
  );
  throwsCode("PATH_ESCAPE", () => ctx.reader.readSession(fresh, "../b/secret.jsonl"));
  throwsCode("PATH_ESCAPE", () =>
    ctx.reader.readSession(fresh, path.join(rootB, "secret.jsonl")),
  );
  throwsCode("FILE_NOT_FOUND", () =>
    ctx.reader.readSession(fresh, "project/missing.jsonl"),
  );
  assert.equal(
    ctx.reader.readSession(fresh, "project/session.jsonl").messages[0].text,
    "正常",
  );
  assert.equal(fs.readFileSync(path.join(rootB, "secret.jsonl"), "utf8"), "SECRET-BODY");
});

test("POL-SOURCE-009 尾读有界、半行/坏行/编码与输出裁剪诊断", (t) => {
  const ctx = makeContext(t);
  const root = ctx.dir("bounded");
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });

  const tailRecords = [];
  for (let index = 0; index < 2500; index += 1) {
    tailRecords.push(claudeUser(`t-${index}`, `记录${index}:${"中".repeat(200)}`));
  }
  const tailFile = path.join(project, "tail.jsonl");
  writeJsonl(tailFile, tailRecords);
  assert.ok(fs.statSync(tailFile).size > 512 * 1024);

  const partialFile = path.join(project, "partial.jsonl");
  fs.writeFileSync(
    partialFile,
    [
      JSON.stringify(claudeUser("p-1", "合法中文一")),
      "{not-json",
      JSON.stringify({
        type: "assistant",
        uuid: "p-2",
        message: { role: "assistant", content: "合法中文二" },
      }),
    ].join("\n") + '\n{"type":"user","uuid":"p-3","message":{"role":"user","content":"半行',
  );

  fs.writeFileSync(
    path.join(project, "bad-encoding.jsonl"),
    Buffer.concat([
      Buffer.from('{"type":"user","uuid":"bad","message":{"role":"user","content":"'),
      Buffer.from([0xff]),
      Buffer.from('"}}\n'),
    ]),
  );

  fs.writeFileSync(
    path.join(project, "huge.jsonl"),
    JSON.stringify({
      type: "user",
      uuid: "huge",
      message: { role: "user", content: "中".repeat(200000) },
    }),
  );

  writeJsonl(path.join(project, "long.jsonl"), [
    claudeUser("long-1", "字".repeat(5000)),
  ]);

  const budgetRecords = [];
  for (let index = 0; index < 40; index += 1) {
    budgetRecords.push(claudeUser(`b-${index}`, `消息${index}:${"文".repeat(995)}`));
  }
  writeJsonl(path.join(project, "budget.jsonl"), budgetRecords);

  // 窗口恰好从换行后开始：没有裁断首行，但前文已被窗口省略。
  const edgeUsers =
    [claudeUser("edge-1", "边界一"), claudeUser("edge-2", "边界二")]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n";
  const edgeHead = '{"type":"system","content":"';
  const edgeTail = '"}\n';
  const edgePadding =
    512 * 1024 -
    Buffer.byteLength(edgeUsers) -
    Buffer.byteLength(edgeHead) -
    Buffer.byteLength(edgeTail);
  assert.ok(edgePadding > 0);
  const edgeWindow = edgeHead + "S".repeat(edgePadding) + edgeTail + edgeUsers;
  assert.equal(Buffer.byteLength(edgeWindow), 512 * 1024);
  const edgeFile = path.join(project, "edge.jsonl");
  fs.writeFileSync(
    edgeFile,
    `${JSON.stringify(claudeUser("edge-old", "旧记录"))}\n${edgeWindow}`,
  );
  assert.ok(fs.statSync(edgeFile).size > 512 * 1024);

  const grant = ctx.permissions.grantDirectory("claude-code", root);
  const permit = ctx.permissions.issueReadPermit(grant.id);

  const tail = ctx.reader.readSession(permit, "project/tail.jsonl");
  assert.equal(tail.messages.length, 40);
  assert.ok(tail.messages[0].text.startsWith("记录2460:"));
  assert.ok(tail.messages[39].text.startsWith("记录2499:"));
  assert.equal(tail.diagnostics.headTruncated, true);
  assert.equal(tail.diagnostics.tailLimited, true);
  assert.equal(tail.truncated, true);
  assert.ok(tail.messages.every((message) => textLength(message.text) <= 4000));
  assert.ok(tail.messages.reduce((sum, message) => sum + textLength(message.text), 0) <= 16000);
  assert.equal(JSON.stringify(tail).includes("�"), false);

  const edge = ctx.reader.readSession(permit, "project/edge.jsonl");
  assert.deepEqual(edge.messages.map((message) => message.text), ["边界一", "边界二"]);
  assert.equal(edge.diagnostics.headTruncated, false);
  assert.equal(edge.diagnostics.tailLimited, true);
  assert.equal(edge.truncated, true);

  const partial = ctx.reader.readSession(permit, "project/partial.jsonl");
  assert.deepEqual(partial.messages.map((message) => message.text), ["合法中文一", "合法中文二"]);
  assert.equal(partial.diagnostics.malformedLines, 1);
  assert.equal(partial.diagnostics.incompleteTail, true);
  assert.equal(partial.truncated, true);
  assert.equal(JSON.stringify(partial).includes("半行"), false);

  const badEncoding = ctx.reader.readSession(permit, "project/bad-encoding.jsonl");
  assert.equal(badEncoding.messages.length, 0);
  assert.equal(badEncoding.diagnostics.invalidEncodingLines, 1);
  assert.equal(JSON.stringify(badEncoding).includes("�"), false);

  const huge = ctx.reader.readSession(permit, "project/huge.jsonl");
  assert.equal(huge.messages.length, 0);
  assert.equal(huge.diagnostics.headTruncated, true);
  assert.equal(huge.diagnostics.tailLimited, true);
  assert.equal(huge.diagnostics.lineTooLarge, true);
  assert.equal(huge.diagnostics.incompleteTail, true);
  assert.equal(huge.truncated, true);

  const long = ctx.reader.readSession(permit, "project/long.jsonl");
  assert.equal(long.messages.length, 1);
  assert.equal(textLength(long.messages[0].text), 4000);
  assert.equal(long.messages[0].truncated, true);
  assert.equal(long.diagnostics.truncatedMessages, 1);
  assert.equal(long.truncated, true);

  const budget = ctx.reader.readSession(permit, "project/budget.jsonl");
  assert.equal(budget.messages.length, 16);
  assert.ok(budget.messages[0].text.startsWith("消息24:"));
  assert.ok(budget.messages[15].text.startsWith("消息39:"));
  assert.ok(budget.messages.reduce((sum, message) => sum + textLength(message.text), 0) <= 16000);
  assert.equal(budget.diagnostics.droppedMessages, 24);
  assert.equal(budget.truncated, true);
});

test("POL-SOURCE-010 追加/重授权标识稳定，不同授权根不碰撞", (t) => {
  const ctx = makeContext(t);
  const rootA = ctx.dir("ids-a");
  const rootB = ctx.dir("ids-b");
  const stableFile = path.join(rootA, "project", "stable.jsonl");
  writeJsonl(stableFile, [
    { type: "user", message: { role: "user", content: "第一条" } },
    { type: "assistant", message: { role: "assistant", content: "第二条" } },
  ]);
  writeJsonl(path.join(rootA, "project", "duplicates.jsonl"), [
    claudeUser("dup-1", "第一次"),
    claudeUser("dup-1", "第二次"),
    claudeUser("same-1", "同一句话"),
    claudeUser("same-2", "同一句话"),
  ]);
  writeJsonl(path.join(rootA, "project", "collision.jsonl"), [
    claudeUser("shared-id", "同一文本"),
  ]);
  writeJsonl(path.join(rootB, "project", "collision.jsonl"), [
    claudeUser("shared-id", "同一文本"),
  ]);

  const grantA = ctx.permissions.grantDirectory("claude-code", rootA);
  const grantB = ctx.permissions.grantDirectory("claude-code", rootB);
  const permitA = ctx.permissions.issueReadPermit(grantA.id);
  const permitB = ctx.permissions.issueReadPermit(grantB.id);

  const before = ctx.reader.readSession(permitA, "project/stable.jsonl");
  const beforeIds = before.messages.map((message) => message.sourceId);
  assert.equal(beforeIds.length, 2);
  fs.appendFileSync(
    stableFile,
    `${JSON.stringify({ type: "user", message: { role: "user", content: "第三条" } })}\n`,
  );
  const after = ctx.reader.readSession(permitA, "project/stable.jsonl");
  assert.deepEqual(after.messages.slice(0, 2).map((message) => message.sourceId), beforeIds);
  assert.equal(after.messages.length, 3);
  assert.equal(after.messages[2].text, "第三条");
  assert.equal(beforeIds.includes(after.messages[2].sourceId), false);

  const duplicates = ctx.reader.readSession(permitA, "project/duplicates.jsonl");
  assert.deepEqual(
    duplicates.messages.map((message) => message.text),
    ["第一次", "同一句话", "同一句话"],
  );
  assert.equal(new Set(duplicates.messages.map((message) => message.sourceId)).size, 3);

  // 同provider、同相对路径、同显式ID与同文本，不同授权根必须隔离。
  const collisionA = ctx.reader.readSession(permitA, "project/collision.jsonl");
  const collisionB = ctx.reader.readSession(permitB, "project/collision.jsonl");
  assert.equal(collisionA.messages[0].text, collisionB.messages[0].text);
  assert.notEqual(collisionA.messages[0].sourceId, collisionB.messages[0].sourceId);
  assert.equal(JSON.stringify(collisionA).includes(rootA), false);

  // 撤销后重新授权同一规范根，显式ID与偏移ID都应保持稳定。
  ctx.permissions.revokeDirectory(grantA.id);
  const regrantedA = ctx.permissions.grantDirectory("claude-code", rootA);
  const permitA2 = ctx.permissions.issueReadPermit(regrantedA.id);
  const collisionAgain = ctx.reader.readSession(permitA2, "project/collision.jsonl");
  assert.equal(collisionAgain.messages[0].sourceId, collisionA.messages[0].sourceId);
  const stableAgain = ctx.reader.readSession(permitA2, "project/stable.jsonl");
  assert.deepEqual(
    stableAgain.messages.map((message) => message.sourceId),
    after.messages.map((message) => message.sourceId),
  );
});

test("POL-SOURCE-011 枚举深度/数量、未知来源/格式与未知 schema", (t) => {
  const ctx = makeContext(t);
  const unknownRoot = ctx.dir("unknown-provider");
  writeJsonl(path.join(unknownRoot, "project", "session.jsonl"), [claudeUser("u-1", "普通")]);

  const formatRoot = ctx.dir("formats");
  fs.mkdirSync(path.join(formatRoot, "project"), { recursive: true });
  fs.writeFileSync(path.join(formatRoot, "archive.zip"), "PK");
  fs.writeFileSync(path.join(formatRoot, "image.png"), "png");
  fs.writeFileSync(path.join(formatRoot, "state.db"), "db");
  fs.writeFileSync(path.join(formatRoot, "notes.txt"), "text");
  writeJsonl(path.join(formatRoot, "project", "unknown.jsonl"), [
    { type: "mystery", payload: { text: "MUST-NOT-LEAK" } },
    { type: "user", message: { role: "user", content: { nested: "MUST-NOT-LEAK" } } },
  ]);

  const depthRoot = ctx.dir("depth");
  writeJsonl(path.join(depthRoot, "a", "b", "c", "d", "session.jsonl"), [
    claudeUser("depth-ok", "层级内"),
  ]);
  writeJsonl(path.join(depthRoot, "a", "b", "c", "d", "e", "deep.jsonl"), [
    claudeUser("depth-deep", "越界层级"),
  ]);

  const manyRoot = ctx.dir("many");
  fs.mkdirSync(path.join(manyRoot, "project"), { recursive: true });
  for (let index = 0; index < 501; index += 1) {
    fs.writeFileSync(
      path.join(manyRoot, "project", `f${String(index).padStart(4, "0")}.jsonl`),
      "",
    );
  }

  // 非匹配条目也消耗总访问预算；2001 个 .txt 不应被完整扫描后声称未截断。
  const visitRoot = ctx.dir("visits");
  for (let index = 0; index < 2001; index += 1) {
    fs.writeFileSync(path.join(visitRoot, `nonmatch-${index}.txt`), "");
  }

  const unknownGrant = ctx.permissions.grantDirectory("other-agent", unknownRoot);
  const formatGrant = ctx.permissions.grantDirectory("claude-code", formatRoot);
  const depthGrant = ctx.permissions.grantDirectory("claude-code", depthRoot);
  const manyGrant = ctx.permissions.grantDirectory("claude-code", manyRoot);
  const visitGrant = ctx.permissions.grantDirectory("claude-code", visitRoot);
  const unknownPermit = ctx.permissions.issueReadPermit(unknownGrant.id);
  const formatPermit = ctx.permissions.issueReadPermit(formatGrant.id);
  const depthPermit = ctx.permissions.issueReadPermit(depthGrant.id);
  const manyPermit = ctx.permissions.issueReadPermit(manyGrant.id);
  const visitPermit = ctx.permissions.issueReadPermit(visitGrant.id);

  throwsCode("UNSUPPORTED_PROVIDER", () => ctx.reader.listSessionFiles(unknownPermit));
  throwsCode("UNSUPPORTED_PROVIDER", () =>
    ctx.reader.readSession(unknownPermit, "project/session.jsonl"),
  );

  for (const file of ["archive.zip", "image.png", "state.db"]) {
    throwsCode("UNSUPPORTED_FORMAT", () => ctx.reader.readSession(formatPermit, file));
  }
  throwsCode("NOT_SESSION_FILE", () =>
    ctx.reader.readSession(formatPermit, "notes.txt"),
  );
  throwsCode("PATH_ESCAPE", () =>
    ctx.reader.readSession(formatPermit, "../unknown-provider/project/session.jsonl"),
  );

  const unknown = ctx.reader.readSession(formatPermit, "project/unknown.jsonl");
  assert.equal(unknown.messages.length, 0);
  assert.equal(unknown.diagnostics.ignoredRecords, 1);
  assert.equal(unknown.diagnostics.unsupportedRecords, 1);
  assert.equal(JSON.stringify(unknown).includes("MUST-NOT-LEAK"), false);

  const depth = ctx.reader.listSessionFiles(depthPermit);
  assert.deepEqual(depth.files.map((file) => file.relativePath), ["a/b/c/d/session.jsonl"]);
  assert.equal(depth.truncated, true);

  const many = ctx.reader.listSessionFiles(manyPermit);
  assert.equal(many.files.length, 500);
  assert.equal(many.truncated, true);
  assert.equal(JSON.stringify(many).includes(manyRoot), false);

  const visits = ctx.reader.listSessionFiles(visitPermit);
  assert.equal(visits.files.length, 0);
  assert.equal(visits.truncated, true);
});

test("POL-SOURCE-012 中途改向/改写/截断拒绝，追加给出快照边界", (t) => {
  const ctx = makeContext(t);
  const root = ctx.dir("race");
  const redirectFile = path.join(root, "redirect", "project", "session.jsonl");
  writeJsonl(redirectFile, [claudeUser("rd-1", "原始数据")]);
  const redirectOld = path.join(root, "redirect", "project-old");
  const rewriteFile = path.join(root, "project", "rewrite.jsonl");
  writeJsonl(rewriteFile, [claudeUser("rw-1", "AAAA")]);
  const truncateFile = path.join(root, "project", "truncate.jsonl");
  writeJsonl(truncateFile, [claudeUser("tr-1", "将被截断")]);
  const appendFile = path.join(root, "project", "append.jsonl");
  writeJsonl(appendFile, [claudeUser("ap-1", "快照内")]);
  const initialAppendSize = fs.statSync(appendFile).size;

  const grant = ctx.permissions.grantDirectory("claude-code", root);
  const permit = ctx.permissions.issueReadPermit(grant.id);

  // 目录改向为同一真实目录的软链：旧 resolved 路径仍指向原 inode，
  // 但调用时 relativePath 已解析到不同规范位置，不能发布旧目标数据。
  runWithMutation(
    () => {
      fs.renameSync(path.join(root, "redirect", "project"), redirectOld);
      fs.symlinkSync(redirectOld, path.join(root, "redirect", "project"));
    },
    () => {
      throwsCode("FILE_CHANGED", () =>
        ctx.reader.readSession(permit, "redirect/project/session.jsonl"),
      );
    },
  );

  // 原地改写为等长内容并更新 mtime：不能返回改写前的旧正文。
  runWithMutation(
    () => {
      fs.writeFileSync(rewriteFile, `${JSON.stringify(claudeUser("rw-1", "BBBB"))}\n`);
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(rewriteFile, future, future);
    },
    () => {
      throwsCode("FILE_CHANGED", () => ctx.reader.readSession(permit, "project/rewrite.jsonl"));
    },
  );

  runWithMutation(
    () => {
      fs.truncateSync(truncateFile, 0);
    },
    () => {
      throwsCode("FILE_CHANGED", () =>
        ctx.reader.readSession(permit, "project/truncate.jsonl"),
      );
    },
  );

  // 普通追加允许返回，但必须标明捕获快照字节数，且不包含追加内容。
  const appended = runWithMutation(
    () => {
      fs.appendFileSync(appendFile, `${JSON.stringify(claudeUser("ap-2", "追加数据"))}\n`);
    },
    () => ctx.reader.readSession(permit, "project/append.jsonl"),
  );
  assert.deepEqual(appended.messages.map((message) => message.text), ["快照内"]);
  assert.equal(appended.snapshotBytes, initialAppendSize);
  assert.equal(appended.diagnostics.appendedDuringRead, true);
  assert.equal(JSON.stringify(appended).includes("追加数据"), false);
});

test("POL-SOURCE-013 checkpoint 只校验有界读取区段", (t) => {
  const ctx = makeContext(t);
  const root = ctx.dir("checkpoints");
  const project = path.join(root, "project");
  const grant = ctx.permissions.grantDirectory("claude-code", root);
  const permit = ctx.permissions.issueReadPermit(grant.id);

  function makeFile(name, text = "我喜欢茉莉花茶。") {
    const file = path.join(project, name);
    writeJsonl(file, [claudeUser(`u-${name}`, text), {
      type: "assistant",
      uuid: `a-${name}`,
      message: { role: "assistant", content: "好的。" },
    }]);
    return file;
  }

  function checkpointOf(name) {
    return ctx.reader.readSession(permit, `project/${name}`).checkpoint;
  }

  const plainFile = makeFile("plain.jsonl");
  const plainSize = fs.statSync(plainFile).size;
  const plain = checkpointOf("plain.jsonl");
  assert.equal(typeof plain.fileKey, "string");
  assert.equal(plain.bodyStart, 0);
  assert.equal(plain.byteLength, plainSize);
  assert.equal(plain.snapshotBytes, plainSize);
  assert.match(plain.regionSha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof plain.dev, "string");
  assert.equal(typeof plain.ino, "string");
  assert.equal(
    ctx.reader.fileKey(permit, "project/plain.jsonl").fileKey,
    plain.fileKey,
  );
  assert.deepEqual(
    ctx.reader.verifyCheckpoint(permit, "project/plain.jsonl", plain),
    { verified: true },
  );

  // 纯追加不改变旧区段。
  fs.appendFileSync(plainFile, `${JSON.stringify(claudeUser("plain-more", "追加"))}\n`);
  assert.deepEqual(
    ctx.reader.verifyCheckpoint(permit, "project/plain.jsonl", plain),
    { verified: true },
  );

  const prependFile = makeFile("prepend.jsonl");
  const prepend = checkpointOf("prepend.jsonl");
  fs.writeFileSync(
    prependFile,
    `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "前置" } })}\n` +
      fs.readFileSync(prependFile, "utf8"),
  );
  assert.equal(
    ctx.reader.verifyCheckpoint(permit, "project/prepend.jsonl", prepend).reason,
    "REGION_CHANGED",
  );

  const rewriteFile = makeFile("rewrite.jsonl");
  const rewrite = checkpointOf("rewrite.jsonl");
  const rewriteBytes = fs.readFileSync(rewriteFile);
  rewriteBytes[0] = 0x5b;
  fs.writeFileSync(rewriteFile, rewriteBytes);
  assert.equal(
    ctx.reader.verifyCheckpoint(permit, "project/rewrite.jsonl", rewrite).reason,
    "REGION_CHANGED",
  );

  const truncateFile = makeFile("truncate.jsonl");
  const truncate = checkpointOf("truncate.jsonl");
  fs.truncateSync(truncateFile, 5);
  assert.equal(
    ctx.reader.verifyCheckpoint(permit, "project/truncate.jsonl", truncate).reason,
    "REGION_CHANGED",
  );

  const replaceFile = makeFile("replace.jsonl");
  const replace = checkpointOf("replace.jsonl");
  const replacement = path.join(project, "replacement.tmp");
  fs.copyFileSync(replaceFile, replacement);
  fs.renameSync(replacement, replaceFile);
  assert.equal(
    ctx.reader.verifyCheckpoint(permit, "project/replace.jsonl", replace).reason,
    "FILE_REPLACED",
  );

  const missingFile = makeFile("missing.jsonl");
  const missing = checkpointOf("missing.jsonl");
  fs.rmSync(missingFile);
  throwsCode("FILE_NOT_FOUND", () =>
    ctx.reader.verifyCheckpoint(permit, "project/missing.jsonl", missing),
  );

  assert.equal(
    ctx.reader.verifyCheckpoint(permit, "project/prepend.jsonl", plain).reason,
    "CHECKPOINT_MISMATCH",
  );
  assert.equal(
    ctx.reader.verifyCheckpoint(permit, "project/plain.jsonl", {
      ...plain,
      byteLength: 512 * 1024 + 1,
    }).reason,
    "CHECKPOINT_INVALID",
  );

  ctx.permissions.setEnabled(false);
  throwsCode("ANALYSIS_DISABLED", () =>
    ctx.reader.verifyCheckpoint(permit, "project/plain.jsonl", plain),
  );
  assert.equal(fs.existsSync(plainFile), true);
});
