"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

function optionalRequire(id) {
  try {
    return require(id);
  } catch {
    return null;
  }
}

const vscode = optionalRequire("vscode");

const COMMANDS = {
  startApiWorker: "api-worker.startApiWorker",
  openPoolPage: "api-worker.openPoolPage",
  showLogs: "api-worker.showLogs",
};

const WEBVIEW_MESSAGES = {
  refresh: "refresh",
  getSystemInfo: "getSystemInfo",
  updateConfig: "updateConfig",
  saveApiConfig: "saveApiConfig",
  openExternal: "openExternal",
  startApiWorker: "startApiWorker",
  ideAction: "ideAction",
  updateIdes: "updateIdes",
  saved: "saved",
};

const WORKER_PORT = 9182;
const CURSOR_MAIN_HOOK = (function() {
  const port = 9182;
  return 'window.fetch=function(e){return function(n,t){try{if(typeof n==="string"||n instanceof URL){const u=typeof n==="string"?n:n.href;if(u.endsWith("/auth/logout"))return Promise.reject("blocked");if(u.endsWith("/auth/full_stripe_profile"))return e(n,t).catch((()=>{})).then((()=>new Response(JSON.stringify({membershipType:"pro",daysRemainingOnTrial:14}),{headers:{"Content-Type":"application/json"}})));if(u.includes("api2.cursor.sh")||u.includes("api.cursor.sh")){try{const w=new URL(u);const p="http://127.0.0.1:' + port + '"+w.pathname+w.search;const h=t?Object.assign({},t):{};const hs=new Headers(h.headers||{});hs.set("x-forwarded-host",w.host);h.headers=hs;return e(p,h);}catch(re){}}}}catch(err){}return e(n,t)}}(window.fetch);';
})();

const CURSOR_CPP_CONFIG_PATCH =
  "return(function(x){ if (x.method.name=='CppConfig') x.message.shouldLetUserEnableCppEvenIfNotPro = true; return x; })($1)";

const CURSOR_CPP_CONFIG_PATCH_LEGACY_RE =
  /return\(function\(x\)\{ if \(x\.method\.name=='CppConfig'[^)]*\) x\.message\.shouldLetUserEnableCppEvenIfNotPro = true; return x; \}\)\(\$1\)/g;

const LOCAL_WORKER_ORIGIN = "http://127.0.0.1:9182";
const API_WORKER_HOME_DIR = path.join(os.homedir(), "api-worker");
const API_CONFIG_PATH = path.join(API_WORKER_HOME_DIR, "api-config.json");
const API_AUTH_PATH = path.join(API_WORKER_HOME_DIR, ".auth");
const AUGPRO_CONFIG_PATH = path.join(os.homedir(), ".augpro.json");
const DEFAULT_API_CONFIG = Object.freeze({
  url: "",
  token: "",
  model: "",
});

let ideStatusCache = null;
let ideStatusCacheTime = 0;
const IDE_STATUS_CACHE_TTL = 30_000; // 30s

const sharedState = {
  context: null,
  output: null,
  webviewManager: null,
  apiWorkerTerminal: null,
};

function getOutput() {
  if (!sharedState.output && vscode?.window?.createOutputChannel) {
    sharedState.output = vscode.window.createOutputChannel("API Worker");
  }
  return sharedState.output;
}

