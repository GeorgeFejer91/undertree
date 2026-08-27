const { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess } = require("electron");
const { randomBytes } = require("node:crypto");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const http = require("node:http");

const PORT = 37371;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let mainWindow;
let serviceProcess;
let stopping = false;

function applicationRoot() {
  return app.isPackaged ? app.getAppPath() : resolve(__dirname, "../..");
}

function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveReady, reject) => {
    const poll = () => {
      const request = http.get(`${ORIGIN}/api/health`, (response) => {
        response.resume();
        if (response.statusCode === 200) resolveReady();
        else retry();
      });
      request.on("error", retry);
      request.setTimeout(500, () => request.destroy());
    };
    const retry = () => Date.now() >= deadline
      ? reject(new Error("The local UnderTree service did not become ready."))
      : setTimeout(poll, 150);
    poll();
  });
}

function addExecutableDirectoryToPath(environment, directory, executable) {
  if (!existsSync(join(directory, executable))) return false;
  const currentPath = environment.PATH || "";
  if (!currentPath.split(";").some((entry) => entry.toLowerCase() === directory.toLowerCase())) {
    environment.PATH = `${directory};${currentPath}`;
  }
  return true;
}

function configureTexRuntime(baseEnvironment) {
  const environment = { ...baseEnvironment };
  // Unix locale variables inherited from development shells make Strawberry
  // Perl emit warnings on Windows. With them absent, Perl uses Windows' locale.
  delete environment.LC_ALL;
  delete environment.LC_CTYPE;
  delete environment.LANG;
  const localAppData = environment.LOCALAPPDATA || "";
  const programFiles = environment.ProgramFiles || "";
  const miktexDirectories = [
    join(localAppData, "Programs", "MiKTeX", "miktex", "bin", "x64"),
    join(programFiles, "MiKTeX", "miktex", "bin", "x64"),
  ];
  const perlDirectories = [
    join(environment.UNDERTREE_PERL_ROOT || "", "perl", "bin"),
    "C:\\Strawberry\\perl\\bin",
    join(localAppData, "Programs", "Strawberry", "perl", "bin"),
  ];
  miktexDirectories.some((directory) => addExecutableDirectoryToPath(environment, directory, "latexmk.exe"));
  perlDirectories.some((directory) => addExecutableDirectoryToPath(environment, directory, "perl.exe"));
  return environment;
}

async function startServer() {
  const root = applicationRoot();
  const configRoot = join(app.getPath("userData"), "config");
  const stateRoot = join(app.getPath("userData"), "state");
  const tokenFile = join(configRoot, "token");
  const token = randomBytes(24).toString("hex");
  mkdirSync(configRoot, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(tokenFile, token, { encoding: "utf8", mode: 0o600 });

  const environment = configureTexRuntime({
    ...process.env,
    UNDERTREE_PORT: String(PORT),
    UNDERTREE_TOKEN_FILE: tokenFile,
    UNDERTREE_STATE_ROOT: stateRoot,
    UNDERTREE_LIBRARY_ROOT: join(app.getPath("documents"), "Overleaf-projects"),
  });
  serviceProcess = utilityProcess.fork(join(root, "modules", "compiler", "server-process.mjs"), [], {
    env: environment,
    stdio: "pipe",
    serviceName: "UnderTree Compiler Service",
  });
  let serviceError = "";
  serviceProcess.stderr?.on("data", (chunk) => { serviceError = `${serviceError}${chunk}`.slice(-16_384); });
  serviceProcess.on("exit", (code) => {
    serviceProcess = null;
    if (!stopping) {
      dialog.showErrorBox("UnderTree compiler service stopped", serviceError.trim() || `The compiler service exited with code ${code}.`);
      app.quit();
    }
  });
  return token;
}

function sourceArgument() {
  return process.argv.find((arg) => /\.(?:tex|bib|bibtex)$/i.test(arg));
}

async function createWindow(token) {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: "#1b222c",
    title: "UnderTree",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(__dirname, "preload.cjs") },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(ORIGIN)) event.preventDefault();
  });
  const params = new URLSearchParams({ token });
  const source = sourceArgument();
  if (source) params.set("file", source);
  await mainWindow.loadURL(`${ORIGIN}/?${params}`);
  mainWindow.show();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  ipcMain.handle("undertree:choose-project-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Add a local TeX project folder",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async () => {
    try {
      const token = await startServer();
      await waitForServer();
      await createWindow(token);
    } catch (error) {
      dialog.showErrorBox("UnderTree could not start", error.message);
      app.quit();
    }
  });
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  stopping = true;
  serviceProcess?.kill();
  serviceProcess = null;
});
