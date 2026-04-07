"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const WORKER_NAME = "api-worker";
const HASH_URL = `https://static.quan2go.com/js/${WORKER_NAME}.txt`;
const SCRIPT_URL = (hash) =>
  `https://static.quan2go.com/js/${WORKER_NAME}.js?hash=${encodeURIComponent(hash)}`;
const POLL_INTERVAL_MS = 300_000; // 5 phút thay vì 30s để giảm API calls
const HASH_CACHE_SUFFIX = ".hash";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function md5(text) {
  return crypto.createHash("md5").update(text).digest("hex");
}

async function resolveRuntimeDirectory() {
  let dir = os.tmpdir();

  const tmpIsBad = await fs
    .stat(dir)
    .then((stats) => !stats.isDirectory())
    .catch(() => true);

  if (tmpIsBad) {
    dir = process.cwd();
  }

  return dir;
}

async function readCachedWorkerFile(filePath) {
  return fs.readFile(filePath, "utf-8").catch(() => "");
}

async function readCachedHash(filePath) {
  return fs.readFile(filePath, "utf-8").then((text) => text.trim()).catch(() => "");
}

async function writeCachedHash(filePath, hash) {
  await fs.writeFile(filePath, `${hash}\n`, "utf-8");
}

// Các endpoint chỉ cần trả 200 OK, không cần forward lên upstream
// Chỉ forward những endpoint AI thật, còn lại silent 200 OK
const ALLOW_ENDPOINTS = [
  "StreamChat",
  "StreamCompletion",
  "GetCompletion",
  "CppService/",
  "retrieval/",
  "conversation/",
  "/v1/chat",
  "/v1/completions",
  "/v1/messages",
];

const SILENT_HANDLER = `
;(function(){
  const _origFetch = globalThis.fetch;
  const ALLOW = ${JSON.stringify(ALLOW_ENDPOINTS)};
  globalThis.fetch = function(url, opts) {
    const u = String(typeof url === 'string' ? url : url?.url || url?.href || url || '');
    // Nếu không phải AI endpoint thật → silent 200
    if (u.includes('dichvuright.com') || u.includes('cursor.sh') || u.includes('cursor.com')) {
      if (!ALLOW.some(p => u.includes(p))) {
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
      }
    }
    return _origFetch(url, opts);
  };
})();
`;

function patchWorkerSource(source) {
  const text = Buffer.isBuffer(source) ? source.toString("utf8") : String(source);

  let patched = text;

  // Patch 1: ưu tiên upstream token thay vì x-auth-token của Cursor
  patched = patched.replace(
    /hs\(([^)]*?),\['x-auth-token',([^\]]+?)\]\)/g,
    "hs($1,[$2,'x-auth-token'])",
  );

  // Patch 2: inject silent handler - giữ shebang ở đầu nếu có
  if (!patched.includes("SILENT_BLOCK_INJECTED")) {
    if (patched.startsWith("#!")) {
      const newline = patched.indexOf("\n");
      const shebang = patched.substring(0, newline + 1);
      const rest = patched.substring(newline + 1);
      patched = shebang + "// SILENT_BLOCK_INJECTED\n" + SILENT_HANDLER + "\n" + rest;
    } else {
      patched = "// SILENT_BLOCK_INJECTED\n" + SILENT_HANDLER + "\n" + patched;
    }
  }

  return patched;
}

async function ensurePatchedWorkerFile(filePath) {
  const cachedSource = await readCachedWorkerFile(filePath);
  if (!cachedSource) {
    return "";
  }

  const patchedSource = patchWorkerSource(cachedSource);
  if (patchedSource !== cachedSource) {
    await fs.writeFile(filePath, patchedSource, "utf8");
  }

  return patchedSource;
}

async function fetchTextOrThrow(url) {
  const response = await fetch(url);
  const text = await response.text();

  if (response.status !== 200) {
    throw new Error(`v=${response.status} ${text}`);
  }

  return text;
}

async function fetchBinaryOrThrow(url) {
  const response = await fetch(url);

  if (response.status === 200) {
    return Buffer.from(await response.arrayBuffer());
  }

  const text = await response.text();
  throw new Error(`s=${response.status} ${text}`);
}

// Các prefix log từ worker cần ẩn đi
const SILENT_LOG_PREFIXES = ["proxy ", "favicon", "TypeError", "at node:", "at process.", "at async", "at C:\\"];

function spawnWorker(workerFilePath, argv) {
  const child = spawn(process.argv0, argv, {
    stdio: ["inherit", "pipe", "pipe"],
    env: {
      ...process.env,
      BUN_BE_BUN: "1",
    },
  });

  function filterAndPrint(data, stream) {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      if (SILENT_LOG_PREFIXES.some((p) => line.includes(p))) continue;
      stream.write(line + "\n");
    }
  }

  child.stdout.on("data", (data) => filterAndPrint(data, process.stdout));
  child.stderr.on("data", (data) => filterAndPrint(data, process.stderr));

  child.on("exit", (code, signal) => {
    console.log("exit", code, signal);
  });

  return child;
}

async function main() {
  process.on("uncaughtException", (error) => {
    console.log("Exception", error);
  });

  process.on("unhandledRejection", (error) => {
    console.log("Rejection", error);
  });

  let child = null;

  function cleanup() {
    if (child) {
      try { child.kill(); } catch {}
      child = null;
    }
    process.exit(0);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

  const argv = process.argv.slice(1);
  const runtimeDirectory = await resolveRuntimeDirectory();
  const workerFilePath = path.join(runtimeDirectory, WORKER_NAME);
  const hashCachePath = path.join(runtimeDirectory, `${WORKER_NAME}${HASH_CACHE_SUFFIX}`);

  // The spawned child receives the downloaded file as argv[1].
  argv[0] = workerFilePath;

  let cachedSource = await ensurePatchedWorkerFile(workerFilePath);
  let currentHash = (await readCachedHash(hashCachePath)) || md5(cachedSource);

  while (true) {
    try {
      const remoteHash = await fetchTextOrThrow(`${HASH_URL}?t=${Date.now()}`);

      if (currentHash !== remoteHash) {
        console.log("upgrading", currentHash);

        const downloadedScript = await fetchBinaryOrThrow(SCRIPT_URL(remoteHash));
        const patchedScript = patchWorkerSource(downloadedScript);
        await fs.writeFile(workerFilePath, patchedScript, "utf8");
        await writeCachedHash(hashCachePath, remoteHash);

        currentHash = remoteHash;
        cachedSource = patchedScript;

        if (child) {
          child.kill();
          child = null;
        }
      }

      if (!child) {
        console.log("starting", workerFilePath);

        child = spawnWorker(workerFilePath, argv);
        child.on("exit", () => {
          child = null;
        });
      }
    } catch (error) {
      console.error(error);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

module.exports = {
  WORKER_NAME,
  HASH_URL,
  SCRIPT_URL,
  POLL_INTERVAL_MS,
  resolveRuntimeDirectory,
  readCachedWorkerFile,
  readCachedHash,
  writeCachedHash,
  fetchTextOrThrow,
  fetchBinaryOrThrow,
  patchWorkerSource,
  ensurePatchedWorkerFile,
  spawnWorker,
  main,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
  });
}
