/* S04a 正式验收：真实 SQLite 与临时文件系统，不 Mock 权限、目录或存储。
   覆盖 POL-SOURCE-001～005；只证明发现/授权/开关/路径校验基础，
   不覆盖会话解析、在途模型提交、设置 UI 或预算。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { AppError } = require("../../app/errors.cjs");
const { createExternalSources } = require("../../app/external-sources.cjs");

const SENTINEL = "EXTERNAL-SESSION-BODY-MUST-NOT-LEAK";

function throwsCode(code, fn) {
  assert.throws(
    fn,
    (error) => error instanceof AppError && error.code === code,
    `预期业务错误 ${code}`,
  );
}

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-sources-"));
  const dirA = path.join(root, "provider-a");
  const dirB = path.join(root, "provider-b");
  const missing = path.join(root, "provider-missing");
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);
  fs.mkdirSync(path.join(dirA, "sessions"));
  fs.writeFileSync(path.join(dirA, "sessions", "private.jsonl"), `${SENTINEL}\n`);
  fs.writeFileSync(path.join(dirB, "secret.jsonl"), `${SENTINEL}\n`);

  const candidateConfig = [
    { provider: "claude-code", path: dirA },
    { provider: "codex", path: missing },
  ];
  const dbPath = path.join(root, "sources.sqlite3");
  let db = new DatabaseSync(dbPath);
  let service = createExternalSources({ db, candidates: candidateConfig });
  const fixture = {
    root,
    dirA,
    dirB,
    missing,
    get db() {
      return db;
    },
    get service() {
      return service;
    },
    reopen() {
      db.close();
      db = new DatabaseSync(dbPath);
      service = createExternalSources({ db, candidates: candidateConfig });
      return service;
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
  return fixture;
}

test("POL-SOURCE-001 默认关闭、仅返回候选可用性且不读取正文", (t) => {
  const fx = makeFixture(t);
  const found = fx.service.discoverCandidates();

  assert.equal(found.length, 2);
  assert.deepEqual(Object.keys(found[0]).sort(), ["available", "displayPath", "provider"]);
  assert.equal(found[0].provider, "claude-code");
  assert.equal(found[0].displayPath, fx.dirA);
  assert.equal(found[0].available, true);
  assert.equal(found[1].provider, "codex");
  assert.equal(found[1].available, false);
  assert.equal(found[1].reason, "NOT_FOUND");

  const serialized = JSON.stringify(found);
  assert.equal(serialized.includes(SENTINEL), false);
  assert.equal(serialized.includes("private.jsonl"), false);

  assert.equal(fx.service.isEnabled(), false);
  assert.deepEqual(fx.service.listGrants(), []);
  throwsCode("ANALYSIS_DISABLED", () => fx.service.issueReadPermit("no-grant"));

  fx.reopen();
  assert.equal(fx.service.isEnabled(), false);
  assert.deepEqual(fx.service.listGrants(), []);
  assert.equal(fs.existsSync(path.join(fx.dirA, "sessions", "private.jsonl")), true);
});

test("POL-SOURCE-002 开启分析不等于授权，授权 A 不影响 B", (t) => {
  const fx = makeFixture(t);
  assert.deepEqual(fx.service.setEnabled(true), { enabled: true });
  assert.equal(fx.service.isEnabled(), true);
  assert.deepEqual(fx.service.listGrants(), []);
  throwsCode("GRANT_NOT_FOUND", () => fx.service.issueReadPermit("no-grant"));

  const grantA = fx.service.grantDirectory("claude-code", fx.dirA);
  assert.equal(grantA.active, true);
  assert.equal(grantA.revision, 1);
  assert.equal(grantA.canonicalPath, fs.realpathSync(fx.dirA));
  assert.equal(grantA.displayPath, fx.dirA);

  const permit = fx.service.issueReadPermit(grantA.id);
  assert.equal(fx.service.validateReadPermit(permit).directoryId, grantA.id);
  assert.equal(fx.service.listGrants().length, 1);
  throwsCode("GRANT_NOT_FOUND", () => fx.service.issueReadPermit("provider-b"));

  // 同目录重复授权幂等：不新增权限、不提升修订号。
  const again = fx.service.grantDirectory("claude-code", fx.dirA);
  assert.equal(again.id, grantA.id);
  assert.equal(again.revision, grantA.revision);
  assert.equal(fx.service.listGrants().length, 1);

  fx.reopen();
  assert.equal(fx.service.isEnabled(), true);
  const grants = fx.service.listGrants();
  assert.equal(grants.length, 1);
  assert.equal(grants[0].id, grantA.id);
  assert.equal(grants[0].active, true);
  assert.deepEqual(
    Object.keys(grants[0]).sort(),
    ["active", "canonicalPath", "displayPath", "id", "provider", "revision"],
  );
  assert.equal(JSON.stringify(grants).includes(SENTINEL), false);
  assert.equal(fx.service.validateReadPermit(fx.service.issueReadPermit(grantA.id)).directoryId, grantA.id);
});

test("POL-SOURCE-003 关→开与撤→重授权使旧令牌失效", (t) => {
  const fx = makeFixture(t);
  fx.service.setEnabled(true);
  const grant = fx.service.grantDirectory("claude-code", fx.dirA);
  const first = fx.service.issueReadPermit(grant.id);
  assert.ok(fx.service.validateReadPermit(first));

  fx.service.setEnabled(false);
  throwsCode("ANALYSIS_DISABLED", () => fx.service.validateReadPermit(first));
  throwsCode("ANALYSIS_DISABLED", () => fx.service.issueReadPermit(grant.id));
  assert.equal(fx.service.releaseReadPermit(first), false);

  fx.service.setEnabled(true);
  throwsCode("PERMIT_INVALID", () => fx.service.validateReadPermit(first));
  const second = fx.service.issueReadPermit(grant.id);
  assert.ok(fx.service.validateReadPermit(second));

  fx.service.revokeDirectory(grant.id);
  throwsCode("PERMIT_INVALID", () => fx.service.validateReadPermit(second));
  throwsCode("GRANT_NOT_ACTIVE", () => fx.service.issueReadPermit(grant.id));

  // 真实数据库重开：撤销状态与权限修订持久化，旧令牌不能复活。
  fx.reopen();
  assert.equal(fx.service.listGrants()[0].active, false);
  throwsCode("GRANT_NOT_ACTIVE", () => fx.service.issueReadPermit(grant.id));
  assert.throws(() => fx.service.validateReadPermit(second));

  const regranted = fx.service.grantDirectory("claude-code", fx.dirA);
  assert.equal(regranted.id, grant.id);
  assert.ok(regranted.revision > grant.revision);
  const fresh = fx.service.issueReadPermit(regranted.id);
  assert.ok(fx.service.validateReadPermit(fresh));
  assert.throws(() => fx.service.validateReadPermit(second));

  fx.reopen();
  assert.throws(() => fx.service.validateReadPermit(fresh));
  const reopened = fx.service.issueReadPermit(regranted.id);
  assert.ok(fx.service.validateReadPermit(reopened));
});

test("POL-SOURCE-004 只解析授权根内普通文件，拒绝逃逸与外部软链", (t) => {
  const fx = makeFixture(t);
  fx.service.setEnabled(true);
  const grant = fx.service.grantDirectory("claude-code", fx.dirA);
  const permit = fx.service.issueReadPermit(grant.id);

  const normal = path.join(fx.dirA, "normal.txt");
  fs.writeFileSync(normal, "授权目录内普通内容");
  const resolved = fx.service.resolveAuthorizedFile(permit, "normal.txt");
  assert.equal(resolved, fs.realpathSync(normal));
  assert.equal(resolved.includes(SENTINEL), false);

  throwsCode("PATH_ESCAPE", () =>
    fx.service.resolveAuthorizedFile(permit, "../provider-b/secret.jsonl"),
  );
  throwsCode("PATH_ESCAPE", () =>
    fx.service.resolveAuthorizedFile(permit, path.join(fx.dirB, "secret.jsonl")),
  );

  const fileLink = path.join(fx.dirA, "outside-link.jsonl");
  fs.symlinkSync(path.join(fx.dirB, "secret.jsonl"), fileLink);
  throwsCode("SYMLINK_ESCAPE", () =>
    fx.service.resolveAuthorizedFile(permit, "outside-link.jsonl"),
  );

  const dirLink = path.join(fx.dirA, "outside-dir");
  fs.symlinkSync(fx.dirB, dirLink);
  throwsCode("SYMLINK_ESCAPE", () =>
    fx.service.resolveAuthorizedFile(permit, path.join("outside-dir", "secret.jsonl")),
  );
  throwsCode("FILE_NOT_FOUND", () =>
    fx.service.resolveAuthorizedFile(permit, "not-exists.jsonl"),
  );

  // 拒绝外部路径不读取、不删除任何 fixture 文件。
  assert.equal(fs.existsSync(path.join(fx.dirB, "secret.jsonl")), true);
  assert.equal(fs.readFileSync(path.join(fx.dirB, "secret.jsonl"), "utf8").includes(SENTINEL), true);
});

test("POL-SOURCE-005 目录消失或改指向使旧授权失效，重授权不动记忆", (t) => {
  const fx = makeFixture(t);
  fx.service.setEnabled(true);
  const grant = fx.service.grantDirectory("claude-code", fx.dirA);
  const permit = fx.service.issueReadPermit(grant.id);
  assert.ok(fx.service.validateReadPermit(permit));

  // 记忆与防回流控制由其他模块拥有；本轮只验证重授权不会触碰它们。
  fx.db.exec(`
    CREATE TABLE memory_forget_controls (
      character_id TEXT NOT NULL,
      fact_key_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (character_id, fact_key_hash)
    )
  `);
  fx.db
    .prepare("INSERT INTO memory_forget_controls (character_id, fact_key_hash, created_at) VALUES (?, ?, ?)")
    .run("a", "hash-1", 1);

  fs.rmSync(fx.dirA, { recursive: true, force: true });
  throwsCode("PATH_UNAVAILABLE", () => fx.service.validateReadPermit(permit));
  throwsCode("PATH_UNAVAILABLE", () => fx.service.issueReadPermit(grant.id));

  // 同一字符串路径被换成指向 B 的软链，不能当作原授权继续使用。
  fs.symlinkSync(fx.dirB, fx.dirA);
  throwsCode("GRANT_PATH_CHANGED", () => fx.service.validateReadPermit(permit));
  throwsCode("GRANT_PATH_CHANGED", () => fx.service.issueReadPermit(grant.id));

  const regranted = fx.service.grantDirectory("claude-code", fx.dirA);
  assert.notEqual(regranted.id, grant.id);
  assert.equal(regranted.canonicalPath, fs.realpathSync(fx.dirB));
  assert.equal(fx.service.listGrants().find((item) => item.id === grant.id).active, false);
  const fresh = fx.service.issueReadPermit(regranted.id);
  assert.equal(fx.service.validateReadPermit(fresh).directoryId, regranted.id);
  throwsCode("PERMIT_INVALID", () => fx.service.validateReadPermit(permit));

  assert.equal(
    fx.db.prepare("SELECT COUNT(*) AS count FROM memory_forget_controls").get().count,
    1,
  );
  assert.equal(fs.existsSync(path.join(fx.dirB, "secret.jsonl")), true);

  fx.service.revokeDirectory(regranted.id);
  throwsCode("PERMIT_INVALID", () => fx.service.validateReadPermit(fresh));
  fx.reopen();
  assert.equal(fx.service.listGrants().find((item) => item.id === regranted.id).active, false);
  throwsCode("GRANT_NOT_ACTIVE", () => fx.service.issueReadPermit(regranted.id));
  assert.equal(
    fx.db.prepare("SELECT COUNT(*) AS count FROM memory_forget_controls").get().count,
    1,
  );

  // 同一字符串路径删除后由另一个目录替换，身份不同，旧授权不能自动复活。
  const dirC = path.join(fx.root, "provider-c");
  const replacement = path.join(fx.root, "provider-c-replacement");
  fs.mkdirSync(dirC);
  fs.mkdirSync(replacement);
  const grantC = fx.service.grantDirectory("claude-code", dirC);
  const permitC = fx.service.issueReadPermit(grantC.id);
  fs.rmSync(dirC, { recursive: true, force: true });
  fs.renameSync(replacement, dirC);
  throwsCode("GRANT_PATH_CHANGED", () => fx.service.validateReadPermit(permitC));
  throwsCode("GRANT_PATH_CHANGED", () => fx.service.issueReadPermit(grantC.id));
  const regrantedC = fx.service.grantDirectory("claude-code", dirC);
  assert.equal(regrantedC.id, grantC.id);
  assert.ok(regrantedC.revision > grantC.revision);
  assert.throws(() => fx.service.validateReadPermit(permitC));
  assert.ok(fx.service.validateReadPermit(fx.service.issueReadPermit(regrantedC.id)));
  assert.equal(
    fx.db.prepare("SELECT COUNT(*) AS count FROM memory_forget_controls").get().count,
    1,
  );
});

test("POL-SOURCE-006 许可显式释放，事务失败不清有效许可", (t) => {
  const fx = makeFixture(t);
  fx.service.setEnabled(true);
  const grant = fx.service.grantDirectory("claude-code", fx.dirA);
  const first = fx.service.issueReadPermit(grant.id);
  assert.ok(fx.service.validateReadPermit(first));

  // 撤销事务失败：授权、开关和内存中的有效许可都必须保持原状。
  fx.db.exec(`
    CREATE TRIGGER fail_revoke BEFORE UPDATE ON external_source_grants
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END
  `);
  assert.throws(() => fx.service.revokeDirectory(grant.id));
  assert.equal(fx.service.isEnabled(), true);
  assert.equal(fx.service.listGrants()[0].active, true);
  assert.ok(fx.service.validateReadPermit(first));

  // 开关事务失败：同样不得误清仍有效许可。
  fx.db.exec(`
    CREATE TRIGGER fail_state BEFORE UPDATE ON external_source_state
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END
  `);
  assert.throws(() => fx.service.setEnabled(false));
  assert.equal(fx.service.isEnabled(), true);
  assert.ok(fx.service.validateReadPermit(first));
  fx.db.exec("DROP TRIGGER fail_revoke");
  fx.db.exec("DROP TRIGGER fail_state");

  // 显式释放立即失效、幂等，且不牵连其他许可。
  assert.equal(fx.service.releaseReadPermit(first), true);
  assert.equal(fx.service.releaseReadPermit(first), false);
  assert.equal(fx.service.releaseReadPermit(null), false);
  throwsCode("PERMIT_INVALID", () => fx.service.validateReadPermit(first));
  const second = fx.service.issueReadPermit(grant.id);
  assert.ok(fx.service.validateReadPermit(second));

  // 新增授权同样提升全局修订，旧许可被清理。
  const grantB = fx.service.grantDirectory("claude-code", fx.dirB);
  assert.equal(grantB.active, true);
  throwsCode("PERMIT_INVALID", () => fx.service.validateReadPermit(second));
  assert.equal(fx.service.releaseReadPermit(second), false);

  // 撤销成功提交后清理旧条目；release 返回 false 证明条目已被清理。
  const third = fx.service.issueReadPermit(grant.id);
  assert.ok(fx.service.validateReadPermit(third));
  fx.service.revokeDirectory(grant.id);
  throwsCode("PERMIT_INVALID", () => fx.service.validateReadPermit(third));
  assert.equal(fx.service.releaseReadPermit(third), false);

  // 重启不复活已释放或已失效的许可。
  fx.reopen();
  throwsCode("PERMIT_INVALID", () => fx.service.validateReadPermit(third));
  throwsCode("GRANT_NOT_ACTIVE", () => fx.service.issueReadPermit(grant.id));
});

test("POL-SOURCE-014 授权有效性只读查询不改变开关或许可", (t) => {
  const fx = makeFixture(t);
  const grant = fx.service.grantDirectory("claude-code", fx.dirA);
  assert.equal(fx.service.isEnabled(), false);

  const active = fx.service.listGrantsWithValidity();
  assert.equal(active.length, 1);
  assert.equal(active[0].id, grant.id);
  assert.equal(active[0].active, true);
  assert.equal(active[0].valid, true);
  assert.equal(active[0].reason, null);
  assert.equal(fx.service.isEnabled(), false, "状态查询不得自动打开分析");

  // 同一展示路径换指向其他真实目录：授权记录仍在，但当前根不可用。
  fs.rmSync(fx.dirA, { recursive: true, force: true });
  fs.symlinkSync(fx.dirB, fx.dirA);
  const changed = fx.service.listGrantsWithValidity()[0];
  assert.equal(changed.active, true);
  assert.equal(changed.valid, false);
  assert.equal(changed.reason, "GRANT_PATH_CHANGED");
  assert.equal(fx.service.isEnabled(), false);

  // 目录消失：授权仍存在，但不可用。
  fs.unlinkSync(fx.dirA);
  const missing = fx.service.listGrantsWithValidity()[0];
  assert.equal(missing.active, true);
  assert.equal(missing.valid, false);
  assert.equal(missing.reason, "PATH_UNAVAILABLE");
  assert.equal(fx.service.isEnabled(), false);

  fx.service.revokeDirectory(grant.id);
  const revoked = fx.service.listGrantsWithValidity()[0];
  assert.equal(revoked.active, false);
  assert.equal(revoked.valid, false);
  assert.equal(revoked.reason, "REVOKED");
  assert.equal(fx.service.isEnabled(), false);
});
