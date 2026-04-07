import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const extensionDir = process.cwd();
const repoRoot = path.resolve(extensionDir, "..");
const stageRoot = findAvailableStageRoot();
const stageExtensionDir = path.join(stageRoot, "extension");
const { zipPath, vsixPath } = findAvailableArtifactPaths();

const requiredRootFiles = ["extension.vsixmanifest", "[Content_Types].xml"];
const requiredExtensionPaths = [
  "package.json",
  "LICENSE.md",
  "README.md",
  "dist/extension.js",
  "dist/mcp-server.js",
  "dist/shell.js",
  "resources",
  "webview",
];

function findAvailableStageRoot() {
  let attempt = 0;

  while (true) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const candidate = path.join(repoRoot, `.vsix-stage-dichvuright${suffix}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
    attempt += 1;
  }
}

function findAvailableArtifactPaths() {
  const baseName = "api-worker-1.0.5-dichvuright-rebuilt";
  let attempt = 0;

  while (true) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const candidateZipPath = path.join(repoRoot, `${baseName}${suffix}.zip`);
    const candidateVsixPath = path.join(repoRoot, `${baseName}${suffix}.vsix`);

    if (!fs.existsSync(candidateZipPath) && !fs.existsSync(candidateVsixPath)) {
      return {
        zipPath: candidateZipPath,
        vsixPath: candidateVsixPath,
      };
    }

    attempt += 1;
  }
}

function extractManifestReferencedPaths(manifestText) {
  const paths = new Set();
  const patterns = [/<Icon>([^<]+)<\/Icon>/g, /<License>([^<]+)<\/License>/g, /Path="([^"]+)"/g];

  for (const pattern of patterns) {
    for (const match of manifestText.matchAll(pattern)) {
      const candidate = match[1]?.trim();
      if (candidate) {
        paths.add(candidate);
      }
    }
  }

  return [...paths];
}

function ensureExists(targetPath) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Missing required file: ${targetPath}`);
  }
}

function recreateDir(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.mkdirSync(targetPath, { recursive: true });
}

function copyIntoStage(relativePath) {
  const sourcePath = path.join(extensionDir, relativePath);
  const targetPath = path.join(stageExtensionDir, relativePath);

  ensureExists(sourcePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
  console.log(`[package:vsix] copied extension/${relativePath}`);
}

function copyRootFile(fileName) {
  const sourcePath = path.join(repoRoot, fileName);
  const targetPath = path.join(stageRoot, fileName);

  ensureExists(sourcePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  console.log(`[package:vsix] copied ${fileName}`);
}

function removeIfExists(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function createVsixArchive() {
  const script = [
    "Compress-Archive",
    "-LiteralPath",
    "'.\\extension', '.\\extension.vsixmanifest', '.\\[Content_Types].xml'",
    "-DestinationPath",
    `'${zipPath.replace(/'/g, "''")}'`,
    "-CompressionLevel",
    "Optimal",
    "-Force",
  ].join(" ");

  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      cwd: stageRoot,
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Compress-Archive failed with exit code ${result.status}`);
  }
}

function validateManifestReferences() {
  const manifestPath = path.join(stageRoot, "extension.vsixmanifest");
  const manifestText = fs.readFileSync(manifestPath, "utf8");
  const referencedPaths = extractManifestReferencedPaths(manifestText);

  for (const relativePath of referencedPaths) {
    ensureExists(path.join(stageRoot, relativePath));
  }
}

function main() {
  recreateDir(stageExtensionDir);
  removeIfExists(zipPath);
  removeIfExists(vsixPath);

  for (const fileName of requiredRootFiles) {
    copyRootFile(fileName);
  }

  for (const relativePath of requiredExtensionPaths) {
    copyIntoStage(relativePath);
  }

  validateManifestReferences();
  createVsixArchive();
  fs.copyFileSync(zipPath, vsixPath);
  try {
    fs.rmSync(zipPath, { force: true });
  } catch {}
  console.log(`[package:vsix] created ${vsixPath}`);
}

main();
