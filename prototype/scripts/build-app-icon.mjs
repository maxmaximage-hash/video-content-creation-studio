import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, "build", "app-icon-1024.png");
const iconset = path.join(root, "build", "app-icon.iconset");
const output = path.join(root, "build", "app-icon.icns");
const sizes = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];

try {
  await fs.access(output);
  console.log(`${output} (existing)`);
} catch {
  await fs.rm(iconset, { recursive: true, force: true });
  await fs.mkdir(iconset, { recursive: true });
  for (const [size, name] of sizes) {
    await execFileAsync("sips", ["-z", String(size), String(size), source, "--out", path.join(iconset, name)]);
  }
  await execFileAsync("iconutil", ["-c", "icns", iconset, "-o", output]);
  await fs.rm(iconset, { recursive: true, force: true });
  console.log(output);
}
