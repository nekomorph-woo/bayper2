/* 托盘只承载生命周期和显示开关，不直接访问业务存储。 */
const { Tray, Menu, nativeImage } = require("electron");

function trayStatusLabel(desktop) {
  if (!desktop || desktop.state === "stopped") {
    return "桌面角色：未启动";
  }
  if (desktop.state === "running") {
    return desktop.assetState === "ready" ? "桌面角色：运行中" : "桌面角色：素材制作中";
  }
  if (desktop.state === "failed") {
    return "桌面角色：暂不可用";
  }
  return "桌面角色：正在启动";
}

function createAppTray({
  iconPath,
  getState,
  onOpen,
  onToggleVisible,
  onTogglePassthrough,
  onRestartCanvas,
  onQuit,
}) {
  const image = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  const tray = new Tray(image);
  tray.setToolTip("Bayper");

  function buildMenu() {
    const state = getState();
    const failedReason =
      state.desktop?.state === "failed" && state.desktop.error
        ? state.desktop.error.slice(0, 80)
        : null;
    return Menu.buildFromTemplate([
      { label: trayStatusLabel(state.desktop), enabled: false },
      ...(failedReason ? [{ label: failedReason, enabled: false }] : []),
      { type: "separator" },
      { label: "打开小窝", click: onOpen },
      {
        label: state.desktopVisible ? "隐藏桌面角色" : "显示桌面角色",
        click: onToggleVisible,
      },
      {
        label: "允许鼠标穿透",
        type: "checkbox",
        checked: state.desktopPassthrough,
        click: (item) => onTogglePassthrough(item.checked),
      },
      { label: "重新启动角色画布", click: onRestartCanvas },
      { type: "separator" },
      { label: "完全退出", click: onQuit },
    ]);
  }

  function refresh() {
    tray.setContextMenu(buildMenu());
  }

  refresh();

  return {
    refresh,
    destroy() {
      tray.destroy();
    },
  };
}

module.exports = { createAppTray };
