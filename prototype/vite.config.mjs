import fs from "node:fs/promises";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { extractXiaohongshuFromHtml, extractXiaohongshuFromObjects } from "./server/xiaohongshu.mjs";
import { authPlatformKey, createAuthCaptureManager } from "./server/auth-capture.mjs";
import { classifyDouyinFallbackResponse } from "./server/platforms/douyin.mjs";
import { createPlatformTaskScheduler } from "./server/extraction-scheduler.mjs";
import {
  evaluateExtractionQuality,
  isUsableCapturedPage,
  retryWithBackoff,
  retryableHttpError,
  sanitizeEvidence,
  xiaohongshuShellReason,
} from "./server/extraction-quality.mjs";
import { createLibraryManager } from "./server/library-manager.mjs";
import {
  isPathInside,
  validateContentId,
  validateProjectAssetPath,
  validateReadableLibraryAssetPath,
} from "./server/path-security.mjs";

const extractionScheduler = createPlatformTaskScheduler();
const discardedExtractionIds = new Set();
const deletionCleanupStates = new Map();
const deletionCleanupTasks = new Map();
const projectMediaUploadTokens = new Map();
const requestHeaders = {
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
  "cache-control": "no-cache",
  "pragma": "no-cache",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
};

function platformKey(value) {
  return authPlatformKey(value);
}

function extractionDiscardKey(sessionId, contentId) {
  return `${String(sessionId || "")}:${String(contentId || "")}`;
}

function isExtractionDiscarded(sessionId, contentId) {
  return discardedExtractionIds.has(extractionDiscardKey(sessionId, contentId));
}

function firstUrl(input) {
  return String(input || "").match(/https?:\/\/[^\s"'<>，。]+/)?.[0] || String(input || "").trim();
}

function xiaohongshuNoteId(url = "") {
  return String(url).match(/\/(?:explore|item|discovery\/item)\/([A-Za-z0-9]+)/)?.[1] || "";
}

function normalizedSourceUrl(input = "") {
  const raw = firstUrl(input);
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return raw.trim();
  }
}

function canonicalSourceIdentity({ platform = "", platformItemId = "", originalUrl = "", resolvedUrl = "" } = {}) {
  const key = platformKey(platform) || platformKey(originalUrl) || platformKey(resolvedUrl) || "unknown";
  const itemId = String(platformItemId || (
    key === "xiaohongshu"
      ? xiaohongshuNoteId(resolvedUrl) || xiaohongshuNoteId(originalUrl)
      : extractAwemeId(resolvedUrl || originalUrl)
  )).trim();
  const normalizedUrl = normalizedSourceUrl(resolvedUrl || originalUrl);
  return {
    platformKey: key,
    platformItemId: itemId,
    normalizedUrl,
    canonicalSourceKey: itemId ? `${key}:${itemId}` : `${key}:url:${normalizedUrl}`,
  };
}

function localMediaAvailable(item = {}) {
  return [
    ...(Array.isArray(item.images) ? item.images : []),
    ...(Array.isArray(item.mediaAssets) ? item.mediaAssets : []),
  ].some((asset) => (
    asset?.localPath
    || asset?.relativePath
    || String(asset?.src || "").startsWith("/library-assets/")
  )) || String(item.videoLocalPath || "").startsWith("/library-assets/");
}

function existingInspirationScore(item = {}) {
  const acquired = item.acquisitionState === "acquired" || localMediaAvailable(item);
  const successful = item.parseState === "success" || item.parseProgress === 100;
  return (acquired ? 4 : 0) + (successful ? 2 : 0);
}

function oldestContentIdValue(item = {}) {
  return Number(String(item.id || "").match(/^I(\d+)$/)?.[1]) || Number.MAX_SAFE_INTEGER;
}

function decodeEntities(value = "") {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function textFromHtml(html = "") {
  return decodeEntities(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
}

function pickMeta(html, names) {
  for (const name of names) {
    const pattern = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${name}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i");
    const reversePattern = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name|itemprop)=["']${name}["'][^>]*>`, "i");
    const match = html.match(pattern) || html.match(reversePattern);
    if (match?.[1]) return decodeEntities(match[1]);
  }
  return "";
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === "") return "";
  return String(value);
}

function compactVisibleNumber(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d+(?:\.\d+)?\s*万$/.test(text)) return text.replace(/\s+/g, "");
  if (/^\d+(?:\.\d+)?$/.test(text)) return text;
  return "";
}

function epochToText(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  const ms = number < 10_000_000_000 ? number * 1000 : number;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms)).replaceAll("/", ".");
}

async function fetchText(url, options = {}) {
  return retryWithBackoff(async () => {
    let response;
    try {
      response = await fetch(url, {
        redirect: options.redirect || "follow",
        headers: { ...requestHeaders, ...(options.headers || {}) },
        signal: AbortSignal.timeout(options.timeoutMs || 10000),
      });
    } catch (error) {
      error.retryable = true;
      error.errorCode = "NETWORK_TRANSIENT";
      throw error;
    }
    const retryError = retryableHttpError(response);
    if (retryError) {
      await response.body?.cancel?.().catch(() => {});
      throw retryError;
    }
    const text = await response.text();
    return { url: response.url || url, status: response.status, ok: response.ok, text, headers: response.headers };
  }, { onRetry: options.onRetry });
}

async function expandUrl(inputUrl, evidence) {
  let current = firstUrl(inputUrl);
  for (let index = 0; index < 8; index += 1) {
    const response = await retryWithBackoff(async () => {
      let nextResponse;
      try {
        nextResponse = await fetch(current, { redirect: "manual", headers: requestHeaders, signal: AbortSignal.timeout(8000) });
      } catch (error) {
        error.retryable = true;
        error.errorCode = "NETWORK_TRANSIENT";
        throw error;
      }
      const retryError = retryableHttpError(nextResponse);
      if (retryError) {
        await nextResponse.body?.cancel?.().catch(() => {});
        throw retryError;
      }
      return nextResponse;
    }, { onRetry: ({ attempt, errorCode }) => evidence.push(`展开重试 ${attempt}: ${errorCode}`) });
    evidence.push(`展开 ${index + 1}: ${response.status} ${current}`);
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) return current;
    current = new URL(location, current).toString();
  }
  return current;
}

function extractAwemeId(url, html = "") {
  const haystack = `${url}\n${html.slice(0, 200000)}`;
  return haystack.match(/\/video\/(\d{10,25})/)?.[1]
    || haystack.match(/[?&](?:modal_id|aweme_id|item_ids?)=(\d{10,25})/)?.[1]
    || haystack.match(/"aweme_id"\s*:\s*"(\d{10,25})"/)?.[1]
    || haystack.match(/"awemeId"\s*:\s*"(\d{10,25})"/)?.[1]
    || "";
}

function collectJsonCandidates(html) {
  const candidates = [];
  const scriptPattern = /<script[^>]*(?:id=["']([^"']+)["'])?[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptPattern.exec(html))) {
    const id = match[1] || "";
    const raw = match[2]?.trim();
    if (!raw) continue;
    if (id === "RENDER_DATA") {
      try { candidates.push(JSON.parse(decodeURIComponent(raw))); } catch {}
    }
    if (id.includes("UNIVERSAL") || raw.includes("aweme") || raw.includes("douyin")) {
      try { candidates.push(JSON.parse(raw)); } catch {}
      try { candidates.push(JSON.parse(decodeURIComponent(raw))); } catch {}
    }
  }
  return candidates;
}

function firstUrlFrom(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.find((item) => typeof item === "string") || "";
  if (Array.isArray(value.url_list)) return value.url_list.find(Boolean) || "";
  if (Array.isArray(value.urlList)) return value.urlList.find(Boolean) || "";
  return "";
}

function urlListFrom(value) {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (Array.isArray(value.url_list)) return value.url_list.filter(Boolean);
  if (Array.isArray(value.urlList)) return value.urlList.filter(Boolean);
  return [];
}

function isPlayableVideoUrl(url = "") {
  return /douyinvod\.com|mime_type=video_mp4|media-video|\.mp4/i.test(url);
}

function isPreferredVideoUrl(url = "") {
  return isPlayableVideoUrl(url) && !/hvc1|h265|bytevc1/i.test(url);
}

function bestVideoUrlFromVideo(video) {
  if (!video || typeof video !== "object") return "";
  const candidates = [];
  candidates.push(...urlListFrom(video.play_addr_h264));
  candidates.push(...urlListFrom(video.playAddrH264));
  if (Array.isArray(video.bit_rate)) {
    const mp4Rates = video.bit_rate
      .filter((item) => item && typeof item === "object")
      .filter((item) => String(item.format || "").toLowerCase() === "mp4")
      .sort((a, b) => Number(a.bit_rate || 0) - Number(b.bit_rate || 0));
    for (const rate of mp4Rates) candidates.push(...urlListFrom(rate.play_addr || rate.playAddr));
  }
  candidates.push(...urlListFrom(video.play_addr));
  candidates.push(...urlListFrom(video.playAddr));
  candidates.push(...urlListFrom(video.download_addr));
  candidates.push(...urlListFrom(video.downloadAddr));
  return candidates.find(isPreferredVideoUrl) || candidates.find(isPlayableVideoUrl) || candidates.find(Boolean) || "";
}

function mergeExtracted(target, source) {
  if (!source) return target;
  const stats = source.stats || {};
  const nextTitle = target.title || source.title || source.body?.slice(0, 48) || "";
  const nextBody = normalizeComparableText(source.body) === normalizeComparableText(nextTitle) ? "" : source.body;
  return {
    ...target,
    title: nextTitle,
    body: target.body || nextBody || "",
    author: target.author || source.author || "",
    contentType: target.contentType || source.contentType || "",
    images: target.images?.length ? target.images : (source.images || []),
    coverUrl: target.coverUrl || source.coverUrl || "",
    videoUrl: target.videoUrl || source.videoUrl || "",
    publishedAt: target.publishedAt || source.publishedAt || "",
    duration: target.duration || source.duration || "",
    stats: {
      likes: target.stats.likes || normalizeNumber(stats.likes),
      favorites: target.stats.favorites || normalizeNumber(stats.favorites),
      comments: target.stats.comments || normalizeNumber(stats.comments),
      shares: target.stats.shares || normalizeNumber(stats.shares),
      views: target.stats.views || normalizeNumber(stats.views),
    },
  };
}

function mergeMatchedXiaohongshu(target, source) {
  if (!source?.targetMatched || !source.platformItemId || source.platformItemId !== source.targetId) return target;
  const stats = source.stats || {};
  const sameTarget = Boolean(target.platformItemId && target.platformItemId === source.platformItemId);
  const nextTitle = source.title || (sameTarget ? target.title : "") || source.body?.slice(0, 48) || "";
  const nextBody = normalizeComparableText(source.body) === normalizeComparableText(nextTitle) ? "" : source.body;
  return {
    ...target,
    platformItemId: source.platformItemId || target.platformItemId || "",
    title: nextTitle,
    body: nextBody || (sameTarget ? target.body : "") || "",
    author: source.author || (sameTarget ? target.author : "") || "",
    contentType: source.contentType || (sameTarget ? target.contentType : "") || "",
    images: source.images?.length ? source.images : (sameTarget ? target.images || [] : []),
    imageProvenanceId: source.images?.length
      ? source.imageProvenanceId
      : sameTarget ? target.imageProvenanceId || "" : "",
    coverUrl: source.coverUrl || source.images?.[0]?.sourceUrl || (sameTarget ? target.coverUrl : "") || "",
    videoUrl: source.videoUrl || (sameTarget ? target.videoUrl : "") || "",
    publishedAt: source.publishedAt || (sameTarget ? target.publishedAt : "") || "",
    duration: source.duration || (sameTarget ? target.duration : "") || "",
    stats: {
      likes: normalizeNumber(stats.likes) || (sameTarget ? target.stats.likes : ""),
      favorites: normalizeNumber(stats.favorites) || (sameTarget ? target.stats.favorites : ""),
      comments: normalizeNumber(stats.comments) || (sameTarget ? target.stats.comments : ""),
      shares: normalizeNumber(stats.shares) || (sameTarget ? target.stats.shares : ""),
      views: normalizeNumber(stats.views) || (sameTarget ? target.stats.views : ""),
    },
  };
}

