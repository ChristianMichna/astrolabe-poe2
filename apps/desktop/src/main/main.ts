import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  shell,
} from "electron";
import { autoUpdater } from "electron-updater";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createStderrLogger } from "@astrolabe/server";
import { installRelease, listRemoteReleases, removeLeftovers } from "@astrolabe/release-sync";
import { IPC } from "../shared/bridge.js";
import { createAppProtocolHandler } from "./app-protocol.js";
import { loadDesktopConfig, type DesktopConfig } from "./config.js";
import { createHandlers } from "./ipc-handlers.js";
import { focusWindow, showWindow } from "./window-guard.js";
import { startDataSync, type DataSyncController } from "./data-sync.js";
import { findDataRelease, knownReleaseIds, resolveAppDirs } from "./resources.js";
import {
  APP_SCHEME,
  APP_URL,
  isAppUrl,
  citationUrlToOpen,
  isDataSyncUrl,
  isTrustedSender,
} from "./security.js";
import { stopWithin } from "./shutdown.js";
import { startServices, type Services } from "./services.js";
import { StatusStore } from "./status.js";
import { startUpdates, type UpdateController } from "./updater.js";

const logger = createStderrLogger("desktop");
/** The server and the calc pool get this long to stop when the app quits; then the app ends anyway. */
const SHUTDOWN_LIMIT_MS = 10_000;
/** Hosts a citation link may open; empty (nothing opens) until the configuration is loaded. */
let citationHosts: readonly string[] = [];

/** Host of a link for the log; never the path or query. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "(unparseable)";
  }
}

// The window and the userData folder (%APPDATA%\Astrolabe) are named after the app.
app.setName("Astrolabe");

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

let mainWindow: BrowserWindow | undefined;
let services: Services | undefined;
let updates: UpdateController | undefined;
let dataSync: DataSyncController | undefined;

/** Repository root when running unpackaged (dist/main.cjs → apps/desktop → repo). */
const repoRoot = join(__dirname, "..", "..", "..");

// Electron's own dialog shows nothing in a log; this one leaves a line the self-test looks for.
process.on("uncaughtException", (error) => {
  logger.error("uncaught exception in the main process", { error });
  dialog.showErrorBox("Astrolabe: unexpected error", error.stack ?? error.message);
});

