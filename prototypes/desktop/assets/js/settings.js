/* 设置：模型服务、桌面与通知、陪伴节奏、来源与隐私、数据与关于。
   Key 只在输入框里，不读进状态、不写存储；保存失败保留输入并内联提示。 */

(function () {
  const A = window.App;
  const DATA = A.data;
  const state = A.state;

  const SECTIONS = [
    { id: "model", label: "模型服务" },
    { id: "desktop", label: "桌面与通知" },
    { id: "rhythm", label: "陪伴节奏" },
    { id: "privacy", label: "来源与隐私" },
    { id: "data", label: "数据与关于" },
  ];

  const SIZE_LABEL = { s: "小", m: "中", l: "大" };
  const SIZE_PX = { s: 96, m: 124, l: 152 };

  let section = A.params.get("section");
  if (!SECTIONS.some((s) => s.id === section)) section = "model";

  const forceError = A.params.get("state") === "error";
  let focusAfter = "";

  const snavEl = document.getElementById("snav");
  const panelEl = document.getElementById("panel");

  // 走查用：?state=demo 预置「分析已开 + 一个来源已授权」，方便截图复验。
  if (A.params.get("state") === "demo") {
    state.settings.privacy.analysis = true;
    state.dirs[DATA.agentSources[0].id] = DATA.agentSources[0].dirLabel;
  }

  const esc = A.escapeHtml;

  function noteSlot() {
    return `<div id="noteSlot"></div>`;
  }

  function showNote(message, ok) {
    const slot = document.getElementById("noteSlot");
    if (!slot) return;
    slot.innerHTML = `<p class="${ok ? "ok-note" : "save-note"}">${esc(message)}</p>`;
  }

  function switchRow(title, hint, checked, key, locked) {
    return `<div class="row">
        <div>
          <p class="row__label">${esc(title)}</p>
          <p class="row__hint">${esc(hint)}</p>
        </div>
        <label class="switch">
          <input type="checkbox" data-toggle="${key}" ${checked ? "checked" : ""}
            ${locked ? "disabled" : ""} aria-label="${esc(title)}">
          <span class="switch__track"></span>
        </label>
      </div>`;
  }

  /* ---------- 模型服务 ---------- */

  function viewModel() {
    const model = state.settings.model;
    return `
      <h2>模型服务</h2>
      <p class="panel__desc">配置保存到本机，不发任何请求。Key 需要填写，但只留在输入框里。</p>
      ${noteSlot()}
      <form class="formgrid" id="modelForm" novalidate>
        <div class="field">
          <label for="endpoint">Endpoint</label>
          <input class="input" id="endpoint" type="text" spellcheck="false" autocomplete="off"
            value="${esc(model.endpoint)}">
          <p class="field__error" data-error="endpoint" hidden></p>
          <p class="field__hint">需要完整的 http:// 或 https:// 地址，本机与局域网都可以。</p>
        </div>
        <div class="field">
          <label for="model">模型</label>
          <input class="input" id="model" type="text" spellcheck="false" autocomplete="off"
            value="${esc(model.model)}">
          <p class="field__error" data-error="model" hidden></p>
        </div>
        <div class="field">
          <label for="apiKey">API Key</label>
          <input class="input" id="apiKey" type="password" autocomplete="off" placeholder="填入演示用 Key">
          <p class="field__error" data-error="apiKey" hidden></p>
          <p class="field__hint">不会写入存储，刷新后是空的。</p>
        </div>
        <div class="form-actions">
          <button class="btn btn--primary" type="submit">保存配置</button>
          <button class="btn btn--ghost" type="button" data-reset-model>恢复默认</button>
        </div>
      </form>`;
  }

  // 只接受能解析、带主机名的 http(s) 地址。
  function endpointError(value) {
    if (!value) return "请填写 Endpoint。";
    let url;
    try {
      url = new URL(value);
    } catch (error) {
      return "这不是一个完整地址，需要以 http:// 或 https:// 开头。";
    }
    if (!/^https?:$/.test(url.protocol)) return "只支持 http:// 或 https://。";
    if (!url.hostname) return "地址里缺少主机名。";
    return "";
  }

  function bindModel() {
    const form = document.getElementById("modelForm");

    const setError = (name, message) => {
      const field = form.querySelector(`[data-error="${name}"]`);
      const input = form.querySelector(`#${name}`);
      field.textContent = message;
      field.hidden = !message;
      input.setAttribute("aria-invalid", message ? "true" : "false");
    };

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const endpoint = form.querySelector("#endpoint").value.trim();
      const modelName = form.querySelector("#model").value.trim();
      const key = form.querySelector("#apiKey").value.trim();

      setError("endpoint", "");
      setError("model", "");
      setError("apiKey", "");
      document.getElementById("noteSlot").innerHTML = "";

      let firstInvalid = null;
      const urlMessage = endpointError(endpoint);
      if (urlMessage) {
        setError("endpoint", urlMessage);
        firstInvalid = form.querySelector("#endpoint");
      }
      if (!modelName) {
        setError("model", "请填写模型名。");
        firstInvalid = firstInvalid || form.querySelector("#model");
      }
      if (!key) {
        setError("apiKey", "请填入一个演示用 Key，空着不能保存。");
        firstInvalid = firstInvalid || form.querySelector("#apiKey");
      }
      if (firstInvalid) {
        firstInvalid.focus();
        return;
      }

      if (forceError) {
        setError("endpoint", "这个地址没有响应。");
        form.querySelector("#endpoint").focus();
        showNote("连接测试失败：这个地址没有响应。演示环境不会真的发出请求。", false);
        return;
      }

      // Key 不读入状态，也不参与保存。
      state.settings.model = { endpoint, model: modelName };
      if (!A.save()) {
        showNote("没有保存成功，配置只在当前窗口生效。", false);
        return;
      }
      showNote("已保存到本机。Key 没有写入任何存储。", true);
    });

    form.querySelector("[data-reset-model]").addEventListener("click", () => {
      state.settings.model = JSON.parse(JSON.stringify(DATA.settings.model));
      if (!A.save()) {
        showNote("没有保存成功，配置只在当前窗口生效。", false);
        return;
      }
      render();
      document.querySelector("#endpoint").focus();
    });

    if (forceError) {
      form.querySelector("#endpoint").setAttribute("aria-invalid", "true");
      showNote("上次保存时连接测试失败：这个地址没有响应。演示环境不会真的发出请求。", false);
    }
  }

  /* ---------- 桌面与通知 ---------- */

  function viewDesktop() {
    const desktop = state.settings.desktop;
    const notify = state.settings.notify;
    return `
      <h2>桌面与通知</h2>
      <p class="panel__desc">开关只保存在本机偏好里，不会改动系统设置。</p>
      ${noteSlot()}

      <div class="group">
        <p class="group__title">桌面角色</p>
        <div class="size-row" role="group" aria-label="角色大小">
          ${["s", "m", "l"]
            .map(
              (size) => `<button class="size-opt" type="button" data-size="${size}"
                aria-pressed="${desktop.size === size}">${SIZE_LABEL[size]}</button>`
            )
            .join("")}
        </div>
        <div class="desk-preview">
          <img src="assets/img/rin.png" alt="凛在桌面上的大小预览"
            style="height:${SIZE_PX[desktop.size]}px">
        </div>
        <p class="row__hint" style="margin-top:8px">实际尺寸还会跟着屏幕缩放走。</p>
      </div>

      <div class="group">
        ${switchRow("开机启动", "登录时自动打开 Bayper。", desktop.autostart, "autostart")}
        ${switchRow("鼠标交互", "角色会回应鼠标经过。", desktop.pointer, "pointer")}
      </div>

      <div class="group">
        <p class="group__title">通知</p>
        ${switchRow(
          "Agent 需要你处理",
          "必需通知。Herdr 的 Agent 需要你决定时一定会发出，不能整体关闭。",
          true,
          "required",
          true
        )}
        ${switchRow("新角色到来", "有新的角色愿意来小窝时提醒。", notify.arrivals, "arrivals")}
        ${switchRow("故事更新", "有新的见闻时提醒。", notify.stories, "stories")}
      </div>`;
  }

  function bindDesktop() {
    panelEl.querySelectorAll("[data-size]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.settings.desktop.size = btn.dataset.size;
        const saved = A.save();
        focusAfter = `[data-size="${btn.dataset.size}"]`;
        render();
        if (!saved) showNote("没有保存成功，大小只在当前窗口生效。", false);
      });
    });

    const handlers = {
      autostart: (on) => {
        state.settings.desktop.autostart = on;
      },
      pointer: (on) => {
        state.settings.desktop.pointer = on;
      },
      arrivals: (on) => {
        state.settings.notify.arrivals = on;
      },
      stories: (on) => {
        state.settings.notify.stories = on;
      },
    };

    panelEl.querySelectorAll("[data-toggle]").forEach((input) => {
      const key = input.dataset.toggle;
      if (!handlers[key]) return;
      input.addEventListener("change", () => {
        handlers[key](input.checked);
        if (!A.save()) showNote("没有保存成功，这次改动只在当前窗口生效。", false);
      });
    });
  }

  /* ---------- 陪伴节奏 ---------- */

  function viewRhythm() {
    const rhythm = state.settings.rhythm;
    return `
      <h2>陪伴节奏</h2>
      <p class="panel__desc">自动活动是机会，不是任务。不排班，也不会补做。</p>
      ${noteSlot()}

      <div class="budget">
        <strong>每 30 分钟最多评估一次，合资格时 25% 的概率发生一件小事。</strong>
        <span>全应用同时只允许 1 个自动请求在途。</span>
      </div>

      <details class="budget-more">
        <summary>展开完整额度</summary>
        <dl>
          <div><dt>自动活动机会</dt><dd>每 30 分钟评估一次，合资格时 25%</dd></div>
          <div><dt>短日常活动</dt><dd>全应用最多 1 次／小时</dd></div>
          <div><dt>探索</dt><dd>同时 1 位；4 小时最多 1 次，24 小时最多 2 次</dd></div>
          <div><dt>自动模型请求</dt><dd>1 小时 1 次、8 小时 4 次、24 小时 6 次</dd></div>
          <div><dt>自动分享</dt><dd>1 小时 1 次、8 小时 3 次</dd></div>
        </dl>
      </details>

      <div class="group">
        <p class="group__title">已接受的小活动</p>
        ${rhythm.activities
          .map((a) => switchRow(a.name, `${a.kind} · 偶尔发生，不需要完成`, a.on, `act-${a.id}`))
          .join("")}
      </div>

      <div class="group">
        ${switchRow(
          "暂停自动活动",
          "停下所有自动开启的活动。Herdr 的通知不受影响，需要你处理时照常发出。",
          rhythm.paused,
          "pause"
        )}
      </div>`;
  }

  function bindRhythm() {
    const rhythm = state.settings.rhythm;

    panelEl.querySelectorAll("[data-toggle]").forEach((input) => {
      const key = input.dataset.toggle;
      if (key === "pause") {
        input.addEventListener("change", () => {
          rhythm.paused = input.checked;
          const saved = A.save();
          render();
          if (!saved) showNote("没有保存成功，暂停状态只在当前窗口生效。", false);
        });
        return;
      }
      if (!key.startsWith("act-")) return;
      const id = key.slice(4);
      input.addEventListener("change", () => {
        const activity = rhythm.activities.find((a) => a.id === id);
        if (activity) activity.on = input.checked;
        if (!A.save()) showNote("没有保存成功，这次改动只在当前窗口生效。", false);
      });
    });
  }

  /* ---------- 来源与隐私 ---------- */

  function viewPrivacy() {
    const on = state.settings.privacy.analysis;
    const dirs = state.dirs;

    const sources = DATA.agentSources
      .map((agent) => {
        const dir = dirs[agent.id];
        const stateText = dir
          ? `<span class="status" data-kind="desktop"><i class="status__dot"></i>已授权：${esc(
              dir
            )}</span>`
          : `<span class="status" data-kind="unknown"><i class="status__dot"></i>未授权</span>`;
        const action = dir
          ? `<button class="btn btn--quiet btn--sm" type="button" data-revoke="${agent.id}">撤销</button>`
          : `<button class="btn btn--ghost btn--sm" type="button" data-auth="${agent.id}">选择会话目录</button>`;
        return `<div class="agent-src">
            <div class="agent-src__main">
              <p class="agent-src__name">${esc(agent.name)}</p>
              <p class="agent-src__meta">${esc(agent.what)} · ${esc(agent.dirLabel)}</p>
            </div>
            <div class="agent-src__side">${stateText}${action}</div>
          </div>`;
      })
      .join("");

    return `
      <h2>来源与隐私</h2>
      <p class="panel__desc">外部分析默认关闭。原型不会读取任何真实会话目录。</p>
      ${noteSlot()}

      <div class="group">
        ${switchRow(
          "外部分析",
          "分析已授权的 Coding Agent 会话，找出可以记住的内容。开关和目录授权是两件事。",
          on,
          "analysis"
        )}
        <div class="agents">
          ${on ? sources : `<p class="row__hint">现在是关闭状态，没有读取任何会话。</p>`}
        </div>
      </div>

      <div class="group">
        <p class="group__title">分析形成的记忆</p>
        <p class="row__hint">撤销授权只会停止新的分析，已经记下的内容不会自动删除，需要单独清理。</p>
        <div class="dirlock__actions">
          <button class="btn btn--danger btn--sm" type="button" data-clean
            ${state.analysisCleared ? "disabled" : ""}>
            ${state.analysisCleared ? "没有可清理的记录" : "清理分析形成的记忆"}
          </button>
        </div>
      </div>`;
  }

  function bindPrivacy() {
    const analysis = panelEl.querySelector('[data-toggle="analysis"]');
    if (analysis) {
      analysis.addEventListener("change", () => {
        state.settings.privacy.analysis = analysis.checked;
        const saved = A.save();
        render();
        if (!saved) showNote("没有保存成功，这个开关只在当前窗口生效。", false);
      });
    }

    panelEl.querySelectorAll("[data-auth]").forEach((btn) => {
      const agentId = btn.dataset.auth;
      const agent = DATA.agentSources.find((a) => a.id === agentId);
      btn.addEventListener("click", () => {
        A.dialog({
          title: `选择 ${agent.name} 的会话目录`,
          body: `<p>下面都是模拟标签，不会真的读取磁盘。${agent.name} 的会话记录一般放在它自己的工作目录里。</p>
                 <div class="dirlist">
                   ${DATA.demoDirectories
                     .map(
                       (dir) =>
                         `<button type="button" data-dir="${esc(dir.name)}" data-ok="${dir.ok}">${esc(
                           dir.name
                         )}</button>`
                     )
                     .join("")}
                 </div>`,
          confirmText: "关闭",
          cancel: false,
          onOpen(panel) {
            panel.querySelectorAll("[data-dir]").forEach((item) => {
              item.addEventListener("click", () => {
                const name = item.dataset.dir;
                const ok = item.dataset.ok === "true";
                A.closeDialog();
                if (!ok) {
                  showNote("这个位置没有读取权限，授权没有完成。", false);
                  return;
                }
                state.dirs[agentId] = name;
                const saved = A.save();
                render();
                if (!saved) showNote("没有保存成功，授权只在当前窗口生效。", false);
                A.toast(`已经授权：${name}`);
              });
            });
          },
        });
      });
    });

    panelEl.querySelectorAll("[data-revoke]").forEach((btn) => {
      const agentId = btn.dataset.revoke;
      const agent = DATA.agentSources.find((a) => a.id === agentId);
      btn.addEventListener("click", () => {
        A.dialog({
          title: `撤销 ${agent.name} 的授权？`,
          body: `<p>分析会停下来。已经记下的内容不会被删除，需要的话可以单独清理。</p>`,
          confirmText: "撤销授权",
          danger: true,
          onConfirm() {
            delete state.dirs[agentId];
            const saved = A.save();
            render();
            if (!saved) showNote("没有保存成功，撤销只在当前窗口生效。", false);
            A.toast("已经撤销授权，分析停止了。");
          },
        });
      });
    });

    const clean = panelEl.querySelector("[data-clean]");
    if (clean) {
      clean.addEventListener("click", () => {
        A.dialog({
          title: "清理分析形成的记忆？",
          body: `<p>会删掉从 Coding Agent 会话里得来的内容。角色自己说过的话、共同经历和转述不在这里。</p>
                 <p>这一步不能撤销。</p>`,
          confirmText: "清理",
          danger: true,
          onConfirm() {
            state.analysisCleared = true;
            const saved = A.save();
            render();
            if (!saved) showNote("没有保存成功，清理只在当前窗口生效。", false);
            A.toast("分析形成的记忆已经清理。");
          },
        });
      });
    }
  }

  /* ---------- 数据与关于 ---------- */

  function viewData() {
    return `
      <h2>数据与关于</h2>
      <p class="panel__desc">这些只存在这台设备的浏览器里，不涉及真实资料。</p>
      ${noteSlot()}

      <div class="group">
        <div class="row">
          <div>
            <p class="row__label">版本</p>
            <p class="row__hint">Bayper · ${esc(DATA.versionLabel)}</p>
          </div>
        </div>
        <div class="row">
          <div>
            <p class="row__label">本地保存的内容</p>
            <p class="row__hint">称呼、固定位、桌面上的角色、聊天记录、记忆纠正、开关状态。</p>
          </div>
        </div>
      </div>

      <div class="group">
        <p class="group__title">清理</p>
        <p class="row__hint">只清除这个原型存在浏览器里的演示数据，不删除项目文件，也不碰任何真实资料。</p>
        <div class="dirlock__actions">
          <button class="btn btn--danger btn--sm" type="button" data-clear>清除演示数据</button>
        </div>
      </div>

      <div class="group">
        <p class="group__title">关于</p>
        <p class="about"><strong>Bayper</strong> 是桌面陪伴原型。角色、故事、Herdr 状态和通知都是模拟内容，
          不会调用真实模型，也不会读取真实目录或会话。</p>
      </div>`;
  }

  function bindData() {
    const clear = panelEl.querySelector("[data-clear]");
    if (!clear) return;
    clear.addEventListener("click", () => {
      A.dialog({
        title: "清除所有演示数据？",
        body: `<p>称呼、固定位、桌面同屏、聊天记录、记忆改动和设置都会回到初始状态。</p>
               <p>只影响这个原型，不会删除项目文件。</p>`,
        confirmText: "清除并重来",
        danger: true,
        onConfirm() {
          A.resetState();
          location.reload();
        },
      });
    });
  }

  /* ---------- 组装 ---------- */

  const VIEWS = {
    model: { view: viewModel, bind: bindModel },
    desktop: { view: viewDesktop, bind: bindDesktop },
    rhythm: { view: viewRhythm, bind: bindRhythm },
    privacy: { view: viewPrivacy, bind: bindPrivacy },
    data: { view: viewData, bind: bindData },
  };

  function renderNav() {
    snavEl.innerHTML = SECTIONS.map(
      (item) => `<button type="button" data-section="${item.id}"
        aria-current="${item.id === section}">${item.label}</button>`
    ).join("");

    snavEl.querySelectorAll("[data-section]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.section === section) return;
        section = btn.dataset.section;
        focusAfter = `[data-section="${section}"]`;
        render();
        document.querySelector(".page").scrollTop = 0;
      });
    });
  }

  function render() {
    renderNav();
    panelEl.innerHTML = VIEWS[section].view();
    VIEWS[section].bind();
    history.replaceState(null, "", `settings.html?section=${section}`);
    if (focusAfter) {
      const target = document.querySelector(focusAfter);
      if (target) target.focus();
      focusAfter = "";
    }
  }

  render();
})();
