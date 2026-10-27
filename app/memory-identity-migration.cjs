/* S03l 存量误合身份组一次性迁移：按有效证明重建 identity 组件，保留控制/
   别名/正文/来源/FTS，不按当前 factKey 重新归因历史孤儿控制。只在 store
   打开的既有保存点内运行；失败由调用方回滚。 */
const crypto = require("node:crypto");

const REPORT_KEY = "memory.identity.migration.v2";
const REPORT_VERSION = 2;

function migrateLegacyIdentityGroups(db, { nowMs = Date.now() } = {}) {
  const marker = db.prepare("SELECT value FROM app_state WHERE key = ?").get(REPORT_KEY);
  if (marker) {
    const parsed = JSON.parse(marker.value);
    if (parsed?.version >= REPORT_VERSION) {
      return null;
    }
  }

  const entries = db.prepare(`
    SELECT e.id, e.character_id, e.fact_identity_id, e.created_at, e.version,
           COALESCE(d.parent_entry_id, e.derived_from_entry_id) AS parent_entry_id
    FROM memory_entries e
    LEFT JOIN memory_derivations d ON d.entry_id = e.id
    ORDER BY e.created_at ASC, e.id ASC
  `).all();
  if (entries.some((entry) => !entry.fact_identity_id)) {
    throw new Error("身份迁移要求所有记忆条目已有 fact_identity_id");
  }
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const parentOf = new Map(
    entries
      .filter((entry) => entry.parent_entry_id)
      .map((entry) => [entry.id, entry.parent_entry_id]),
  );

  // 有向派生环边不参与证明；环内条目仍可由其他有效关系/派生连接。
  const cycleNodes = new Set();
  for (const entry of entries) {
    const path = [];
    const seen = new Map();
    let current = entry.id;
    while (current && entriesById.has(current)) {
      if (seen.has(current)) {
        for (let index = seen.get(current); index < path.length; index += 1) {
          cycleNodes.add(path[index]);
        }
        break;
      }
      seen.set(current, path.length);
      path.push(current);
      current = parentOf.get(current) ?? null;
    }
  }

  const union = createUnionFind();
  for (const entry of entries) {
    union.add(entry.id);
  }
  for (const [entryId, parentId] of parentOf) {
    if (cycleNodes.has(entryId)) {
      continue;
    }
    union.add(parentId);
    union.union(entryId, parentId);
  }
  for (const edge of db.prepare(
    "SELECT from_entry_id, to_entry_id FROM memory_fact_relation_edges",
  ).all()) {
    union.add(edge.from_entry_id);
    union.add(edge.to_entry_id);
    union.union(edge.from_entry_id, edge.to_entry_id);
  }

  const rootEntries = new Map();
  const rootOf = new Map();
  for (const entry of entries) {
    const root = union.find(entry.id);
    rootOf.set(entry.id, root);
    if (!rootEntries.has(root)) {
      rootEntries.set(root, []);
    }
    rootEntries.get(root).push(entry);
  }

  const identityEntries = new Map();
  for (const entry of entries) {
    if (!identityEntries.has(entry.fact_identity_id)) {
      identityEntries.set(entry.fact_identity_id, []);
    }
    identityEntries.get(entry.fact_identity_id).push(entry);
  }
  const identityRoots = new Map();
  const preferredRoot = new Map();
  const earliestByIdentity = new Map();
  for (const [identityId, identityRows] of identityEntries) {
    const roots = new Set(identityRows.map((entry) => rootOf.get(entry.id)));
    identityRoots.set(identityId, roots);
    const earliest = identityRows[0];
    earliestByIdentity.set(identityId, earliest);
    preferredRoot.set(identityId, rootOf.get(earliest.id));
  }

  const targetByRoot = new Map();
  for (const [identityId, root] of preferredRoot) {
    const current = targetByRoot.get(root);
    if (!current || compareEntries(earliestByIdentity.get(identityId), earliestByIdentity.get(current)) < 0) {
      targetByRoot.set(root, identityId);
    }
  }

  const finalByRoot = new Map();
  const newIdentities = [];
  for (const root of rootEntries.keys()) {
    const target = targetByRoot.get(root) ?? null;
    if (target) {
      finalByRoot.set(root, target);
      continue;
    }
    const identityId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO memory_fact_identities (identity_id, created_at) VALUES (?, ?)",
    ).run(identityId, nowMs);
    finalByRoot.set(root, identityId);
    newIdentities.push(identityId);
  }

  const changedRoots = new Set();
  for (const [root, componentEntries] of rootEntries) {
    const identities = [...new Set(componentEntries.map((entry) => entry.fact_identity_id))];
    const finalIdentity = finalByRoot.get(root);
    if (
      identities.length > 1 ||
      identities.some((identityId) => identityRoots.get(identityId).size > 1) ||
      componentEntries.some((entry) => entry.fact_identity_id !== finalIdentity)
    ) {
      changedRoots.add(root);
    }
  }

  for (const [root, componentEntries] of rootEntries) {
    const changed = changedRoots.has(root);
    const finalIdentity = finalByRoot.get(root);
    if (changed) {
      const target = targetByRoot.get(root) ?? componentEntries[0].fact_identity_id;
      db.prepare(
        "UPDATE memory_fact_identities SET legacy_identity_id = ? WHERE identity_id = ?",
      ).run(target, finalIdentity);
    }
    for (const entry of componentEntries) {
      if (!changed && entry.fact_identity_id === finalIdentity) {
        continue;
      }
      if (entry.fact_identity_id !== finalIdentity) {
        db.prepare(`
          UPDATE memory_entries
          SET fact_identity_id = ?, version = version + 1, updated_at = ?
          WHERE id = ?
        `).run(finalIdentity, nowMs, entry.id);
      } else {
        db.prepare(`
          UPDATE memory_entries SET version = version + 1, updated_at = ? WHERE id = ?
        `).run(nowMs, entry.id);
      }
    }
  }

  const targetsByIdentity = new Map();
  const oldStillHolds = new Map();
  for (const entry of entries) {
    const oldIdentity = entry.fact_identity_id;
    if (!targetsByIdentity.has(oldIdentity)) {
      targetsByIdentity.set(oldIdentity, new Set());
    }
    const target = finalByRoot.get(rootOf.get(entry.id));
    targetsByIdentity.get(oldIdentity).add(target);
    if (target === oldIdentity) {
      oldStillHolds.set(oldIdentity, true);
    }
  }

  // 先取不可变的原始控制/alias 快照，再按旧 identity→目标映射复制；
  // 清理空源放到所有复制之后，避免遍历顺序影响扩散范围。
  const shareControls = new Map(
    db.prepare("SELECT identity_id, created_at FROM memory_share_identity_controls").all()
      .map((row) => [row.identity_id, row.created_at]),
  );
  const forgetControls = new Map();
  for (const row of db.prepare(
    "SELECT character_id, identity_id, created_at FROM memory_forget_identity_controls",
  ).all()) {
    if (!forgetControls.has(row.identity_id)) {
      forgetControls.set(row.identity_id, []);
    }
    forgetControls.get(row.identity_id).push(row);
  }
  const aliasRows = db.prepare(
    "SELECT fingerprint, identity_id FROM memory_fact_aliases",
  ).all();
  const conflictRows = db.prepare(
    "SELECT fingerprint, identity_id FROM memory_fact_alias_conflicts",
  ).all();
  const fingerprintPrimary = new Map(
    aliasRows.map((row) => [row.fingerprint, row.identity_id]),
  );
  const fingerprintsByIdentity = new Map();
  for (const row of [...aliasRows, ...conflictRows]) {
    if (!fingerprintsByIdentity.has(row.identity_id)) {
      fingerprintsByIdentity.set(row.identity_id, new Set());
    }
    fingerprintsByIdentity.get(row.identity_id).add(row.fingerprint);
  }

  const insertShareControl = db.prepare(`
    INSERT OR IGNORE INTO memory_share_identity_controls (identity_id, created_at)
    VALUES (?, ?)
  `);
  const insertForgetControl = db.prepare(`
    INSERT OR IGNORE INTO memory_forget_identity_controls (
      character_id, identity_id, created_at
    ) VALUES (?, ?, ?)
  `);
  const insertConflict = db.prepare(`
    INSERT OR IGNORE INTO memory_fact_alias_conflicts (
      fingerprint, identity_id, created_at
    ) VALUES (?, ?, ?)
  `);

  for (const [identityId] of identityEntries) {
    const targets = targetsByIdentity.get(identityId);
    if (!targets || targets.size === 0) {
      continue;
    }
    const shareCreatedAt = shareControls.get(identityId);
    if (shareCreatedAt !== undefined) {
      for (const target of targets) {
        if (target !== identityId) {
          insertShareControl.run(target, shareCreatedAt);
        }
      }
    }
    for (const forgetRow of forgetControls.get(identityId) ?? []) {
      for (const target of targets) {
        if (target !== identityId) {
          insertForgetControl.run(forgetRow.character_id, target, forgetRow.created_at);
        }
      }
    }
    for (const fingerprint of fingerprintsByIdentity.get(identityId) ?? []) {
      const primary = fingerprintPrimary.get(fingerprint) ?? null;
      for (const target of targets) {
        if (target !== primary) {
          insertConflict.run(fingerprint, target, nowMs);
        }
      }
    }
  }

  // 只有存在映射目标且控制/历史 alias 已复制后，才清理无条目的旧源；
  // 无条目的孤儿 identity 不在 identityEntries，不进入此循环。
  const moveAlias = db.prepare(
    "UPDATE memory_fact_aliases SET identity_id = ? WHERE fingerprint = ?",
  );
  const deleteConflictForPair = db.prepare(
    "DELETE FROM memory_fact_alias_conflicts WHERE fingerprint = ? AND identity_id = ?",
  );
  const deleteConflictsForIdentity = db.prepare(
    "DELETE FROM memory_fact_alias_conflicts WHERE identity_id = ?",
  );
  const deleteShareControl = db.prepare(
    "DELETE FROM memory_share_identity_controls WHERE identity_id = ?",
  );
  const deleteForgetControls = db.prepare(
    "DELETE FROM memory_forget_identity_controls WHERE identity_id = ?",
  );
  for (const [identityId, identityRows] of identityEntries) {
    if (oldStillHolds.get(identityId) === true) {
      continue;
    }
    const targets = targetsByIdentity.get(identityId);
    if (!targets || targets.size === 0) {
      continue;
    }
    const moveTarget = finalByRoot.get(rootOf.get(identityRows[0].id));
    for (const fingerprint of fingerprintsByIdentity.get(identityId) ?? []) {
      if (fingerprintPrimary.get(fingerprint) === identityId) {
        moveAlias.run(moveTarget, fingerprint);
        deleteConflictForPair.run(fingerprint, moveTarget);
      }
    }
    deleteConflictsForIdentity.run(identityId);
    deleteShareControl.run(identityId);
    deleteForgetControls.run(identityId);
  }

  const affectedCharacters = new Set();
  for (const root of changedRoots) {
    for (const entry of rootEntries.get(root)) {
      affectedCharacters.add(entry.character_id);
    }
  }
  for (const characterId of affectedCharacters) {
    db.prepare(`
      INSERT INTO memory_context_versions (character_id, version, updated_at)
      VALUES (?, 1, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        version = version + 1,
        updated_at = excluded.updated_at
    `).run(characterId, nowMs);
  }

  const needsReverification = new Set();
  for (const [root, componentEntries] of rootEntries) {
    if (componentEntries.length !== 1) {
      continue;
    }
    const entry = componentEntries[0];
    const parentMissing = entry.parent_entry_id && !entriesById.has(entry.parent_entry_id);
    if (changedRoots.has(root) || parentMissing) {
      needsReverification.add(finalByRoot.get(root));
    }
  }

  const changedEntries = [...changedRoots]
    .flatMap((root) => rootEntries.get(root));
  const affectedIdentities = new Set();
  for (const [identityId, roots] of identityRoots) {
    if (
      roots.size > 1 ||
      identityEntries.get(identityId).some(
        (entry) => finalByRoot.get(rootOf.get(entry.id)) !== identityId,
      )
    ) {
      affectedIdentities.add(identityId);
    }
  }

  const report = {
    version: REPORT_VERSION,
    appliedAt: nowMs,
    splitIdentities: affectedIdentities.size,
    splitEntries: changedEntries.length,
    createdIdentities: newIdentities.length,
    needsReverification: [...needsReverification].sort(),
    cycles: [...cycleNodes].sort(),
  };
  db.prepare(`
    INSERT INTO app_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(REPORT_KEY, JSON.stringify(report));
  return report;
}

function compareEntries(left, right) {
  if (left.created_at !== right.created_at) {
    return left.created_at - right.created_at;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function createUnionFind() {
  const parent = new Map();
  function add(node) {
    if (!parent.has(node)) {
      parent.set(node, node);
    }
  }
  function find(node) {
    let root = node;
    while (parent.get(root) !== root) {
      root = parent.get(root);
    }
    let current = node;
    while (parent.get(current) !== root) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }
    return root;
  }
  function union(left, right) {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent.set(rightRoot, leftRoot);
    }
  }
  return { add, find, union };
}

module.exports = { migrateLegacyIdentityGroups, REPORT_KEY };
