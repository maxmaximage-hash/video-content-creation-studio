import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = "com.yinli.video-content-creation-studio.tencent-asr";
const SECRET_ID_ACCOUNT = "secret-id";
const SECRET_KEY_ACCOUNT = "secret-key";
const QUOTA_ERRORS = new Set([
  "FailedOperation.UserHasNoFreeAmount",
  "FailedOperation.UserHasNoAmount",
  "FailedOperation.ServiceIsolate",
]);
const TENCENT_FREE_SECONDS_PER_MONTH = 10 * 60 * 60;
const TENCENT_FREE_SAFETY_SECONDS = 2 * 60;
const CLOUD_SEGMENT_SECONDS = 15 * 60;

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBody(value) {
  return JSON.stringify(value);
}

function tencentHeaders({ secretId, secretKey, action, body, region, now = new Date() }) {
  const service = "asr";
  const host = "asr.tencentcloudapi.com";
  const timestamp = Math.floor(now.getTime() / 1000);
  const date = now.toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, sha256(body)].join("\n");
  const scope = `${date}/${service}/tc3_request`;
  const stringToSign = ["TC3-HMAC-SHA256", timestamp, scope, sha256(canonicalRequest)].join("\n");
  const secretDate = hmac(Buffer.from(`TC3${secretKey}`), date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = createHmac("sha256", secretSigning).update(stringToSign).digest("hex");
  return {
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    timestamp,
    host,
    action,
    region,
  };
}

async function keychainRead(account) {
  if (process.platform !== "darwin") return "";
  const result = await execFileAsync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], {
    encoding: "utf8",
  }).catch(() => ({ stdout: "" }));
  return String(result.stdout || "").trim();
}

async function keychainWrite(account, value) {
  if (process.platform !== "darwin") throw new Error("当前系统不支持 macOS 钥匙串");
  if (!value) {
    await execFileAsync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account]).catch(() => {});
    return;
  }
  await execFileAsync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value]);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.trim() || stdout.trim() || `${command} exit ${code}`)));
  });
}

async function findExecutable(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return "";
}

async function runtimePaths(projectRoot) {
  const configuredRoot = String(process.env.VIDEO_STUDIO_RUNTIME_ROOT || "").trim();
  const resourcesRoot = configuredRoot
    ? path.dirname(configuredRoot)
    : process.resourcesPath && !process.resourcesPath.includes("node_modules/electron")
      ? process.resourcesPath
      : projectRoot;
  const baseRuntimeRoot = configuredRoot || path.join(resourcesRoot, "runtime");
  const runtimeRoot = path.join(baseRuntimeRoot, process.arch);
  const sharedRoot = path.join(baseRuntimeRoot, "shared");
  const ffmpeg = await findExecutable([
    process.env.VIDEO_STUDIO_FFMPEG_PATH,
    path.join(runtimeRoot, "tools", "ffmpeg"),
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ]);
  const whisperCli = await findExecutable([
    process.env.VIDEO_STUDIO_WHISPER_CLI_PATH,
    path.join(runtimeRoot, "tools", "whisper-cli"),
  ]);
  const whisperModel = await findExecutable([
    process.env.VIDEO_STUDIO_WHISPER_MODEL_PATH,
    path.join(sharedRoot, "ggml-small.bin"),
  ]);
  return { ffmpeg, whisperCli, whisperModel };
}

async function prepareAudio(filePath, ffmpeg, directory, mode) {
  if (!ffmpeg) throw new Error("音频处理运行时尚未安装");
  const output = path.join(directory, mode === "cloud" ? "audio.m4a" : "audio.wav");
  const args = mode === "cloud"
    ? ["-y", "-i", filePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "24k", output]
    : ["-y", "-i", filePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output];
  await run(ffmpeg, args, { timeout: 240000 });
  return output;
}

async function prepareCloudAudioParts(filePath, ffmpeg, directory) {
  if (!ffmpeg) throw new Error("音频处理运行时尚未安装");
  const outputPattern = path.join(directory, "cloud-%03d.m4a");
  await run(ffmpeg, [
    "-y", "-i", filePath,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "24k",
    "-f", "segment", "-segment_time", String(CLOUD_SEGMENT_SECONDS), "-reset_timestamps", "1",
    outputPattern,
  ], { timeout: 240000 });
  const names = (await fs.readdir(directory))
    .filter((name) => /^cloud-\d{3}\.m4a$/.test(name))
    .sort();
  if (!names.length) throw new Error("没有生成可用的云端转写音频");
  return names.map((name) => path.join(directory, name));
}

