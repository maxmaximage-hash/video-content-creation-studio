import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputDir = path.join(root, "release", "mac-arm64");
const appEntries = await fs.readdir(outputDir, { withFileTypes: true });
const appEntry = appEntries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
if (!appEntry) throw new Error("没有找到桌面应用产物");
const appPath = path.join(outputDir, appEntry.name);

await execFileAsync("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath]);
await execFileAsync("codesign", ["--verify", "--deep", "--strict", appPath]);
console.log(appPath);
