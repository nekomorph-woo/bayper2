/* 管理窗固定导航：只负责页面显隐、顶部标题和可聚焦入口。
   页面数据仍由 app.js 从真实快照渲染；导航不关闭聊天，也不改变在场角色。 */
(function () {
  "use strict";

  const PAGE_META = {
    home: { title: "小窝", subtitle: "今天先这样待在一起" },
    characters: { title: "角色", subtitle: "已结识的角色" },
    settings: { title: "设置", subtitle: "模型连接与本机配置" },
  };

  function createWindowNavigation({ onNavigate } = {}) {
    const byId = (id) => document.getElementById(id);
    const buttons = Array.from(document.querySelectorAll("[data-nav]"));
    const pages = Array.from(document.querySelectorAll("[data-page]"));
    const onboarding = Array.from(document.querySelectorAll('[data-step="config"], [data-step="wish"]'));
    let current = null;

    function setToolbar(title, subtitle) {
      byId("page-title").textContent = title;
      byId("page-subtitle").textContent = subtitle || "";
    }

    function highlight(name) {
      for (const button of buttons) {
        if (button.dataset.nav === name) {
          button.setAttribute("aria-current", "page");
        } else {
          button.removeAttribute("aria-current");
        }
      }
    }

    function isVisible(element) {
      return Boolean(
        element &&
          element.isConnected &&
          !element.closest("[hidden]") &&
          element.getClientRects().length > 0,
      );
    }

    function focusEntry() {
      const page = pages.find((section) => !section.hidden);
      const target = page?.querySelector("[data-page-entry]");
      if (isVisible(target)) {
        target.focus();
      }
    }

    function showPage(name, { focus = false } = {}) {
      const meta = PAGE_META[name];
      if (!meta) {
        return;
      }
      const changed = current !== name;
      current = name;
      for (const section of onboarding) {
        section.hidden = true;
      }
      for (const section of pages) {
        section.hidden = section.dataset.page !== name;
      }
      byId("primary-nav").hidden = false;
      byId("page-toolbar").hidden = false;
      highlight(name);
      setToolbar(meta.title, meta.subtitle);
      document.body.dataset.activePage = name;
      if (onNavigate) {
        onNavigate(name, { changed });
      }
      if (focus && changed) {
        focusEntry();
      }
    }

    function showOnboarding(step, subtitle) {
      current = null;
      for (const section of pages) {
        section.hidden = true;
      }
      for (const section of onboarding) {
        section.hidden = section.dataset.step !== step;
      }
      byId("primary-nav").hidden = true;
      byId("page-toolbar").hidden = true;
      highlight(null);
      setToolbar("首次相遇", subtitle);
      document.body.dataset.activePage = "onboarding";
    }

    for (const button of buttons) {
      button.addEventListener("click", () => {
        showPage(button.dataset.nav);
      });
    }

    return {
      showPage,
      showOnboarding,
      setSubtitle(subtitle) {
        byId("page-subtitle").textContent = subtitle || "";
      },
      focusEntry,
      isNavVisible: () => !byId("primary-nav").hidden,
      currentPage: () => current,
    };
  }

  window.createWindowNavigation = createWindowNavigation;
})();
