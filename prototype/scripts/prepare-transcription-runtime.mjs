#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = path.join(root, "runtime");
const cacheRoot = path.join(runtimeRoot, ".cache");
const lock = JSON.parse(await fs.readFile(path.join(runtimeRoot, "runtime-lock.json"), "utf8"));
const arch = process.argv.includes("--arch") ? process.argv[process.argv.indexOf("--arch") + 1] : process.arch;
if (!["arm64", "x64"].includes(arch)) throw new Error(`不支持的运行时架构：${arch}`);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} 失败，退出码 ${code}`)));
  });
}

async function digest(filePath) {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function download(asset, name) {
  await fs.mkdir(cacheRoot, { recursive: true });
  const filename = path.basename(new URL(asset.url).pathname) || name;
  const target = path.join(cacheRoot, `${asset.sha256}-${filename}`);
  if (await fs.stat(target).catch(() => null) && await digest(target) === asset.sha256) return target;
  const temporary = `${target}.${process.pid}.tmp`;
  let downloaded = false;
  let lastError;
  for (const url of [...(asset.mirrors || []), asset.url]) {
    try {
      await fs.rm(temporary, { force: true });
      await run("curl", [
        "--fail",
        "--location",
        "--retry", "2",
        "--retry-delay", "2",
        "--connect-timeout", "20",
        "--max-time", "1800",
        "--output", temporary,
        url,
      ]);
      downloaded = true;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!downloaded) throw lastError || new Error(`${name} 下载失败`);
  const actual = await digest(temporary);
  if (actual !== asset.sha256) {
    await fs.rm(temporary, { force: true });
    throw new Error(`${name} SHA-256 不匹配`);
  }
  await fs.rename(temporary, target);
  return target;
}

async function findFile(directory, predicate) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, predicate);
      if (nested) return nested;
    } else if (predicate(candidate)) return candidate;
  }
  return "";
}

async function ensureCmake() {
  for (const candidate of ["/opt/homebrew/bin/cmake", "/usr/local/bin/cmake"]) {
    if ((await fs.stat(candidate).catch(() => null))?.isFile()) return candidate;
  }
  const tools = path.join(runtimeRoot, ".tools");
  const python = path.join(tools, "bin", "python3");
  const cmake = path.join(tools, "bin", "cmake");
  if (!(await fs.stat(cmake).catch(() => null))?.isFile()) {
    await fs.rm(tools, { recursive: true, force: true });
    await run("python3", ["-m", "venv", tools]);
    await run(python, ["-m", "pip", "install", "--disable-pip-version-check", "cmake==4.1.3"]);
  }
  return cmake;
}

const outputTools = path.join(runtimeRoot, arch, "tools");
const ffmpegOutput = path.join(outputTools, "ffmpeg");
const whisperOutput = path.join(outputTools, "whisper-cli");
const modelOutput = path.join(runtimeRoot, "shared", "ggml-small.bin");
await fs.mkdir(outputTools, { recursive: true });
await fs.mkdir(path.dirname(modelOutput), { recursive: true });

if (!(await fs.stat(ffmpegOutput).catch(() => null))?.isFile()) {
  const wheel = await download(lock.ffmpeg[arch], "ffmpeg");
  const extractRoot = path.join(cacheRoot, `ffmpeg-${arch}`);
  await fs.rm(extractRoot, { recursive: true, force: true });
  await fs.mkdir(extractRoot, { recursive: true });
  await run("ditto", ["-x", "-k", wheel, extractRoot]);
  const binary = await findFile(extractRoot, (filePath) => path.basename(filePath).startsWith("ffmpeg-") || path.basename(filePath) === "ffmpeg");
  if (!binary) throw new Error("FFmpeg wheel 中没有找到可执行文件");
  await fs.copyFile(binary, ffmpegOutput);
  await fs.chmod(ffmpegOutput, 0o755);
}

if (!(await fs.stat(whisperOutput).catch(() => null))?.isFile()) {
  const sourceArchive = await download(lock.whisper_cpp, "whisper.cpp");
  const sourceRoot = path.join(cacheRoot, `whisper-source-${arch}`);
  const buildRoot = path.join(cacheRoot, `whisper-build-${arch}`);
  await fs.rm(sourceRoot, { recursive: true, force: true });
  await fs.rm(buildRoot, { recursive: true, force: true });
  await fs.mkdir(sourceRoot, { recursive: true });
  await run("tar", ["-xzf", sourceArchive, "-C", sourceRoot, "--strip-components=1"]);
  const cmake = await ensureCmake();
  const cmakeArch = arch === "x64" ? "x86_64" : "arm64";
  await run(cmake, ["-S", sourceRoot, "-B", buildRoot, "-DCMAKE_BUILD_TYPE=Release", `-DCMAKE_OSX_ARCHITECTURES=${cmakeArch}`, "-DBUILD_SHARED_LIBS=OFF", "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_EXAMPLES=ON", "-DWHISPER_BUILD_SERVER=OFF"]);
  await run(cmake, ["--build", buildRoot, "--config", "Release", "--target", "whisper-cli", "-j", "4"]);
  const binary = await findFile(buildRoot, (filePath) => path.basename(filePath) === "whisper-cli");
  if (!binary) throw new Error("whisper.cpp 构建没有生成 whisper-cli");
  await fs.copyFile(binary, whisperOutput);
  await fs.chmod(whisperOutput, 0o755);
}

if (!(await fs.stat(modelOutput).catch(() => null))?.isFile() || await digest(modelOutput) !== lock.whisper_model.sha256) {
  const model = await download(lock.whisper_model, "Whisper small model");
  await fs.copyFile(model, modelOutput);
}

console.log(`TRANSCRIPTION_RUNTIME_READY=${runtimeRoot}`);
