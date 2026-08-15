import nodeNet from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net as electronNet, shell } from "electron";
import { preview } from "vite";
import { libraryApiPlugin } from "../vite.config.mjs";
import { DEFAULT_LIBRARY_NAME } from "../server/library-manager.mjs";
import { APP_PRODUCT_NAME, LEGACY_USER_DATA_NAME } from "./app-identity.mjs";
import { resolveDragFile } from "./file-drag.mjs";
import { createReusableServerLifecycle } from "./server-lifecycle.mjs";
import { createMobileInboxService } from "../server/mobile-inbox-service.mjs";

const APP_NAME = APP_PRODUCT_NAME;
const smokeTest = process.argv.includes("--smoke-test");
let mainWindow = null;
let activeLibraryDir = null;
let activeLibrarySessionId = "";

app.setName(APP_NAME);
// Keep upgrades on the existing session and platform-login profiles while the visible brand changes.
app.setPath("userData", path.join(app.getPath("appData"), LEGACY_USER_DATA_NAME));

function defaultLibraryDir() {
  const configuredRoot = String(process.env.VIDEO_CONTENT_LIBRARY_ROOT || "").trim();
  return path.join(configuredRoot || app.getPath("temp"), DEFAULT_LIBRARY_NAME);
}

function librarySessionPath() {
  return path.join(app.getPath("userData"), "library-session.json");
}

async function readInitialLibraryDir() {
  if (smokeTest) return defaultLibraryDir();
  try {
    const session = JSON.parse(await fs.readFile(librarySessionPath(), "utf8"));
    if (session.closed || !session.libraryDir) return null;
    const stat = await fs.stat(session.libraryDir).catch(() => null);
    return stat?.isDirectory() ? session.libraryDir : null;
  } catch {
    return null;
  }
}

