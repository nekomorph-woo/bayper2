/* S04e 把已授权来源分析接入应用级自动机会。
   一个机会只选择一个授权目录中的一份会话并调用 source-analysis 一次；
   不扫描全部正文、不重试、不另建调度器。游标只保存目录 ID、相对路径与
   各授权目录的最小文件位置，用于目录和目录内文件的边界轮转。 */
const { createAutomaticOpportunities } = require("./automatic-opportunities.cjs");
const { AppError } = require("./errors.cjs");

const MIN_ENERGY = 30;
const CURSOR_KEY = "source_analysis_cursor";
const MAX_GRANTS_PER_ATTEMPT = 16;

function createSourceAutomation({
  store,
  companionship,
  permissions,
  reader,
  analysis,
  isBlocked = () => false,
  isModelConfigured = () => true,
  now = () => Date.now(),
  random = () => Math.random(),
} = {}) {
  if (
    !store ||
    typeof store.getAppState !== "function" ||
    typeof store.setAppState !== "function" ||
    typeof store.runInTransaction !== "function"
  ) {
    throw new AppError("DEPENDENCY_REQUIRED", "来源自动化需要 store 状态接口。");
  }
  if (!companionship || typeof companionship.getSnapshot !== "function") {
    throw new AppError("DEPENDENCY_REQUIRED", "来源自动化需要陪伴快照。");
  }
  if (
    !permissions ||
    typeof permissions.isEnabled !== "function" ||
    typeof permissions.listGrantsWithValidity !== "function" ||
    typeof permissions.issueReadPermit !== "function" ||
    typeof permissions.releaseReadPermit !== "function"
  ) {
    throw new AppError("DEPENDENCY_REQUIRED", "来源自动化需要权限服务。");
  }
  if (!reader || typeof reader.listSessionFiles !== "function") {
    throw new AppError("DEPENDENCY_REQUIRED", "来源自动化需要会话读取器。");
  }
  if (
    !analysis ||
    typeof analysis.analyze !== "function" ||
    typeof analysis.cancel !== "function" ||
    typeof analysis.dispose !== "function"
  ) {
    throw new AppError("DEPENDENCY_REQUIRED", "来源自动化需要来源分析服务。");
  }

  let disposed = false;
  let activeRun = null;

  function readCursor() {
    try {
      const raw = store.getAppState(CURSOR_KEY);
      if (!raw) {
        return null;
      }
      const value = JSON.parse(raw);
      if (typeof value?.directoryId !== "string" || value.directoryId.length === 0) {
        return null;
      }
      const relativePath = typeof value.relativePath === "string" ? value.relativePath : "";
      const files = {};
      if (value.files && typeof value.files === "object" && !Array.isArray(value.files)) {
        for (const [directoryId, filePath] of Object.entries(value.files)) {
          if (
            typeof directoryId === "string" &&
            directoryId.length > 0 &&
            typeof filePath === "string" &&
            filePath.length > 0
          ) {
            files[directoryId] = filePath;
          }
        }
      }
      // 兼容旧的单目录游标：把旧文件位置作为该目录的文件游标。
      if (relativePath && !files[value.directoryId]) {
        files[value.directoryId] = relativePath;
      }
      return { directoryId: value.directoryId, relativePath, files };
    } catch {
      // 游标损坏时从第一份文件重新开始，不影响授权与预算事实。
    }
    return null;
  }

  function saveCursor(cursor) {
    try {
      store.setAppState(
        CURSOR_KEY,
        JSON.stringify({
          directoryId: cursor.directoryId,
          relativePath: cursor.relativePath ?? "",
          files: cursor.files ?? {},
        }),
      );
    } catch (error) {
      console.error("来源分析游标保存失败：", error?.message ?? error);
    }
  }

  function blockedNow() {
    try {
      return isBlocked() === true;
    } catch {
      return true;
    }
  }

  function characterEligible(characterId) {
    if (blockedNow()) {
      return false;
    }
    try {
      const snapshot = companionship.getSnapshot();
      if (snapshot.interaction || snapshot.pendingRotation) {
        return false;
      }
      const roster = Array.isArray(snapshot.roster) ? snapshot.roster : [];
      if (!roster.some((entry) => entry?.characterId === characterId)) {
        return false;
      }
      const character = (snapshot.characters ?? []).find(
        (item) => item.characterId === characterId,
      );
      const energy = Number(character?.stats?.energy);
      return Boolean(
        character &&
          character.inRoster === true &&
          Number.isFinite(energy) &&
          energy > MIN_ENERGY &&
          character.exploring !== true &&
          character.mode !== "resting" &&
          character.mode !== "interacting",
      );
    } catch {
      return false;
    }
  }

  function isEligible(characterId) {
    return characterEligible(characterId);
  }

  function validGrants() {
    try {
      return permissions
        .listGrantsWithValidity()
        .filter((grant) => grant.active === true && grant.valid === true)
        .sort((left, right) => left.id.localeCompare(right.id));
    } catch {
      return null;
    }
  }

  function listFiles(grantId) {
    let permit = null;
    try {
      permit = permissions.issueReadPermit(grantId);
      return reader.listSessionFiles(permit);
    } catch {
      return null;
    } finally {
      if (permit) {
        try {
          permissions.releaseReadPermit(permit);
        } catch {
          // 释放失败不改变本次枚举结果。
        }
      }
    }
  }

  function chooseSession() {
    if (!permissions.isEnabled()) {
      return { reason: "ANALYSIS_DISABLED" };
    }
    const grants = validGrants();
    if (grants === null) {
      return { reason: "GRANT_LOOKUP_FAILED" };
    }
    if (grants.length === 0) {
      return { reason: "NO_VALID_GRANT" };
    }

    const cursor = readCursor();
    const fileCursors = cursor?.files ? { ...cursor.files } : {};
    const cursorIndex = cursor
      ? grants.findIndex((grant) => grant.id === cursor.directoryId)
      : -1;
    // 每次机会从游标目录的下一个目录开始；目录内再按文件游标轮转。
    const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
    const limit = Math.min(grants.length, MAX_GRANTS_PER_ATTEMPT);
    let lastAttempted = null;
    let truncated = false;

    for (let offset = 0; offset < limit; offset += 1) {
      const grant = grants[(start + offset) % grants.length];
      lastAttempted = grant.id;
      const listing = listFiles(grant.id);
      if (!listing || !Array.isArray(listing.files)) {
        continue;
      }
      truncated = truncated || listing.truncated === true;
      const files = listing.files.filter(
        (file) => typeof file?.relativePath === "string" && file.relativePath.length > 0,
      );
      if (files.length === 0) {
        continue;
      }

      let index = 0;
      const lastPath = fileCursors[grant.id];
      if (lastPath) {
        const at = files.findIndex((file) => file.relativePath === lastPath);
        if (at >= 0 && at + 1 < files.length) {
          index = at + 1;
        }
      }
      const selected = files[index];
      return {
        grant,
        file: selected,
        truncated,
        cursor: {
          directoryId: grant.id,
          relativePath: selected.relativePath,
          files: { ...fileCursors, [grant.id]: selected.relativePath },
        },
      };
    }

    // 空/坏目录也要推进目录游标，后续机会从本次最后尝试的目录之后继续。
    return {
      reason: "NO_SESSION_FILE",
      truncated,
      cursor: lastAttempted
        ? { directoryId: lastAttempted, relativePath: "", files: fileCursors }
        : null,
    };
  }

  async function runActivity({ characterId, requestId, isEligible: opportunityEligible }) {
    if (disposed) {
      return { status: "skipped", reason: "DISPOSED" };
    }
    if (
      (typeof opportunityEligible === "function" && !opportunityEligible(characterId)) ||
      !characterEligible(characterId)
    ) {
      return { status: "skipped", reason: "NOT_ELIGIBLE" };
    }
    if (!isModelConfigured()) {
      return { status: "skipped", reason: "MODEL_NOT_CONFIGURED" };
    }

    const selected = chooseSession();
    if (selected.cursor) {
      saveCursor(selected.cursor);
    }
    if (selected.reason) {
      return {
        status: "skipped",
        reason: selected.reason,
        truncated: selected.truncated === true,
      };
    }

    // 先推进目录/文件游标再分析；失败/坏文件只会在下一次机会换目录/文件，不在本次重试。
    const result = await analysis.analyze({
      requestId,
      characterId,
      directoryId: selected.grant.id,
      relativePath: selected.file.relativePath,
    });
    return {
      ...result,
      directoryId: selected.grant.id,
      relativePath: selected.file.relativePath,
      enumerationTruncated: selected.truncated === true,
    };
  }

  const opportunities = createAutomaticOpportunities({
    store,
    companionship,
    now,
    random,
    runActivity: (payload) => {
      const run = runActivity(payload);
      activeRun = run;
      return run.finally(() => {
        if (activeRun === run) {
          activeRun = null;
        }
      });
    },
    cancelActivity: () => {
      analysis.cancel();
    },
  });

  function evaluate() {
    return opportunities.evaluate();
  }

  function pause() {
    analysis.cancel();
    return opportunities.pause();
  }

  function resume() {
    if (blockedNow()) {
      return false;
    }
    return opportunities.resume();
  }

  /* 关闭分析或撤销授权时取消当前在途分析；机会时间表不因开关变化重置。 */
  function cancelActive() {
    analysis.cancel();
  }

  async function dispose() {
    if (disposed) {
      return false;
    }
    disposed = true;
    opportunities.dispose();
    analysis.cancel();
    analysis.dispose();
    if (activeRun) {
      await Promise.race([
        activeRun.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    return true;
  }

  return { evaluate, pause, resume, cancelActive, dispose, isEligible };
}

module.exports = { createSourceAutomation, CURSOR_KEY };