async function tencentRequest(credentials, action, payload, fetchImpl = fetch) {
  const body = jsonBody(payload);
  const signed = tencentHeaders({ ...credentials, action, body, region: credentials.region || "ap-guangzhou" });
  const response = await fetchImpl(`https://${signed.host}/`, {
    method: "POST",
    headers: {
      authorization: signed.authorization,
      "content-type": "application/json; charset=utf-8",
      host: signed.host,
      "x-tc-action": action,
      "x-tc-version": "2019-06-14",
      "x-tc-timestamp": String(signed.timestamp),
      "x-tc-region": credentials.region || "ap-guangzhou",
    },
    body,
    signal: AbortSignal.timeout(60000),
  });
  const data = await response.json().catch(() => ({}));
  const result = data.Response || {};
  if (!response.ok || result.Error) {
    const error = new Error(result.Error?.Message || `腾讯云 ASR HTTP ${response.status}`);
    error.code = result.Error?.Code || `HTTP_${response.status}`;
    error.quotaExhausted = QUOTA_ERRORS.has(error.code);
    throw error;
  }
  return result;
}

async function tencentTranscribe(audioPath, credentials, options = {}) {
  const bytes = await fs.readFile(audioPath);
  if (bytes.length > 5 * 1024 * 1024) {
    const error = new Error("云端单次音频超过 5 MB，切换本地转写");
    error.code = "TENCENT_LOCAL_UPLOAD_TOO_LARGE";
    throw error;
  }
  const created = await tencentRequest(credentials, "CreateRecTask", {
    EngineModelType: "16k_zh",
    ChannelNum: 1,
    ResTextFormat: 3,
    SourceType: 1,
    Data: bytes.toString("base64"),
    DataLen: bytes.length,
    FilterDirty: 0,
    FilterPunc: 0,
    FilterModal: 0,
    ConvertNumMode: 1,
  }, options.fetchImpl);
  const taskId = created.Data?.TaskId;
  if (taskId === undefined || taskId === null) throw new Error("腾讯云 ASR 未返回任务编号");
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const status = await tencentRequest(credentials, "DescribeTaskStatus", { TaskId: Number(taskId) }, options.fetchImpl);
    const data = status.Data || {};
    if (Number(data.Status) === 2) {
      const sentences = (data.ResultDetail || []).map((item) => String(item.FinalSentence || "").trim()).filter(Boolean);
      const text = sentences.length ? sentences.join("\n") : String(data.Result || "").replace(/^\s*\[[^\]]+\]\s*/gm, "").trim();
      if (!text) throw new Error("腾讯云 ASR 返回为空");
      return text;
    }
    if (Number(data.Status) === 3) throw new Error(data.ErrorMsg || "腾讯云 ASR 任务失败");
  }
  throw new Error("腾讯云 ASR 等待超时");
}

function chinaDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function tencentMonthlyUsage(credentials, fetchImpl = fetch) {
  const today = chinaDate();
  const startDate = `${today.slice(0, 7)}-01`;
  const result = await tencentRequest(credentials, "GetUsageByDate", {
    BizNameList: ["asr_rec"],
    StartDate: startDate,
    EndDate: today,
  }, fetchImpl);
  const usage = (result.Data?.UsageByDateInfoList || []).find((item) => item?.BizName === "asr_rec");
  if (!usage) throw new Error("腾讯云未返回录音文件识别用量");
  return Math.max(0, Number(usage.Duration) || 0);
}

async function estimatedAudioSeconds(paths) {
  let bytes = 0;
  for (const filePath of paths) bytes += Number((await fs.stat(filePath)).size) || 0;
  return Math.max(1, Math.ceil((bytes * 8 / 24000) * 1.08));
}

async function localWhisper(audioPath, runtime, directory) {
  if (!runtime.whisperCli || !runtime.whisperModel) throw new Error("本地 Whisper 运行时尚未安装");
  const outputBase = path.join(directory, "transcript");
  await run(runtime.whisperCli, ["-m", runtime.whisperModel, "-f", audioPath, "-l", "zh", "-otxt", "-of", outputBase, "-np"], { timeout: 360000 });
  const text = await fs.readFile(`${outputBase}.txt`, "utf8").catch(() => "");
  if (!text.trim()) throw new Error("本地 Whisper 返回为空");
  return text.trim();
}

