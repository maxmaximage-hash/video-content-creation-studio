#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP_NAME = "视频内容创作中台.app";
const APP_ID = "com.yinli.video-content-creation-studio";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function run(command, args, { quiet = false, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: quiet ? "ignore" : "inherit",
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} 失败${signal ? ` (${signal})` : `，退出码 ${code}`}`));
    });
  });
}

function output(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

async function bundleId(appPath) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  return output("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist]).catch(() => "");
}

async function findBuiltApp() {
  const releaseRoot = path.join(root, "release");
  const entries = await fs.readdir(releaseRoot, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(releaseRoot, entry.name, APP_NAME);
    if (await bundleId(candidate) === APP_ID) candidates.push(candidate);
  }
  candidates.sort((left, right) => right.localeCompare(left));
  if (!candidates.length) throw new Error("没有找到可安装的桌面应用产物");
  return candidates[0];
}

async function removeStaleBuildApps() {
  const legacyDirectories = ["mac", "mac-arm64", "mac-x64", "mac-universal"];
  for (const directory of legacyDirectories) {
    const candidate = path.join(root, "dist", directory, APP_NAME);
    if (await bundleId(candidate) === APP_ID) {
      await fs.rm(path.dirname(candidate), { recursive: true, force: true });
    }
  }
}

if (process.platform !== "darwin") throw new Error("自动安装脚本只支持 macOS");
if (!["arm64", "x64"].includes(process.arch)) throw new Error(`不支持的 macOS 架构：${process.arch}`);

const playwrightCli = path.join(root, "node_modules/.bin/playwright");
await run(playwrightCli, ["install", "chromium"]);
await run(process.execPath, [path.join(root, "scripts/package-desktop.mjs"), "--arch", process.arch]);

const sourceApp = await findBuiltApp();
const targetRoot = path.resolve(argument("--target") || "/Applications");
const targetApp = path.join(targetRoot, APP_NAME);
const temporaryApp = path.join(targetRoot, `.video-content-studio-installing-${process.pid}.app`);
const previousApp = path.join(targetRoot, `.video-content-studio-previous-${process.pid}.app`);

await fs.mkdir(targetRoot, { recursive: true });
if (await fs.stat(targetApp).catch(() => null)) {
  if (await bundleId(targetApp) !== APP_ID) {
    throw new Error(`拒绝覆盖 Bundle ID 不匹配的应用：${targetApp}`);
  }
  await run("osascript", ["-e", `tell application id \"${APP_ID}\" to quit`], { quiet: true }).catch(() => {});
}

await run("ditto", [sourceApp, temporaryApp]);
await run("codesign", ["--verify", "--deep", "--strict", temporaryApp]);
if (await bundleId(temporaryApp) !== APP_ID) throw new Error("安装前 Bundle ID 校验失败");

let movedPrevious = false;
try {
  if (await fs.stat(targetApp).catch(() => null)) {
    await fs.rename(targetApp, previousApp);
    movedPrevious = true;
  }
  await fs.rename(temporaryApp, targetApp);
  await run("codesign", ["--verify", "--deep", "--strict", targetApp]);
  if (await bundleId(targetApp) !== APP_ID) throw new Error("安装后 Bundle ID 校验失败");
  if (movedPrevious) await fs.rm(previousApp, { recursive: true, force: true });
} catch (error) {
  await fs.rm(temporaryApp, { recursive: true, force: true }).catch(() => {});
  if (movedPrevious && !await fs.stat(targetApp).catch(() => null)) {
    await fs.rename(previousApp, targetApp).catch(() => {});
  }
  throw error;
}

await fs.rm(path.dirname(sourceApp), { recursive: true, force: true });
await removeStaleBuildApps();

console.log(`INSTALLED_APP=${targetApp}`);
console.log(`AUTH_PROFILE_ROOT=${path.join(os.homedir(), "Library", "Application Support", "视频内容创作中台", "auth-browser")}`);
if (process.argv.includes("--open")) await run("open", [targetApp]);