function log(...args) {
  const line = args
    .map((value) => {
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(" ");
  getOutput()?.appendLine(line);
}

function formatError(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  return error.stack || error.message || String(error);
}

function pathExists(targetPath) {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeText(filePath, contents) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, contents, "utf8");
}

function xorBuffer(input, key) {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const output = Buffer.from(source);
  for (let index = 0; index < output.length; index += 1) {
    output[index] ^= key;
  }
  return output;
}

// Xóa bỏ: login(), whoami(), logout(), getNotice(), getStatus(),
// getProxyConfig(), poolGain(), poolGainList() — không còn dùng trong flow hiện tại.
// API remote (deepl.micosoft.icu) và BSON/XOR transport cũng đã được loại bỏ.

function sanitizeApiConfig(value) {
  const candidate = Array.isArray(value)
    ? value.find((item) => item && typeof item === "object") || {}
    : value && typeof value === "object"
      ? value
      : {};

  return {
    url: typeof candidate.url === "string" ? candidate.url.trim() : "",
    token: typeof candidate.token === "string" ? candidate.token.trim() : "",
    model: typeof candidate.model === "string" ? candidate.model.trim() : "",
  };
}

function readApiConfig() {
  try {
    return sanitizeApiConfig(JSON.parse(readText(API_CONFIG_PATH)));
  } catch {
    return { ...DEFAULT_API_CONFIG };
  }
}

function readAugproConfig() {
  try {
    const decoded = xorBuffer(fs.readFileSync(AUGPRO_CONFIG_PATH), 0x25).toString("utf8").trim();
    const parsed = decoded ? JSON.parse(decoded) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAugproConfig(value) {
  const encoded = xorBuffer(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"), 0x25);
  fs.writeFileSync(AUGPRO_CONFIG_PATH, encoded);
}

function validateApiConfig(config) {
  if (!config.url && (config.token || config.model)) {
    throw new Error("API URL is required when token or model is set");
  }

  if (config.url) {
    let parsed;
    try {
      parsed = new URL(config.url);
    } catch {
      throw new Error("API URL must be a valid http/https URL");
    }

    if (!/^https?:$/i.test(parsed.protocol)) {
      throw new Error("API URL must start with http:// or https://");
    }
  }
}

function persistLocalApiConfig(value) {
  const config = sanitizeApiConfig(value);
  validateApiConfig(config);

  writeText(API_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  writeText(API_AUTH_PATH, config.token || "");

  const augproConfig = {
    ...readAugproConfig(),
    CURSOR_TOKEN: config.token || "",
    CURSOR_MODEL: config.model || "",
    CURSOR_PROXY: config.url || "",
  };
  writeAugproConfig(augproConfig);

  process.env.CURSOR_TOKEN = config.token || "";
  process.env.CURSOR_MODEL = config.model || "";

  return config;
}

function getSystemInfo() {
  const info = {
    extensionVersion: "unknown",
    ideVersion: "unknown",
    author: "unknown",
    localWorkerUrl: LOCAL_WORKER_ORIGIN,
    localConfigPath: API_CONFIG_PATH,
  };

  try {
    const packageJson = JSON.parse(readText(path.join(sharedState.context.extensionPath, "package.json")));
    info.extensionVersion = packageJson.version || "unknown";
    info.author =
      typeof packageJson.author === "string"
        ? packageJson.author
        : packageJson.author?.name || "unknown";
  } catch (error) {
    log("Failed to read package.json metadata:", formatError(error));
  }

  try {
    info.ideVersion =
      JSON.parse(readText(path.join(vscode.env.appRoot, "product.json"))).version || "unknown";
  } catch (error) {
    log("Failed to read product.json version:", formatError(error));
  }

  return info;
}

// configureApi: chỉ mở webview panel
function configureApi() {
  return sharedState.webviewManager?.showPoolPage?.();
}

async function hasChildProcess(pid) {
  if (!pid) return false;
  try {
    if (process.platform === "win32") {
      const output = childProcess.execSync(
        `wmic process where (ParentProcessId=${pid}) get ProcessId`,
        { encoding: "utf8" },
      );
      return /\d+/.test(output);
    }
    childProcess.execSync(`pgrep -P ${pid}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const net = require("net");
    const tester = net.createConnection({ port, host: "127.0.0.1" });
    tester.once("connect", () => { tester.destroy(); resolve(true); });
    tester.once("error", () => { tester.destroy(); resolve(false); });
  });
}

async function startApiWorkerTerminal() {
  if (!vscode?.window?.createTerminal) return false;

  const shellEntry = path.join(__dirname, "shell.js");
  const command = `"${process.argv[0]}" "${shellEntry}"`;

  if (sharedState.apiWorkerTerminal) {
    sharedState.apiWorkerTerminal.show();
    try {
      const pid = await sharedState.apiWorkerTerminal.processId;
      if (await hasChildProcess(pid)) {
        log("api-worker process is still running; skip duplicate start");
        return true;
      }
    } catch (error) {
      log("Failed to inspect existing terminal:", formatError(error));
    }

    sharedState.apiWorkerTerminal.sendText(command);
    log("Reusing existing api-worker terminal and rerunning command");
    return true;
  }

  sharedState.apiWorkerTerminal = vscode.window.createTerminal({
    name: "API Worker",
    shellPath: process.platform === "win32" ? "cmd.exe" : undefined,
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ASAR: "1",
    },
  });
  sharedState.apiWorkerTerminal.show();
  sharedState.apiWorkerTerminal.sendText(command);
  log("Started api-worker in terminal:", shellEntry);

  vscode.window.onDidCloseTerminal?.((terminal) => {
    if (terminal === sharedState.apiWorkerTerminal) {
      sharedState.apiWorkerTerminal = null;
    }
  });

  return true;
}

function backupPath(filePath) {
  return `${filePath}.bak`;
}

function ensureBackup(filePath) {
  const bak = backupPath(filePath);
  if (!pathExists(bak) && pathExists(filePath)) {
    fs.copyFileSync(filePath, bak);
  }
}

function restoreBackupIfChanged(filePath) {
  const bak = backupPath(filePath);
  if (!pathExists(bak) || !pathExists(filePath)) return false;
  const current = fs.readFileSync(filePath);
  const backup = fs.readFileSync(bak);
  if (Buffer.compare(current, backup) === 0) return false;
  fs.copyFileSync(bak, filePath);
  return true;
}

async function writeTextWithRetry(filePath, contents, allowWindowsIcacls = false) {
  try {
    writeText(filePath, contents);
    return true;
  } catch (error) {
    log("Write failed, retrying with permission changes:", filePath, formatError(error));
    try {
      fs.chmodSync(pathExists(filePath) ? filePath : path.dirname(filePath), 0o666);
    } catch {}

    if (allowWindowsIcacls && process.platform === "win32") {
      try {
        const username = process.env.USERNAME || process.env.USER || "";
        childProcess.execSync(`icacls "${path.dirname(filePath)}" /grant ${username}:F /t /c`, {
          stdio: "ignore",
        });
      } catch {}
    }

    writeText(filePath, contents);
    return true;
  }
}

function reloadWindow() {
  return vscode?.commands?.executeCommand?.("workbench.action.reloadWindow");
}

function showInfo(message) {
  return vscode?.window?.showInformationMessage?.(message);
}

function getCursorNetworkMode() {
  const config = vscode?.workspace?.getConfiguration?.("cursor");
  const disableHttp2 = Boolean(config?.get?.("general.disableHttp2"));
  const disableHttp1SSE = Boolean(config?.get?.("general.disableHttp1SSE"));
  if (disableHttp2 && disableHttp1SSE) return "1.0";
  if (disableHttp2) return "1.1";
  return "2";
}

async function setCursorNetworkMode(mode, globalTarget) {
  const target =
    globalTarget && vscode?.ConfigurationTarget
      ? vscode.ConfigurationTarget.Global
      : undefined;
  const config = vscode?.workspace?.getConfiguration?.("cursor");
  if (!config?.update) return;

  if (mode === "1.0") {
    await config.update("general.disableHttp2", true, target);
    await config.update("general.disableHttp1SSE", true, target);
    return;
  }

  if (mode === "1.1") {
    await config.update("general.disableHttp2", true, target);
    await config.update("general.disableHttp1SSE", false, target);
    return;
  }

  await config.update("general.disableHttp2", false, target);
  await config.update("general.disableHttp1SSE", false, target);
}

// Cursor AI endpoints cần redirect về worker local
const CURSOR_ENDPOINTS = [
  "https://api2.cursor.sh",
  "https://api3.cursor.sh",
  "https://api4.cursor.sh",
  "https://repo42.cursor.sh",
];
const WORKER_REDIRECT_URL = `http://vn.local.dichvuright.com:${WORKER_PORT}`;

function patchWorkbench(original) {
  let patched = original;
  // Inject fetch hook (fake stripe pro)
  if (!patched.startsWith(CURSOR_MAIN_HOOK)) {
    patched = `${CURSOR_MAIN_HOOK}${patched}`;
  }
  // Bypass isPure license check
  patched = patched.replace(/isPure:\w,proof/g, "isPure:true,proof");
  // Redirect Cursor AI endpoints → local worker (cách bản gốc làm)
  for (const endpoint of CURSOR_ENDPOINTS) {
    patched = patched.split(endpoint).join(WORKER_REDIRECT_URL);
  }
  return patched;
}

function patchAlwaysLocal(original) {
  let patched = original.replace(CURSOR_CPP_CONFIG_PATCH_LEGACY_RE, () => CURSOR_CPP_CONFIG_PATCH);

  if (patched.includes("x.message.shouldLetUserEnableCppEvenIfNotPro = true")) {
    return patched;
  }

  return patched.replace(/return(\{stream:!1,service:[^{}]+\})/g, CURSOR_CPP_CONFIG_PATCH);
}

async function patchCursor(checkOnly, restore) {
  const appRoot = vscode?.env?.appRoot || "";
  const targets = {
    workbench: path.join(appRoot, "/out/vs/workbench/workbench.desktop.main.js"),
    extensionHost: path.join(appRoot, "/out/vs/workbench/api/node/extensionHostProcess.js"),
    alwaysLocal: path.join(appRoot, "/extensions/cursor-always-local/dist/main.js"),
    retrieval: path.join(appRoot, "/extensions/cursor-retrieval/dist/main.js"),
  };

  let changed = false;

  for (const filePath of Object.values(targets)) {
    if (!pathExists(filePath)) continue;
    ensureBackup(filePath);

    if (restore) {
      changed = restoreBackupIfChanged(filePath) || changed;
      continue;
    }

    const original = readText(filePath);
    let patched = original;

    if (filePath === targets.workbench) {
      patched = patchWorkbench(original);
    } else if (filePath === targets.extensionHost) {
      patched = patched.replace(/if\(!\w\.valid\)/g, "if(!1)");
    } else if (filePath === targets.alwaysLocal) {
      patched = patchAlwaysLocal(original);
    }

    if (patched !== original) {
      changed = true;
      if (!checkOnly) {
        await writeTextWithRetry(filePath, patched, true);
      }
    }
  }

  return changed;
}

const cursorActivator = {
  key: "cursor",
  name: "Cursor",
  isInstalled() {
    return pathExists(path.join(vscode?.env?.appRoot || "", "/out/vs/workbench/workbench.desktop.main.js"));
  },
  async getStatus() {
    if (!this.isInstalled()) return { status: "Not found", btns: [] };
    // Cache kết quả 30s để tránh đọc file system mỗi lần refresh
    const now = Date.now();
    if (ideStatusCache && now - ideStatusCacheTime < IDE_STATUS_CACHE_TTL) {
      return ideStatusCache;
    }
    const activated = getCursorNetworkMode() === "1.1" && !(await patchCursor(true, false));
    ideStatusCache = { status: activated ? "Activated" : "Not activated", btns: ["Activate", "Deactivate"] };
    ideStatusCacheTime = now;
    return ideStatusCache;
  },
  async doAction(action) {
    // Xóa cache khi thay đổi trạng thái
    ideStatusCache = null;
    if (action === 1) {
      const changed = await patchCursor(false, true);
      await setCursorNetworkMode("2", true);
      if (changed) await reloadWindow();
      return;
    }

    const changed = await patchCursor(false, false);
    await setCursorNetworkMode("1.1", true);
    // Luôn start worker trước, sau đó mới reload
    await startApiWorkerTerminal();
    if (changed) {
      await reloadWindow();
    } else {
      showInfo("Cursor forwarding is active — worker started.");
    }
  },
};

class WebviewManager {
  constructor(context) {
    this.context = context;
    this.extensionUri = context.extensionUri;
    this.panel = null;
    this.sidebarView = null;
    this.panelMessageDisposable = null;
    this.sidebarMessageDisposable = null;
    log("WebviewManager instance created");
  }

  getWebviewOptions() {
    return {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "webview")],
    };
  }

  getWebviewHtml() {
    return readText(path.join(this.extensionUri.fsPath, "webview/pool.html"));
  }

  bindWebview(webview, target) {
    webview.options = this.getWebviewOptions();
    webview.html = this.getWebviewHtml();

    const disposable = webview.onDidReceiveMessage((message) => this.onMessage(message));
    if (target === "panel") {
      this.panelMessageDisposable?.dispose?.();
      this.panelMessageDisposable = disposable;
      return;
    }

    this.sidebarMessageDisposable?.dispose?.();
    this.sidebarMessageDisposable = disposable;
  }

  async resolveWebviewView(webviewView) {
    this.sidebarView = webviewView;
    this.bindWebview(webviewView.webview, "sidebar");
    await this.refreshWebview();
  }

  getActiveWebviews() {
    return [this.panel?.webview, this.sidebarView?.webview].filter(Boolean);
  }

  async showPoolPage() {
    if (!vscode?.window?.createWebviewPanel) return null;

    if (this.panel) {
      this.panel.reveal();
      await this.refreshWebview();
      return this.panel;
    }

    this.panel = vscode.window.createWebviewPanel("apiWorker", "API Worker", 1, {
      ...this.getWebviewOptions(),
      retainContextWhenHidden: true,
    });

    this.bindWebview(this.panel.webview, "panel");
    this.panel.onDidDispose(() => {
      this.panelMessageDisposable?.dispose?.();
      this.panelMessageDisposable = null;
      this.panel = null;
    });

    await this.refreshWebview();
    return this.panel;
  }

  async post(type, payload) {
    const targets = this.getActiveWebviews();
    if (targets.length === 0) return;

    await Promise.all(
      targets.map(async (webview) => {
        try {
          await webview.postMessage({ command: type, ...payload });
        } catch (error) {
          log("Failed to post webview message:", formatError(error));
        }
      }),
    );
  }

  async pushSystemInfo() {
    await this.post(WEBVIEW_MESSAGES.getSystemInfo, getSystemInfo());
  }

  async pushApiConfig() {
    await this.post(WEBVIEW_MESSAGES.updateConfig, {
      config: readApiConfig(),
    });
  }

  async pushIdeStatus() {
    const status = await cursorActivator.getStatus();
    await this.post(WEBVIEW_MESSAGES.updateIdes, {
      ides: [
        {
          installed: cursorActivator.isInstalled(),
          key: cursorActivator.key,
          name: cursorActivator.name,
          info: {
            status: status?.status || "Not found",
            btns: status?.btns || [],
          },
        },
      ],
    });
  }

  async refreshWebview() {
    await this.pushSystemInfo();
    await this.pushApiConfig();
    await this.pushIdeStatus();
  }

  async onMessage(message) {
    try {
      switch (message?.command ?? message?.type) {
        case WEBVIEW_MESSAGES.refresh:
          await this.refreshWebview();
          break;
        case WEBVIEW_MESSAGES.getSystemInfo:
          await this.pushSystemInfo();
          break;
        case WEBVIEW_MESSAGES.openExternal:
          await vscode?.env?.openExternal?.(vscode.Uri.parse(message.url));
          break;
        case WEBVIEW_MESSAGES.saveApiConfig: {
          const savedConfig = persistLocalApiConfig(message.config);
          await this.post(WEBVIEW_MESSAGES.updateConfig, {
            config: savedConfig,
          });
          await this.post(WEBVIEW_MESSAGES.saved, {
            message: "API config saved to the local worker files",
          });
          showInfo("API config saved. Restart api-worker if requests still use the old upstream.");
          break;
        }
        case WEBVIEW_MESSAGES.startApiWorker:
          await vscode?.commands?.executeCommand?.(COMMANDS.startApiWorker);
          break;
        case WEBVIEW_MESSAGES.ideAction: {
          const actionValue =
            typeof message.action === "number"
              ? message.action
              : /\bdeactivate|disable|off|cancel|remove\b/i.test(
                    String(message.action || message.actionLabel || ""),
                  )
                ? 1
                : 0;
          await cursorActivator.doAction(actionValue);
          await this.pushIdeStatus();
          break;
        }
        default:
          log("Unhandled webview message:", message);
      }
    } catch (error) {
      log("Webview action failed:", formatError(error));
      await this.post("error", { message: formatError(error) });
    }
  }
}

function createStatusBarItem() {
  if (!vscode?.window?.createStatusBarItem) return null;
  const item = vscode.window.createStatusBarItem();
  item.text = "$(rocket) API Worker";
  item.tooltip = "Open the API Worker extension panel";
  item.command = COMMANDS.openPoolPage;
  item.show();
  return item;
}

async function activate(context) {
  sharedState.context = context;
  sharedState.webviewManager = new WebviewManager(context);

  log("API Worker activate");

  const disposables = [
    vscode?.commands?.registerCommand?.(COMMANDS.startApiWorker, startApiWorkerTerminal),
    vscode?.commands?.registerCommand?.(COMMANDS.openPoolPage, () => sharedState.webviewManager.showPoolPage()),
    vscode?.commands?.registerCommand?.(COMMANDS.showLogs, () => getOutput()?.show?.()),
    vscode?.window?.registerWebviewViewProvider?.("api-worker.mainView", sharedState.webviewManager, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
    createStatusBarItem(),
  ].filter(Boolean);

  context.subscriptions.push(...disposables);
}

function deactivate() {}

module.exports = {
  COMMANDS,
  WEBVIEW_MESSAGES,
  CURSOR_MAIN_HOOK,
  CURSOR_CPP_CONFIG_PATCH,
  sharedState,
  getSystemInfo,
  LOCAL_WORKER_ORIGIN,
  API_CONFIG_PATH,
  API_AUTH_PATH,
  AUGPRO_CONFIG_PATH,
  readApiConfig,
  readAugproConfig,
  persistLocalApiConfig,
  xorBuffer,
  startApiWorkerTerminal,
  getCursorNetworkMode,
  setCursorNetworkMode,
  patchCursor,
  cursorActivator,
  WebviewManager,
  activate,
  deactivate,
};
