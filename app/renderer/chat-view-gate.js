/* S03b 聊天视图代次：区分“打开/切换目标”的 epoch 与同一角色内“历史选择/继续新聊天”的 view。
   仅提供代次判断，不处理 DOM、IPC 或业务数据。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.createChatViewGate = api.createChatViewGate;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function createChatViewGate() {
    let epoch = 0;
    let view = 0;

    return {
      beginOpen() {
        epoch += 1;
        view += 1;
        return { epoch, view };
      },
      beginHistory() {
        view += 1;
        return { epoch, view };
      },
      invalidateView() {
        view += 1;
        return { epoch, view };
      },
      current(token) {
        return Boolean(token) && token.epoch === epoch && token.view === view;
      },
      snapshot() {
        return { epoch, view };
      },
      reset() {
        epoch += 1;
        view += 1;
      },
    };
  }

  return { createChatViewGate };
});
