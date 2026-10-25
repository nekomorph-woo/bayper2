/* S04d 设置页的会话来源状态与目录授权接线。
   只检查已配置候选根、原生确认/选择目录并调用既有权限服务；
   不枚举会话正文、不签发读取许可、不改变分析开关以外的事实。 */
const fs = require("node:fs");
const path = require("node:path");
const { AppError } = require("./errors.cjs");

const PROVIDERS = Object.freeze([
  {
    provider: "claude-code",
    label: "Claude Code",
    configEnv: "CLAUDE_CONFIG_DIR",
    homeDir: ".claude",
    childDir: "projects",
  },
  {
    provider: "codex",
    label: "Codex",
    configEnv: "CODEX_HOME",
    homeDir: ".codex",
    childDir: "sessions",
  },
]);

const PROVIDER_BY_ID = new Map(PROVIDERS.map((provider) => [provider.provider, provider]));
const PATH_LIMIT = 4096;
const ID_LIMIT = 200;

const REASON_TEXT = Object.freeze({
  NOT_FOUND: "目录不存在或尚未创建",
  INACCESSIBLE: "目录当前不可访问",
  NOT_DIRECTORY: "目标不是目录",
  PATH_UNAVAILABLE: "目录已不存在",
  PATH_INACCESSIBLE: "目录当前不可访问",
  GRANT_PATH_CHANGED: "目录已变化，需要重新授权",
  REVOKED: "授权已撤销",
});

function contract(value, field, limit) {
  if (typeof value !== "string") {
    throw new AppError("INVALID_INPUT", `${field}必须是字符串。`);
  }
  const text = value.trim();
  if (!text || text.length > limit || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new AppError("INVALID_INPUT", `${field}无效。`);
  }
  return text;
}

function providerDefinition(providerValue) {
  const provider = contract(providerValue, "来源", 100);
  const definition = PROVIDER_BY_ID.get(provider);
  if (!definition) {
    throw new AppError("UNSUPPORTED_PROVIDER", "暂不支持这个会话来源。");
  }
  return definition;
}

