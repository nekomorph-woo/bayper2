const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { candidates } = require("../../app/content/characters.json");
const {
  recommendCharacters,
  createOnboardingService,
} = require("../../app/onboarding.cjs");
const { createStore } = require("../../app/store.cjs");

test("愿望推荐：空愿望按目录顺序，命中特征后稳定排序", () => {
  const empty = recommendCharacters("", candidates);
  assert.equal(empty.recommendedId, "rin");
  assert.deepEqual(
    empty.candidates.map((item) => item.id),
    ["rin", "hu", "cheng"],
  );
  assert.match(empty.candidates[0].reason, /默认顺序/);

  const quiet = recommendCharacters("想找安静陪着我的伙伴", candidates);
  assert.equal(quiet.recommendedId, "rin");
  assert.match(quiet.candidates[0].reason, /安静/);

  const lively = recommendCharacters("想要活泼一点，能聊天的", candidates);
  assert.equal(lively.recommendedId, "hu");

  const slow = recommendCharacters("慢慢来，午后发发呆", candidates);
  assert.equal(slow.recommendedId, "cheng");

  const noMatch = recommendCharacters("今天天气不错", candidates);
  assert.equal(noMatch.recommendedId, "rin");
  assert.match(noMatch.candidates[0].reason, /默认顺序/);
});

test("接纳事务幂等：重复接纳不新增关系、固定位或当前角色", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-unit-"));
  const store = createStore(dataDir);
  try {
    store.saveModelConfig({
      baseUrl: "https://api.example.com/v1",
      modelName: "unit-model",
      keyCipher: Buffer.from("cipher-only"),
      updatedAt: new Date().toISOString(),
    });
    const service = createOnboardingService({
      store,
      safeStorage: {
        isAsyncEncryptionAvailable: async () => true,
        encryptStringAsync: async () => Buffer.from("unused"),
      },
      candidates,
    });

    const first = service.accept("rin");
    assert.equal(first.alreadyAccepted, false);
    assert.equal(first.acceptedCharacterId, "rin");
    assert.equal(first.snapshot.state, "accepted");
    assert.equal(first.snapshot.currentCharacter.name, "凛");

    const second = service.accept("hu");
    assert.equal(second.alreadyAccepted, true);
    assert.equal(second.acceptedCharacterId, "rin");
    assert.equal(second.snapshot.relationship.characterId, "rin");

    assert.throws(
      () => service.accept("nobody"),
      (error) => error.code === "INVALID_CHARACTER",
    );

    const db = new DatabaseSync(store.dbPath, { readOnly: true });
    try {
      const count = (sql) => db.prepare(sql).get().n;
      assert.equal(count("SELECT count(*) AS n FROM relationships"), 1);
      assert.equal(count("SELECT count(*) AS n FROM roster"), 1);
      assert.deepEqual(
        { ...db.prepare("SELECT intimacy, energy, mood FROM character_stats").get() },
        { intimacy: 10, energy: 100, mood: 0 },
      );
      assert.equal(
        db.prepare("SELECT value FROM app_state WHERE key = 'current_character_id'").get().value,
        "rin",
      );
      assert.equal(
        db.prepare("SELECT value FROM app_state WHERE key = 'fixed_character_id'").get().value,
        "rin",
      );
    } finally {
      db.close();
    }
  } finally {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
