/* S06j 故事回看与相遇邀请面板。只通过 preload 的具名故事接口读写；
   拥有故事列表/详情状态与异步生命周期，app.js 只负责导航和快照接线。
   邀请只有在实际绘制并进入故事详情局部滚动视口后才回执 manual 展示。 */
(function () {
  "use strict";

  function createStoryPanel({
    api,
    showAlert,
    getSnapshot,
    isActive,
    applySnapshot,
  }) {
    const byId = (id) => document.getElementById(id);
    const STORY_TYPE_LABELS = { character: "角色故事", outfit: "衣装故事" };
    const STORY_STATUS_LABELS = {
      prepared: "待展示",
      pending: "等你决定",
      later: "已稍后",
      rejected: "已结束",
      accepted: "已接纳",
    };
    const STORY_REASON_TEXT = {
      ASSET_UNAVAILABLE: "这段故事的素材暂时不可用；故事与邀请都会保留。",
      STORY_UNAVAILABLE: "当前版本暂时找不到这段故事。",
      STORY_IDENTITY_CONFLICT: "当前版本内容与已记录的故事不一致，暂不能展示邀请。",
      STORY_NOT_MATURE: "故事还没有完整发生。",
      ALREADY_ACCEPTED: "这位角色已经在小窝里了。",
      TARGET_REJECTED: "这次相遇已经结束；若想再考虑，可以从故事里重新开启同一份邀请。",
      INVITATION_ACTIVE: "还有另一份相遇邀请在等你决定。",
      INVITATION_QUOTA: "自动邀请还在间隔中；主动回看不会占用这份额度。",
      STORY_VIEW_STALE: "当前故事详情已切换，请重新打开后再确认展示。",
      INVITATION_NOT_VISIBLE: "邀请还没有进入可见区域，暂时不会记为已展示。",
    };
    const STORY_SUCCESS = {
      acceptInvitation: "已接纳。她已加入角色列表；当前在场、固定位和今日名单没有被改动。",
      deferInvitation: "已稍后。不会催你，故事和邀请都会保留。",
      rejectInvitation: "已不接纳。故事仍可回看，也可以随时重新开启。",
      reopenInvitation: "邀请已重新开启。",
    };

    const state = {
      active: false,
      list: [],
      loading: false,
      detail: null,
      selectedId: null,
      viewToken: null,
      seq: 0,
      listSeq: 0,
      busy: false,
      acking: null,
      notice: "",
      error: null,
    };
    let bound = false;
    let ackFrame = null;

    function characters() {
      return getSnapshot()?.companionship?.characters ?? [];
    }

    function call(method, ...args) {
      if (!api || typeof api[method] !== "function") {
        return Promise.resolve({
          ok: false,
          error: { code: "IPC_ERROR", message: "故事回看暂时不可用。" },
        });
      }
      return api[method](...args).catch(() => ({
        ok: false,
        error: { code: "IPC_ERROR", message: "故事通信失败，请重试。" },
      }));
    }

    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function personName(characterId, fallback) {
      return (
        characters().find((item) => item.characterId === characterId)?.displayName ??
        fallback ??
        characterId
      );
    }

    function dateText(ms) {
      if (!Number.isFinite(ms)) return "";
      const date = new Date(ms);
      const pad = (value) => String(value).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    function storyTitle(story) {
      return story.type === "outfit"
        ? `${personName(story.ownerCharacterId, story.ownerName)} 的衣装故事`
        : `关于${personName(story.targetId, story.targetName)}`;
    }

    function storyMeta(story) {
      return `${story.themeName ?? "版本故事"} · ${
        story.progressStatus === "mature" ? "故事已完整发生" : "故事还在继续"
      }`;
    }

    function sourceLabel(sources) {
      const kinds = new Set(sources.map((source) => source.kind));
      return kinds.has("daily")
        ? "日常记录"
        : kinds.has("exploration")
          ? "探索记录"
          : "活动记录";
    }

    function panelVisible() {
      const panel = byId("character-stories");
      return Boolean(
        state.active &&
          panel &&
          !panel.hidden &&
          isActive &&
          isActive() &&
          document.visibilityState === "visible",
      );
    }

    function invitationInViewport(invitation) {
      const detail = state.detail;
      if (
        !detail ||
        !invitation ||
        invitation.status !== "prepared" ||
        detail.story.storyId !== state.selectedId ||
        detail.invitation?.invitationId !== invitation.invitationId ||
        !panelVisible()
      ) {
        return false;
      }
      const box = byId("story-invitation");
      const viewport = byId("story-detail");
      const title = box?.querySelector(".story-invitation-title");
      const body = byId("story-invitation-text");
      if (!box || !viewport || !title || !body || box.hidden || viewport.hidden) {
        return false;
      }
      if (!box.getClientRects().length || !viewport.getClientRects().length) return false;
      const style = window.getComputedStyle(box);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const view = viewport.getBoundingClientRect();
      const visibleHeight = (rect) =>
        Math.max(0, Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top));
      const visibleWidth = (rect) =>
        Math.max(0, Math.min(rect.right, view.right) - Math.max(rect.left, view.left));
      const titleRect = title.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      // 只露出边框或 1~2px 不算可读；至少标题和正文各有可读区域。
      return (
        visibleWidth(titleRect) > 0 &&
        visibleHeight(titleRect) >= Math.min(titleRect.height, 16) &&
        visibleWidth(bodyRect) > 0 &&
        visibleHeight(bodyRect) >= Math.min(bodyRect.height, 24)
      );
    }

    function updateListItem(invitation) {
      if (!invitation) return;
      state.list = state.list.map((item) =>
        item.storyId === invitation.storyId ? { ...item, invitation } : item,
      );
      renderList();
    }

    function renderList() {
      const list = byId("story-list");
      if (!list) return;
      list.replaceChildren(
        ...state.list.map((story) => {
          const button = element("button", "character-item");
          button.type = "button";
          button.dataset.storyId = story.storyId;
          if (story.storyId === state.selectedId) {
            button.setAttribute("aria-current", "true");
          }
          const extra = story.invitation
            ? ` · ${STORY_STATUS_LABELS[story.invitation.status] ?? "邀请"}`
            : "";
          const who = element("span", "character-item-who");
          who.append(
            element("span", "character-item-name", storyTitle(story)),
            element(
              "span",
              "character-item-state",
              `${STORY_TYPE_LABELS[story.type] ?? "故事"}${extra}`,
            ),
          );
          button.append(who);
          button.addEventListener("click", () => selectStory(story.storyId));
          const item = element("li");
          item.append(button);
          return item;
        }),
      );
      const empty = byId("story-empty");
      empty.hidden = state.loading || state.list.length > 0;
      empty.textContent = state.loading
        ? "正在读取故事…"
        : "还没有已发生的故事。继续日常或探索后再回来看看。";
      list.hidden = state.list.length === 0;
    }

    function renderNodes(detail) {
      byId("story-nodes").replaceChildren(
        ...detail.story.nodes.map((node) => {
          const narrators = [
            ...new Set(
              node.sources.map((source) =>
                personName(source.narratorId, source.narratorName),
              ),
            ),
          ];
          const item = element("article", "settings-block");
          item.append(
            element("p", null, node.body ?? "这段故事内容暂时不可用。"),
            element(
              "p",
              "note",
              `由${narrators.join("、") || "记录"}讲述 · ${sourceLabel(
                node.sources,
              )} · ${dateText(node.learnedAt)}`,
            ),
          );
          return item;
        }),
      );
    }

    function renderInvitation(detail) {
      const box = byId("story-invitation");
      const { invitation, otherInvitation: other, preparation } = detail;
      box.hidden = !invitation && !other && !preparation?.reason;
      if (!invitation) {
        for (const id of [
          "story-accept",
          "story-later",
          "story-reject",
          "story-reopen",
        ]) {
          byId(id).hidden = true;
        }
        byId("story-invitation-text").textContent = other
          ? "还有另一份相遇邀请在等你决定；处理完之前，这段故事不会另开一份。"
          : preparation?.reason
            ? STORY_REASON_TEXT[preparation.reason] ??
              "这份故事暂时不能形成相遇邀请。"
            : "";
        return;
      }
      const assetNote = detail.story.available
        ? ""
        : STORY_REASON_TEXT[detail.story.reason] ??
          STORY_REASON_TEXT.ASSET_UNAVAILABLE;
      const statusText =
        {
          accepted:
            "已接纳。她已经在角色列表里；当前在场、固定位和今日名单都没有被自动改掉。",
          rejected:
            "这次相遇已经结束。故事仍可回看；想再考虑时可以重新开启同一份邀请。",
          later: "已稍后。不会催你，故事和这份邀请都会保留。",
          pending:
            "这份邀请正在等你决定。接纳不会切换当前在场角色，也不会改动固定位或今日名单。",
          prepared: "正在确认邀请已经出现在窗口中…",
        }[invitation.status] ?? "";
      byId("story-invitation-text").textContent = [assetNote, statusText]
        .filter(Boolean)
        .join(" ");

      const open = ["prepared", "pending", "later"].includes(invitation.status);
      const blocked =
        state.busy ||
        Boolean(state.acking) ||
        invitation.status === "prepared";
      for (const [id, visible, disabled] of [
        ["story-accept", open, blocked || !detail.story.available],
        ["story-later", open, blocked],
        ["story-reject", open, blocked],
        [
          "story-reopen",
          invitation.status === "rejected",
          blocked || !detail.story.available,
        ],
      ]) {
        byId(id).hidden = !visible;
        byId(id).disabled = disabled;
      }
    }

    function renderDetail() {
      const detail = state.detail;
      byId("story-detail-content").hidden = !detail;
      byId("story-detail-empty").hidden = Boolean(detail);
      showAlert(byId("story-error"), state.error);
      byId("story-notice").textContent = state.notice;
      byId("story-nodes").replaceChildren();
      byId("story-invitation").hidden = true;
      if (!detail) {
        byId("story-detail-empty").textContent = !state.selectedId
          ? "从左边选一段已经发生的故事。"
          : state.error
            ? "这段故事读取失败，请重试。"
            : "正在读取故事…";
        return;
      }
      byId("story-title").textContent = storyTitle(detail.story);
      byId("story-meta").textContent = storyMeta(detail.story);
      renderNodes(detail);
      renderInvitation(detail);
    }

    async function loadList() {
      const seq = ++state.listSeq;
      state.loading = true;
      state.error = null;
      renderList();
      const result = await call("listStories");
      if (seq !== state.listSeq) return;
      state.loading = false;
      if (!result.ok) {
        state.error = result.error;
        renderList();
        renderDetail();
        return;
      }
      state.list = Array.isArray(result.stories) ? result.stories : [];
      if (
        state.selectedId &&
        !state.list.some((story) => story.storyId === state.selectedId)
      ) {
        state.selectedId = null;
        state.detail = null;
        state.viewToken = null;
      }
      renderList();
      renderDetail();
    }

    async function loadDetail(storyId) {
      const seq = ++state.seq;
      state.detail = null;
      state.viewToken = null;
      state.notice = "";
      state.error = null;
      renderDetail();
      const result = await call("getStory", storyId);
      if (seq !== state.seq || state.selectedId !== storyId) return;
      if (!result.ok) {
        state.error = result.error;
        renderDetail();
        return;
      }
      state.detail = {
        story: result.story,
        invitation: result.invitation,
        otherInvitation: result.otherInvitation,
        preparation: result.preparation,
      };
      state.viewToken = result.viewToken ?? null;
      renderDetail();
      scheduleInvitationAck();
    }

    function selectStory(storyId) {
      if (state.busy || !state.active) return;
      state.selectedId = storyId;
      renderList();
      loadDetail(storyId);
    }

    function cancelAckFrame() {
      if (ackFrame !== null) {
        window.cancelAnimationFrame(ackFrame);
        ackFrame = null;
      }
    }

    /* 等待两次绘制，确认邀请自身进入局部滚动视口后再回执；
       隐藏、切页、换详情或滚动离开视口都不会确认展示。 */
    function scheduleInvitationAck() {
      if (ackFrame !== null) return;
      ackFrame = window.requestAnimationFrame(() => {
        ackFrame = window.requestAnimationFrame(() => {
          ackFrame = null;
          acknowledgeInvitation();
        });
      });
    }

    async function acknowledgeInvitation() {
      const detail = state.detail;
      const invitation = detail?.invitation;
      if (
        !invitation ||
        invitation.status !== "prepared" ||
        !state.viewToken ||
        state.acking ||
        !invitationInViewport(invitation)
      ) {
        return;
      }
      const seq = state.seq;
      const storyId = detail.story.storyId;
      const invitationId = invitation.invitationId;
      const viewToken = state.viewToken;
      state.acking = invitationId;
      renderDetail();
      const result = await call("acknowledgeInvitation", {
        storyId,
        invitationId,
        viewToken,
        visible: true,
      });
      if (state.acking === invitationId) state.acking = null;
      if (
        seq !== state.seq ||
        state.selectedId !== storyId ||
        state.viewToken !== viewToken ||
        state.detail?.invitation?.invitationId !== invitationId
      ) {
        return;
      }
      if (!result.ok) {
        if (result.error?.code === "STORY_VIEW_STALE") {
          state.viewToken = null;
        }
        state.notice =
          STORY_REASON_TEXT[result.error?.code] ??
          result.error?.message ??
          "邀请展示回执没有被接受。";
        renderDetail();
        return;
      }
      state.detail = { ...detail, invitation: result.invitation };
      updateListItem(result.invitation);
      renderDetail();
    }

    async function runAction(action) {
      const detail = state.detail;
      const invitation = detail?.invitation;
      if (!invitation || state.busy) return;
      const seq = state.seq;
      const storyId = detail.story.storyId;
      state.busy = true;
      state.notice = "正在处理…";
      state.error = null;
      renderDetail();
      const result = await call(action, invitation.invitationId);
      state.busy = false;
      if (seq !== state.seq || state.selectedId !== storyId) return;
      if (!result.ok) {
        state.error = result.error;
        state.notice = "";
        renderDetail();
        return;
      }
      if (result.snapshot && applySnapshot) {
        applySnapshot(result.snapshot);
      }
      state.detail = { ...detail, invitation: result.invitation ?? invitation };
      updateListItem(state.detail.invitation);
      state.notice =
        action === "reopenInvitation" &&
        state.detail.invitation?.status === "prepared"
          ? "邀请已重新开启，正在确认展示。"
          : STORY_SUCCESS[action] ?? "已处理。";
      renderDetail();
      if (state.detail.invitation?.status === "prepared") {
        scheduleInvitationAck();
      }
    }

    function bind() {
      if (bound) return;
      bound = true;
      byId("story-accept").addEventListener("click", () =>
        runAction("acceptInvitation"),
      );
      byId("story-later").addEventListener("click", () =>
        runAction("deferInvitation"),
      );
      byId("story-reject").addEventListener("click", () =>
        runAction("rejectInvitation"),
      );
      byId("story-reopen").addEventListener("click", () =>
        runAction("reopenInvitation"),
      );
      byId("story-detail").addEventListener("scroll", scheduleInvitationAck, {
        passive: true,
      });
      window.addEventListener("resize", scheduleInvitationAck);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") scheduleInvitationAck();
      });
      window.addEventListener("focus", scheduleInvitationAck);
    }

    /* 每次进入故事页都重新读取列表；列表只读，不准备或确认邀请。 */
    async function activate() {
      bind();
      if (api && typeof api.leaveStory === "function") {
        api.leaveStory().catch(() => {});
      }
      state.active = true;
      cancelAckFrame();
      state.seq += 1;
      state.listSeq += 1;
      state.selectedId = null;
      state.detail = null;
      state.viewToken = null;
      state.busy = false;
      state.acking = null;
      state.notice = "";
      state.error = null;
      renderList();
      renderDetail();
      await loadList();
    }

    async function deactivate() {
      if (!state.active) return;
      state.active = false;
      state.seq += 1;
      state.listSeq += 1;
      state.selectedId = null;
      state.detail = null;
      state.viewToken = null;
      state.busy = false;
      state.acking = null;
      state.notice = "";
      state.error = null;
      cancelAckFrame();
      if (api && typeof api.leaveStory === "function") {
        api.leaveStory().catch(() => {});
      }
    }

    /* 快照更新只刷新角色名等展示信息；不重新取列表，也不自动确认邀请。 */
    function handleSnapshot() {
      if (!state.active) return;
      renderList();
      renderDetail();
      scheduleInvitationAck();
    }

    return { activate, deactivate, handleSnapshot };
  }

  window.createStoryPanel = createStoryPanel;
})();
