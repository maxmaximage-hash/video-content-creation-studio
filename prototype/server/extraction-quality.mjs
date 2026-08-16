const SENSITIVE_KEY_PATTERN = /^(?:authorization|cookie|token|access_token|refresh_token|session|sessionid|signature|sign|x-s|x-t|xsec_token|expires?|auth_key|wssecret|wstime)$/i;
const SENSITIVE_TEXT_PATTERN = /(authorization|cookie|token|sessionid|signature|x-s|x-t)\s*[:=]\s*[^\s,;&]+/gi;

export const EXTRACTION_ERRORS = {
  AUTH_PROFILE_MISSING: { retryable: false, needsUserAction: true },
  AUTH_LOGIN_REQUIRED: { retryable: false, needsUserAction: true },
  AUTH_CHALLENGE: { retryable: false, needsUserAction: true },
  AUTH_CAPTURE_FAILED: { retryable: true, needsUserAction: false },
  CONTENT_UNAVAILABLE: { retryable: false, needsUserAction: false },
  PUBLIC_SHELL: { retryable: false, needsUserAction: false },
  MEDIA_AUTH_REQUIRED: { retryable: false, needsUserAction: true },
  MEDIA_DOWNLOAD_FAILED: { retryable: true, needsUserAction: false },
  NETWORK_TRANSIENT: { retryable: true, needsUserAction: false },
  RATE_LIMITED: { retryable: true, needsUserAction: false },
  PLATFORM_BLOCKED: { retryable: false, needsUserAction: true },
  PLATFORM_CONTRACT_CHANGED: { retryable: false, needsUserAction: false },
  PARSER_CHANGED: { retryable: false, needsUserAction: false },
  PLATFORM_UNAVAILABLE: { retryable: true, needsUserAction: false },
  FALLBACK_UNAVAILABLE: { retryable: true, needsUserAction: false },
};

