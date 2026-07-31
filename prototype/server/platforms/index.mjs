import { douyinAdapter } from "./douyin.mjs";
import { xiaohongshuAdapter } from "./xiaohongshu.mjs";

export const PLATFORM_ADAPTERS = Object.freeze({
  douyin: douyinAdapter,
  xiaohongshu: xiaohongshuAdapter,
});

export function platformAdapter(key, adapters = PLATFORM_ADAPTERS) {
  const adapter = adapters[key];
  if (!adapter) throw new Error("不支持的平台登录");
  return adapter;
}

export function platformKeyFromValue(value, adapters = PLATFORM_ADAPTERS) {
  return Object.values(adapters).find((adapter) => adapter.matchesValue(value))?.key || "";
}

export function platformChallengeFromUrl(value, adapters = PLATFORM_ADAPTERS) {
  return Object.values(adapters).find((adapter) => adapter.challengeUrlPattern.test(String(value)))?.key || "";
}

export function platformRetryMetadata(key, {
  attempt = 1,
  retryAfterMs = 0,
  now = Date.now(),
} = {}, adapters = PLATFORM_ADAPTERS) {
  const policy = platformAdapter(key, adapters).retryPolicy || {};
  const delays = policy.delaysMs || [5000, 15000, 45000, 120000, 300000];
  const normalizedAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  const suggested = Number(retryAfterMs) || delays[Math.min(normalizedAttempt - 1, delays.length - 1)] || 5000;
  const delay = Math.max(1000, Math.min(Number(policy.maxDelayMs) || 300000, suggested));
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  return {
    attempt: normalizedAttempt,
    retryAfterMs: delay,
    nextRetryAt: new Date(nowMs + delay).toISOString(),
  };
}