async function writeLibrarySession(session) {
  if (smokeTest) return;
  await fs.mkdir(path.dirname(librarySessionPath()), { recursive: true });
  await fs.writeFile(librarySessionPath(), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

function installDesktopBridge() {
  ipcMain.on("start-file-drag", (event, payload) => {
    try {
      const file = resolveDragFile({
        libraryDir: activeLibraryDir,
        activeSessionId: activeLibrarySessionId,
        payload,
      });
      const iconPath = path.join(app.getAppPath(), "public", "app-icon.png");
      const icon = nativeImage.createFromPath(iconPath).resize({ width: 64, height: 64 });
      event.sender.startDrag({ file, icon });
    } catch (error) {
      console.error(`Native file drag failed: ${error.message}`);
    }
  });
}

async function chooseLibraryPath({ action, currentDir }) {
  const parent = BrowserWindow.getFocusedWindow() || mainWindow || undefined;
  if (action === "new") {
    const result = await dialog.showSaveDialog(parent, {
      title: "新建视频内容资料库",
      buttonLabel: "新建资料库",
      defaultPath: path.join(currentDir || app.getPath("documents"), "未命名资料库.library"),
      filters: [{ name: "视频内容资料库", extensions: ["library"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    return result.canceled ? null : result.filePath;
  }
  const result = await dialog.showOpenDialog(parent, {
    title: "打开视频内容资料库",
    buttonLabel: "打开资料库",
    defaultPath: currentDir || app.getPath("documents"),
    properties: ["openDirectory", "createDirectory", "treatPackageAsDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = nodeNet.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function launchLocalAppServer() {
  const root = app.getAppPath();
  const port = await reservePort();
  const initialLibraryDir = await readInitialLibraryDir();
  activeLibraryDir = initialLibraryDir;
  process.env.VIDEO_CONTENT_AUTH_ROOT ||= path.join(app.getPath("userData"), "auth-browser");
  process.env.VIDEO_STUDIO_RUNTIME_ROOT ||= path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), "runtime");
  // The mobile inbox must honor macOS proxy settings. Electron's network stack
  // follows the active system proxy, while Node's global fetch connects directly.
  const mobileInboxService = createMobileInboxService({
    fetchImpl: (...args) => electronNet.fetch(...args),
  });
  let apiPlugin;
  apiPlugin = libraryApiPlugin({
    initialLibraryDir,
    allowImplicitCreate: smokeTest,
    chooseLibraryPath,
    mobileInboxService,
    onStateChange: async (state) => {
      const storage = apiPlugin.getLibraryStorage();
      activeLibraryDir = storage?.libraryDir || null;
      activeLibrarySessionId = storage?.sessionId || "";
      await writeLibrarySession(state);
    },
  });
  activeLibrarySessionId = apiPlugin.getLibraryStorage()?.sessionId || "";
  const server = await preview({
    root,
    configFile: false,
    logLevel: "error",
    build: {
      outDir: path.join(root, "dist", "client"),
    },
    plugins: [apiPlugin],
    preview: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      open: false,
    },
  });
  return { server, apiPlugin, url: `http://127.0.0.1:${port}/` };
}

const localAppServer = createReusableServerLifecycle(
  launchLocalAppServer,
  async ({ server, apiPlugin }) => {
    await apiPlugin?.dispose?.();
    await new Promise((resolve) => server?.httpServer?.close(resolve) || resolve());
  },
);

function sendLibraryCommand(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.executeJavaScript(
    `window.dispatchEvent(new CustomEvent('library-command', { detail: { action: ${JSON.stringify(action)} } }))`,
  ).catch(console.error);
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        { role: "about", label: `关于${APP_NAME}` },
        { type: "separator" },
        { role: "hide", label: "隐藏" },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "全部显示" },
        { type: "separator" },
        { role: "quit", label: `退出${APP_NAME}` },
      ],
    },
    {
      label: "文件",
      submenu: [
        { label: "新建资料库…", accelerator: "CmdOrCtrl+N", click: () => sendLibraryCommand("new") },
        { label: "打开资料库…", accelerator: "CmdOrCtrl+O", click: () => sendLibraryCommand("open") },
        { type: "separator" },
        { label: "重命名资料库…", click: () => sendLibraryCommand("rename") },
        { label: "关闭资料库", accelerator: "CmdOrCtrl+Shift+W", click: () => sendLibraryCommand("close") },
      ],
    },
    { label: "编辑", submenu: [{ role: "undo", label: "撤销" }, { role: "redo", label: "重做" }, { type: "separator" }, { role: "cut", label: "剪切" }, { role: "copy", label: "复制" }, { role: "paste", label: "粘贴" }, { role: "selectAll", label: "全选" }] },
    { label: "显示", submenu: [{ role: "reload", label: "重新载入" }, { role: "togglefullscreen", label: "进入全屏" }] },
    { label: "窗口", submenu: [{ role: "minimize", label: "最小化" }, { role: "zoom", label: "缩放" }, { role: "front", label: "前置全部窗口" }] },
  ]));
}

async function createWindow() {
  const { url: localUrl } = await localAppServer.get();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 680,
    show: !smokeTest,
    backgroundColor: "#090a0c",
    title: APP_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(app.getAppPath(), "desktop", "preload.cjs"),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(localUrl)) return;
    event.preventDefault();
    shell.openExternal(url);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(localUrl);

  if (smokeTest) {
    const result = await mainWindow.webContents.executeJavaScript(`fetch('/api/library').then(async (response) => ({
      ok: response.ok,
      status: response.status,
      data: await response.json(),
      dragBridge: typeof window.videoContentDesktop?.startFileDrag === 'function',
    }))`);
    if (!result.ok || !result.data?.storage?.libraryDir) throw new Error(`Desktop library smoke test failed: HTTP ${result.status}`);
    if (!result.dragBridge) throw new Error("Desktop native drag bridge is unavailable");
    const smokeRelativePath = "content-units/C999999/media/finished-video/electron-smoke.mp4";
    const smokeFilePath = path.join(result.data.storage.libraryDir, smokeRelativePath);
    await fs.mkdir(path.dirname(smokeFilePath), { recursive: true });
    await fs.writeFile(smokeFilePath, "electron-smoke");
    try {
      const resolvedSmokeFile = resolveDragFile({
        libraryDir: activeLibraryDir,
        activeSessionId: activeLibrarySessionId,
        payload: {
          projectId: "C999999",
          relativePath: smokeRelativePath,
          scope: "finished_video",
          sessionId: result.data.storage.sessionId,
        },
      });
      if (resolvedSmokeFile !== await fs.realpath(smokeFilePath)) throw new Error("Desktop drag resolver returned the wrong file");
    } finally {
      await fs.rm(smokeFilePath, { force: true });
    }
    console.log(`DESKTOP_SMOKE_OK ${result.data.storage.libraryDir} drag-validated`);
    app.quit();
  }
}

const hasSingleInstanceLock = smokeTest || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    installDesktopBridge();
    installMenu();
    await createWindow();
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(console.error);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" || smokeTest) app.quit();
  });

  app.on("will-quit", () => {
    void localAppServer.close();
  });
}