function configuredRoot({ homeDir, env, definition }) {
  const override = env?.[definition.configEnv];
  if (typeof override === "string" && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(homeDir, definition.homeDir);
}

/* Claude 默认 ~/.claude/projects（CLAUDE_CONFIG_DIR 可改变配置根）；
   Codex 默认 ~/.codex/sessions（CODEX_HOME 可改变配置根）。
   这里只建立候选路径，不读取目录内容。 */
function buildDefaultSourceCandidates({ homeDir, env = process.env } = {}) {
  if (typeof homeDir !== "string" || homeDir.trim() === "") {
    throw new AppError("INVALID_INPUT", "无法确定用户主目录。");
  }
  return PROVIDERS.map((definition) => ({
    provider: definition.provider,
    label: definition.label,
    path: path.join(configuredRoot({ homeDir, env, definition }), definition.childDir),
  }));
}

function directoryIdentity(displayPath) {
  // 确认前后各核对一次；最终授权仍由 permissions.grantDirectory 重新解析并落库。
  try {
    const canonicalPath = fs.realpathSync(displayPath);
    const stat = fs.statSync(canonicalPath, { bigint: true });
    if (!stat.isDirectory()) {
      throw new AppError("NOT_A_DIRECTORY", "目标不是目录。");
    }
    return {
      displayPath,
      canonicalPath,
      identity: `${stat.dev}:${stat.ino}`,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    const denied = error.code === "EACCES" || error.code === "EPERM";
    throw new AppError(
      denied ? "PATH_INACCESSIBLE" : "PATH_UNAVAILABLE",
      denied ? "目录当前不可访问。" : "目录不存在或无法解析。",
    );
  }
}

function reasonMessage(reason) {
  return REASON_TEXT[reason] || "目录当前不可用";
}

function publicGrant(grant, providerLabel) {
  return {
    id: grant.id,
    provider: grant.provider,
    providerLabel,
    displayPath: grant.displayPath,
    revision: grant.revision,
    active: grant.active,
    valid: grant.valid,
    reason: grant.reason,
  };
}

function createSourceSettings({
  permissions,
  candidates = [],
  dialog,
  getWindow = () => null,
  isRequestActive = () => true,
} = {}) {
  if (
    !permissions ||
    typeof permissions.isEnabled !== "function" ||
    typeof permissions.setEnabled !== "function" ||
    typeof permissions.discoverCandidates !== "function" ||
    typeof permissions.grantDirectory !== "function" ||
    typeof permissions.revokeDirectory !== "function" ||
    typeof permissions.listGrantsWithValidity !== "function"
  ) {
    throw new AppError("PERMISSIONS_REQUIRED", "来源设置需要权限服务。");
  }
  if (!dialog || typeof dialog.showOpenDialog !== "function" || typeof dialog.showMessageBox !== "function") {
    throw new AppError("DIALOG_REQUIRED", "来源设置需要原生目录对话框。");
  }

  const configuredCandidates = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => PROVIDER_BY_ID.has(candidate?.provider))
    .map((candidate) => ({
      provider: candidate.provider,
      label: PROVIDER_BY_ID.get(candidate.provider).label,
      path: path.resolve(contract(candidate.path, "候选目录", PATH_LIMIT)),
    }));

  function activeWindow() {
    const window = getWindow();
    if (!window || (typeof window.isDestroyed === "function" && window.isDestroyed())) {
      return null;
    }
    if (typeof window.isVisible === "function" && !window.isVisible()) {
      return null;
    }
    return window;
  }

  /* 原生对话框等待期间窗口可能被关闭或应用开始退出。
     迟到的确认只有在请求仍属于可见管理窗时才允许落库。 */
  function requestWindow() {
    const window = activeWindow();
    if (!window || !isRequestActive()) {
      throw new AppError("REQUEST_INACTIVE", "窗口已关闭或应用正在退出，目录授权已取消。");
    }
    return window;
  }

  function assertRequestWindow(window) {
    if (!window || window.isDestroyed() || !window.isVisible() || !isRequestActive()) {
      throw new AppError("REQUEST_INACTIVE", "窗口已关闭或应用正在退出，目录授权已取消。");
    }
  }

  function grantFor(grants, provider, displayPath) {
    return (
      grants.find(
        (grant) => grant.active && grant.provider === provider && grant.displayPath === displayPath,
      ) ?? null
    );
  }

  function getState() {
    const discovered = permissions.discoverCandidates();
    const grants = permissions.listGrantsWithValidity().map((grant) =>
      publicGrant(grant, PROVIDER_BY_ID.get(grant.provider)?.label ?? grant.provider),
    );
    const matchedGrantIds = new Set();
    const visibleCandidates = [];

    for (const item of discovered) {
      const definition = PROVIDER_BY_ID.get(item.provider);
      if (!definition) {
        continue;
      }
      const grant = grantFor(grants, item.provider, item.displayPath);
      if (grant) {
        matchedGrantIds.add(grant.id);
      }
      visibleCandidates.push({
        provider: item.provider,
        label: definition.label,
        displayPath: item.displayPath,
        available: item.available,
        reason: item.reason ?? null,
        grant,
      });
    }

    return {
      enabled: permissions.isEnabled(),
      candidates: visibleCandidates,
      customGrants: grants.filter((grant) => grant.active && !matchedGrantIds.has(grant.id)),
    };
  }

  async function confirmAndGrant(definition, selectedPath) {
    const displayPath = path.resolve(contract(selectedPath, "目录", PATH_LIMIT));
    const window = requestWindow();
    const before = directoryIdentity(displayPath);
    const options = {
      type: "warning",
      buttons: ["取消", "允许分析此目录"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: "确认目录授权",
      message: `允许 ${definition.label} 分析这个目录？`,
      detail: [
        `来源：${definition.label}`,
        `目录：${before.displayPath}`,
        ...(before.canonicalPath !== before.displayPath
          ? [`实际位置：${before.canonicalPath}`]
          : []),
        "",
        "分析会话中用户表达的内容，可能发送必要片段到你配置的模型；不会把原目录作为记忆存储。",
        "只有开启“允许分析”后才会读取；关闭开关或撤销授权会停止后续分析。",
      ].join("\n"),
    };

    const response = await dialog.showMessageBox(window, options);
    if (response?.response !== 1) {
      return { canceled: true, state: getState() };
    }
    assertRequestWindow(window);

    // 确认期间目录可能被替换或改向；重新核对后再落库，不把新目标当作原选择。
    const after = directoryIdentity(displayPath);
    if (after.canonicalPath !== before.canonicalPath || after.identity !== before.identity) {
      throw new AppError("DIRECTORY_CHANGED", "目录在确认期间发生变化，请重新选择。");
    }

    const grant = permissions.grantDirectory(definition.provider, displayPath);
    return {
      canceled: false,
      grant: publicGrant({ ...grant, valid: true, reason: null }, definition.label),
      state: getState(),
    };
  }

  async function authorizeCandidate(providerValue) {
    const definition = providerDefinition(providerValue);
    const candidate = configuredCandidates.find((item) => item.provider === definition.provider);
    const discovered = permissions.discoverCandidates().find(
      (item) => item.provider === definition.provider,
    );
    if (!candidate || !discovered?.available) {
      throw new AppError(
        "SOURCE_UNAVAILABLE",
        `默认目录当前不可用：${reasonMessage(discovered?.reason)}；请选择其他目录。`,
      );
    }
    return confirmAndGrant(definition, discovered.displayPath);
  }

  async function chooseDirectory(providerValue) {
    const definition = providerDefinition(providerValue);
    const options = {
      title: `选择 ${definition.label} 会话目录`,
      buttonLabel: "选择此目录",
      message: "只选择包含会话记录的目录；不会扫描其他位置。",
      properties: ["openDirectory"],
    };
    const window = requestWindow();
    const result = await dialog.showOpenDialog(window, options);
    if (result?.canceled || !Array.isArray(result?.filePaths) || result.filePaths.length === 0) {
      return { canceled: true, state: getState() };
    }
    assertRequestWindow(window);
    return confirmAndGrant(definition, result.filePaths[0]);
  }

  function setEnabled(enabled) {
    if (typeof enabled !== "boolean") {
      throw new AppError("INVALID_INPUT", "分析开关必须是布尔值。");
    }
    permissions.setEnabled(enabled);
    return getState();
  }

  function revokeDirectory(grantId) {
    const id = contract(grantId, "授权ID", ID_LIMIT);
    permissions.revokeDirectory(id);
    return getState();
  }

  return {
    getState,
    setEnabled,
    authorizeCandidate,
    chooseDirectory,
    revokeDirectory,
  };
}

module.exports = {
  buildDefaultSourceCandidates,
  createSourceSettings,
  PROVIDERS,
};
