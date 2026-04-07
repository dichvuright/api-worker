import path from "node:path";
import { spawn } from "node:child_process";

const editor = process.argv[2] || "code";
const rootDir = process.cwd();

const args = [
  "--new-window",
  "--user-data-dir",
  path.join(rootDir, editor === "cursor" ? ".cursor-dev" : ".vscode-dev"),
  "--extensions-dir",
  path.join(rootDir, editor === "cursor" ? ".cursor-ext" : ".vscode-ext"),
  "--extensionDevelopmentPath",
  rootDir,
  rootDir,
];

console.log(`[run-editor] ${editor} ${args.join(" ")}`);

const child = spawn(editor, args, {
  cwd: rootDir,
  stdio: "inherit",
  shell: true,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