function extractFromObject(root) {
  const result = { stats: {} };
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const object = value;
    const author = object.author || object.authorInfo || object.user || object.owner;
    const stats = object.statistics || object.stats || object.statisticsInfo || object.interactInfo;
    const video = object.video || object.videoInfo || object.aweme_video_info;
    if (!result.body && typeof object.desc === "string") result.body = object.desc;
    if (!result.body && typeof object.caption === "string") result.body = object.caption;
    if (!result.title && typeof object.title === "string") result.title = object.title;
    if (!result.title && typeof object.item_title === "string") result.title = object.item_title;
    if (!result.author && author && typeof author === "object") result.author = author.nickname || author.name || author.unique_id || author.shortId || "";
    if (!result.coverUrl) result.coverUrl = firstUrlFrom(object.cover) || firstUrlFrom(object.cover_url) || firstUrlFrom(object.coverUrl) || firstUrlFrom(object.thumbnail);
    if (!result.coverUrl && video && typeof video === "object") {
      result.coverUrl = firstUrlFrom(video.cover) || firstUrlFrom(video.origin_cover) || firstUrlFrom(video.dynamic_cover) || firstUrlFrom(video.thumbnail);
    }
    if (!result.videoUrl && video && typeof video === "object") {
      result.videoUrl = bestVideoUrlFromVideo(video);
    }
    if (!result.videoUrl) result.videoUrl = firstUrlFrom(object.play_addr) || firstUrlFrom(object.playAddr) || firstUrlFrom(object.video_url) || firstUrlFrom(object.videoUrl);
    if (!result.publishedAt) result.publishedAt = epochToText(object.create_time || object.createTime || object.publish_time || object.publishTime);
    if (!result.duration) result.duration = object.duration || (video && typeof video === "object" ? video.duration : "") || "";
    if (stats && typeof stats === "object") {
      result.stats.likes ||= stats.digg_count ?? stats.like_count ?? stats.likeCount ?? stats.diggCount ?? "";
      result.stats.favorites ||= stats.collect_count ?? stats.collectCount ?? stats.favorite_count ?? "";
      result.stats.comments ||= stats.comment_count ?? stats.commentCount ?? "";
      result.stats.shares ||= stats.share_count ?? stats.shareCount ?? "";
      result.stats.views ||= stats.play_count ?? stats.playCount ?? stats.view_count ?? stats.viewCount ?? "";
    }
    for (const child of Object.values(object)) {
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return result;
}

async function downloadCover(coverUrl, itemId, evidence, libraryManager) {
  if (!coverUrl || !itemId) return {};
  try {
    const storage = await libraryManager.ensureCurrentLibrary();
    const contentId = validateContentId(itemId);
    const response = await fetch(coverUrl, { headers: { ...requestHeaders, referer: "https://www.douyin.com/" } });
    if (!response.ok) {
      evidence.push(`封面下载失败: HTTP ${response.status}`);
      return {};
    }
    const contentType = response.headers.get("content-type") || "";
    const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
    const relativeDirectory = `content-units/${contentId}/covers`;
    const relativePath = `${relativeDirectory}/captured-cover.${ext}`;
    const libraryRoot = await resolveLibraryRoot(storage);
    const absoluteDirectory = await ensureSafeWriteDirectory(libraryRoot, relativeDirectory);
    const filePath = await resolveSafeWriteFile(absoluteDirectory, `captured-cover.${ext}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(filePath, bytes);
    evidence.push(`封面已保存: ${relativePath}`);
    return { coverLocalPath: `/library-assets/${relativePath}` };
  } catch (error) {
    evidence.push(`封面下载异常: ${error.message}`);
    return {};
  }
}

export async function downloadXiaohongshuImages(images, itemId, evidence, libraryManager, sessionHeaders = {}, options = {}) {
  if (!Array.isArray(images) || !images.length || !itemId) return [];
  if (options.shouldDiscard?.()) return [];
  const storage = await libraryManager.ensureCurrentLibrary();
  const safeId = validateContentId(itemId);
  const relativeDirectory = `content-units/${safeId}/media/images`;
  const libraryRoot = await resolveLibraryRoot(storage);
  const absoluteDirectory = await ensureSafeWriteDirectory(libraryRoot, relativeDirectory);
  const downloaded = [];
  for (let index = 0; index < images.length; index += 1) {
    if (options.shouldDiscard?.()) {
      evidence.push("灵感已删除，停止保存剩余图片");
      break;
    }
    const image = images[index];
    const sourceUrl = image?.sourceUrl || image?.url || "";
    const record = { ...image, id: `${safeId}-image-${index + 1}`, index, sourceUrl };
    if (!/^https?:\/\//i.test(sourceUrl)) {
      downloaded.push(record);
      continue;
    }
    const baseName = String(index + 1).padStart(2, "0");
    const indexedExisting = options.existingImages?.[index];
    const indexedRelativePath = String(indexedExisting?.relativePath || indexedExisting?.localPath || "")
      .replace(/^\/library-assets\//, "")
      .replace(/^\/+/, "");
    if (indexedRelativePath) {
      const indexedAvailability = await resolveExistingLibraryTarget(storage, indexedRelativePath);
      if (indexedAvailability.state === "available" && indexedAvailability.stat?.size >= 512) {
        const localRecord = {
          ...record,
          ...indexedExisting,
          localPath: indexedExisting.localPath || `/library-assets/${indexedRelativePath}`,
          relativePath: indexedRelativePath,
          role: "content_image",
          order: index + 1,
          version: Number(indexedExisting.version) || 1,
        };
        downloaded.push(localRecord);
        evidence.push(`第 ${index + 1} 张图片已存在本地资料库`);
        continue;
      }
    }
    const canonicalExisting = await (async () => {
      for (const ext of ["jpg", "webp", "png"]) {
        const relativePath = `${relativeDirectory}/${baseName}.${ext}`;
        const availability = await resolveExistingLibraryTarget(storage, relativePath);
        if (availability.state === "available" && availability.stat?.size >= 512) return relativePath;
      }
      return "";
    })();
    if (canonicalExisting) {
      downloaded.push({
        ...record,
        localPath: `/library-assets/${canonicalExisting}`,
        relativePath: canonicalExisting,
        role: "content_image",
        order: index + 1,
        version: 1,
      });
      evidence.push(`第 ${index + 1} 张图片已存在本地资料库`);
      continue;
    }
    let temporaryPath = "";
    try {
      const response = await fetch(sourceUrl, {
        headers: { ...requestHeaders, ...sessionHeaders, referer: sessionHeaders.referer || "https://www.xiaohongshu.com/" },
      });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.startsWith("image/")) {
        evidence.push(`第 ${index + 1} 张图片下载失败: HTTP ${response.status}`);
        downloaded.push(record);
        continue;
      }
      const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
      const preferredFileName = `${baseName}.${ext}`;
      const preferredPath = await resolveSafeWriteFile(absoluteDirectory, preferredFileName);
      const preferredExists = await fs.lstat(preferredPath).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const fileName = preferredExists
        ? `${baseName}-repair-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`
        : preferredFileName;
      const relativePath = `${relativeDirectory}/${fileName}`;
      const filePath = await resolveSafeWriteFile(absoluteDirectory, fileName, { mustNotExist: true });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 512) throw new Error("图片文件过小");
      if (options.shouldDiscard?.()) {
        evidence.push("灵感已删除，丢弃当前图片下载结果");
        break;
      }
      temporaryPath = `${filePath}.${Date.now()}.tmp`;
      await fs.writeFile(temporaryPath, bytes, { flag: "wx" });
      await fs.rename(temporaryPath, filePath);
      options.createdFiles?.push(filePath);
      const localRecord = {
        ...record,
        localPath: `/library-assets/${relativePath}`,
        relativePath,
        contentType,
        role: "content_image",
        order: index + 1,
        version: 1,
      };
      downloaded.push(localRecord);
    } catch (error) {
      if (temporaryPath) await fs.rm(temporaryPath, { force: true }).catch(() => {});
      evidence.push(`第 ${index + 1} 张图片下载异常: ${error.message}`);
      downloaded.push(record);
    }
  }
  const savedCount = downloaded.filter((image) => image.localPath).length;
  evidence.push(`小红书图片: 识别 ${images.length} 张，已保存 ${savedCount} 张`);
  return downloaded;
}

function localContentImage(image, contentId, fallbackOrder = 1) {
  const relativePath = String(image?.relativePath || image?.localPath || image?.src || "")
    .replace(/^\/library-assets\//, "")
    .replace(/^\/+/, "");
  const expectedRoot = `content-units/${contentId}/media/images/`;
  if (!relativePath.startsWith(expectedRoot)) return null;
  const order = Number(image?.order) || Number(image?.index) + 1 || fallbackOrder;
  return {
    ...image,
    id: image?.id || `${contentId}-image-${order}`,
    localPath: `/library-assets/${relativePath}`,
    relativePath,
    role: "content_image",
    order,
    version: Number(image?.version) || 1,
  };
}

function mergeLocalContentImages(currentItem, incomingImages) {
  const current = Array.isArray(currentItem?.images) ? currentItem.images : [];
  const byOrder = new Map(current.map((image, index) => [
    Number(image?.order) || Number(image?.index) + 1 || index + 1,
    image,
  ]));
  incomingImages.forEach((image, index) => {
    const local = localContentImage(image, currentItem.id, index + 1);
    if (!local) return;
    const existing = byOrder.get(local.order) || {};
    byOrder.set(local.order, { ...existing, ...local });
  });
  return [...byOrder.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, image], index) => ({
      ...image,
      id: image.id || `${currentItem.id}-image-${index + 1}`,
      role: "content_image",
      order: index + 1,
      version: Number(image.version) || 1,
    }));
}

function replaceLocalContentImages(currentItem, incomingImages) {
  return incomingImages
    .map((image, index) => localContentImage(image, currentItem.id, index + 1))
    .filter(Boolean)
    .sort((left, right) => left.order - right.order)
    .map((image, index) => ({
      ...image,
      id: image.id || `${currentItem.id}-image-${index + 1}`,
      role: "content_image",
      order: index + 1,
      version: Number(image.version) || 1,
    }));
}

function mergeImageAssets(currentItem, images) {
  const otherAssets = (Array.isArray(currentItem?.mediaAssets) ? currentItem.mediaAssets : [])
    .filter((asset) => asset?.role !== "content_image");
  return [
    ...otherAssets,
    ...images
      .map((image, index) => localContentImage(image, currentItem.id, index + 1))
      .filter(Boolean),
  ];
}

function selectCanonicalInspiration(items = []) {
  return [...items].sort((left, right) => (
    existingInspirationScore(right) - existingInspirationScore(left)
    || oldestContentIdValue(left) - oldestContentIdValue(right)
  ))[0] || null;
}

function matchingSourceItems(items, identity, originalUrl) {
  const rawNormalized = normalizedSourceUrl(originalUrl);
  return (items || []).filter((item) => {
    const current = canonicalSourceIdentity({
      platform: item.platform || item.source?.platform,
      platformItemId: item.platformItemId,
      originalUrl: item.originalUrl || item.source?.originalUrl,
      resolvedUrl: item.resolvedUrl,
    });
    if (identity.platformItemId && current.platformItemId) {
      return identity.canonicalSourceKey === current.canonicalSourceKey;
    }
    const currentUrls = [
      normalizedSourceUrl(item.originalUrl || item.source?.originalUrl),
      normalizedSourceUrl(item.resolvedUrl),
    ].filter(Boolean);
    return current.platformKey === identity.platformKey
      && [rawNormalized, identity.normalizedUrl].filter(Boolean).some((value) => currentUrls.includes(value));
  });
}

function serverInspiration({ id, originalUrl, category, identity }) {
  const now = new Date().toISOString();
  const platform = identity.platformKey === "douyin"
    ? "抖音"
    : identity.platformKey === "xiaohongshu" ? "小红书" : "未识别";
  return {
    id,
    generation: 1,
    unitSchemaVersion: 1,
    origin: "captured",
    type: "inspiration",
    originalUrl,
    resolvedUrl: identity.platformItemId && identity.platformKey === "douyin"
      ? `https://www.douyin.com/video/${identity.platformItemId}`
      : "",
    canonicalSourceKey: identity.canonicalSourceKey,
    platformItemId: identity.platformItemId,
    platform,
    author: "",
    title: `待整理：${platform} 链接`,
    body: "",
    category: String(category || "").trim(),
    categoryAssignedByUser: Boolean(String(category || "").trim()),
    capturedAt: now,
    updatedAt: now,
    parseStatus: "正在扒取公开信息",
    parseState: "extracting",
    parseStage: "正在排队",
    parseProgress: 4,
    acquisitionState: "pending",
    refreshState: "extracting",
    refreshStatus: "正在扒取公开信息",
    stats: { likes: "", favorites: "", comments: "", shares: "", views: "" },
    publishedAt: "",
    duration: "",
    coverUrl: "",
    coverLocalPath: "",
    contentType: "",
    images: [],
    videoUrl: "",
    videoPreviewUrl: "",
    videoLocalPath: "",
    parseEvidence: [],
    mediaAssets: [],
    metricsSnapshots: [],
    source: {
      platform,
      originalUrl,
      canonicalSourceKey: identity.canonicalSourceKey,
      accountName: "",
      publishedAt: "",
    },
    workflow: {
      stage: "inspiration",
      creationStatus: null,
      completedAt: null,
    },
  };
}

async function ingestInspiration(payload, requestSessionId, libraryManager) {
  const originalUrl = firstUrl(payload?.rawText || payload?.url);
  if (!/^https?:\/\//i.test(originalUrl)) throw apiError("没有识别到有效内容链接", 400);
  const initialIdentity = canonicalSourceIdentity({ originalUrl });
  if (!["douyin", "xiaohongshu"].includes(initialIdentity.platformKey)) {
    throw apiError("目前只支持抖音和小红书真实链接", 400);
  }

  const initialLibrary = await libraryManager.readLibrary();
  const immediateExisting = selectCanonicalInspiration(matchingSourceItems(
    initialLibrary.inspirations,
    initialIdentity,
    originalUrl,
  ));
  if (immediateExisting) {
    return { existing: true, item: immediateExisting, canonicalSourceKey: initialIdentity.canonicalSourceKey, library: initialLibrary };
  }

  let resolvedUrl = originalUrl;
  if (!initialIdentity.platformItemId) {
    resolvedUrl = await expandUrl(originalUrl, []).catch(() => originalUrl);
  }
  const identity = canonicalSourceIdentity({ originalUrl, resolvedUrl });
  return libraryManager.mutateLibrary(async ({ current, paths }) => {
    const existing = selectCanonicalInspiration(matchingSourceItems(current.inspirations, identity, originalUrl));
    if (existing) {
      return {
        payload: current,
        result: { existing: true, item: existing, canonicalSourceKey: identity.canonicalSourceKey },
      };
    }

    const entries = await fs.readdir(path.join(paths.libraryDir, "content-units"), { withFileTypes: true });
    const occupied = [
      ...(current.inspirations || []).map((item) => item?.id),
      ...entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    ];
    const maximum = occupied.reduce((value, id) => (
      Math.max(value, Number(String(id || "").match(/^I(\d+)$/)?.[1]) || 0)
    ), Number(current.contentIdCounters?.I) || 0);
    const id = `I${String(maximum + 1).padStart(6, "0")}`;
    const item = serverInspiration({ id, originalUrl, category: payload?.category, identity });
    return {
      payload: {
        ...current,
        inspirations: [item, ...(current.inspirations || [])],
        contentIdCounters: {
          ...(current.contentIdCounters || {}),
          I: maximum + 1,
        },
      },
      syncItems: [item],
      result: { existing: false, item, canonicalSourceKey: identity.canonicalSourceKey },
    };
  }, requestSessionId || "");
}

const INSPIRATION_PATCH_FIELDS = new Set([
  "body",
  "category",
  "categoryAssignedByUser",
  "refreshState",
  "refreshStatus",
  "refreshStage",
  "refreshEvidence",
]);

async function patchInspiration(payload, requestSessionId, libraryManager) {
  const id = validateContentId(payload?.id);
  if (!/^I\d{6,}$/.test(id)) throw apiError("只能更新灵感内容 ID", 400);
  const patch = Object.fromEntries(Object.entries(payload?.patch || {})
    .filter(([key]) => INSPIRATION_PATCH_FIELDS.has(key)));
  if (!Object.keys(patch).length) throw apiError("没有可更新的灵感字段", 400);
  return libraryManager.mutateLibrary(async ({ current }) => {
    if (current.inspirationTombstones?.[id]) throw apiError("这条灵感已删除，拒绝旧请求回写", 409);
    const item = (current.inspirations || []).find((candidate) => candidate?.id === id);
    if (!item) throw apiError("找不到要更新的灵感", 404);
    const generation = Number(item.generation) || 1;
    if (payload?.generation !== undefined && Number(payload.generation) !== generation) {
      throw apiError("这条灵感已更新，拒绝旧请求覆盖", 409);
    }
    const nextItem = {
      ...item,
      ...patch,
      generation,
      updatedAt: new Date().toISOString(),
    };
    const referencePatch = Object.fromEntries(Object.entries(patch)
      .filter(([key]) => ["body", "category", "categoryAssignedByUser"].includes(key)));
    const syncReference = (project) => {
      if (!project || !Object.keys(referencePatch).length || !Array.isArray(project.references)) return project;
      let changed = false;
      const references = project.references.map((reference) => {
        if (!reference || typeof reference !== "object" || reference.id !== id) return reference;
        changed = true;
        return {
          ...reference,
          ...referencePatch,
          updatedAt: nextItem.updatedAt,
        };
      });
      return changed ? { ...project, references, modified: "刚刚" } : project;
    };
    const projects = (current.projects || []).map(syncReference);
    const archive = (current.archive || []).map(syncReference);
    const activeProject = syncReference(current.activeProject);
    const changedProjects = [
      ...projects.filter((project, index) => project !== current.projects?.[index]),
      ...archive.filter((project, index) => project !== current.archive?.[index]),
      ...(activeProject && activeProject !== current.activeProject ? [activeProject] : []),
    ];
    return {
      payload: {
        ...current,
        inspirations: (current.inspirations || []).map((candidate) => candidate?.id === id ? nextItem : candidate),
        projects,
        archive,
        activeProject,
      },
      syncItems: [nextItem, ...changedProjects],
      result: { item: nextItem },
    };
  }, requestSessionId || "");
}

function mergeExtractionIntoInspiration(currentItem, extraction) {
  const extractedImages = replaceLocalContentImages(currentItem, extraction.images || []);
  const isPlaceholderTitle = !currentItem.title || currentItem.title.startsWith("待整理：");
  const extractedBody = String(extraction.body || "").trim();
  const currentBody = String(currentItem.body || "").trim();
  const metricsSnapshot = {
    capturedAt: new Date().toISOString(),
    likes: extraction.stats?.likes || currentItem.stats?.likes || "",
    favorites: extraction.stats?.favorites || currentItem.stats?.favorites || "",
    comments: extraction.stats?.comments || currentItem.stats?.comments || "",
    shares: extraction.stats?.shares || currentItem.stats?.shares || "",
    views: extraction.stats?.views || currentItem.stats?.views || "",
  };
  const nextStats = {
    likes: metricsSnapshot.likes,
    favorites: metricsSnapshot.favorites,
    comments: metricsSnapshot.comments,
    shares: metricsSnapshot.shares,
    views: metricsSnapshot.views,
  };
  const sourceIdentity = canonicalSourceIdentity({
    platform: extraction.platform || currentItem.platform,
    platformItemId: extraction.platformItemId || currentItem.platformItemId,
    originalUrl: currentItem.originalUrl || currentItem.source?.originalUrl,
    resolvedUrl: extraction.resolvedUrl || currentItem.resolvedUrl,
  });
  return {
    ...currentItem,
    generation: Number(currentItem.generation) || 1,
    unitSchemaVersion: 1,
    origin: "captured",
    platform: extraction.platform || currentItem.platform,
    resolvedUrl: extraction.resolvedUrl || currentItem.resolvedUrl || "",
    platformItemId: extraction.platformItemId || currentItem.platformItemId || "",
    canonicalSourceKey: sourceIdentity.canonicalSourceKey,
    title: extraction.title && isPlaceholderTitle ? extraction.title : currentItem.title,
    body: currentBody || extractedBody,
    author: extraction.author && !currentItem.author ? extraction.author : currentItem.author,
    contentType: extraction.contentType || currentItem.contentType || (extractedImages.length ? "image_set" : ""),
    images: extractedImages.length ? extractedImages : (currentItem.images || []),
    mediaAssets: extractedImages.length
      ? mergeImageAssets(currentItem, extractedImages)
      : (currentItem.mediaAssets || []),
    coverUrl: extraction.coverUrl || currentItem.coverUrl || "",
    coverLocalPath: extraction.coverLocalPath || extractedImages[0]?.localPath || currentItem.coverLocalPath || "",
    videoUrl: extraction.videoUrl || currentItem.videoUrl || "",
    videoPreviewUrl: extraction.videoLocalPath || extraction.videoPreviewUrl || currentItem.videoLocalPath || currentItem.videoPreviewUrl || "",
    videoLocalPath: extraction.videoLocalPath || currentItem.videoLocalPath || "",
    publishedAt: extraction.publishedAt || currentItem.publishedAt || "",
    duration: extraction.duration || currentItem.duration || "",
    stats: nextStats,
    parseStatus: extraction.parseStatus || currentItem.parseStatus || "已扒取公开信息",
    parseState: extraction.parseState || currentItem.parseState || "success",
    parseStage: extraction.parseState === "success" ? "扒取完成" : extraction.parseState === "partial" ? "部分完成" : currentItem.parseStage,
    parseProgress: extraction.parseState === "success" ? 100 : extraction.parseState === "partial" ? 72 : currentItem.parseProgress,
    acquisitionState: extractedImages.length || extraction.videoLocalPath || localMediaAvailable(currentItem)
      ? "acquired"
      : currentItem.acquisitionState || "pending",
    refreshState: extraction.parseState || "success",
    refreshStatus: extraction.parseStatus || "已完成刷新",
    errorCode: extraction.errorCode || "",
    needsUserAction: Boolean(extraction.needsUserAction),
    retryable: Boolean(extraction.retryable),
    captureState: extraction.captureState || extraction.parseState || "success",
    capturePhase: extraction.capturePhase || "",
    attempt: 0,
    retryAfterMs: 0,
    nextRetryAt: "",
    parseEvidence: extraction.parseEvidence || currentItem.parseEvidence || [],
    source: {
      platform: extraction.platform || currentItem.platform || "",
      originalUrl: currentItem.originalUrl || currentItem.source?.originalUrl || "",
      canonicalSourceKey: sourceIdentity.canonicalSourceKey,
      accountName: extraction.author || currentItem.author || "",
      publishedAt: extraction.publishedAt || currentItem.publishedAt || "",
    },
    metricsSnapshots: [...(currentItem.metricsSnapshots || []), metricsSnapshot],
    mediaAvailability: extractedImages.length || extraction.videoLocalPath
      ? "available"
      : currentItem.mediaAvailability,
    mediaVersion: Number(currentItem.mediaVersion) || 1,
    updatedAt: new Date().toISOString(),
  };
}

async function commitInspirationExtraction({ libraryManager, sessionId, contentId, generation, extraction }) {
  const id = validateContentId(contentId);
  if (!id.startsWith("I")) return null;
  if (isExtractionDiscarded(sessionId, id)) {
    return { discarded: true, library: await libraryManager.readLibrary() };
  }
  return libraryManager.mutateLibrary(async ({ current }) => {
    if (isExtractionDiscarded(sessionId, id)) return { payload: current, result: { discarded: true } };
    if (current.inspirationTombstones?.[id]) return { payload: current, result: { discarded: true } };
    const currentItem = (current.inspirations || []).find((item) => item?.id === id);
    if (!currentItem) return { payload: current, result: { discarded: true } };
    if (generation !== undefined && Number(generation) !== (Number(currentItem.generation) || 1)) {
      return { payload: current, result: { discarded: true } };
    }
    const currentTargetId = currentItem.platformItemId
      || xiaohongshuNoteId(currentItem.originalUrl || currentItem.source?.originalUrl || "");
    const extractionTargetId = extraction.platformItemId
      || xiaohongshuNoteId(extraction.resolvedUrl || extraction.originalUrl || "");
    if (currentTargetId && extractionTargetId && currentTargetId !== extractionTargetId) {
      throw apiError("采集结果与当前灵感不是同一条内容，已停止回写", 409);
    }
    const isXiaohongshu = extraction.platform === "小红书" || currentItem.platform === "小红书";
    if (isXiaohongshu && (
      !currentTargetId
      || extraction.targetMatched !== true
      || extractionTargetId !== currentTargetId
      || (extraction.images?.length && extraction.imageProvenanceId !== currentTargetId)
    )) {
      throw apiError("小红书采集结果未通过同笔记校验，已停止回写", 409);
    }
    const nextItem = mergeExtractionIntoInspiration(currentItem, extraction);
    return {
      payload: {
        ...current,
        storage: undefined,
        libraryOpen: undefined,
        revision: undefined,
        inspirations: (current.inspirations || []).map((item) => item?.id === id ? nextItem : item),
      },
      syncItems: [nextItem],
      result: { item: nextItem },
    };
  }, sessionId || "");
}

async function commitInspirationRefreshResult({ libraryManager, sessionId, contentId, generation, extraction }) {
  const id = validateContentId(contentId);
  return libraryManager.mutateLibrary(async ({ current }) => {
    if (isExtractionDiscarded(sessionId, id) || current.inspirationTombstones?.[id]) {
      return { payload: current, result: { discarded: true } };
    }
    const currentItem = (current.inspirations || []).find((item) => item?.id === id);
    if (!currentItem) return { payload: current, result: { discarded: true } };
    if (generation !== undefined && Number(generation) !== (Number(currentItem.generation) || 1)) {
      return { payload: current, result: { discarded: true } };
    }
    const acquired = currentItem.acquisitionState === "acquired" || localMediaAvailable(currentItem);
    const nextItem = {
      ...currentItem,
      acquisitionState: acquired ? "acquired" : (currentItem.acquisitionState || "pending"),
      parseState: acquired ? (currentItem.parseState === "extracting" ? "success" : currentItem.parseState) : (extraction.parseState || "failed"),
      parseStatus: acquired ? (currentItem.parseStatusBeforeRefresh || currentItem.parseStatus || "已获得本地素材") : (extraction.parseStatus || "扒取失败"),
      parseStage: acquired ? "本地素材可用" : (extraction.parseStage || extraction.parseStatus || "扒取失败"),
      parseProgress: acquired ? 100 : 0,
      refreshState: extraction.parseState || "failed",
      refreshStatus: acquired && ["failed", "blocked", "unsupported"].includes(extraction.parseState)
        ? "上次刷新失败，本地素材可用"
        : extraction.parseStatus || "刷新未完成",
      refreshStage: extraction.parseStage || "",
      refreshEvidence: extraction.parseEvidence || [],
      errorCode: extraction.errorCode || "",
      needsUserAction: Boolean(extraction.needsUserAction),
      retryable: Boolean(extraction.retryable),
      captureState: extraction.captureState || extraction.parseState || "failed",
      capturePhase: extraction.capturePhase || "",
      attempt: Number(extraction.attempt) || 0,
      retryAfterMs: Number(extraction.retryAfterMs) || 0,
      nextRetryAt: extraction.nextRetryAt || "",
      generation: Number(currentItem.generation) || 1,
      updatedAt: new Date().toISOString(),
    };
    return {
      payload: {
        ...current,
        inspirations: (current.inspirations || []).map((item) => item?.id === id ? nextItem : item),
      },
      syncItems: [nextItem],
      result: { item: nextItem },
    };
  }, sessionId || "");
}

function imageOrderFromFileName(fileName, fallbackOrder) {
  const parsed = Number(String(fileName || "").match(/^(\d+)/)?.[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallbackOrder;
}

async function recoverContentUnitImages({ libraryManager, sessionId, contentId }) {
  const id = validateContentId(contentId);
  if (!id.startsWith("I")) throw apiError("只支持恢复灵感内容单元", 400);
  return libraryManager.mutateLibrary(async ({ current, paths }) => {
    const currentItem = (current.inspirations || []).find((item) => item?.id === id);
    if (!currentItem) throw apiError("找不到要恢复的灵感记录", 404);
    const storage = libraryManager.requireActive(sessionId || "");
    const unitRelativeRoot = `content-units/${id}`;
    const imageRelativeRoot = `${unitRelativeRoot}/media/images`;
    const unitAvailability = await resolveExistingLibraryTarget(storage, unitRelativeRoot, { expectDirectory: true });
    if (unitAvailability.state === "offline") throw apiError("当前资料库或所在卷不可访问", 503);
    if (unitAvailability.state !== "available") {
      return { payload: current, result: { item: currentItem, recovered: 0, state: unitAvailability.state } };
    }

    let manifest = null;
    const manifestPath = path.join(unitAvailability.targetPath, "manifest.json");
    try {
      const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const itemIdentity = canonicalSourceIdentity({
        platform: currentItem.platform || currentItem.source?.platform,
        platformItemId: currentItem.platformItemId,
        originalUrl: currentItem.originalUrl || currentItem.source?.originalUrl,
        resolvedUrl: currentItem.resolvedUrl,
      });
      const manifestIdentity = canonicalSourceIdentity({
        platform: parsed?.source?.platform,
        originalUrl: parsed?.source?.originalUrl,
      });
      const manifestSourceKey = parsed?.source?.canonicalSourceKey || manifestIdentity.canonicalSourceKey;
      const itemSourceKey = currentItem.canonicalSourceKey || currentItem.source?.canonicalSourceKey || itemIdentity.canonicalSourceKey;
      if (parsed?.contentId === id && manifestSourceKey === itemSourceKey) manifest = parsed;
    } catch {}
    if (!manifest) {
      return { payload: current, result: { item: currentItem, recovered: 0, state: "identity_mismatch" } };
    }

    const recovered = [];
    const manifestImages = (Array.isArray(manifest?.mediaAssets) ? manifest.mediaAssets : [])
      .filter((asset) => asset?.role === "content_image")
      .sort((left, right) => (Number(left.order) || 0) - (Number(right.order) || 0));
    for (const [index, asset] of manifestImages.entries()) {
      const local = localContentImage(asset, id, index + 1);
      if (!local) continue;
      const availability = await resolveExistingLibraryTarget(storage, local.relativePath);
      if (availability.state === "offline") throw apiError("当前资料库或所在卷不可访问", 503);
      if (availability.state === "available" && availability.stat?.size >= 512) recovered.push(local);
    }

    if (!recovered.length) {
      return { payload: current, result: { item: currentItem, recovered: 0, state: "missing" } };
    }
    const images = mergeLocalContentImages(currentItem, recovered);
    const nextItem = {
      ...currentItem,
      contentType: currentItem.contentType || "image_set",
      images,
      mediaAssets: mergeImageAssets(currentItem, images),
      coverLocalPath: currentItem.coverLocalPath || images[0]?.localPath || "",
      mediaAvailability: "available",
      mediaVersion: Number(currentItem.mediaVersion) || 1,
      updatedAt: new Date().toISOString(),
    };
    const unchanged = JSON.stringify(currentItem.images || []) === JSON.stringify(nextItem.images)
      && JSON.stringify(currentItem.mediaAssets || []) === JSON.stringify(nextItem.mediaAssets || []);
    if (unchanged) {
      return { payload: current, result: { item: currentItem, recovered: images.length, state: "available" } };
    }
    return {
      payload: {
        ...current,
        storage: undefined,
        libraryOpen: undefined,
        revision: undefined,
        inspirations: (current.inspirations || []).map((item) => item?.id === id ? nextItem : item),
      },
      syncItems: [nextItem],
      result: { item: nextItem, recovered: images.length, state: "available" },
    };
  }, sessionId || "");
}

async function downloadVideo(videoUrl, itemId, evidence, libraryManager, referer = "https://www.douyin.com/", sessionHeaders = {}) {
  if (!/^https?:\/\//i.test(videoUrl || "") || !itemId) return {};
  const storage = await libraryManager.ensureCurrentLibrary();
  const contentId = validateContentId(itemId);
  const relativeDirectory = `content-units/${contentId}/media/captured-video`;
  const relativePath = `${relativeDirectory}/video.mp4`;
  const libraryRoot = await resolveLibraryRoot(storage);
  const absoluteDirectory = await ensureSafeWriteDirectory(libraryRoot, relativeDirectory);
  const filePath = await resolveSafeWriteFile(absoluteDirectory, "video.mp4");
  const localPath = `/library-assets/${relativePath}`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const existing = await fs.stat(filePath).catch(() => null);
  if (existing?.isFile() && existing.size > 64 * 1024) {
    evidence.push(`视频已存在本地资料库: ${relativePath}`);
    return { videoLocalPath: localPath, videoPreviewUrl: localPath };
  }

  const temporaryPath = `${filePath}.${Date.now()}.tmp`;
  try {
    const response = await fetch(videoUrl, {
      headers: {
        ...requestHeaders,
        ...sessionHeaders,
        accept: "video/mp4,video/*;q=0.9,*/*;q=0.6",
        referer: sessionHeaders.referer || referer,
      },
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || (!contentType.startsWith("video/") && !contentType.includes("octet-stream"))) {
      evidence.push(`视频保存失败: HTTP ${response.status}${contentType ? ` ${contentType}` : ""}`);
      return {};
    }
    if (!response.body) {
      evidence.push("视频保存失败: 响应没有媒体内容");
      return {};
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath, { flags: "wx" }));
    const stored = await fs.stat(temporaryPath);
    if (stored.size <= 64 * 1024) throw new Error("下载到的视频文件过小");
    await fs.rename(temporaryPath, filePath);
    evidence.push(`视频已保存: ${relativePath} (${Math.ceil(stored.size / 1024 / 1024)} MB)`);
    return { videoLocalPath: localPath, videoPreviewUrl: localPath };
  } catch (error) {
    evidence.push(`视频保存异常: ${error.message}`);
    return {};
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function proxyRemoteMedia(req, res) {
  const requestUrl = new URL(req.url, "http://local");
  const remoteUrl = requestUrl.searchParams.get("url");
  if (!remoteUrl || !/^https?:\/\//i.test(remoteUrl)) {
    res.statusCode = 400;
    res.end("Missing media url");
    return;
  }
  const range = req.headers.range;
  const response = await fetch(remoteUrl, {
    headers: {
      ...requestHeaders,
      referer: "https://www.douyin.com/",
      ...(range ? { range } : {}),
    },
  });
  res.statusCode = response.status;
  for (const header of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = response.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  res.setHeader("cache-control", "no-store");
  if (req.method === "HEAD") {
    await response.body?.cancel().catch(() => {});
    res.end();
    return;
  }
  if (!response.body) {
    res.end();
    return;
  }
  Readable.fromWeb(response.body).pipe(res);
}

function contentTypeForAsset(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".mov") return "video/quicktime";
  if (extension === ".m4v") return "video/x-m4v";
  if (extension === ".webm") return "video/webm";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/jpeg";
}

const OFFLINE_ERROR_CODES = new Set(["EACCES", "EIO", "ENODEV", "ENXIO", "ESTALE", "ETIMEDOUT"]);

function apiError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function inaccessibleState(error) {
  if (OFFLINE_ERROR_CODES.has(error?.code)) return "offline";
  if (["ENOENT", "ENOTDIR"].includes(error?.code)) return "missing";
  return "offline";
}

async function resolveLibraryRoot(storage) {
  try {
    return await fs.realpath(storage.libraryDir);
  } catch (error) {
    const wrapped = apiError("当前资料库或所在卷不可访问", 503);
    wrapped.assetState = "offline";
    wrapped.cause = error;
    throw wrapped;
  }
}

async function ensureSafeWriteDirectory(libraryRoot, relativeDirectory) {
  let currentPath = libraryRoot;
  for (const part of relativeDirectory.split("/")) {
    currentPath = path.join(currentPath, part);
    const existing = await fs.lstat(currentPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!existing) {
      await fs.mkdir(currentPath);
      continue;
    }
    if (existing.isSymbolicLink()) throw apiError("写入目录不能经过符号链接", 403);
    if (!existing.isDirectory()) throw apiError("写入路径不是目录", 409);
  }
  const realDirectory = await fs.realpath(currentPath);
  if (!isPathInside(libraryRoot, realDirectory, { allowRoot: true })) throw apiError("写入路径不在当前资料库内", 403);
  return realDirectory;
}

async function resolveSafeWriteFile(absoluteDirectory, fileName, { mustNotExist = false } = {}) {
  const targetPath = path.join(absoluteDirectory, path.basename(fileName));
  if (!isPathInside(absoluteDirectory, targetPath)) throw apiError("写入文件路径无效", 403);
  const existing = await fs.lstat(targetPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw apiError("写入文件不能是符号链接", 403);
  if (existing && !existing.isFile()) throw apiError("写入目标不是文件", 409);
  if (existing && mustNotExist) throw apiError("写入文件已经存在", 409);
  return targetPath;
}

async function resolveExistingLibraryTarget(storage, relativePath, { expectDirectory = false } = {}) {
  const libraryRoot = await resolveLibraryRoot(storage);
  const requestedPath = path.resolve(libraryRoot, relativePath);
  if (!isPathInside(libraryRoot, requestedPath)) throw apiError("素材路径不在当前资料库内", 403);
  let targetPath;
  try {
    targetPath = await fs.realpath(requestedPath);
  } catch (error) {
    return { state: inaccessibleState(error), libraryRoot, requestedPath, targetPath: null, stat: null };
  }
  if (!isPathInside(libraryRoot, targetPath)) throw apiError("素材路径不在当前资料库内", 403);
  try {
    const stat = await fs.stat(targetPath);
    const validType = expectDirectory ? stat.isDirectory() : stat.isFile();
    if (!validType) return { state: "missing", libraryRoot, requestedPath, targetPath, stat };
    await fs.access(targetPath, fsConstants.R_OK);
    return { state: "available", libraryRoot, requestedPath, targetPath, stat };
  } catch (error) {
    return { state: inaccessibleState(error), libraryRoot, requestedPath, targetPath, stat: null };
  }
}

async function serveLibraryAsset(req, res, next, libraryManager) {
  const storage = libraryManager.requireActive();
  const requestUrl = new URL(req.url, "http://local");
  const relativePath = validateReadableLibraryAssetPath(
    decodeURIComponent(requestUrl.pathname.replace("/library-assets/", "")),
  );
  const resolved = await resolveExistingLibraryTarget(storage, relativePath);
  if (resolved.state === "offline") throw apiError("当前资料库或所在卷不可访问", 503);
  if (resolved.state !== "available") {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "private, no-store");
    res.end(JSON.stringify({ error: "本地素材不存在", state: resolved.state }));
    return;
  }
  const filePath = resolved.targetPath;
  const file = resolved.stat;

  const contentType = contentTypeForAsset(filePath);
  const isVideo = contentType.startsWith("video/");
  const immutableVersionedImage = !isVideo && requestUrl.searchParams.has("assetVersion");
  res.setHeader("content-type", contentType);
  res.setHeader(
    "cache-control",
    immutableVersionedImage ? "private, max-age=31536000, immutable" : "private, no-store",
  );
  if (immutableVersionedImage) {
    const etag = `"${file.size.toString(16)}-${Math.trunc(file.mtimeMs).toString(16)}"`;
    res.setHeader("etag", etag);
    res.setHeader("last-modified", file.mtime.toUTCString());
    if (req.headers["if-none-match"] === etag) {
      res.statusCode = 304;
      res.end();
      return;
    }
  }
  if (!isVideo) {
    res.setHeader("content-length", file.size);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
    return;
  }

  res.setHeader("accept-ranges", "bytes");
  const range = req.headers.range;
  let start = 0;
  let end = file.size - 1;
  if (range) {
    const match = String(range).match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2])) {
      res.statusCode = 416;
      res.setHeader("content-range", `bytes */${file.size}`);
      res.end();
      return;
    }
    if (match[1]) start = Number(match[1]);
    if (match[2]) end = Number(match[2]);
    if (!match[1] && match[2]) {
      const suffixLength = Number(match[2]);
      start = Math.max(0, file.size - suffixLength);
      end = file.size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= file.size || end < start) {
      res.statusCode = 416;
      res.setHeader("content-range", `bytes */${file.size}`);
      res.end();
      return;
    }
    end = Math.min(end, file.size - 1);
    res.statusCode = 206;
    res.setHeader("content-range", `bytes ${start}-${end}/${file.size}`);
  }
  res.setHeader("content-length", end - start + 1);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath, { start, end }).pipe(res);
}

function parseHtmlIntoResult(result, html, evidence, label = "页面") {
  if (!html) return result;
  result.title ||= pickMeta(html, ["og:title", "twitter:title", "title", "lark:url:video_title"]) || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  result.body ||= pickMeta(html, ["og:description", "description", "twitter:description"]) || "";
  result.coverUrl ||= pickMeta(html, ["og:image", "twitter:image", "image", "lark:url:video_cover_image_url"]) || "";
  result.videoUrl ||= pickMeta(html, ["og:video", "og:video:url", "twitter:player:stream"]) || "";
  const jsonCandidates = collectJsonCandidates(html);
  evidence.push(`${label} JSON 候选: ${jsonCandidates.length}`);
  for (const candidate of jsonCandidates) {
    Object.assign(result, mergeExtracted(result, extractFromObject(candidate)));
  }
  if (/captcha|verify|验证|登录后|安全验证|滑块/i.test(textFromHtml(html).slice(0, 3000))) {
    evidence.push(`${label}提示: 可能需要登录或安全验证`);
  }
  return result;
}

function cleanDouyinTitle(value = "") {
  return decodeEntities(value)
    .replace(/\s+-\s+抖音$/, "")
    .replace(/\s*-\s*抖音短视频$/, "")
    .trim();
}

function cleanDouyinBody(value = "") {
  return decodeEntities(value)
    .replace(/\s+-\s+[\s\S]{1,80}?于(\d{8}|\d{4}[./年-]\d{1,2}[./月-]\d{1,2})[\s\S]*?发布在抖音[\s\S]*$/, "")
    .replace(/，?来抖音，记录美好生活！?$/, "")
    .trim();
}

function normalizeComparableText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseDouyinDescription(result, html, evidence, label = "页面") {
  const description = pickMeta(html, ["description", "og:description", "twitter:description"]);
  if (!description) return;
  const text = decodeEntities(description);
  const match = text.match(/^([\s\S]*?)\s+-\s+([\s\S]{1,40}?)于(\d{8}|\d{4}[./年-]\d{1,2}[./月-]\d{1,2})[\s\S]*?发布/);
  if (match) {
    const descriptionTitle = cleanDouyinBody(match[1]);
    if (!result.body || result.body === text || result.body.length < descriptionTitle.length) result.body = descriptionTitle;
    const currentTitle = cleanDouyinTitle(result.title);
    if (!currentTitle || currentTitle.length < descriptionTitle.length * 0.6 || /^@.+创作的原声$/.test(currentTitle)) {
      result.title = descriptionTitle;
    }
    result.author ||= match[2].trim();
    if (!result.publishedAt) {
      const date = match[3];
      result.publishedAt = /^\d{8}$/.test(date)
        ? `${date.slice(0, 4)}.${date.slice(4, 6)}.${date.slice(6, 8)}`
        : date.replace(/[年月/-]/g, ".").replace(/日$/, "");
    }
    evidence.push(`${label}描述解析: 标题/作者/发布时间`);
    return;
  }
  if (!result.body) result.body = text.replace(/，?来抖音，记录美好生活！?$/, "").trim();
}

function parseDouyinVisibleText(result, bodyText = "", evidence, label = "登录页面") {
  const lines = String(bodyText || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return;

  const durationLine = lines.find((line) => /\d{1,2}:\d{2}\s*\/\s*\d{1,2}:\d{2}/.test(line));
  const durationMatch = durationLine?.match(/\/\s*(\d{1,2}:\d{2})/);
  if (durationMatch && (!result.duration || Number(result.duration) > 1000)) result.duration = durationMatch[1];

  const published = lines.find((line) => /^发布时间[:：]/.test(line));
  if (published && !result.publishedAt) result.publishedAt = published.replace(/^发布时间[:：]\s*/, "");

  const reportIndex = lines.findIndex((line) => line === "举报");
  if (reportIndex > 0) {
    const stats = [];
    let cursor = reportIndex - 1;
    while (cursor >= 0 && stats.length < 4) {
      const number = compactVisibleNumber(lines[cursor]);
      if (!number) break;
      stats.unshift(number);
      cursor -= 1;
    }
    if (stats.length) {
      result.stats.likes ||= stats[0] || "";
      result.stats.comments ||= stats[1] || "";
      result.stats.favorites ||= stats[2] || "";
      result.stats.shares ||= stats[3] || "";
      evidence.push(`${label}正文解析: 互动 ${stats.join("/")}`);
    }
    const titleLine = lines[cursor];
    if (titleLine && !/^(章节要点|分享|回复|关注|登录|扫码登录)$/.test(titleLine)) {
      result.body ||= titleLine;
      result.title = cleanDouyinTitle(result.title || titleLine);
    }
  }

  if (!result.author) {
    const followerIndex = lines.findIndex((line) => /^粉丝.+获赞/.test(line));
    if (followerIndex > 0) result.author = lines[followerIndex - 1];
  }
}

function pickDouyinResourceUrls(resources = []) {
  const urls = resources.filter((url) => typeof url === "string");
  return {
    coverUrl: urls.find((url) => /douyinpic\.com/.test(url) && /cover|origin_cover|tplv-dy/.test(url)) || "",
    videoUrl: urls.find((url) => /douyinvod\.com/.test(url) && /media-video-avc1|mime_type=video_mp4/.test(url) && !/hvc1|h265|bytevc1/i.test(url))
      || urls.find((url) => /douyinvod\.com/.test(url) && /media-video|mime_type=video_mp4/.test(url))
      || "",
  };
}

export async function fetchLoggedPage(url, key, evidence, authManager) {
  const page = await authManager.capturePage(url, key);
  const label = key === "douyin" ? "抖音" : "小红书";
  if (page?.authState === "challenge") {
    evidence.push(`${label}登录会话需要手动验证；最终页面: ${page.finalUrl || "未取得"}`);
  } else if (page?.html) {
    evidence.push(`${label}登录会话抓取完成`);
    if (page.responseJsonCandidates?.length) evidence.push(`登录会话接口 JSON: ${page.responseJsonCandidates.length}`);
  } else {
    const diagnostic = [
      page?.stage ? `stage=${page.stage}` : "",
      page?.errorCode ? `errorCode=${page.errorCode}` : "",
      page?.causeCode ? `cause=${page.causeCode}` : "",
      page?.error ? `message=${page.error}` : "",
      page?.finalUrl ? `finalUrl=${page.finalUrl}` : "",
    ].filter(Boolean).join(" ");
    evidence.push(`${label}登录会话抓取失败${diagnostic ? `: ${diagnostic}` : ""}`);
  }
  return page;
}

async function extractDouyin(payload, libraryManager, authManager) {
  const evidence = [];
  const originalUrl = firstUrl(payload.url);
  let transientFailure = null;
  let capturePhase = "public_quick_path";
  const expandedUrl = await expandUrl(originalUrl, evidence).catch((error) => {
    evidence.push(`短链展开异常: ${error.message}`);
    if (error?.retryable) transientFailure = error;
    return originalUrl;
  });
  const result = {
    platform: "抖音",
    originalUrl,
    resolvedUrl: expandedUrl,
    body: "",
    title: "",
    author: "",
    coverUrl: "",
    publishedAt: "",
    duration: "",
    stats: { likes: "", favorites: "", comments: "", shares: "", views: "" },
    parseEvidence: evidence,
  };

  let page = null;
  try {
    page = await fetchText(expandedUrl, { headers: { referer: "https://www.douyin.com/" } });
    evidence.push(`页面抓取: HTTP ${page.status}`);
  } catch (error) {
    evidence.push(`页面抓取异常: ${error.message}`);
    if (error?.retryable) transientFailure = error;
  }

  if (page?.text) {
    parseHtmlIntoResult(result, page.text, evidence, "公开页面");
    parseDouyinDescription(result, page.text, evidence, "公开页面");
  }

  const awemeId = extractAwemeId(expandedUrl, page?.text || "");
  if (awemeId) {
    result.platformItemId = awemeId;
    if (!/\/video\//.test(result.resolvedUrl)) result.resolvedUrl = `https://www.douyin.com/video/${awemeId}`;
  }
  const detailUrl = awemeId ? `https://www.douyin.com/video/${awemeId}` : expandedUrl;
  capturePhase = "session_capture";
  const loggedPage = await fetchLoggedPage(detailUrl, "douyin", evidence, authManager);
  if (isUsableCapturedPage(loggedPage)) {
    result.resolvedUrl = loggedPage.finalUrl || result.resolvedUrl;
    for (const candidate of loggedPage.responseJsonCandidates || []) {
      Object.assign(result, mergeExtracted(result, extractFromObject(candidate)));
    }
    parseHtmlIntoResult(result, loggedPage.html, evidence, "登录页面");
    parseDouyinDescription(result, loggedPage.html, evidence, "登录页面");
    parseDouyinVisibleText(result, loggedPage.bodyText, evidence, "登录页面");
    const resourceUrls = pickDouyinResourceUrls(loggedPage.resources);
    if (!result.coverUrl && resourceUrls.coverUrl) {
      result.coverUrl = resourceUrls.coverUrl;
      evidence.push("登录页面资源解析: 封面 URL");
    }
    if (!result.videoUrl && resourceUrls.videoUrl) {
      result.videoUrl = resourceUrls.videoUrl;
      evidence.push("登录页面资源解析: 视频预览 URL");
    }
    if (!result.duration && loggedPage.videoDuration) result.duration = loggedPage.videoDuration;
  }

  let platformFailure = null;
  if (awemeId && (!loggedPage?.html || !result.title || !result.videoUrl)) {
    capturePhase = "fallback_capture";
    const apiUrls = [
      `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${awemeId}`,
      `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}&aid=1128&device_platform=webapp`,
    ];
    for (const apiUrl of apiUrls) {
      try {
        const api = await fetchText(apiUrl, { headers: { referer: expandedUrl, accept: "application/json,text/plain,*/*" } });
        evidence.push(`接口尝试: HTTP ${api.status} ${new URL(apiUrl).hostname}`);
        if (api.ok && api.text.trim().startsWith("{")) {
          const apiJson = JSON.parse(api.text);
          if (apiJson.status_msg) evidence.push(`接口返回: ${apiJson.status_msg}`);
          if (apiJson.status_code && apiJson.status_code !== 0) evidence.push(`接口状态码: ${apiJson.status_code}`);
          const fallbackFailure = classifyDouyinFallbackResponse(apiJson);
          if (fallbackFailure) {
            platformFailure = fallbackFailure;
            evidence.push(`备用接口契约阻断: ${fallbackFailure.errorCode} ${fallbackFailure.message}`);
          }
          Object.assign(result, mergeExtracted(result, extractFromObject(apiJson)));
        } else if (api.ok && !api.text.trim()) {
          evidence.push("接口返回: 空响应");
        }
      } catch (error) {
        evidence.push(`接口异常: ${error.message}`);
        if (error?.retryable) transientFailure = error;
      }
    }
  } else if (!awemeId) {
    evidence.push("未识别到抖音作品 ID");
  }

  result.title = cleanDouyinTitle(result.title);
  result.body = cleanDouyinBody(result.body);
  if (result.title && result.body && normalizeComparableText(result.title) === normalizeComparableText(result.body)) result.body = "";
  if (!result.title && result.body) {
    result.title = result.body.slice(0, 48);
    result.body = "";
  }
  if (result.coverUrl && !isExtractionDiscarded(payload.sessionId, payload.id)) {
    Object.assign(result, await downloadCover(result.coverUrl, payload.id || awemeId || "douyin-cover", evidence, libraryManager));
  }
  if (result.videoUrl && !isExtractionDiscarded(payload.sessionId, payload.id)) {
    result.contentType = "video";
    result.videoPreviewUrl = `/library-proxy/media?url=${encodeURIComponent(result.videoUrl)}`;
    const sessionHeaders = loggedPage?.authState === "authenticated"
      ? await authManager.authenticatedHeaders("douyin", result.videoUrl, detailUrl)
      : {};
    Object.assign(result, await downloadVideo(result.videoUrl, payload.id || awemeId || "douyin-video", evidence, libraryManager, detailUrl, sessionHeaders));
  }
  const quality = evaluateExtractionQuality(result, {
    authState: loggedPage?.authState || "unknown",
    hasProfile: await authManager.hasProfile("douyin"),
    targetMatched: Boolean(awemeId),
    blocked: evidence.some((line) => /空响应|安全验证|滑块|风控|forbidden|拒绝/i.test(line)),
    platformFailure,
    transientFailure,
    captureFailure: loggedPage?.errorCode === "AUTH_CAPTURE_FAILED" ? loggedPage : null,
    attempt: payload.attempt,
    retryAfterMs: transientFailure?.retryAfterMs,
  });
  return { ...result, ...quality, capturePhase, parseEvidence: sanitizeEvidence(evidence) };
}

async function extractGenericPublic(payload, platform, libraryManager, authManager) {
  const evidence = [];
  const originalUrl = firstUrl(payload.url);
  let transientFailure = null;
  let capturePhase = "public_quick_path";
  let repairItem = null;
  let repairTargetId = "";
  if (payload.repairMissingOnly) {
    if (platform !== "小红书") throw apiError("当前只支持修复小红书图文素材", 400);
    const current = await libraryManager.readLibrary();
    repairItem = (current.inspirations || []).find((item) => item?.id === payload.id) || null;
    if (!repairItem || !/^I\d{6,}$/.test(String(repairItem.id || ""))) throw apiError("找不到要修复的灵感记录", 404);
    const storedOriginalUrl = repairItem.originalUrl || repairItem.source?.originalUrl || "";
    repairTargetId = String(repairItem.platformItemId || xiaohongshuNoteId(storedOriginalUrl));
    const requestedTargetId = xiaohongshuNoteId(originalUrl);
    if (!repairTargetId || !requestedTargetId || repairTargetId !== requestedTargetId) {
      throw apiError("修复请求与原灵感链接不是同一条小红书笔记", 409);
    }
    if (!Array.isArray(repairItem.images) || !repairItem.images.length) {
      throw apiError("原灵感没有可核对的图片顺序，不能自动修复", 409);
    }
    evidence.push(`修复素材: ${repairItem.id}, 目标图片 ${repairItem.images.length} 张`);
  }
  const expandedUrl = await expandUrl(originalUrl, evidence).catch((error) => {
    evidence.push(`短链展开异常: ${error.message}`);
    if (error?.retryable) transientFailure = error;
    return originalUrl;
  });
  const result = {
    platform,
    originalUrl,
    resolvedUrl: expandedUrl,
    body: "",
    title: "",
    author: "",
    contentType: "",
    images: [],
    coverUrl: "",
    videoUrl: "",
    publishedAt: "",
    duration: "",
    stats: { likes: "", favorites: "", comments: "", shares: "", views: "" },
    parseEvidence: evidence,
  };

  let page = null;
  let shellReason = "";
  let targetMatched = false;
  try {
    page = await fetchText(expandedUrl, { headers: { referer: expandedUrl } });
    result.resolvedUrl = page.url || result.resolvedUrl;
    evidence.push(`页面抓取: HTTP ${page.status}`);
    const finalHost = new URL(page.url || expandedUrl).hostname;
    evidence.push(`最终域名: ${finalHost}`);
  } catch (error) {
    evidence.push(`页面抓取异常: ${error.message}`);
    if (error?.retryable) transientFailure = error;
  }

  if (page?.text) {
    if (platform === "小红书") {
      const xiaohongshu = extractXiaohongshuFromHtml({
        html: page.text,
        originalUrl,
        resolvedUrl: page.url || expandedUrl,
      });
      Object.assign(result, mergeMatchedXiaohongshu(result, xiaohongshu));
      if (xiaohongshu.targetMatched) {
        targetMatched = true;
        result.platformItemId = xiaohongshu.platformItemId;
      }
      shellReason = xiaohongshuShellReason({
        resolvedUrl: page.url || expandedUrl,
        html: page.text,
        title: result.title,
        candidateCount: xiaohongshu.candidateCount,
      });
      evidence.push(`小红书结构化数据: ${xiaohongshu.candidateCount} 个笔记候选，${xiaohongshu.images.length} 张图片`);
    } else {
      parseHtmlIntoResult(result, page.text, evidence, "公开页面");
    }
  }

  const loggedKey = platform === "小红书" ? "xiaohongshu" : "";
  if (loggedKey) capturePhase = "session_capture";
  const loggedPage = loggedKey ? await fetchLoggedPage(originalUrl, loggedKey, evidence, authManager) : null;
  if (isUsableCapturedPage(loggedPage)) {
    result.resolvedUrl = loggedPage.finalUrl || result.resolvedUrl;
    if (platform === "小红书") {
      const xiaohongshu = extractXiaohongshuFromHtml({ html: loggedPage.html, originalUrl, resolvedUrl: result.resolvedUrl });
      const responseExtraction = extractXiaohongshuFromObjects({
        objects: loggedPage.responseJsonCandidates || [],
        originalUrl,
        resolvedUrl: result.resolvedUrl,
      });
      Object.assign(result, mergeMatchedXiaohongshu(result, xiaohongshu));
      Object.assign(result, mergeMatchedXiaohongshu(result, responseExtraction));
      const matchedExtraction = responseExtraction.targetMatched
        ? responseExtraction
        : xiaohongshu.targetMatched ? xiaohongshu : null;
      if (matchedExtraction) {
        targetMatched = true;
        result.platformItemId = matchedExtraction.platformItemId;
        shellReason = "";
      } else {
        shellReason = xiaohongshuShellReason({
          resolvedUrl: loggedPage.finalUrl,
          html: loggedPage.html,
          title: loggedPage.title,
          body: loggedPage.bodyText,
          candidateCount: xiaohongshu.candidateCount + responseExtraction.candidateCount,
        }) || shellReason;
      }
      evidence.push(`小红书登录页结构化数据: ${xiaohongshu.candidateCount} 个笔记候选，${xiaohongshu.images.length} 张图片`);
      evidence.push(`小红书登录接口结构化数据: ${responseExtraction.candidateCount} 个笔记候选`);
    }
    if (platform !== "小红书") parseHtmlIntoResult(result, loggedPage.html, evidence, "登录页面");
  }

  result.title = decodeEntities(result.title).replace(/\s+-\s+小红书$/, "").trim();
  result.body = decodeEntities(result.body);
  result.publishedAt = epochToText(result.publishedAt) || result.publishedAt;
  const expectedTargetId = platform === "小红书"
    ? xiaohongshuNoteId(originalUrl) || xiaohongshuNoteId(expandedUrl) || xiaohongshuNoteId(result.resolvedUrl)
    : "";
  if (platform === "小红书") {
    result.targetMatched = targetMatched;
    result.targetId = expectedTargetId;
    if (
      result.images.length
      && (
        !expectedTargetId
        || !targetMatched
        || result.platformItemId !== expectedTargetId
        || result.imageProvenanceId !== expectedTargetId
      )
    ) {
      throw apiError("图片来源与目标小红书笔记不一致，已停止且未写入文件", 409);
    }
    if (
      (result.coverUrl || result.videoUrl)
      && (!expectedTargetId || !targetMatched || result.platformItemId !== expectedTargetId)
    ) {
      throw apiError("媒体来源与目标小红书笔记不一致，已停止且未写入文件", 409);
    }
  }
  const sessionHeaders = loggedPage?.authState === "authenticated"
    ? await authManager.authenticatedHeaders("xiaohongshu", result.coverUrl || result.videoUrl || originalUrl, result.resolvedUrl || originalUrl)
    : {};
  const repairCreatedFiles = [];
  if (payload.repairMissingOnly && (!targetMatched || result.platformItemId !== repairTargetId)) {
    throw apiError("没有确认到原小红书笔记，已停止修复且未写入文件", 409);
  }
  if (payload.repairMissingOnly && result.images.length !== repairItem.images.length) {
    throw apiError(`图片数量与原记录不一致（原 ${repairItem.images.length} 张，当前 ${result.images.length} 张），已停止修复`, 409);
  }
  if (platform === "小红书" && result.images.length) {
    result.images = await downloadXiaohongshuImages(
      result.images,
      payload.id || result.platformItemId || platform,
      evidence,
      libraryManager,
      sessionHeaders,
      {
        repairMissingOnly: Boolean(payload.repairMissingOnly),
        createdFiles: repairCreatedFiles,
        existingImages: payload.repairMissingOnly ? repairItem.images : [],
        shouldDiscard: () => isExtractionDiscarded(payload.sessionId, payload.id),
      },
    );
    result.coverUrl ||= result.images[0]?.sourceUrl || "";
    result.coverLocalPath = result.images.find((image) => image.localPath)?.localPath || "";
  } else if (result.coverUrl && !isExtractionDiscarded(payload.sessionId, payload.id)) {
    Object.assign(result, await downloadCover(result.coverUrl, payload.id || platform, evidence, libraryManager));
  }
  if (result.videoUrl && !isExtractionDiscarded(payload.sessionId, payload.id)) {
    result.contentType = "video";
    result.videoPreviewUrl = `/library-proxy/media?url=${encodeURIComponent(result.videoUrl)}`;
    Object.assign(result, await downloadVideo(
      result.videoUrl,
      payload.id || result.platformItemId || platform,
      evidence,
      libraryManager,
      platform === "小红书" ? "https://www.xiaohongshu.com/" : result.resolvedUrl,
      sessionHeaders,
    ));
  }
  const quality = evaluateExtractionQuality(result, {
    authState: loggedPage?.authState || "unknown",
    hasProfile: await authManager.hasProfile("xiaohongshu"),
    shellReason,
    targetMatched,
    transientFailure,
    captureFailure: loggedPage?.errorCode === "AUTH_CAPTURE_FAILED" ? loggedPage : null,
    attempt: payload.attempt,
    retryAfterMs: transientFailure?.retryAfterMs,
  });
  const response = { ...result, ...quality, capturePhase, parseEvidence: sanitizeEvidence(evidence) };
  if (!payload.repairMissingOnly && payload.id) {
    const hasLocalAssets = result.images.some((image) => image?.localPath || image?.relativePath)
      || Boolean(result.coverLocalPath || result.videoLocalPath);
    if (hasLocalAssets || ["success", "partial"].includes(quality.parseState)) {
      const committed = await commitInspirationExtraction({
        libraryManager,
        sessionId: payload.sessionId,
        contentId: payload.id,
        generation: payload.generation,
        extraction: response,
      });
      response.discarded = Boolean(committed?.discarded);
      response.library = committed?.library;
      if (committed?.item) {
        response.images = committed.item.images;
        response.mediaAssets = committed.item.mediaAssets;
        response.coverLocalPath = committed.item.coverLocalPath;
      }
    }
  }
  if (payload.repairMissingOnly && !result.images.every((image) => image.localPath)) {
    await Promise.all(repairCreatedFiles.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
    throw apiError("仍有图片未保存到本地，本次修复已回滚", 409);
  }
  if (payload.repairMissingOnly && ["success", "partial"].includes(quality.parseState)) {
    let repairResult;
    try {
      repairResult = await libraryManager.mutateLibrary(async ({ current }) => {
      const currentItem = (current.inspirations || []).find((item) => item?.id === repairItem.id);
      const currentTargetId = String(currentItem?.platformItemId || xiaohongshuNoteId(currentItem?.originalUrl || currentItem?.source?.originalUrl || ""));
      if (!currentItem || currentTargetId !== repairTargetId) throw apiError("灵感记录已变化，请刷新后重新修复", 409);
      if (!Array.isArray(currentItem.images) || currentItem.images.length !== result.images.length) {
        throw apiError("灵感图片顺序已变化，请刷新后重新修复", 409);
      }
      const storage = libraryManager.requireActive(payload.sessionId || "");
      const repairedImages = [];
      for (let index = 0; index < currentItem.images.length; index += 1) {
        const existing = currentItem.images[index];
        const candidate = result.images[index];
        const relativePath = String(existing.relativePath || existing.localPath || "")
          .replace(/^\/library-assets\//, "")
          .replace(/^\/+/, "");
        const availability = relativePath
          ? await resolveExistingLibraryTarget(storage, relativePath)
          : { state: "missing" };
        repairedImages.push(availability.state === "available"
          ? existing
          : candidate.localPath
            ? {
                ...existing,
                localPath: candidate.localPath,
                relativePath: candidate.relativePath,
                contentType: candidate.contentType,
                role: "content_image",
                order: index + 1,
              }
            : { ...existing, localPath: "", relativePath: "" });
      }
      if (repairedImages.some((image) => !image.localPath && !image.relativePath)) {
        throw apiError("仍有图片未保存到本地，修复没有提交", 409);
      }
      const repairedItem = {
        ...currentItem,
        images: repairedImages,
        coverLocalPath: repairedImages[0]?.localPath || currentItem.coverLocalPath || "",
        parseState: quality.parseState,
        parseStatus: quality.parseStatus,
        parseEvidence: sanitizeEvidence(evidence),
        updatedAt: new Date().toISOString(),
      };
      return {
        payload: {
          ...current,
          storage: undefined,
          libraryOpen: undefined,
          revision: undefined,
          inspirations: (current.inspirations || []).map((item) => item?.id === repairedItem.id ? repairedItem : item),
        },
        syncItems: [repairedItem],
        result: { repairedItem },
      };
      }, payload.sessionId || "");
    } catch (error) {
      await Promise.all(repairCreatedFiles.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
      throw error;
    }
    response.images = repairResult.repairedItem.images;
    response.coverLocalPath = repairResult.repairedItem.coverLocalPath;
    response.library = repairResult.library;
  } else if (payload.repairMissingOnly) {
    await Promise.all(repairCreatedFiles.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
  }
  return response;
}

async function extractContent(payload, libraryManager, authManager) {
  const url = firstUrl(payload.url);
  if (!url) return { error: "没有可解析的链接" };
  libraryManager.requireActive(payload.sessionId || "");
  if (payload.id && isExtractionDiscarded(payload.sessionId, payload.id)) {
    return {
      discarded: true,
      parseState: "discarded",
      parseStatus: "灵感已删除，采集结果已丢弃",
      library: await libraryManager.readLibrary(),
    };
  }
  if (/douyin\.com|iesdouyin\.com/.test(url)) return extractDouyin({ ...payload, url }, libraryManager, authManager);
  if (/xiaohongshu\.com|xhslink\.(?:com|cn)/.test(url)) return extractGenericPublic({ ...payload, url }, "小红书", libraryManager, authManager);
  return {
    platform: "未识别",
    originalUrl: url,
    parseState: "unsupported",
    parseStatus: "暂未接入这个平台解析器",
    parseEvidence: ["非抖音/小红书链接，暂未接入解析器"],
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function readBinaryBody(req, maxBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(new Error("封面文件不能超过 20 MB"));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function detectImageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: "png", contentType: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: "jpg", contentType: "image/jpeg" };
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return { ext: "webp", contentType: "image/webp" };
  }
  throw new Error("只支持 JPG、PNG 或 WebP 图片");
}

function safeFilePart(value, fallback) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

async function storeUploadedCover(bytes, projectId, encodedName, storage) {
  if (!bytes.length) throw new Error("没有收到封面文件");
  const imageType = detectImageType(bytes);
  let originalName = "cover";
  try {
    originalName = decodeURIComponent(String(encodedName || "cover"));
  } catch {
    originalName = String(encodedName || "cover");
  }
  const uniquePart = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const contentId = validateContentId(projectId);
  const storedName = `${uniquePart}.${imageType.ext}`;
  const relativeDirectory = `content-units/${contentId}/covers`;
  const relativePath = `${relativeDirectory}/${storedName}`;
  const libraryRoot = await resolveLibraryRoot(storage);
  const absoluteDirectory = await ensureSafeWriteDirectory(libraryRoot, relativeDirectory);
  const absolutePath = await resolveSafeWriteFile(absoluteDirectory, storedName, { mustNotExist: true });
  await fs.writeFile(absolutePath, bytes, { flag: "wx" });
  return {
    id: `cover-${uniquePart}`,
    name: path.basename(originalName),
    src: `/library-assets/${relativePath}`,
    contentType: imageType.contentType,
    size: bytes.length,
    addedAt: new Date().toISOString(),
    relativePath,
  };
}

function decodeUploadName(encodedName, fallback) {
  try {
    return path.basename(decodeURIComponent(String(encodedName || fallback)));
  } catch {
    return path.basename(String(encodedName || fallback));
  }
}

function projectVideoType(originalName, headerType) {
  const extension = path.extname(originalName).toLowerCase();
  const supported = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".webm": "video/webm",
  };
  if (!supported[extension]) throw new Error("只支持 MP4、MOV、M4V 或 WebM 视频");
  const contentType = String(headerType || "").split(";")[0].trim();
  return { extension, contentType: contentType.startsWith("video/") ? contentType : supported[extension] };
}

function canonicalProjectMediaRole(value = "") {
  const role = ({
    raw: "source_video",
    original: "source_video",
    source: "source_video",
    final: "finished_video",
    refined: "finished_video",
    refined_video: "finished_video",
    finished: "finished_video",
  })[String(value || "").toLowerCase()] || String(value || "");
  if (!["source_video", "finished_video"].includes(role)) {
    throw apiError("视频角色必须是 source_video 或 finished_video", 400);
  }
  return role;
}

function canonicalProjectAccountRole(value = "") {
  const accountRole = String(value || "").toLowerCase();
  if (!["blogger", "ip"].includes(accountRole)) {
    throw apiError("账号归属必须是 blogger 或 ip", 400);
  }
  return accountRole;
}

function projectMediaUploadId(value = "") {
  const uploadId = String(value || "");
  if (!/^[A-Za-z0-9:._-]{8,220}$/.test(uploadId)) {
    throw apiError("视频上传任务标识无效", 400);
  }
  return uploadId;
}

async function storeUploadedProjectMedia(
  req,
  projectId,
  roleValue,
  accountRoleValue,
  uploadIdValue,
  encodedName,
  storage,
  verifySession,
) {
  const contentId = validateContentId(projectId);
  if (!contentId.startsWith("C")) throw apiError("视频只能上传到创作内容", 400);
  const role = canonicalProjectMediaRole(roleValue);
  const accountRole = canonicalProjectAccountRole(accountRoleValue);
  const uploadId = projectMediaUploadId(uploadIdValue);
  const uploadKey = `${path.resolve(storage.libraryDir)}:${contentId}:${role}:${accountRole}`;
  projectMediaUploadTokens.set(uploadKey, uploadId);
  const originalName = decodeUploadName(encodedName, "video.mp4");
  const videoType = projectVideoType(originalName, req.headers["content-type"]);
  const uniquePart = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const baseName = safeFilePart(path.basename(originalName, videoType.extension), "video");
  const storedName = `${uniquePart}-${baseName}${videoType.extension}`;
  const relativeDirectory = `content-units/${contentId}/media/${role === "source_video" ? "source-video" : "finished-video"}`;
  const relativePath = `${relativeDirectory}/${storedName}`;
  const libraryRoot = await resolveLibraryRoot(storage);
  const absoluteDirectory = await ensureSafeWriteDirectory(libraryRoot, relativeDirectory);
  const absolutePath = await resolveSafeWriteFile(absoluteDirectory, storedName, { mustNotExist: true });
  const partialPath = `${absolutePath}.part`;
  let size = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      callback(null, chunk);
    },
  });

  try {
    await pipeline(req, meter, createWriteStream(partialPath, { flags: "wx" }));
    if (!size) throw new Error("没有收到视频文件");
    verifySession();
    if (projectMediaUploadTokens.get(uploadKey) !== uploadId) {
      throw apiError("同一上传位置已有更新的视频", 409);
    }
    await fs.rename(partialPath, absolutePath);
    if (projectMediaUploadTokens.get(uploadKey) !== uploadId) {
      await fs.rm(absolutePath, { force: true }).catch(() => {});
      throw apiError("同一上传位置已有更新的视频", 409);
    }
  } catch (error) {
    await fs.rm(partialPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    if (projectMediaUploadTokens.get(uploadKey) === uploadId) {
      projectMediaUploadTokens.delete(uploadKey);
    }
  }

  return {
    id: `media-${role}-${accountRole}-${uniquePart}`,
    role,
    accountRole,
    order: accountRole === "ip" ? 2 : 1,
    name: originalName,
    src: `/library-assets/${relativePath}`,
    relativePath,
    contentType: videoType.contentType,
    size,
    addedAt: new Date().toISOString(),
  };
}

function projectMediaRole(value, fallback = "") {
  return ({
    raw: "source_video",
    original: "source_video",
    source: "source_video",
    final: "finished_video",
    refined: "finished_video",
    refined_video: "finished_video",
    finished: "finished_video",
  })[String(value || "").toLowerCase()] || value || fallback;
}

function projectMediaAccountRole(value = "") {
  const accountRole = String(value || "").toLowerCase();
  return ["blogger", "ip"].includes(accountRole) ? accountRole : "";
}

function projectMediaRelativePath(asset = {}) {
  const value = String(asset.relativePath || asset.localPath || asset.src || "");
  return value
    .replace(/^\/library-assets\//, "")
    .replace(/^\/+/, "");
}

function projectMediaEntries(record = {}) {
  const entries = [];
  const add = (asset, role) => {
    if (!asset || typeof asset !== "object") return;
    entries.push({ asset, role: projectMediaRole(asset.role, role) });
  };
  (Array.isArray(record.mediaAssets) ? record.mediaAssets : []).forEach((asset) => add(asset, ""));
  add(record.rawMaterial, "source_video");
  (Array.isArray(record.finishedVideos) ? record.finishedVideos : []).forEach((asset) => add(asset, "finished_video"));
  (Array.isArray(record.finalVideos) ? record.finalVideos : []).forEach((asset) => add(asset, "finished_video"));
  add(record.finalVideo, "finished_video");
  return entries;
}

function projectMediaMatches(asset, role, target) {
  if (!asset || typeof asset !== "object") return false;
  if (projectMediaRole(asset.role, role) !== target.role) return false;
  const assetAccountRole = projectMediaAccountRole(asset.accountRole);
  if (target.legacyAccountRole ? assetAccountRole : assetAccountRole !== target.accountRole) return false;
  const assetPath = projectMediaRelativePath(asset);
  if (assetPath !== target.relativePath) return false;
  return !target.mediaId || !asset.id || String(asset.id) === target.mediaId;
}

function removeProjectMediaFromRecord(record, target) {
  if (!record || String(record.id || "") !== target.contentId) return record;
  let changed = false;
  const removeArray = (items, role = "") => (Array.isArray(items) ? items.filter((asset) => {
    const matches = projectMediaMatches(asset, role, target);
    if (matches) changed = true;
    return !matches;
  }) : items);
  const next = {
    ...record,
    mediaAssets: removeArray(record.mediaAssets),
    finishedVideos: removeArray(record.finishedVideos, "finished_video"),
    finalVideos: removeArray(record.finalVideos, "finished_video"),
  };
  if (projectMediaMatches(record.rawMaterial, "source_video", target)) {
    next.rawMaterial = null;
    changed = true;
  }
  if (projectMediaMatches(record.finalVideo, "finished_video", target)) {
    next.finalVideo = null;
    changed = true;
  }
  if (!changed) return record;
  if (Array.isArray(next.mediaAssets)) {
    next.mediaAssets = next.mediaAssets.map((asset) => {
      const role = projectMediaRole(asset.role);
      const accountRole = projectMediaAccountRole(asset.accountRole);
      if (!["source_video", "finished_video"].includes(role)) return asset;
      return {
        ...asset,
        role,
        ...(accountRole ? { accountRole, order: accountRole === "ip" ? 2 : 1 } : {}),
      };
    });
  }
  return {
    ...next,
    unitSchemaVersion: Math.max(1, Number(record.unitSchemaVersion) || 0),
    modified: "刚刚",
    updatedAt: new Date().toISOString(),
  };
}

function indexedContentRecords(library = {}) {
  return [
    ...(Array.isArray(library.projects) ? library.projects : []),
    ...(Array.isArray(library.archive) ? library.archive : []),
    ...(library.activeProject ? [library.activeProject] : []),
  ].filter(Boolean);
}

async function deleteProjectMediaContent(payload, requestSessionId, libraryManager) {
  const contentId = validateContentId(payload.projectId);
  if (!contentId.startsWith("C")) throw apiError("只能删除创作内容中的视频", 400);
  const role = canonicalProjectMediaRole(payload.role);
  const accountRole = canonicalProjectAccountRole(payload.accountRole);
  const legacyAccountRole = payload.legacyAccountRole === true;
  const scope = role;
  const relativePath = validateProjectAssetPath({
    contentId,
    relativePath: payload.relativePath,
    scope,
  });
  const mediaId = String(payload.mediaId || "");
  const target = {
    contentId,
    role,
    accountRole,
    legacyAccountRole,
    relativePath,
    mediaId,
  };

  return libraryManager.mutateLibrary(async ({ current, paths }) => {
    const contentRecords = indexedContentRecords(current);
    const ownRecords = contentRecords.filter((record) => String(record.id || "") === contentId);
    if (!ownRecords.length) throw apiError("找不到这条创作内容", 404);

    const indexedTarget = ownRecords.some((record) => (
      projectMediaEntries(record).some(({ asset, role: assetRole }) => (
        projectMediaMatches(asset, assetRole, target)
      ))
    ));
    const canonicalRoot = `content-units/${contentId}/media/${role === "source_video" ? "source-video" : "finished-video"}/`;
    if (!indexedTarget && !relativePath.startsWith(canonicalRoot)) {
      throw apiError("这条视频不属于当前内容单元", 403);
    }

    const sharedByOtherContent = contentRecords.some((record) => (
      String(record.id || "") !== contentId
      && projectMediaEntries(record).some(({ asset }) => projectMediaRelativePath(asset) === relativePath)
    ));
    if (sharedByOtherContent) {
      throw apiError("这条文件仍被其他内容使用，已停止永久删除", 409);
    }

    const resolved = await resolveExistingLibraryTarget(paths, relativePath);
    if (resolved.state === "offline") throw apiError("当前资料库或所在卷不可访问", 503);
    let stagedPath = "";
    if (resolved.state === "available") {
      const directStat = await fs.lstat(resolved.requestedPath);
      if (directStat.isSymbolicLink()) throw apiError("拒绝删除符号链接视频", 403);
      const stageName = `.deleting-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(relativePath).slice(-96)}`;
      stagedPath = path.join(path.dirname(resolved.targetPath), stageName);
      if (!isPathInside(resolved.libraryRoot, stagedPath)) throw apiError("视频删除暂存路径无效", 403);
      await fs.rename(resolved.targetPath, stagedPath);
    }

    const nextProjects = (current.projects || []).map((record) => removeProjectMediaFromRecord(record, target));
    const nextArchive = (current.archive || []).map((record) => removeProjectMediaFromRecord(record, target));
    const nextActiveProject = removeProjectMediaFromRecord(current.activeProject, target);
    const changedRecords = [
      ...nextProjects,
      ...nextArchive,
      nextActiveProject,
    ].filter((record) => record?.id === contentId);

    return {
      payload: {
        ...current,
        projects: nextProjects,
        archive: nextArchive,
        activeProject: nextActiveProject,
      },
      syncItems: changedRecords,
      result: {
        deleted: true,
        contentId,
        mediaId,
        role,
        accountRole,
        relativePath,
        fileDeleted: resolved.state === "available",
        previousState: resolved.state,
      },
      rollback: async () => {
        if (!stagedPath) return;
        const stagedExists = await fs.lstat(stagedPath).then(() => true).catch(() => false);
        const targetExists = await fs.lstat(resolved.requestedPath).then(() => true).catch(() => false);
        if (stagedExists && !targetExists) await fs.rename(stagedPath, resolved.requestedPath);
      },
      afterCommit: async () => {
        if (stagedPath) await fs.rm(stagedPath, { force: true });
      },
    };
  }, requestSessionId || "");
}

function openLocalPath(targetPath, revealFile) {
  return new Promise((resolve, reject) => {
    if (process.platform !== "darwin") {
      reject(new Error("当前系统不支持在访达中显示"));
      return;
    }
    const child = spawn("open", revealFile ? ["-R", targetPath] : [targetPath], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("访达打开失败")));
  });
}

export async function revealProjectPath(payload, requestSessionId, libraryManager, options = {}) {
  const storage = libraryManager.requireActive(requestSessionId || "");
  const scope = payload.scope || (payload.relativePath ? "asset" : "project");
  const relativePath = validateProjectAssetPath({
    contentId: payload.projectId,
    relativePath: payload.relativePath,
    scope,
  });
  const resolved = await resolveExistingLibraryTarget(storage, relativePath, { expectDirectory: scope === "project" });
  if (resolved.state === "offline") throw apiError("当前资料库或所在卷不可访问", 503);
  if (resolved.state !== "available") throw apiError("已记录的素材文件不存在", 404);
  if (options.revealPath) await options.revealPath(resolved.targetPath, scope !== "project");
  else await openLocalPath(resolved.targetPath, scope !== "project");
  return { revealed: true, relativePath, state: "available" };
}

export async function projectAssetStates(payload, requestSessionId, libraryManager) {
  const storage = libraryManager.requireActive(requestSessionId || "");
  const contentId = validateContentId(payload.projectId);
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  if (assets.length > 256) throw apiError("单次素材状态检查数量过多", 400);
  const states = {};

  for (const [index, asset] of assets.entries()) {
    const key = String(asset?.key || `asset-${index}`);
    if (!asset?.relativePath) {
      states[key] = { state: "not_added", relativePath: "" };
      continue;
    }
    const scope = asset.scope || "asset";
    const relativePath = validateProjectAssetPath({
      contentId,
      relativePath: asset.relativePath,
      scope,
    });
    const resolved = await resolveExistingLibraryTarget(storage, relativePath, { expectDirectory: scope === "project" });
    states[key] = { state: resolved.state, relativePath };
  }

  return { states };
}

function referenceId(reference) {
  if (typeof reference === "string") return reference;
  return String(reference?.id || reference?.contentId || reference?.referenceContentId || "");
}

function referenceEntries(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return [value];
  return [];
}

function removeReferenceValue(value, contentId) {
  if (Array.isArray(value)) {
    return value.filter((reference) => referenceId(reference) !== contentId);
  }
  if ((typeof value === "string" || (value && typeof value === "object"))
    && referenceId(value) === contentId) {
    return [];
  }
  return value;
}

function removeInspirationReference(record, contentId) {
  if (!record || typeof record !== "object") return record;
  const next = { ...record };
  if (record.references !== undefined) {
    next.references = removeReferenceValue(record.references, contentId);
  }
  if (record.relationships && typeof record.relationships === "object") {
    next.relationships = {
      ...record.relationships,
      referenceContentIds: removeReferenceValue(record.relationships.referenceContentIds, contentId),
    };
  }
  return next;
}

function recordReferencesInspiration(record, contentId) {
  if (!record || typeof record !== "object") return false;
  return referenceEntries(record.references).some((reference) => referenceId(reference) === contentId)
    || referenceEntries(record.relationships?.referenceContentIds)
      .some((reference) => referenceId(reference) === contentId);
}

function cleanupStateKey(libraryDir, contentId) {
  return `${path.resolve(libraryDir)}:${contentId}`;
}

function publicCleanupState(state) {
  if (!state) return null;
  return {
    contentId: state.contentId,
    state: state.state,
    attempt: state.attempt,
    stagedName: state.stagedName,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt || "",
    retryAt: state.retryAt || "",
    errorCode: state.errorCode || "",
    cleanupMs: state.cleanupMs || 0,
  };
}

function scheduleDeleteCleanup({ libraryDir, contentId, stagingPath, attempt = 1, startedAt = new Date().toISOString() }) {
  const key = cleanupStateKey(libraryDir, contentId);
  if (deletionCleanupTasks.has(key)) return publicCleanupState(deletionCleanupStates.get(key));
  const stagedName = path.basename(stagingPath);
  if (!new RegExp(`^\\.deleting-${contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-`).test(stagedName)) {
    throw apiError("待清理目录名称无效", 403);
  }
  const state = {
    contentId,
    state: "pending",
    attempt,
    stagedName,
    startedAt,
    updatedAt: new Date().toISOString(),
    completedAt: "",
    retryAt: "",
    errorCode: "",
    cleanupMs: 0,
  };
  deletionCleanupStates.set(key, state);
  const task = (async () => {
    const cleanupStarted = Date.now();
    try {
      state.state = "cleaning";
      state.updatedAt = new Date().toISOString();
      await fs.rm(stagingPath, { recursive: true, force: false });
      state.state = "complete";
      state.completedAt = new Date().toISOString();
      state.updatedAt = state.completedAt;
      state.cleanupMs = Date.now() - cleanupStarted;
      state.errorCode = "";
      console.info("[inspiration-delete-cleanup]", JSON.stringify({
        contentId,
        state: state.state,
        attempt,
        cleanupMs: state.cleanupMs,
      }));
    } catch (error) {
      if (error.code === "ENOENT") {
        state.state = "complete";
        state.completedAt = new Date().toISOString();
        state.updatedAt = state.completedAt;
        state.cleanupMs = Date.now() - cleanupStarted;
        state.errorCode = "";
        return;
      }
      state.state = "retry_wait";
      state.updatedAt = new Date().toISOString();
      state.errorCode = String(error.code || "CLEANUP_FAILED");
      state.cleanupMs = Date.now() - cleanupStarted;
      const retryDelay = Math.min(5000 * (2 ** Math.min(attempt - 1, 6)), 300000);
      state.retryAt = new Date(Date.now() + retryDelay).toISOString();
      console.warn("[inspiration-delete-cleanup]", JSON.stringify({
        contentId,
        state: state.state,
        attempt,
        errorCode: state.errorCode,
        retryDelay,
      }));
      const retryTimer = setTimeout(() => {
        deletionCleanupTasks.delete(key);
        scheduleDeleteCleanup({ libraryDir, contentId, stagingPath, attempt: attempt + 1, startedAt });
      }, retryDelay);
      retryTimer.unref?.();
    } finally {
      if (state.state !== "retry_wait") deletionCleanupTasks.delete(key);
    }
  })();
  deletionCleanupTasks.set(key, task);
  return publicCleanupState(state);
}

async function resumePendingDeleteCleanup(libraryManager) {
  const storage = libraryManager.storage();
  if (!storage?.libraryDir) return [];
  const libraryRoot = await resolveLibraryRoot(storage);
  const contentUnitsPath = path.join(libraryRoot, "content-units");
  const entries = await fs.readdir(contentUnitsPath, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const resumed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const match = entry.name.match(/^\.deleting-(I\d{6,})-\d+-\d+$/);
    if (!match) continue;
    const stagingPath = path.join(contentUnitsPath, entry.name);
    if (!isPathInside(contentUnitsPath, stagingPath)) continue;
    resumed.push(scheduleDeleteCleanup({
      libraryDir: storage.libraryDir,
      contentId: match[1],
      stagingPath,
    }));
  }
  return resumed;
}

export async function deleteInspirationContentUnit(payload, requestSessionId, expectedRevision, libraryManager) {
  if (!libraryManager && expectedRevision?.mutateLibrary) {
    libraryManager = expectedRevision;
    expectedRevision = "";
  }
  const contentId = validateContentId(payload?.id);
  if (!/^I\d{6,}$/.test(contentId)) throw apiError("只能删除灵感内容 ID", 400);
  const storage = libraryManager.requireActive(requestSessionId || "");
  const discardKey = extractionDiscardKey(storage.sessionId, contentId);
  discardedExtractionIds.add(discardKey);
  try {
    return await libraryManager.mutateLibrary(async ({ current }) => {
    const started = Date.now();
    const timings = {};
    const libraryRoot = await resolveLibraryRoot(storage);
    const contentUnitsPath = path.join(libraryRoot, "content-units");
    const contentUnitsStat = await fs.lstat(contentUnitsPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!contentUnitsStat) throw apiError("当前资料库缺少 content-units 目录", 409);
    if (contentUnitsStat.isSymbolicLink() || !contentUnitsStat.isDirectory()) throw apiError("内容单元根目录无效", 403);
    const realContentUnits = await fs.realpath(contentUnitsPath);
    if (!isPathInside(libraryRoot, realContentUnits)) throw apiError("内容单元根目录不在当前资料库内", 403);

    const targetPath = path.join(realContentUnits, contentId);
    if (!isPathInside(realContentUnits, targetPath)) throw apiError("待删除内容单元路径无效", 403);
    let targetStat;
    try {
      targetStat = await fs.lstat(targetPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        const state = inaccessibleState(error);
        throw apiError(state === "offline" ? "当前资料库或所在卷不可访问" : "无法检查内容单元", state === "offline" ? 503 : 409);
      }
      targetStat = null;
    }
    if (targetStat?.isSymbolicLink()) throw apiError("拒绝删除符号链接内容单元", 403);
    if (targetStat && !targetStat.isDirectory()) throw apiError("内容单元路径不是目录", 409);
    if (targetStat) {
      const realTarget = await fs.realpath(targetPath);
      if (!isPathInside(realContentUnits, realTarget)) throw apiError("待删除内容单元不在当前资料库内", 403);
    }

    const projects = (current.projects || []).map((record) => removeInspirationReference(record, contentId));
    const archive = (current.archive || []).map((record) => removeInspirationReference(record, contentId));
    const activeProject = removeInspirationReference(current.activeProject, contentId);
    const affectedRecords = [
      ...(current.projects || []).map((record, index) => recordReferencesInspiration(record, contentId) ? projects[index] : null),
      ...(current.archive || []).map((record, index) => recordReferencesInspiration(record, contentId) ? archive[index] : null),
      recordReferencesInspiration(current.activeProject, contentId) ? activeProject : null,
    ].filter(Boolean);
    const nextPayload = {
      ...current,
      storage: undefined,
      libraryOpen: undefined,
      revision: undefined,
      inspirations: (current.inspirations || []).filter((item) => item?.id !== contentId),
      inspirationTombstones: {
        ...(current.inspirationTombstones || {}),
        [contentId]: {
          generation: Number((current.inspirations || []).find((item) => item?.id === contentId)?.generation) || 1,
          deletedAt: new Date().toISOString(),
        },
      },
      projects,
      archive,
      activeProject,
    };
    const stagingPath = path.join(realContentUnits, `.deleting-${contentId}-${process.pid}-${Date.now()}`);
    let staged = false;
    if (targetStat) {
      const renameStarted = Date.now();
      await fs.rename(targetPath, stagingPath);
      staged = true;
      timings.renameMs = Date.now() - renameStarted;
    } else {
      timings.renameMs = 0;
    }
    timings.prepareMs = Date.now() - started;

    return {
      payload: nextPayload,
      syncItems: affectedRecords,
      rollback: async () => {
        if (!staged) return;
        await fs.rename(stagingPath, targetPath);
      },
      afterCommit: ({ library }) => {
        timings.commitMs = Date.now() - started;
        const cleanup = staged
          ? scheduleDeleteCleanup({
              libraryDir: storage.libraryDir,
              contentId,
              stagingPath,
            })
          : {
              contentId,
              state: "not_needed",
              attempt: 0,
              stagedName: "",
              startedAt: "",
              updatedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              retryAt: "",
              errorCode: "",
              cleanupMs: 0,
            };
        console.info("[inspiration-delete]", JSON.stringify({
          contentId,
          indexed: true,
          affectedRecords: affectedRecords.length,
          renameMs: timings.renameMs,
          commitMs: timings.commitMs,
          cleanupState: cleanup.state,
        }));
        return library;
      },
      result: {
        deleted: true,
        contentId,
        contentUnitState: targetStat ? "cleanup_pending" : "missing",
        cleanup: staged
          ? {
              contentId,
              state: "pending",
              attempt: 1,
              stagedName: path.basename(stagingPath),
              startedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: "",
              retryAt: "",
              errorCode: "",
              cleanupMs: 0,
            }
          : {
              contentId,
              state: "not_needed",
              attempt: 0,
              stagedName: "",
              startedAt: "",
              updatedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              retryAt: "",
              errorCode: "",
              cleanupMs: 0,
            },
        timings,
      },
    };
    }, storage.sessionId);
  } catch (error) {
    if (error.statusCode === 503) discardedExtractionIds.delete(discardKey);
    throw error;
  }
}

function installLibraryApi(server, libraryManager, options = {}) {
  const authManager = options.authManager;
  let resumedCleanupLibraryDir = "";
  server.middlewares.use(async (req, res, next) => {
        const activeLibraryDir = libraryManager.storage()?.libraryDir || "";
        if (activeLibraryDir && resumedCleanupLibraryDir !== activeLibraryDir) {
          resumedCleanupLibraryDir = activeLibraryDir;
          void resumePendingDeleteCleanup(libraryManager).catch((error) => {
            console.warn("[inspiration-delete-cleanup]", JSON.stringify({
              state: "resume_failed",
              errorCode: String(error.code || "CLEANUP_RESUME_FAILED"),
            }));
          });
        }
        if (req.url?.startsWith("/library-proxy/media") && ["GET", "HEAD"].includes(req.method || "")) {
          try {
            await proxyRemoteMedia(req, res);
          } catch (error) {
            res.statusCode = 502;
            res.end(`Media proxy failed: ${error.message}`);
          }
          return;
        }
        if (req.url?.startsWith("/library-assets/") && ["GET", "HEAD"].includes(req.method || "")) {
          try {
            await serveLibraryAsset(req, res, next, libraryManager);
          } catch (error) {
            res.statusCode = error.statusCode || 500;
            res.end(error.message);
          }
          return;
        }
        if (!req.url?.startsWith("/api/library") && !req.url?.startsWith("/api/content-ids") && !req.url?.startsWith("/api/extract") && !req.url?.startsWith("/api/covers") && !req.url?.startsWith("/api/project-media") && !req.url?.startsWith("/api/project-actions") && !req.url?.startsWith("/api/project-assets/status") && !req.url?.startsWith("/api/auth/") && !req.url?.startsWith("/api/inspirations/")) return next();
        res.setHeader("content-type", "application/json; charset=utf-8");
        try {
          if (req.url.startsWith("/api/content-ids")) {
            if (req.method !== "POST") {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: "Method not allowed" }));
              return;
            }
            const payload = await readJsonBody(req);
            const result = await libraryManager.allocateContentId(
              payload.prefix || "C",
              req.headers["x-library-session-id"] || "",
              req.headers["x-library-revision"] || "",
            );
            res.statusCode = 201;
            res.end(JSON.stringify(result));
            return;
          }
          if (req.url.startsWith("/api/project-actions")) {
            if (req.method !== "POST") {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: "Method not allowed" }));
              return;
            }
            const payload = await readJsonBody(req);
            if (payload.action !== "reveal") throw new Error("未知的项目操作");
            const result = await revealProjectPath(payload, req.headers["x-library-session-id"], libraryManager, options);
            res.end(JSON.stringify(result));
            return;
          }
          if (req.url.startsWith("/api/project-assets/status")) {
            if (req.method !== "POST") {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: "Method not allowed" }));
              return;
            }
            const payload = await readJsonBody(req);
            const result = await projectAssetStates(payload, req.headers["x-library-session-id"], libraryManager);
            res.end(JSON.stringify(result));
            return;
          }
          if (req.url.startsWith("/api/project-media")) {
            if (req.method === "DELETE") {
              const payload = await readJsonBody(req);
              const result = await deleteProjectMediaContent(
                payload,
                req.headers["x-library-session-id"] || "",
                libraryManager,
              );
              res.end(JSON.stringify(result));
              return;
            }
            if (req.method !== "POST") {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: "Method not allowed" }));
              return;
            }
            const requestUrl = new URL(req.url, "http://local");
            const projectId = requestUrl.searchParams.get("projectId");
            const role = requestUrl.searchParams.get("role");
            const accountRole = requestUrl.searchParams.get("accountRole");
            const uploadId = requestUrl.searchParams.get("uploadId");
            if (!projectId) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "缺少内容 ID" }));
              return;
            }
            const sessionId = req.headers["x-library-session-id"] || "";
            const storage = libraryManager.requireActive(sessionId);
            const media = await storeUploadedProjectMedia(
              req,
              projectId,
              role,
              accountRole,
              uploadId,
              req.headers["x-file-name"],
              storage,
              () => libraryManager.requireActive(sessionId),
            );
            res.statusCode = 201;
            res.end(JSON.stringify({ media }));
            return;
          }
          if (req.url.startsWith("/api/covers")) {
            if (req.method !== "POST") {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: "Method not allowed" }));
              return;
            }
            const requestUrl = new URL(req.url, "http://local");
            const projectId = requestUrl.searchParams.get("projectId");
            if (!projectId) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "缺少内容 ID" }));
              return;
            }
            const bytes = await readBinaryBody(req);
            const storage = libraryManager.requireActive(req.headers["x-library-session-id"] || "");
            const cover = await storeUploadedCover(bytes, projectId, req.headers["x-file-name"], storage);
            res.statusCode = 201;
            res.end(JSON.stringify({ cover }));
            return;
          }
          if (req.url.startsWith("/api/auth/open")) {
            if (req.method !== "POST") {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: "Method not allowed" }));
              return;
            }
            const payload = await readJsonBody(req);
            res.end(JSON.stringify(await authManager.open(payload)));
            return;
          }
          if (req.url.startsWith("/api/inspirations/")) {
            const requestUrl = new URL(req.url, "http://local");
            if (requestUrl.pathname === "/api/inspirations/ingest") {
              if (req.method !== "POST") {
                res.statusCode = 405;
                res.end(JSON.stringify({ error: "Method not allowed" }));
                return;
              }
              const payload = await readJsonBody(req);
              const result = await ingestInspiration(
                payload,
                req.headers["x-library-session-id"] || "",
                libraryManager,
              );
              res.statusCode = result.existing ? 200 : 201;
              res.end(JSON.stringify(result));
              return;
            }
            if (requestUrl.pathname === "/api/inspirations/recover-media") {
              if (req.method !== "POST") {
                res.statusCode = 405;
                res.end(JSON.stringify({ error: "Method not allowed" }));
                return;
              }
              const id = validateContentId(requestUrl.searchParams.get("id"));
              const result = await recoverContentUnitImages({
                libraryManager,
                sessionId: req.headers["x-library-session-id"] || "",
                contentId: id,
              });
              res.end(JSON.stringify(result));
              return;
            }
            if (requestUrl.pathname === "/api/inspirations/delete-status") {
              if (req.method !== "GET") {
                res.statusCode = 405;
                res.end(JSON.stringify({ error: "Method not allowed" }));
                return;
              }
              const id = validateContentId(requestUrl.searchParams.get("id"));
              const storage = libraryManager.requireActive(req.headers["x-library-session-id"] || "");
              const cleanup = publicCleanupState(deletionCleanupStates.get(cleanupStateKey(storage.libraryDir, id)));
              res.end(JSON.stringify({ contentId: id, cleanup: cleanup || { contentId: id, state: "unknown" } }));
              return;
            }
            const id = decodeURIComponent(requestUrl.pathname.slice("/api/inspirations/".length));
            if (req.method === "PATCH") {
              const payload = await readJsonBody(req);
              const result = await patchInspiration(
                { ...payload, id },
                req.headers["x-library-session-id"] || "",
                libraryManager,
              );
              res.end(JSON.stringify(result));
              return;
            }
            if (req.method !== "DELETE") {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: "Method not allowed" }));
              return;
            }
            const result = await deleteInspirationContentUnit(
              { id },
              req.headers["x-library-session-id"] || "",
              req.headers["x-library-revision"] || "",
              libraryManager,
            );
            res.end(JSON.stringify(result));
            return;
          }
          if (req.url.startsWith("/api/auth/status")) {
            const requestUrl = new URL(req.url, "http://local");
            const key = platformKey(requestUrl.searchParams.get("platform") || "");
            const probe = requestUrl.searchParams.get("probe") === "1";
            res.end(JSON.stringify(await authManager.status(key, { probe })));
            return;
          }
          if (req.url.startsWith("/api/extract")) {
            if (req.method !== "POST") {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: "Method not allowed" }));
              return;
            }
            const payload = await readJsonBody(req);
            const queueKey = platformKey(payload.platform) || platformKey(firstUrl(payload.url));
            payload.sessionId ||= req.headers["x-library-session-id"] || "";
            const executeExtraction = async () => {
              const result = await extractContent(payload, libraryManager, authManager);
              if (payload.id && !payload.repairMissingOnly && !result.library && !result.discarded) {
                const committed = ["success", "partial"].includes(result.parseState)
                  ? await commitInspirationExtraction({
                      libraryManager,
                      sessionId: payload.sessionId,
                      contentId: payload.id,
                      generation: payload.generation,
                      extraction: result,
                    })
                  : await commitInspirationRefreshResult({
                      libraryManager,
                      sessionId: payload.sessionId,
                      contentId: payload.id,
                      generation: payload.generation,
                      extraction: result,
                    });
                result.discarded = Boolean(committed?.discarded);
                result.library = committed?.library;
              }
              return result;
            };
            const result = queueKey
              ? await extractionScheduler.run({
                  platform: queueKey,
                  sessionId: payload.sessionId,
                  contentId: payload.id || firstUrl(payload.url),
                  generation: payload.generation,
                }, executeExtraction)
              : await executeExtraction();
            res.end(JSON.stringify(result));
            return;
          }
          if (req.url.startsWith("/api/library/manage")) {
            if (req.method !== "POST") {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: "Method not allowed" }));
              return;
            }
            const payload = await readJsonBody(req);
            await extractionScheduler.waitForIdle();
            const result = await libraryManager.manage(payload.action, {
              ...payload,
              sessionId: payload.sessionId || req.headers["x-library-session-id"] || "",
            });
            res.end(JSON.stringify(result));
            return;
          }
          if (req.method === "GET") {
            res.end(JSON.stringify(await libraryManager.readLibrary()));
            return;
          }
          if (req.method === "POST") {
            const payload = await readJsonBody(req);
            res.end(JSON.stringify(await libraryManager.writeLibrary(
              payload,
              req.headers["x-library-session-id"] || "",
              req.headers["x-library-revision"] || "",
            )));
            return;
          }
          res.statusCode = 405;
          res.end(JSON.stringify({ error: "Method not allowed" }));
        } catch (error) {
          res.statusCode = error.statusCode || 500;
          res.end(JSON.stringify({
            error: error.message,
            code: error.code || "",
            ...(error.library ? { library: error.library } : {}),
          }));
        }
  });
}

export function libraryApiPlugin(options = {}) {
  const libraryManager = createLibraryManager(options);
  const authManager = options.authManager || createAuthCaptureManager({
    authRoot: options.authRoot,
    fetchImpl: options.authFetchImpl,
    spawnImpl: options.authSpawnImpl,
    loadPlaywright: options.loadPlaywright,
  });
  const apiOptions = { ...options, authManager };
  return {
    name: "local-video-content-library-api",
    getLibraryStorage() {
      return libraryManager.storage();
    },
    configureServer(server) {
      installLibraryApi(server, libraryManager, apiOptions);
    },
    configurePreviewServer(server) {
      installLibraryApi(server, libraryManager, apiOptions);
    },
  };
}

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react(), libraryApiPlugin()],
});