if (!app.requestSingleInstanceLock()) {
  // A second instance would fight for the port; hand over to the first one.
  app.quit();
} else {
  app.on("second-instance", () => {
    // The first instance may be shutting down with its window already closed.
    logger.info("second start while the app runs", {
      windowOpen: mainWindow !== undefined && !mainWindow.isDestroyed(),
    });
    focusWindow(mainWindow);
  });
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      // A citation link in a guide opens in the default browser; no other window may open.
      const target = citationUrlToOpen(url, citationHosts);
      if (target === null) {
        logger.warn("blocked a link that is not on the citation host list", { host: hostOf(url) });
      } else {
        shell.openExternal(target).catch((error: unknown) => {
          logger.error("could not open a citation link", { error });
        });
      }
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (!isAppUrl(url)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!isAppUrl(url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  app.on("window-all-closed", () => app.quit());
  let stopped = false;
  app.on("before-quit", (event) => {
    updates?.stop();
    dataSync?.stop();
    if (stopped || services === undefined) return;
    // Let the server and SQLite close cleanly before the process ends.
    event.preventDefault();
    stopped = true;
    void stopWithin(
      () => services?.stop() ?? Promise.resolve(),
      SHUTDOWN_LIMIT_MS,
      (error) => logger.error("server stop failed", { error }),
    ).then((outcome) => {
      if (outcome === "timed-out") {
        // Leave now: a process that lingers without a window blocks every later start.
        logger.error("server did not stop in time, ending the app", { limitMs: SHUTDOWN_LIMIT_MS });
        app.exit(0);
      } else {
        app.quit();
      }
    });
  });
  void app.whenReady().then(boot).catch(fatal);
}

async function boot(): Promise<void> {
  const dirs = resolveAppDirs({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot,
    userData: app.getPath("userData"),
  });
  const config = await loadDesktopConfig(dirs.desktopConfigPath);
  citationHosts = config.citations.allowedHosts;
  const status = new StatusStore(
    app.getVersion(),
    {
      state: "disabled",
      reason: app.isPackaged
        ? "Updates are switched off in the settings."
        : "Not an installed app.",
    },
    config.dataSync.enabled
      ? { state: "idle" }
      : { state: "disabled", reason: "Game data updates are switched off in the settings." },
  );

  hardenSession(`http://127.0.0.1:${config.port}/`);
  const handleApp = createAppProtocolHandler({
    webRoot: dirs.webRoot,
    serverUrl: () => services?.url,
    token: () => services?.token,
    fetch: (input, init) => net.fetch(input as string, init),
  });
  protocol.handle(APP_SCHEME, (request) => handleApp(request));

  const handlers = createHandlers({
    config,
    getStatus: () => status.get(),
    server: () =>
      services === undefined ? undefined : { url: services.url, token: services.token },
    fetch: (input, init) => net.fetch(input as string, init),
    clipboardWrite: (text) => clipboard.writeText(text),
    clipboardRead: () => clipboard.readText(),
    openExternal: (url) => shell.openExternal(url),
    revealPath: (path) => shell.showItemInFolder(path),
    copyFile: async (from, to) => {
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    },
    documentsDir: () => app.getPath("documents"),
    extensionPath: dirs.extensionPath,
    updates: () => updates,
    dataSync: () => dataSync,
    relaunch: () => {
      app.relaunch();
      app.quit();
    },
  });
  registerIpc(handlers, status);

  const win = createWindow(config);
  mainWindow = win;
  status.subscribe((next) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.statusChanged, next);
  });
  await win.loadURL(APP_URL);

  // Server start comes after the window so the person sees progress or the error, not nothing.
  try {
    const catalogDir = await findDataRelease(dirs, process.env["ASTROLABE_DATA_RELEASE"]);
    services = await startServices({
      port: config.port,
      databasePath: dirs.databasePath,
      catalogDir,
      forgeConfigPath: dirs.forgeConfigPath,
      stagesConfigPath: dirs.stagesConfigPath,
      releasesDir: dirs.downloadedReleasesDir,
      exampleGuidesDir: dirs.exampleGuidesDir,
      craftConfigPath: dirs.craftConfigPath,
      ...(config.economy.enabled
        ? {
            economy: {
              configPath: dirs.economyConfigPath,
              itemMapPath: dirs.economyItemMapPath,
              cacheDir: dirs.economyCacheDir,
              appVersion: app.getVersion(),
            },
          }
        : {}),
      pob: {
        resourcesRoot: dirs.resourcesRoot,
        pobHome: dirs.pobHome,
        workerLua: dirs.calcWorkerLua,
        optimizerConfigPath: dirs.optimizerConfigPath,
        required: dirs.packaged,
        ...(dirs.luajit === undefined ? {} : { luajit: dirs.luajit }),
      },
      logger,
    });
    status.setServer({
      state: "ready",
      port: services.port,
      calcEngine: services.calcEngine,
      ...(services.catalogOnlyReason === undefined
        ? {}
        : { catalogOnlyReason: services.catalogOnlyReason }),
      dataReleaseId: services.dataReleaseId,
    });
  } catch (error) {
    logger.error("server failed to start", { error });
    status.setServer({
      state: "failed",
      message: error instanceof Error ? error.message : "The local server failed to start.",
    });
  }

  if (config.dataSync.enabled) {
    const sync = config.dataSync;
    const userAgent = `Astrolabe/${app.getVersion()} (+https://github.com/${sync.repo})`;
    // The page's session blocks every foreign host. Game data updates use a session of their own
    // (like electron-updater does) that allows only the GitHub API and the configured download hosts.
    const dataSession = session.fromPartition("astrolabe-data-sync", { cache: false });
    dataSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !isDataSyncUrl(details.url, sync.allowedRedirectHosts) });
    });
    const fetchLike = (url: string, init?: RequestInit) => dataSession.fetch(url, init);
    const listTimeout = sync.listTimeoutSeconds * 1000;
    const installTimeout = sync.installTimeoutMinutes * 60_000;
    try {
      const removed = await removeLeftovers(
        dirs.downloadedReleasesDir,
        sync.leftoverMinAgeMinutes * 60_000,
      );
      if (removed > 0) logger.info("removed leftovers of interrupted data installs", { removed });
    } catch (error) {
      logger.error("could not clean the data release folder", { error });
    }
    dataSync = startDataSync({
      list: (signal) =>
        listRemoteReleases({
          fetch: fetchLike,
          repo: sync.repo,
          userAgent,
          signal: AbortSignal.any([signal, AbortSignal.timeout(listTimeout)]),
        }),
      knownIds: async () => [
        ...(await knownReleaseIds(dirs)),
        ...(services === undefined ? [] : [services.dataReleaseId]),
      ],
      install: (release, signal) =>
        installRelease({
          signal: AbortSignal.any([signal, AbortSignal.timeout(installTimeout)]),
          fetch: fetchLike,
          release,
          repo: sync.repo,
          allowedRedirectHosts: sync.allowedRedirectHosts,
          releasesDir: dirs.downloadedReleasesDir,
          userAgent,
          maxDownloadBytes: sync.maxDownloadMegabytes * 1_048_576,
          maxUnpackedBytes: sync.maxUnpackedMegabytes * 1_048_576,
          maxChecksumBytes: sync.maxChecksumBytes,
          maxDecompressionRatio: sync.maxDecompressionRatio,
          maxEntries: sync.maxEntries,
        }),
      setState: (state) => status.setData(state),
      includePrereleases: sync.includePrereleases,
      firstCheckDelayMs: sync.firstCheckDelaySeconds * 1000,
      intervalMs: sync.checkIntervalHours * 3_600_000,
      onError: (error) => logger.error("game data check failed", { error }),
    });
  }

  if (app.isPackaged && config.update.enabled) {
    updates = startUpdates({
      updater: autoUpdater,
      setState: (state) => status.setUpdate(state),
      firstCheckDelayMs: config.update.firstCheckDelaySeconds * 1000,
      intervalMs: config.update.checkIntervalHours * 3_600_000,
    });
    status.setUpdate({ state: "idle" });
  }
}

