import fs from "node:fs/promises";
import { constants as fsConstants, createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_EAGLE_API_BASE = "http://127.0.0.1:41595/api";
const INFO_DIR_CACHE = new Map();

export class EagleUnavailableError extends Error {
  constructor(message = "Eagle 文件不可用/重新关联", statusCode = 503) {
    super(message);
    this.statusCode = statusCode;
    this.code = "EAGLE_UNAVAILABLE";
  }
}

function apiBase(options = {}) {
  return String(options.eagleApiBase || process.env.VIDEO_STUDIO_EAGLE_API_BASE || process.env.EAGLE_API_BASE || DEFAULT_EAGLE_API_BASE).replace(/\/+$/, "");
}

function validateEagleItemId(value = "") {
  const id = String(value || "").trim();
  if (!/^MS[A-Z0-9]{8,40}$/i.test(id)) throw new EagleUnavailableError("Eagle item ID 无效", 400);
  return id.toUpperCase();
}

function contentTypeForExtension(filePath = "") {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".webm": "video/webm",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  })[ext] || "application/octet-stream";
}

export async function eagleApiJson(endpoint, { method = "GET", body, options = {} } = {}) {
  let response;
  try {
    response = await fetch(`${apiBase(options)}${endpoint}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new EagleUnavailableError(`Eagle 文件不可用/重新关联：${error.message}`, 503);
  }
  let result = {};
  const text = await response.text();
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    result = { status: response.ok ? "success" : "error", message: text };
  }
  if (!response.ok || result.status === "error") {
    // Eagle V1 sometimes returns its error text in `data` (not `message`),
    // notably while an addFromPath item is still being indexed.
    const message = result.message || (typeof result.data === "string" ? result.data : "") || `Eagle API 请求失败：HTTP ${response.status}`;
    throw new EagleUnavailableError(message, response.status || 503);
  }
  return result;
}

export async function eagleItemInfo(itemId, options = {}) {
  const id = validateEagleItemId(itemId);
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const result = await eagleApiJson(`/item/info?id=${encodeURIComponent(id)}`, { options });
      const item = result.data;
      if (!item || item.isDeleted) throw new EagleUnavailableError("Eagle 文件不可用/重新关联", 404);
      return item;
    } catch (error) {
      lastError = error;
      const isAsyncImportWindow = error?.statusCode === 500 && /File does not exist|文件不存在/i.test(error.message || "");
      if (!isAsyncImportWindow || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastError || new EagleUnavailableError("Eagle 文件不可用/重新关联", 404);
}

export async function updateEagleItem(itemId, patch, options = {}) {
  const id = validateEagleItemId(itemId);
  const result = await eagleApiJson("/item/update", {
    method: "POST",
    body: { id, ...patch },
    options,
  });
  return result.data || {};
}

export async function setEagleAnnotation(itemId, annotation, options = {}) {
  return updateEagleItem(itemId, { annotation: String(annotation || "") }, options);
}

export async function importPathToEagle({
  filePath,
  folderId,
  name = "",
  annotation = "",
  website = "",
  tags = [],
  options = {},
}) {
  const body = {
    path: filePath,
    folderId,
    ...(name ? { name } : {}),
    ...(annotation ? { annotation } : {}),
    ...(website ? { website, url: website } : {}),
    ...(Array.isArray(tags) && tags.length ? { tags } : {}),
  };
  const result = await eagleApiJson("/item/addFromPath", { method: "POST", body, options });
  const data = result.data;
  const itemId = typeof data === "string" ? data : data?.id;
  if (!itemId) throw new EagleUnavailableError("Eagle 导入成功但没有返回 item ID", 502);
  return typeof data === "string" ? { id: data } : data;
}

async function pathExists(value) {
  return fs.access(value, fsConstants.R_OK).then(() => true).catch(() => false);
}

async function eagleLibraryRoots() {
  const raw = [
    process.env.VIDEO_STUDIO_EAGLE_LIBRARY_ROOT,
    process.env.EAGLE_LIBRARY_ROOT,
    "/Volumes/团队文件-MAX线上协作中台/引力环球视频.library",
    "/Volumes/团队文件-MAX线上协作中台/引力环球.library",
    path.join(os.homedir(), "引力环球/引力环球.library"),
  ].filter(Boolean);
  const roots = [];
  for (const root of raw) {
    if (roots.includes(root)) continue;
    if (await pathExists(path.join(root, "images"))) roots.push(root);
  }
  return roots;
}

async function findInfoDirInDirectory(directory, itemId, depth) {
  if (depth < 0) return "";
  const direct = path.join(directory, `${itemId}.info`);
  if (await pathExists(direct)) return direct;
  if (depth === 0) return "";
  let entries = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.endsWith(".info")) continue;
    const found = await findInfoDirInDirectory(path.join(directory, entry.name), itemId, depth - 1);
    if (found) return found;
  }
  return "";
}

async function findEagleInfoDir(itemId) {
  const id = validateEagleItemId(itemId);
  const cached = INFO_DIR_CACHE.get(id);
  if (cached && await pathExists(cached)) return cached;
  for (const root of await eagleLibraryRoots()) {
    const found = await findInfoDirInDirectory(path.join(root, "images"), id, 3);
    if (found) {
      INFO_DIR_CACHE.set(id, found);
      return found;
    }
  }
  throw new EagleUnavailableError("Eagle 文件不可用/重新关联", 404);
}

export async function resolveEagleOriginalPath(item, options = {}) {
  const infoDir = await findEagleInfoDir(item.id);
  const expectedSize = Number(item.size) || 0;
  const expectedExt = String(item.ext || "").replace(/^\./, "").toLowerCase();
  const entries = await fs.readdir(infoDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === "metadata.json" || /thumbnail|palette|preview/i.test(entry.name)) continue;
    const filePath = path.join(infoDir, entry.name);
    const stat = await fs.stat(filePath);
    files.push({ filePath, stat, ext: path.extname(entry.name).slice(1).toLowerCase() });
  }
  const match = files.find((file) => (
    (!expectedExt || file.ext === expectedExt)
    && (!expectedSize || file.stat.size === expectedSize)
  )) || files.find((file) => !expectedSize || file.stat.size === expectedSize) || files[0];
  if (!match) throw new EagleUnavailableError("Eagle 文件不可用/重新关联", 404);
  if (expectedSize && match.stat.size !== expectedSize) throw new EagleUnavailableError("Eagle 原文件大小与索引不一致", 409);
  return match;
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) {
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

function sendJsonError(res, error) {
  res.statusCode = error.statusCode || 500;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: error.message || "Eagle 文件不可用/重新关联", code: error.code || "EAGLE_MEDIA_FAILED" }));
}

export async function serveEagleMedia(req, res, options = {}) {
  if (!["GET", "HEAD"].includes(req.method || "")) {
    res.statusCode = 405;
    res.end("Method not allowed");
    return;
  }
  try {
    const requestUrl = new URL(req.url || "", "http://local");
    const itemId = validateEagleItemId(
      decodeURIComponent(requestUrl.pathname.replace(/^\/api\/eagle-media\/?/, "")) || requestUrl.searchParams.get("itemId"),
    );
    const expectedFolderId = requestUrl.searchParams.get("folderId") || "";
    const item = await eagleItemInfo(itemId, options);
    if (expectedFolderId && (!Array.isArray(item.folders) || !item.folders.includes(expectedFolderId))) {
      throw new EagleUnavailableError("Eagle item 未关联到目标文件夹", 409);
    }
    const resolved = await resolveEagleOriginalPath(item, options);
    const size = resolved.stat.size;
    const range = parseRange(req.headers.range, size);
    const type = contentTypeForExtension(resolved.filePath);
    res.setHeader("accept-ranges", "bytes");
    res.setHeader("content-type", type);
    res.setHeader("cache-control", "no-store");
    if (range?.invalid) {
      res.statusCode = 416;
      res.setHeader("content-range", `bytes */${size}`);
      res.end();
      return;
    }
    if (range) {
      res.statusCode = 206;
      res.setHeader("content-range", `bytes ${range.start}-${range.end}/${size}`);
      res.setHeader("content-length", String(range.end - range.start + 1));
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      createReadStream(resolved.filePath, { start: range.start, end: range.end }).pipe(res);
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-length", String(size));
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(resolved.filePath).pipe(res);
  } catch (error) {
    sendJsonError(res, error);
  }
}