function formatTranscript(text = "") {
  return String(text).replace(/\s+/g, " ").replace(/\s*([。！？；：,.!?])\s*/g, "$1").replace(/([。！？])/g, "$1\n").replace(/\n{2,}/g, "\n").trim();
}

export function createTranscriptionService({ projectRoot, fetchImpl = fetch } = {}) {
  let quotaExhaustedMonth = "";

  async function credentials() {
    return {
      secretId: process.env.TENCENTCLOUD_SECRET_ID || await keychainRead(SECRET_ID_ACCOUNT),
      secretKey: process.env.TENCENTCLOUD_SECRET_KEY || await keychainRead(SECRET_KEY_ACCOUNT),
      region: process.env.TENCENTCLOUD_REGION || "ap-guangzhou",
    };
  }

  async function status() {
    const current = await credentials();
    const runtime = await runtimePaths(projectRoot);
    let usageSeconds = null;
    let usageCheckAvailable = false;
    if (current.secretId && current.secretKey) {
      try {
        usageSeconds = await tencentMonthlyUsage(current, fetchImpl);
        usageCheckAvailable = true;
      } catch {
        // Free-only policy: an unavailable usage check disables cloud ASR.
      }
    }
    const remainingSeconds = usageSeconds === null
      ? null
      : Math.max(0, TENCENT_FREE_SECONDS_PER_MONTH - usageSeconds);
    return {
      tencentConfigured: Boolean(current.secretId && current.secretKey),
      quotaExhaustedThisMonth: quotaExhaustedMonth === new Date().toISOString().slice(0, 7),
      usageCheckAvailable,
      freeUsedSeconds: usageSeconds,
      freeRemainingSeconds: remainingSeconds,
      cloudFreeAvailable: usageCheckAvailable && remainingSeconds > TENCENT_FREE_SAFETY_SECONDS,
      localRuntimeReady: Boolean(runtime.ffmpeg && runtime.whisperCli && runtime.whisperModel),
      strategy: "platform_caption_then_tencent_free_then_local",
    };
  }

  async function configure({ secretId = "", secretKey = "" } = {}) {
    await keychainWrite(SECRET_ID_ACCOUNT, String(secretId).trim());
    await keychainWrite(SECRET_KEY_ACCOUNT, String(secretKey).trim());
    quotaExhaustedMonth = "";
    return status();
  }

  async function transcribe(filePath, { platformTranscript = "" } = {}) {
    if (String(platformTranscript).trim()) {
      return { transcript: formatTranscript(platformTranscript), transcriptSource: "platform_caption" };
    }
    const runtime = await runtimePaths(projectRoot);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "video-studio-asr-"));
    try {
      const current = await credentials();
      const month = new Date().toISOString().slice(0, 7);
      if (current.secretId && current.secretKey && quotaExhaustedMonth !== month) {
        try {
          const cloudParts = await prepareCloudAudioParts(filePath, runtime.ffmpeg, directory);
          const [usageSeconds, neededSeconds] = await Promise.all([
            tencentMonthlyUsage(current, fetchImpl),
            estimatedAudioSeconds(cloudParts),
          ]);
          if (usageSeconds + neededSeconds > TENCENT_FREE_SECONDS_PER_MONTH - TENCENT_FREE_SAFETY_SECONDS) {
            quotaExhaustedMonth = month;
            const quotaError = new Error("腾讯云当月免费额度不足，切换本地转写");
            quotaError.code = "TENCENT_FREE_QUOTA_INSUFFICIENT";
            throw quotaError;
          }
          const transcriptParts = [];
          for (const cloudAudio of cloudParts) {
            transcriptParts.push(await tencentTranscribe(cloudAudio, current, { fetchImpl }));
          }
          return { transcript: formatTranscript(transcriptParts.join("\n")), transcriptSource: "tencent_asr" };
        } catch (error) {
          if (error.quotaExhausted) quotaExhaustedMonth = month;
        }
      }
      const localAudio = await prepareAudio(filePath, runtime.ffmpeg, directory, "local");
      const transcript = await localWhisper(localAudio, runtime, directory);
      return { transcript: formatTranscript(transcript), transcriptSource: "local_whisper" };
    } finally {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { status, configure, transcribe };
}

export const transcriptionTestables = {
  chinaDate,
  estimatedAudioSeconds,
  formatTranscript,
  tencentHeaders,
  tencentMonthlyUsage,
};