function createWindow(config: DesktopConfig): BrowserWindow {
  const win = new BrowserWindow({
    ...config.window,
    backgroundColor: "#0b0d0e",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  win.once("ready-to-show", () => showWindow(win));
  win.once("closed", () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  win.once("closed", () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  return win;
}

/** No camera, location, notifications or other permission for the page; no foreign requests. */
function hardenSession(serverPrefix: string): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    // The app's own origin and the local server. net.fetch from the main process uses this
    // session and so passes this filter too; the page itself is held back by its CSP
    // (connect-src 'self'). Game data updates use a separate session (see boot).
    const allowed =
      isAppUrl(url) ||
      url.startsWith(serverPrefix) ||
      url.startsWith("devtools:") ||
      url.startsWith("data:") ||
      url.startsWith("blob:");
    callback({ cancel: !allowed });
  });
}

function registerIpc(handlers: ReturnType<typeof createHandlers>, status: StatusStore): void {
  const guard =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (event: Electron.IpcMainInvokeEvent, ...args: A): R => {
      if (!isTrustedSender(event.senderFrame?.url)) throw new Error("Untrusted IPC sender");
      return fn(...args);
    };
  ipcMain.handle(
    IPC.getStatus,
    guard(() => status.get()),
  );
  ipcMain.handle(
    IPC.openClaude,
    guard((runId: unknown) => handlers.openClaude(runId)),
  );
  ipcMain.handle(
    IPC.copyClaudeCodeCommand,
    guard(() => handlers.copyClaudeCodeCommand()),
  );
  ipcMain.handle(
    IPC.installClaudeExtension,
    guard(() => handlers.installClaudeExtension()),
  );
  ipcMain.handle(
    IPC.checkForUpdates,
    guard(() => handlers.checkForUpdates()),
  );
  ipcMain.handle(
    IPC.installUpdate,
    guard(() => handlers.installUpdate()),
  );
  ipcMain.handle(
    IPC.checkForData,
    guard(() => handlers.checkForData()),
  );
  ipcMain.handle(
    IPC.restartForData,
    guard(() => handlers.restartForData()),
  );
}

function fatal(error: unknown): void {
  logger.error("startup failed", { error });
  dialog.showErrorBox(
    "Astrolabe could not start",
    error instanceof Error ? error.message : "Unknown error",
  );
  app.quit();
}
