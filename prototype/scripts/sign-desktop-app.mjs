import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appPath = path.join(root, "release", "mac-arm64", "视频内容创作中台.app");

await execFileAsync("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath]);
await execFileAsync("codesign", ["--verify", "--deep", "--strict", appPath]);
console.log(appPath);
