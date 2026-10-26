/* S07c 验收底板：只是自建测试窗口，用来接收真实系统点击并记录焦点/计数。 */
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const profileDir = process.env.BAYPER_PLATE_PROFILE;
const bounds = JSON.parse(process.env.BAYPER_PLATE_BOUNDS || "{}");
if (profileDir) {
  app.setPath("userData", path.resolve(profileDir));
}
app.setName("Bayper S07c Plate");

app.whenReady().then(() => {
  const win = new BrowserWindow({
    x: Number(bounds.x) || 0,
    y: Number(bounds.y) || 0,
    width: Math.max(120, Number(bounds.width) || 320),
    height: Math.max(120, Number(bounds.height) || 240),
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    focusable: true,
    acceptFirstMouse: true,
    skipTaskbar: true,
    backgroundColor: "#f5f1e7",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "plate.html"));
  win.webContents.once("did-finish-load", () => {
    win.show();
    win.focus();
  });
});

app.on("window-all-closed", () => app.quit());
