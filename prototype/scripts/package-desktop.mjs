#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { APP_BUNDLE_ID } from "../desktop/app-identity.mjs";

const APP_ID = APP_BUNDLE_ID;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} 失败${signal ? ` (${signal})` : `，退出码 ${code}`}`));
    });
  });
}

function output(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} 失败，退出码 ${code}: ${stderr.trim()}`));
    });
  });
}

async function ensureElectronDistribution(arch) {
  const electronRoot = path.join(root, "node_modules/electron");
  const electronDist = path.join(electronRoot, "dist");
  const electronExecutable = path.join(electronDist, "Electron.app/Contents/MacOS/Electron");
  const installedArchitectures = await output("lipo", ["-archs", electronExecutable]).catch(() => "");
  if (installedArchitectures.split(/\s+/).includes(arch)) {
    console.log(`ELECTRON_RUNTIME_READY=${electronDist} (${arch})`);
    return;
  }

  const installScript = path.join(electronRoot, "install.js");
  if (!await fs.stat(installScript).catch(() => null)) {
    throw new Error("Electron npm 包不完整，请先运行 npm ci");
  }
  await fs.rm(electronDist, { recursive: true, force: true });
  await fs.rm(path.join(electronRoot, "path.txt"), { force: true });
  const installEnv = {
    ...process.env,
    ELECTRON_INSTALL_PLATFORM: "darwin",
    ELECTRON_INSTALL_ARCH: arch,
    npm_config_arch: arch,
  };
  delete installEnv.ELECTRON_SKIP_BINARY_DOWNLOAD;
  await run(process.execPath, [installScript], { env: installEnv });

  const downloadedArchitectures = await output("lipo", ["-archs", electronExecutable]).catch(() => "");
  if (!downloadedArchitectures.split(/\s+/).includes(arch)) {
    throw new Error(`Electron ${arch} 运行时下载后仍不可用`);
  }
  console.log(`ELECTRON_RUNTIME_READY=${electronDist} (${arch})`);
}

async function findBuiltApp() {
  const releaseRoot = path.join(root, "release");
  const directories = await fs.readdir(releaseRoot, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of directories) {
    if (!entry.isDirectory()) continue;
    const outputDir = path.join(releaseRoot, entry.name);
    const apps = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);
    for (const app of apps) {
      if (!app.isDirectory() || !app.name.endsWith(".app")) continue;
      const candidate = path.join(outputDir, app.name);
      const infoPath = path.join(candidate, "Contents", "Info.plist");
      const appId = await output("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPath]).catch(() => "");
      if (appId === APP_ID) candidates.push(candidate);
    }
  }
  candidates.sort((left, right) => right.localeCompare(left));
  if (!candidates.length) throw new Error("Electron 构建完成，但没有找到应用产物");
  return candidates[0];
}

if (process.platform !== "darwin") {
  throw new Error("当前桌面安装包只支持在 macOS 上构建");
}

const arch = argument("--arch") || process.arch;
if (!["arm64", "x64"].includes(arch)) throw new Error(`不支持的 macOS 架构：${arch}`);

await ensureElectronDistribution(arch);
await run(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build"]);
await run(process.execPath, [path.join(root, "scripts/sanitize-client-build.mjs")]);
await run(process.execPath, [path.join(root, "scripts/prepare-transcription-runtime.mjs"), "--arch", arch]);
await run(path.join(root, "node_modules/.bin/electron-builder"), ["--mac", "dir", `--${arch}`]);

const appPath = await findBuiltApp();
await run("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath]);
await run("codesign", ["--verify", "--deep", "--strict", appPath]);

const infoPath = path.join(appPath, "Contents", "Info.plist");
const builtAppId = await output("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPath]);
if (builtAppId !== APP_ID) throw new Error(`构建产物 Bundle ID 不是 ${APP_ID}`);

console.log(`DESKTOP_APP_READY=${appPath}`);
