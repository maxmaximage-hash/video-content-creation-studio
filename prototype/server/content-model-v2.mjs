import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const CONTENT_MODEL_VERSION = 2;

const CONTENT_ID_PATTERN = /^[IC][A-Za-z0-9._-]+$/;

function asString(value) {
  return value === undefined || value === null ? "" : String(value);
}

function nonEmpty(value) {
  return asString(value).trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function canonicalPath(asset = {}) {
  const candidate = asset.relativePath || asset.localPath || asset.src || "";
  const value = asString(candidate).trim();
  if (value.startsWith("/library-assets/")) return value.slice("/library-assets/".length);
  return value.replace(/^\/+/, "");
}

function sourceKey(item = {}) {
  const source = item.source || {};
  return nonEmpty(source.canonicalSourceKey || item.canonicalSourceKey)
    || (nonEmpty(source.platformItemId || item.platformItemId)
      ? `${sourcePlatformKey(source.platform || item.platform)}:${nonEmpty(source.platformItemId || item.platformItemId)}`
      : sourceKeyFromUrl(item));
}

function sourcePlatformKey(value = "") {
  const platform = nonEmpty(value).toLowerCase();
  if (platform.includes("小红书") || platform.includes("xiaohongshu") || platform.includes("xhs")) return "xhs";
  if (platform.includes("抖音") || platform.includes("douyin")) return "douyin";
  return platform || "unknown";
}

function sourceKeyFromUrl(item = {}) {
  const source = item.source || {};
  const platform = sourcePlatformKey(source.platform || item.platform);
  const url = nonEmpty(
    source.originalUrl
      || item.originalUrl
      || source.resolvedUrl
      || item.resolvedUrl,
  );
  if (platform === "xhs") {
    const noteId = url.match(/(?:discovery\/item|explore|item)\/([0-9a-f]{20,})/i)?.[1] || "";
    return noteId ? `xhs:${noteId}` : "";
  }
  if (platform === "douyin") {
    const videoId = url.match(/(?:video|modal_id)[=/](\d{10,})/i)?.[1] || "";
    return videoId ? `douyin:${videoId}` : "";
  }
  return "";
}

function allItems(data = {}) {
  const candidates = [
    ...(Array.isArray(data.inspirations) ? data.inspirations : []),
    ...(Array.isArray(data.projects) ? data.projects : []),
    ...(Array.isArray(data.archive) ? data.archive : []),
    ...(data.activeProject ? [data.activeProject] : []),
  ].filter((item) => item && CONTENT_ID_PATTERN.test(asString(item.id)));
  const byId = new Map();
  for (const item of candidates) byId.set(asString(item.id), item);
  return [...byId.values()];
}

function legacyAssets(item = {}) {
  const assets = [];
  const add = (asset, role, order, sourcePriority = 0) => {
    if (!asset || typeof asset !== "object") return;
    const relativePath = canonicalPath(asset);
    const src = asString(asset.src || asset.localPath || "");
    if (!relativePath && !src) return;
    assets.push({
      ...asset,
      role,
      order: Number(asset.order) || Number(asset.version) || order,
      relativePath,
      src,
      __sourcePriority: sourcePriority,
    });
  };
  (Array.isArray(item.covers) ? item.covers : []).forEach((asset, index) => add(
    typeof asset === "string" ? { src: asset } : asset,
    "cover_image",
    index + 1,
    1,
  ));
  if (Array.isArray(item.images)) item.images.forEach((asset, index) => add(asset, "content_image", index + 1, 1));
  if (Array.isArray(item.mediaAssets)) {
    item.mediaAssets.forEach((asset, index) => {
      const roleMap = {
        original: "source_video",
        raw: "source_video",
        refined: "finished_video",
        final: "finished_video",
        refined_video: "finished_video",
        finished: "finished_video",
        cover: "cover_image",
      };
      add(asset, roleMap[asset.role] || asset.role || "captured_video", index + 1, 3);
    });
  }
  if (item.videoLocalPath) add({ src: item.videoLocalPath, localPath: item.videoLocalPath }, "captured_video", 1, 0);
  if (item.rawMaterial?.src) add(item.rawMaterial, "source_video", 1, 0);
  const finals = Array.isArray(item.finishedVideos) && item.finishedVideos.length
    ? item.finishedVideos
    : (Array.isArray(item.finalVideos) && item.finalVideos.length
      ? item.finalVideos
      : (item.finalVideo?.src ? [item.finalVideo] : []));
  finals.forEach((asset, index) => add(asset, "finished_video", index + 1, 0));
  const byPath = new Map();
  for (const asset of assets) {
    const key = canonicalPath(asset) || asString(asset.src || asset.localPath);
    if (!key) continue;
    const previous = byPath.get(key);
    if (!previous || (previous.__sourcePriority || 0) < (asset.__sourcePriority || 0)) {
      byPath.set(key, asset);
    }
  }
  return [...byPath.values()].map(({ __sourcePriority, ...asset }) => asset);
}

function assetIdentity(contentId, asset, role, order) {
  const relativePath = canonicalPath(asset);
  const source = asString(asset.src || asset.localPath || "");
  const basis = relativePath || source || `${contentId}:${role}:${order}`;
  return createHash("sha1").update(basis).digest("hex").slice(0, 20);
}

function normalizedMetrics(item) {
  if (Array.isArray(item.metricsSnapshots) && item.metricsSnapshots.length) {
    return item.metricsSnapshots.map((snapshot) => ({ ...snapshot }));
  }
  if (item.stats && typeof item.stats === "object") {
    return [{
      capturedAt: item.capturedAt || item.updatedAt || "",
      likes: asString(item.stats.likes),
      favorites: asString(item.stats.favorites),
      comments: asString(item.stats.comments),
      shares: asString(item.stats.shares),
      views: asString(item.stats.views),
    }];
  }
  return [];
}

function referenceIds(item) {
  const candidates = [
    ...(Array.isArray(item.relationships?.referenceContentIds) ? item.relationships.referenceContentIds : []),
    ...(Array.isArray(item.references) ? item.references : []),
  ];
  return unique(candidates.map((value) => (
    typeof value === "string" ? value : value?.id
  )).map(nonEmpty).filter((id) => CONTENT_ID_PATTERN.test(id)));
}

function normalizeUnit(item) {
  const contentId = nonEmpty(item.id);
  const references = referenceIds(item);
  const origin = item.origin || (contentId.startsWith("I") ? "captured" : "original");
  return {
    contentId,
    origin,
    contentType: item.contentType || (item.images?.length ? "image_set" : (item.videoLocalPath ? "video" : "mixed")),
    title: asString(item.title),
    body: asString(item.body),
    category: asString(item.category),
    source: {
      platform: asString(item.source?.platform || item.platform),
      originalUrl: asString(item.source?.originalUrl || item.originalUrl),
      canonicalSourceKey: sourceKey(item),
      platformItemId: asString(item.source?.platformItemId || item.platformItemId),
      accountName: asString(item.source?.accountName || item.author),
      publishedAt: asString(item.source?.publishedAt || item.publishedAt),
    },
    workflow: {
      stage: asString(item.workflow?.stage || (contentId.startsWith("I") ? "inspiration" : "creating")),
      creationStatus: item.workflow?.creationStatus || item.creationStatus || null,
      completedAt: item.workflow?.completedAt || item.completedAt || null,
    },
    referenceContentIds: references,
    createdAt: item.createdAt || item.capturedAt || "",
    updatedAt: item.updatedAt || item.modified || "",
  };
}

/**
 * Build the normalized v2 collections without moving or copying any media.
 * Legacy page arrays are deliberately retained by the caller as a compatibility projection.
 */
export function buildContentModelV2(data = {}) {
  const items = allItems(data);
  const assets = new Map();
  const assetLinks = [];
  const seenAssetLinks = new Set();
  const contentUnits = [];
  const contentRelations = [];
  const contentRevisions = [];
  const metricsSnapshots = [];

  for (const item of items) {
    const unit = normalizeUnit(item);
    contentUnits.push(unit);
    const itemAssets = legacyAssets(item);
    for (const asset of itemAssets) {
      const role = asString(asset.role || "asset");
      const order = Number(asset.order) || 1;
      const assetId = asString(asset.id) || `asset-${assetIdentity(unit.contentId, asset, role, order)}`;
      const canonicalAssetId = `asset-${assetIdentity(unit.contentId, asset, role, order)}`;
      const existing = assets.get(canonicalAssetId);
      if (!existing) {
        assets.set(canonicalAssetId, {
          assetId: canonicalAssetId,
          kind: role.endsWith("video") ? "video" : "image",
          name: asString(asset.name),
          relativePath: canonicalPath(asset),
          source: asString(asset.src || asset.localPath),
          contentType: asString(asset.contentType),
          size: Number(asset.size) || 0,
          createdAt: asset.addedAt || asset.createdAt || "",
        });
      }
      const linkKey = `${unit.contentId}:${canonicalAssetId}:${role}:${order}`;
      if (seenAssetLinks.has(linkKey)) continue;
      seenAssetLinks.add(linkKey);
      assetLinks.push({
        contentId: unit.contentId,
        assetId: canonicalAssetId,
        legacyAssetId: assetId,
        role,
        order,
      });
    }
    for (const targetId of unit.referenceContentIds) {
      contentRelations.push({
        relationId: `${unit.contentId}:references:${targetId}`,
        fromContentId: unit.contentId,
        toContentId: targetId,
        type: "references",
      });
    }
    for (const snapshot of normalizedMetrics(item)) {
      metricsSnapshots.push({
        snapshotId: `${unit.contentId}:${snapshot.capturedAt || "unknown"}:${metricsSnapshots.length}`,
        contentId: unit.contentId,
        ...snapshot,
      });
    }
    if (item.workflow?.stage === "published" || item.publishedAt) {
      contentRevisions.push({
        revisionId: `${unit.contentId}:published:${item.publishedAt || item.updatedAt || "unknown"}`,
        contentId: unit.contentId,
        stage: "published",
        publishedAt: item.publishedAt || item.updatedAt || "",
        title: unit.title,
        body: unit.body,
        assetIds: assetLinks.filter((link) => link.contentId === unit.contentId).map((link) => link.assetId),
      });
    }
  }

  const duplicateGroups = [...new Map(contentUnits
    .filter((unit) => unit.source.canonicalSourceKey)
    .map((unit) => [unit.source.canonicalSourceKey, []]))
    .keys()]
    .map((canonicalSourceKey) => ({
      canonicalSourceKey,
      contentIds: contentUnits
        .filter((candidate) => candidate.source.canonicalSourceKey === canonicalSourceKey)
        .map((candidate) => candidate.contentId),
    }))
    .filter((group) => group.contentIds.length > 1);

  return {
    schemaVersion: CONTENT_MODEL_VERSION,
    assets: [...assets.values()],
    contentUnits,
    assetLinks,
    contentRelations,
    contentRevisions,
    metricsSnapshots,
    duplicateGroups,
    generatedAt: new Date().toISOString(),
  };
}

export function withContentModelV2(data = {}) {
  const model = buildContentModelV2(data);
  return {
    ...data,
    schemaVersion: CONTENT_MODEL_VERSION,
    assets: model.assets,
    contentUnits: model.contentUnits,
    assetLinks: model.assetLinks,
    contentRelations: model.contentRelations,
    contentRevisions: model.contentRevisions,
    metricsSnapshots: model.metricsSnapshots,
    duplicateGroups: model.duplicateGroups,
  };
}

export function migrationDryRun(data = {}) {
  const model = buildContentModelV2(data);
  const indexedIds = new Set(allItems(data).map((item) => item.id));
  const unitDirectories = Array.isArray(data.contentUnitDirectories) ? data.contentUnitDirectories : [];
  const orphanDirectories = unitDirectories.filter((id) => !indexedIds.has(id));
  const duplicateDeletionCandidates = model.duplicateGroups.map((group) => {
    const sorted = [...group.contentIds].sort((a, b) => {
      const av = Number(asString(a).match(/\d+/)?.[0]) || Number.MAX_SAFE_INTEGER;
      const bv = Number(asString(b).match(/\d+/)?.[0]) || Number.MAX_SAFE_INTEGER;
      return av - bv;
    });
    return {
      canonicalSourceKey: group.canonicalSourceKey,
      suggestedKeepId: sorted[0] || "",
      candidateDeleteIds: sorted.slice(1),
      reason: "同一平台作品身份对应多个不可变内容 ID，需人工确认后再删除。",
    };
  });
  return {
    sourceSchemaVersion: Number(data.schemaVersion) || 1,
    targetSchemaVersion: CONTENT_MODEL_VERSION,
    counts: {
      legacyInspirations: Array.isArray(data.inspirations) ? data.inspirations.length : 0,
      legacyProjects: Array.isArray(data.projects) ? data.projects.length : 0,
      legacyArchive: Array.isArray(data.archive) ? data.archive.length : 0,
      contentUnits: model.contentUnits.length,
      assets: model.assets.length,
      assetLinks: model.assetLinks.length,
      relations: model.contentRelations.length,
      metricsSnapshots: model.metricsSnapshots.length,
    },
    duplicateGroups: model.duplicateGroups,
    duplicateDeletionCandidates,
    orphanDirectories,
    destructiveActions: [],
    warnings: [
      ...(orphanDirectories.length ? ["发现未被 library.json 索引的 content-units 目录；迁移不会自动纳入或删除。"] : []),
      ...(model.duplicateGroups.length ? ["发现同一 canonical source 对应多个内容 ID；迁移不会自动删除，需人工确认。"] : []),
    ],
    model,
  };
}

export async function readLibraryForMigration(libraryDir) {
  const indexPath = path.join(path.resolve(libraryDir), "library.json");
  return JSON.parse(await fs.readFile(indexPath, "utf8"));
}

export async function writeMigratedLibrary(libraryDir, data, { backup = true } = {}) {
  const root = path.resolve(libraryDir);
  const indexPath = path.join(root, "library.json");
  const current = await readLibraryForMigration(root);
  const migrated = withContentModelV2(data);
  const backupPath = backup ? `${indexPath}.pre-v2-${Date.now()}.bak` : "";
  if (backupPath) await fs.copyFile(indexPath, backupPath);
  const temporaryPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, indexPath);
    return { library: migrated, backupPath };
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    if (backupPath) await fs.copyFile(backupPath, indexPath).catch(() => {});
    throw error;
  }
}
