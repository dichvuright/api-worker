import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const srcDir = path.join(rootDir, "src");
const distDir = path.join(rootDir, "dist");
const files = ["extension.js", "shell.js", "mcp-server.js"];
const watchMode = process.argv.includes("--watch");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(name) {
  const sourcePath = path.join(srcDir, name);
  const targetPath = path.join(distDir, name);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing source file: ${sourcePath}`);
  }

  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
  console.log(`[build] copied ${name}`);
}

function buildAll() {
  ensureDir(distDir);
  for (const name of files) {
    copyFile(name);
  }
}

function watchAll() {
  buildAll();
  console.log("[build] watching src/*.js");

  for (const name of files) {
    const sourcePath = path.join(srcDir, name);
    fs.watch(sourcePath, { persistent: true }, () => {
      try {
        copyFile(name);
      } catch (error) {
        console.error(`[build] failed to copy ${name}:`, error.message);
      }
    });
  }
}

if (watchMode) {
  watchAll();
} else {
  buildAll();
}
