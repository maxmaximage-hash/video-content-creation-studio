import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "./path-security.mjs";
import {
  createLibraryIndexBackup,
  purgeLibraryBackupsContaining,
  purgeSensitiveMetadataFiles,
} from "./library-backups.mjs";

function exactReferenceId(reference) {
  if (typeof reference === "string") return reference;
  return String(reference?.id || reference?.contentId || reference?.referenceContentId || "");
}

function removeReference(value, contentId) {
  if (Array.isArray(value)) return value.filter((entry) => exactReferenceId(entry) !== contentId);
  if (exactReferenceId(value) === contentId) return [];
  return value;
}

function stripRecordReferences(record, contentId) {
  if (!record || typeof record !== "object") return record;
  const next = { ...record };
  if (record.references !== undefined) next.references = removeReference(record.references, contentId);
  if (record.relationships && typeof record.relationships === "object") {
    next.relationships = {
      ...record.relationships,
      referenceContentIds: removeReference(record.relationships.referenceContentIds, contentId),
    };
  }
  return next;
}

function containsAny(value, fingerprints) {
  if (!value) return false;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return fingerprints.some((needle) => needle && serialized.includes(needle));
}

function filterContentArray(value, contentId, fingerprints) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => {
    if (entry?.id === contentId || entry?.contentId === contentId) return false;
    return !containsAny(entry, fingerprints);
  });
}

export function contentDeletionFingerprints(current = {}, contentId) {
  void current;
  return [String(contentId || "").trim()].filter(Boolean);
}

export function stripContentFromLibrary(current = {}, contentId) {
  const fingerprints = contentDeletionFingerprints(current, contentId);
  const inspirations = (current.inspirations || []).filter((record) => record?.id !== contentId);
  const projects = (current.projects || [])
    .filter((record) => record?.id !== contentId)
    .map((record) => stripRecordReferences(record, contentId));
  const archive = (current.archive || [])
    .filter((record) => record?.id !== contentId)
    .map((record) => stripRecordReferences(record, contentId));
  const activeProject = current.activeProject?.id === contentId
    ? null
    : stripRecordReferences(current.activeProject, contentId);
  const next = {
    ...current,
    storage: undefined,
    libraryOpen: undefined,
    revision: undefined,
    inspirations,
    projects,
    archive,
    activeProject,
    assets: filterContentArray(current.assets, contentId, [contentId, `content-units/${contentId}/`]),
    contentUnits: filterContentArray(current.contentUnits, contentId, [contentId]),
    assetLinks: filterContentArray(current.assetLinks, contentId, [contentId]),
    contentRelations: filterContentArray(current.contentRelations, contentId, [contentId]),
    contentRevisions: filterContentArray(current.contentRevisions, contentId, [contentId]),
    metricsSnapshots: filterContentArray(current.metricsSnapshots, contentId, [contentId]),
    captureBatches: filterContentArray(current.captureBatches, contentId, fingerprints),
    duplicateGroups: (current.duplicateGroups || []).flatMap((group) => {
      if (group?.id === contentId) return [];
      const ids = (group?.contentIds || group?.ids || []).filter((id) => id !== contentId);
      if (ids.length < 2 && containsAny(group, [contentId])) return [];
      if (Array.isArray(group?.contentIds)) return [{ ...group, contentIds: ids }];
      if (Array.isArray(group?.ids)) return [{ ...group, ids }];
      return containsAny(group, [contentId]) ? [] : [group];
    }),
  };
  delete next.inspirationTombstones;
  return { next, fingerprints };
}

async function removeWithRetries(targetPath, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 4);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.rm(targetPath, { recursive: true, force: false });
      return;
    } catch (error) {
      if (error.code === "ENOENT") return;
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 120));
    }
  }
  throw lastError;
}

export async function stageContentUnitForDeletion(libraryDir, contentId) {
  const root = await fs.realpath(path.resolve(libraryDir));
  const unitsPath = path.join(root, "content-units");
  const unitsStat = await fs.lstat(unitsPath);
  if (unitsStat.isSymbolicLink() || !unitsStat.isDirectory()) throw new Error("内容单元根目录无效");
  const realUnits = await fs.realpath(unitsPath);
  if (!isPathInside(root, realUnits)) throw new Error("内容单元根目录越界");
  const targetPath = path.join(realUnits, contentId);
  if (!isPathInside(realUnits, targetPath)) throw new Error("待删除内容路径越界");
  const targetStat = await fs.lstat(targetPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!targetStat) return { targetPath, stagingPath: "", staged: false };
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) throw new Error("拒绝删除符号链接或非目录内容单元");
  const realTarget = await fs.realpath(targetPath);
  if (!isPathInside(realUnits, realTarget)) throw new Error("待删除内容单元越界");
  const stagingPath = path.join(realUnits, `.hard-delete-${contentId}-${process.pid}-${Date.now()}`);
  await fs.rename(targetPath, stagingPath);
  return { targetPath, stagingPath, staged: true };
}

export async function rollbackStagedContentUnit(staged) {
  if (!staged?.staged || !staged.stagingPath) return;
  const targetExists = await fs.lstat(staged.targetPath).catch(() => null);
  if (!targetExists) await fs.rename(staged.stagingPath, staged.targetPath);
}

export async function finishHardDelete({ libraryDir, staged, fingerprints, sanitizedLibrary }) {
  if (staged?.staged) await removeWithRetries(staged.stagingPath);
  const removedBackups = await purgeLibraryBackupsContaining(libraryDir, fingerprints);
  const removedMetadata = await purgeSensitiveMetadataFiles(libraryDir, fingerprints);
  const cleanText = `${JSON.stringify(sanitizedLibrary, null, 2)}\n`;
  const cleanBackup = await createLibraryIndexBackup(libraryDir, cleanText, { label: "post-hard-delete" });
  const remaining = await Promise.all(fingerprints.map(async (needle) => {
    const currentText = await fs.readFile(path.join(libraryDir, "library.json"), "utf8");
    return currentText.includes(needle) ? needle : "";
  }));
  if (remaining.some(Boolean)) throw new Error("删除后索引验证失败");
  return {
    removedBackupCount: removedBackups.length,
    removedMetadataCount: removedMetadata.length,
    cleanBackup,
  };
}

export async function purgeLegacyDeleteStaging(libraryDir) {
  const unitsPath = path.join(path.resolve(libraryDir), "content-units");
  const entries = await fs.readdir(unitsPath, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!/^\.(?:deleting-I[A-Za-z0-9._-]+-|hard-delete-[IC][A-Za-z0-9._-]+-)/.test(entry.name)) continue;
    const target = path.join(unitsPath, entry.name);
    if (!isPathInside(unitsPath, target)) continue;
    await removeWithRetries(target);
    removed.push(entry.name);
  }
  return removed;
}