function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY_PATTERN.test(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function sanitizeDiagnostic(value = "") {
  return String(value)
    .replace(/https?:\/\/[^\s"'<>]+/g, sanitizeUrl)
    .replace(SENSITIVE_TEXT_PATTERN, "$1=[redacted]");
}

export function sanitizeEvidence(evidence = []) {
  return evidence.map(sanitizeDiagnostic).slice(-80);
}

export function isUsableCapturedPage(page) {
  return Boolean(page?.html && page?.authState !== "challenge");
}

export function xiaohongshuShellReason({ resolvedUrl = "", html = "", title = "", body = "", candidateCount = 0 } = {}) {
  const combined = `${resolvedUrl}\n${title}\n${body}\n${String(html).slice(0, 8000)}`;
  if (/undertake_note_error=/i.test(resolvedUrl) || /该内容暂时无法查看|当前笔记无法查看|内容不存在|笔记已删除/i.test(combined)) {
    return "CONTENT_UNAVAILABLE";
  }
  const genericTitle = /^(小红书|小红书网页版|小红书 - 你的生活指南|发现真实、向上、美好的生活)$/i.test(String(title).trim());
  if (!candidateCount && (genericTitle || /打开小红书|登录后查看更多|扫码登录/i.test(combined))) return "PUBLIC_SHELL";
  return "";
}

function meaningfulFieldCount(result = {}) {
  return [
    result.title && !/^待整理[:：]/.test(result.title),
    result.body,
    result.author,
    result.publishedAt,
    result.duration,
    result.stats?.likes,
    result.stats?.favorites,
    result.stats?.comments,
    result.stats?.shares,
    result.stats?.views,
  ].filter(Boolean).length;
}

function localAssetCount(result = {}) {
  const images = Array.isArray(result.images) ? result.images.filter((image) => image?.localPath || image?.relativePath).length : 0;
  const eagleVideos = Array.isArray(result.mediaAssets)
    ? result.mediaAssets.filter((asset) => asset?.eagleItemId && ["captured_video", "inspiration_video"].includes(String(asset.role || "captured_video"))).length
    : 0;
  return images + [result.coverLocalPath, result.videoLocalPath, result.eagleItemId].filter(Boolean).length + eagleVideos;
}

function stateResult(parseState, parseStatus, errorCode = "", extras = {}) {
  const policy = EXTRACTION_ERRORS[errorCode] || { retryable: false, needsUserAction: false };
  return {
    parseState,
    captureState: extras.captureState || parseState,
    parseStatus,
    errorCode,
    retryable: extras.retryable ?? policy.retryable,
    needsUserAction: extras.needsUserAction ?? policy.needsUserAction,
    ...extras,
  };
}

function retryWaitResult(result, context, errorCode, parseStatus, extras = {}) {
  const platform = platformKeyFromValue(result.platform) || platformKeyFromValue(result.originalUrl) || "douyin";
  const retry = platformRetryMetadata(platform, {
    attempt: context.attempt,
    retryAfterMs: context.retryAfterMs || extras.retryAfterMs,
    now: context.now,
  });
  return stateResult("retry_wait", parseStatus, errorCode, {
    ...extras,
    ...retry,
    retryable: true,
    needsUserAction: false,
  });
}

export function evaluateExtractionQuality(result = {}, context = {}) {
  const authState = context.authState || "unknown";
  const shellReason = context.shellReason || "";
  const targetMatched = context.targetMatched === undefined
    ? Boolean(result.platformItemId)
    : Boolean(context.targetMatched);
  const fields = meaningfulFieldCount(result);
  const assets = localAssetCount(result);
  const isVideo = result.contentType === "video" || Boolean(result.videoUrl);
  const hasRequiredLocalMedia = isVideo
    ? Boolean(
      result.videoLocalPath
      || result.eagleItemId
      || result.mediaAssets?.some?.((asset) => asset?.eagleItemId),
    )
    : assets > 0;
  const platformLabel = result.platform === "抖音" ? "抖音" : result.platform === "小红书" ? "小红书" : "对应平台";

  if (authState === "challenge" && !hasRequiredLocalMedia) {
    return stateResult(
      "waiting_verification",
      `请在${platformLabel}专用窗口完成验证`,
      "AUTH_CHALLENGE",
    );
  }
  if (context.captureFailure && !hasRequiredLocalMedia) {
    return retryWaitResult(
      result,
      context,
      "AUTH_CAPTURE_FAILED",
      "登录采集通道暂时中断，稍后自动继续",
      {
        captureStage: context.captureFailure.stage || "",
        captureCauseCode: context.captureFailure.causeCode || "",
        diagnosticMessage: sanitizeDiagnostic(context.captureFailure.error || ""),
        finalUrl: sanitizeDiagnostic(context.captureFailure.finalUrl || ""),
      },
    );
  }
  if (context.platformFailure && !hasRequiredLocalMedia) {
    const errorCode = context.platformFailure.errorCode || "PLATFORM_CONTRACT_CHANGED";
    if (context.platformFailure.retryable || EXTRACTION_ERRORS[errorCode]?.retryable) {
      return retryWaitResult(
        result,
        context,
        errorCode,
        context.platformFailure.message || "平台备用通道暂时不可用，稍后自动继续",
      );
    }
    return stateResult(
      "blocked",
      context.platformFailure.message || "平台接口契约已变化，需要更新解析器",
      context.platformFailure.errorCode || "PLATFORM_CONTRACT_CHANGED",
      { parserContractFailure: Boolean(context.platformFailure.parserContractFailure) },
    );
  }
  if (authState === "platform_unavailable" && !hasRequiredLocalMedia) {
    return retryWaitResult(result, context, "PLATFORM_UNAVAILABLE", "平台暂时不可用，正在冷却后自动继续");
  }
  if (context.transientFailure && !hasRequiredLocalMedia) {
    const errorCode = context.transientFailure.errorCode || "NETWORK_TRANSIENT";
    return retryWaitResult(
      result,
      { ...context, retryAfterMs: context.transientFailure.retryAfterMs || context.retryAfterMs },
      errorCode,
      errorCode === "RATE_LIMITED" ? "平台请求较多，冷却后自动继续" : "网络暂时不稳定，稍后自动继续",
    );
  }
  if (["login_required", "unknown"].includes(authState) && (shellReason || context.blocked || !targetMatched || !hasRequiredLocalMedia)) {
    const errorCode = context.hasProfile ? "AUTH_LOGIN_REQUIRED" : "AUTH_PROFILE_MISSING";
    return stateResult("waiting_login", "需要登录后继续采集", errorCode);
  }
  if (shellReason === "CONTENT_UNAVAILABLE" && authState === "authenticated") {
    return stateResult("content_unavailable", "该内容已删除、私密或当前不可访问", "CONTENT_UNAVAILABLE");
  }
  if (shellReason) {
    return stateResult("failed", "页面没有返回目标内容", shellReason);
  }
  if (!targetMatched) {
    return stateResult("failed", "未能确认目标内容", "PARSER_CHANGED");
  }
  if (!hasRequiredLocalMedia) {
    if (authState !== "authenticated") return stateResult("waiting_login", "需要登录后保存媒体", "MEDIA_AUTH_REQUIRED");
    return retryWaitResult(result, context, "MEDIA_DOWNLOAD_FAILED", "媒体保存暂时中断，稍后自动继续");
  }
  if (fields >= 3) return stateResult("success", `采集成功：已确认 ${fields} 项内容信息`);
  if (fields >= 1) return stateResult("partial", `部分采集：已保存媒体，仍缺少部分内容信息`);
  return stateResult("failed", "媒体已保存，但未得到可用内容信息", "PARSER_CHANGED");
}

export function retryAfterMs(response) {
  const raw = response?.headers?.get?.("retry-after") || response?.headers?.["retry-after"] || "";
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

export function retryableHttpError(response) {
  const status = Number(response?.status || 0);
  if (status !== 429 && status < 500) return null;
  const error = new Error(status === 429 ? "请求过于频繁" : `平台服务暂时不可用 (${status})`);
  error.status = status;
  error.errorCode = status === 429 ? "RATE_LIMITED" : "NETWORK_TRANSIENT";
  error.retryable = true;
  error.retryAfterMs = retryAfterMs(response);
  return error;
}

export async function retryWithBackoff(operation, {
  maxAttempts = 3,
  delays = [1000, 3000, 9000],
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  onRetry = () => {},
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!error?.retryable || attempt >= maxAttempts) throw error;
      const base = error.retryAfterMs || delays[Math.min(attempt - 1, delays.length - 1)] || 1000;
      const waitMs = Math.round(base + base * 0.15 * random());
      onRetry({ attempt, waitMs, errorCode: error.errorCode || "NETWORK_TRANSIENT" });
      await sleep(waitMs);
    }
  }
  throw lastError;
}

export function createInFlightDeduper() {
  const active = new Map();
  return {
    run(key, task) {
      if (active.has(key)) return active.get(key);
      const promise = Promise.resolve().then(task).finally(() => {
        if (active.get(key) === promise) active.delete(key);
      });
      active.set(key, promise);
      return promise;
    },
    size() {
      return active.size;
    },
  };
}
import { platformKeyFromValue, platformRetryMetadata } from "./platforms/index.mjs";
