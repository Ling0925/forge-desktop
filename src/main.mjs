import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, Menu, session, shell, utilityProcess } from "electron";
import { externalUrl, internalUrl, TOKEN_HEADER } from "./security.mjs";

const directory = fileURLToPath(new URL("./", import.meta.url));
// Allows checks to use a completely isolated profile without touching the
// installed application's browser state or its single-instance lock.
if (process.env.FORGE_DESKTOP_USER_DATA) {
  const profile = resolve(process.env.FORGE_DESKTOP_USER_DATA);
  mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
}
app.setName("Forge");
let window;
let worker;
let origin;
let stopping = false;
let quitAllowed = false;
let workerExit;

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (worker?.pid) {
    worker.postMessage({ kind: "shutdown" });
    const timer = setTimeout(() => worker?.kill(), 10000);
    await workerExit;
    clearTimeout(timer);
  }
  quitAllowed = true;
  app.quit();
}
function openExternal(value) {
  if (externalUrl(value) && !internalUrl(value, origin)) {
    void shell.openExternal(value).catch(() => {});
  }
}
async function createWindow() {
  if (!origin || stopping) return;
  const browserSession = session.fromPartition("persist:forge-workbench");
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    const local = /^(data:|blob:|about:)/.test(details.url);
    callback({ cancel: !local && !internalUrl(details.url, origin) });
  });
  window = new BrowserWindow({
    title: "Forge", width: 1380, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: "#101113", show: false,
    webPreferences: { session: browserSession, sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false },
  });
  const current = window;
  current.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: "deny" }; });
  current.webContents.on("will-navigate", (event, url) => { event.preventDefault(); openExternal(url); });
  current.webContents.on("will-redirect", event => event.preventDefault());
  current.webContents.on("will-attach-webview", event => event.preventDefault());
  current.on("closed", () => { if (window === current) window = undefined; });
  current.webContents.on("render-process-gone", () => {
    // Core stays alive; a renderer crash must not silently cancel running work.
    if (!stopping) dialog.showErrorBox("Forge", "界面进程已退出。请使用“显示 → 重新加载”恢复，或重新打开窗口；Core 任务仍在运行。");
  });
  await current.loadURL(origin);
  current.show();
}

async function launch() {
  const token = randomBytes(32).toString("hex");
  const browserSession = session.fromPartition("persist:forge-workbench");
  // Inject only in the main process and only to this instance's loopback origin.
  // Neither the renderer nor another local browser is given the token.
  browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (internalUrl(details.url, origin)) headers[TOKEN_HEADER] = token;
    callback({ requestHeaders: headers });
  });
  worker = utilityProcess.fork(join(directory, "runtime/worker.mjs"), [], {
    serviceName: "Forge Core", stdio: "inherit",
    env: { ...process.env,
      ...(process.platform === "darwin" ? { FORGE_FLOCK_EXECUTABLE: app.isPackaged
        ? join(process.resourcesPath, "native/forge-flock") : join(directory, "native/forge-flock") } : {}),
      PATH: [...new Set([...(process.env.PATH ?? "").split(":"),
      "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean))].join(":") },
  });
  workerExit = new Promise(resolve => worker.once("exit", resolve));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Core startup timed out")), 30000);
    worker.once("exit", code => { clearTimeout(timer); reject(new Error(`Core exited (${code})`)); });
    worker.once("message", message => {
      clearTimeout(timer);
      if (message?.kind !== "ready" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(message.origin)) {
        reject(new Error("Invalid Core startup response"));
      } else resolve(message.origin);
    });
  });
  worker.postMessage({ token, workspace: process.env.FORGE_WORKSPACE ?? app.getPath("home"),
    rendererRoot: app.isPackaged ? join(process.resourcesPath, "renderer") : join(directory, "renderer") });
  origin = await ready;
  worker.once("exit", () => {
    if (!stopping) {
      dialog.showErrorBox("Forge", "Core 进程已退出，请重新启动 Forge。未自动重放任何任务。");
      void shutdown();
    }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { label: "文件", submenu: [{ label: "打开 Forge 窗口", click: () => {
      if (window) window.show(); else void createWindow().catch(fail);
    } }, { role: "close" }, ...(process.platform === "darwin" ? [] : [{ role: "quit" }])] },
    { role: "editMenu" },
    { label: "显示", submenu: [{ role: "reload" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }] },
    { role: "windowMenu" },
  ]));
  await createWindow();
}
function fail(error) {
  console.error("Forge startup failed:", error instanceof Error ? error.message : "Unknown error");
  dialog.showErrorBox("Forge 启动失败", "无法启动本地 Core 或界面，请退出后重试；未更改 Provider 配置。");
  void shutdown();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
    else void createWindow().catch(fail);
  });
  app.on("before-quit", event => {
    if (!quitAllowed) { event.preventDefault(); void shutdown(); }
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("activate", () => { if (!window) void createWindow().catch(fail); });
  void app.whenReady().then(launch).catch(fail);
}
