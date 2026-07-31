#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { withContentModelV2 } from "../server/content-model-v2.mjs";

const libraryDir = path.resolve(process.argv[process.argv.indexOf("--library") + 1] || "");
const ids = process.argv
  .filter((value) => /^I\d{6}$/.test(value))
  .filter((value, index, values) => values.indexOf(value) === index);
const confirmed = process.argv.includes("--confirm");

if (!libraryDir || !ids.length || !confirmed) {
  console.error("用法：node prototype/scripts/recover-confirmed-orphan-inspirations.mjs --library /path/to/库.library I000013 I000014 I000027 --confirm");
  process.exit(2);
}

const indexPath = path.join(libraryDir, "library.json");
const data = JSON.parse(await fs.readFile(indexPath, "utf8"));
const indexed = new Set((data.inspirations || []).map((item) => item.id));
const latestMetrics = (snapshots = []) => [...snapshots]
  .reverse()
  .find((snapshot) => Object.values(snapshot || {}).some((value) => String(value || "").trim())) || {};
const platformItemId = (url = "") => (
  String(url).match(/(?:discovery\/item|explore|item)\/([0-9a-f]{20,})/i)?.[1] || ""
);
const recover = [];

for (const id of ids) {
  if (indexed.has(id)) continue;
  const unitRoot = path.join(libraryDir, "content-units", id);
  const manifestPath = path.join(unitRoot, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const assets = Array.isArray(manifest.mediaAssets) ? manifest.mediaAssets : [];
  if (!manifest.title || !manifest.source?.platform || !assets.length) {
    throw new Error(`${id} 不是可恢复的完整内容单元，拒绝写入索引`);
  }
  const images = assets.filter((asset) => asset.role === "content_image");
  const video = assets.find((asset) => ["captured_video", "source_video", "finished_video"].includes(asset.role));
  const metrics = Array.isArray(manifest.metricsSnapshots) ? manifest.metricsSnapshots : [];
  const stats = latestMetrics(metrics);
  const originalUrl = String(manifest.source.originalUrl || "");
  recover.push({
    id,
    unitSchemaVersion: 1,
    origin: manifest.origin || "captured",
    type: "inspiration",
    originalUrl,
    platform: manifest.source.platform,
    author: manifest.source.accountName || "",
    title: manifest.title,
    body: manifest.body || "",
    category: manifest.category || "",
    categoryAssignedByUser: false,
    capturedAt: manifest.updatedAt || "",
    updatedAt: manifest.updatedAt || "",
    parseStatus: "采集成功：本地内容已恢复",
    parseState: "success",
    parseStage: "扒取完成",
    parseProgress: 100,
    stats: {
      likes: String(stats.likes || ""),
      favorites: String(stats.favorites || ""),
      comments: String(stats.comments || ""),
      shares: String(stats.shares || ""),
      views: String(stats.views || ""),
    },
    publishedAt: manifest.source.publishedAt || "",
    duration: "",
    resolvedUrl: originalUrl,
    platformItemId: platformItemId(originalUrl),
    coverUrl: images[0]?.sourceUrl || "",
    coverLocalPath: images[0]?.localPath || "",
    contentType: manifest.contentType || (images.length ? "image" : "video"),
    images,
    videoUrl: "",
    videoPreviewUrl: "",
    videoLocalPath: video?.localPath || video?.src || "",
    parseEvidence: ["从现有 content-unit manifest 恢复", "本地素材路径已核验"],
    mediaAssets: [],
    metricsSnapshots: metrics,
    source: manifest.source,
    workflow: manifest.workflow || { stage: "inspiration", creationStatus: null, completedAt: null },
    errorCode: "",
    needsUserAction: false,
    retryable: false,
  });
}

if (!recover.length) {
  console.log(JSON.stringify({ recovered: [], changed: false }, null, 2));
  process.exit(0);
}

const backupPath = `${indexPath}.pre-orphan-recovery-${Date.now()}.bak`;
await fs.copyFile(indexPath, backupPath);
const next = withContentModelV2({
  ...data,
  inspirations: [...recover, ...(data.inspirations || [])],
});
const temporaryPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
await fs.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
await fs.rename(temporaryPath, indexPath);
console.log(JSON.stringify({
  recovered: recover.map((item) => item.id),
  backupPath,
  counts: {
    inspirations: next.inspirations.length,
    assets: next.assets.length,
    assetLinks: next.assetLinks.length,
    metricsSnapshots: next.metricsSnapshots.length,
  },
}, null, 2));
