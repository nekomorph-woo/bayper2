/* S04d 设置页的会话来源面板：只通过 preload 具名接口读写来源状态。
   不持有路径输入、不读取会话、不签发许可；迟到回包按激活代次丢弃。 */
(function () {
  "use strict";

  const REASON_TEXT = {
    NOT_FOUND: "目录不存在或尚未创建",
    INACCESSIBLE: "目录当前不可访问",
    NOT_DIRECTORY: "目标不是目录",
    PATH_UNAVAILABLE: "目录已不存在",
    PATH_INACCESSIBLE: "目录当前不可访问",
    GRANT_PATH_CHANGED: "目录已变化",
    REVOKED: "授权已撤销",
  };

  function reasonText(reason) {
    return REASON_TEXT[reason] || "目录当前不可用";
  }

  const SUPPORTED_PROVIDERS = new Set(["claude-code", "codex"]);

  function createSourceSettings({ api } = {}) {
    const byId = (id) => document.getElementById(id);
    const state = {
      active: false,
      busy: false,
      epoch: 0,
      current: null,
    };

    function setStatus(text) {
      byId("source-status").textContent = text;
    }

    function clearError() {
      const error = byId("source-error");
      error.hidden = true;
      error.textContent = "";
      delete error.dataset.code;
    }

    function showError(error) {
      const element = byId("source-error");
      element.hidden = false;
      element.textContent = error?.message || "来源设置没有完成，请重试。";
      element.dataset.code = error?.code || "UNKNOWN";
    }

    async function call(method, ...args) {
      if (!api || typeof api[method] !== "function") {
        return {
          ok: false,
          error: { code: "NO_BRIDGE", message: "来源接口没有加载，请重新启动应用。" },
        };
      }
      try {
        return await api[method](...args);
      } catch {
        return {
          ok: false,
          error: { code: "IPC_ERROR", message: "来源设置通信失败，请重试。" },
        };
      }
    }

    function actionButton(label, action, dataset, extraClass = "") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `btn btn-small ${extraClass || "btn-ghost"}`.trim();
      button.dataset.sourceAction = action;
      Object.assign(button.dataset, dataset);
      button.textContent = label;
      button.disabled = state.busy;
      return button;
    }

    function candidateState(candidate) {
      const grant = candidate.grant;
      if (grant) {
        return grant.valid
          ? { text: "已授权", kind: "granted" }
          : { text: "授权已失效", kind: "invalid" };
      }
      return candidate.available
        ? { text: "目录可用 · 未授权", kind: "available" }
        : { text: "目录不可用", kind: "unavailable" };
    }

    function candidateHint(candidate, enabled) {
      const grant = candidate.grant;
      if (grant) {
        if (!grant.valid) {
          return `${reasonText(grant.reason)}；请重新选择目录或撤销此授权。`;
        }
        return enabled
          ? "分析已开启；后续低频分析可能读取此目录中的受支持会话。"
          : "分析已关闭；授权保留，当前不会读取。";
      }
      if (candidate.available) {
        return "目录可用，但尚未授权；开启分析也不会自动读取。";
      }
      return `目录不可用：${reasonText(candidate.reason)}。可以选择其他目录。`;
    }

    function renderCandidate(candidate, enabled) {
      const item = document.createElement("li");
      item.className = "source-row";
      item.dataset.provider = candidate.provider;

      const main = document.createElement("div");
      main.className = "source-main";
      const head = document.createElement("div");
      head.className = "source-head";
      const name = document.createElement("span");
      name.className = "source-name";
      name.textContent = candidate.label;
      const status = candidateState(candidate);
      const badge = document.createElement("span");
      badge.className = "source-state";
      badge.dataset.state = status.kind;
      badge.textContent = status.text;
      head.append(name, badge);

      const path = document.createElement("p");
      path.className = "source-path";
      path.textContent = candidate.displayPath;
      const hint = document.createElement("p");
      hint.className = "source-hint";
      hint.textContent = candidateHint(candidate, enabled);
      main.append(head, path, hint);

      const actions = document.createElement("div");
      actions.className = "source-actions";
      if (candidate.grant) {
        actions.append(
          actionButton("撤销授权", "revoke", {
            grantId: candidate.grant.id,
          }),
        );
        if (candidate.available) {
          actions.append(
            actionButton("重新授权此目录", "authorize", {
              provider: candidate.provider,
            }),
          );
        }
      } else if (candidate.available) {
        actions.append(
          actionButton("授权此目录", "authorize", {
            provider: candidate.provider,
          }, "btn-primary"),
        );
      }
      actions.append(
        actionButton("选择其他目录", "choose", {
          provider: candidate.provider,
        }),
      );

      item.append(main, actions);
      return item;
    }

    function renderCustomGrant(grant, enabled) {
      const item = document.createElement("li");
      item.className = "source-row";
      item.dataset.provider = grant.provider;

      const main = document.createElement("div");
      main.className = "source-main";
      const head = document.createElement("div");
      head.className = "source-head";
      const name = document.createElement("span");
      name.className = "source-name";
      name.textContent = grant.providerLabel;
      const badge = document.createElement("span");
      badge.className = "source-state";
      badge.dataset.state = grant.valid ? "granted" : "invalid";
      badge.textContent = grant.valid ? "已授权" : "授权已失效";
      head.append(name, badge);

      const path = document.createElement("p");
      path.className = "source-path";
      path.textContent = grant.displayPath;
      const hint = document.createElement("p");
      hint.className = "source-hint";
      hint.textContent = grant.valid
        ? enabled
          ? "分析已开启；后续低频分析可能读取此目录中的受支持会话。"
          : "分析已关闭；授权保留，当前不会读取。"
        : `${reasonText(grant.reason)}；请重新选择目录或撤销此授权。`;
      main.append(head, path, hint);

      const actions = document.createElement("div");
      actions.className = "source-actions";
      actions.append(
        actionButton("撤销授权", "revoke", {
          grantId: grant.id,
        }),
      );
      if (SUPPORTED_PROVIDERS.has(grant.provider)) {
        actions.append(
          actionButton("选择其他目录", "choose", {
            provider: grant.provider,
          }),
        );
      }
      item.append(main, actions);
      return item;
    }

    function render() {
      const current = state.current;
      const toggle = byId("source-analysis-enabled");
      if (!current) {
        toggle.disabled = true;
        return;
      }

      toggle.checked = current.enabled;
      toggle.disabled = state.busy;
      const validGrantCount =
        current.candidates.filter((candidate) => candidate.grant?.valid).length +
        current.customGrants.filter((grant) => grant.valid).length;
      byId("source-summary").dataset.state = current.enabled ? "ok" : "";
      byId("source-summary").textContent = current.enabled
        ? validGrantCount > 0
          ? "分析已开启"
          : "分析已开启 · 没有可用授权"
        : "分析已关闭";

      byId("source-list").replaceChildren(
        ...current.candidates.map((candidate) => renderCandidate(candidate, current.enabled)),
      );
      byId("source-custom-list").replaceChildren(
        ...current.customGrants.map((grant) => renderCustomGrant(grant, current.enabled)),
      );
      byId("source-custom").hidden = current.customGrants.length === 0;
    }

    async function refresh(epoch) {
      const result = await call("getState");
      if (epoch !== state.epoch || !state.active) {
        return;
      }
      if (result.ok) {
        state.current = result.state;
        render();
      }
    }

    async function runAction(label, request, successText) {
      if (state.busy) {
        return;
      }
      const epoch = ++state.epoch;
      state.busy = true;
      clearError();
      setStatus(label);
      render();

      const result = await request();
      if (epoch !== state.epoch) {
        // 迟到回包已不再属于当前面板；若面板仍活跃，重新读取真实落库状态。
        if (state.active && !state.busy) {
          load();
        }
        return;
      }
      if (!state.active) {
        return;
      }
      state.busy = false;
      if (!result.ok) {
        showError(result.error);
        setStatus("");
        render();
        await refresh(epoch);
        return;
      }
      if (result.state) {
        state.current = result.state;
      }
      setStatus(result.canceled ? "已取消，未写入授权。" : successText);
      render();
    }

    async function load() {
      const epoch = ++state.epoch;
      state.busy = false;
      clearError();
      setStatus("正在读取来源状态…");
      const result = await call("getState");
      if (epoch !== state.epoch || !state.active) {
        return;
      }
      if (!result.ok) {
        showError(result.error);
        setStatus("");
        return;
      }
      state.current = result.state;
      setStatus("");
      render();
    }

    function activate() {
      if (!api) {
        showError({ code: "NO_BRIDGE", message: "来源接口没有加载，请重新启动应用。" });
        return;
      }
      state.active = true;
      load();
    }

    function deactivate() {
      state.active = false;
      state.epoch += 1;
      state.busy = false;
    }

    byId("source-analysis-enabled").addEventListener("change", (event) => {
      const target = event.target.checked;
      if (!state.current || state.busy) {
        event.target.checked = Boolean(state.current?.enabled);
        return;
      }
      runAction(
        "正在更新来源分析开关…",
        () => call("setEnabled", target),
        target ? "已开启来源分析。" : "已关闭来源分析。",
      );
    });

    for (const listId of ["source-list", "source-custom-list"]) {
      byId(listId).addEventListener("click", (event) => {
        const button = event.target.closest("button[data-source-action]");
        if (!button) {
          return;
        }
        const action = button.dataset.sourceAction;
        if (action === "authorize") {
          runAction(
            "等待系统确认…",
            () => call("authorizeCandidate", button.dataset.provider),
            "已授权此目录。",
          );
        } else if (action === "choose") {
          runAction(
            "等待选择目录…",
            () => call("chooseDirectory", button.dataset.provider),
            "已授权所选目录。",
          );
        } else if (action === "revoke") {
          runAction(
            "正在撤销授权…",
            () => call("revoke", button.dataset.grantId),
            "已撤销授权。",
          );
        }
      });
    }

    return { activate, deactivate };
  }

  window.createSourceSettings = createSourceSettings;
})();
