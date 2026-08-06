#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { LIBRARY_KIND } from "../server/library-manager.mjs";
import { createLibraryWriteLease } from "../server/library-lock.mjs";
import { createLibraryIndexBackup, purgeSensitiveMetadataFiles } from "../server/library-backups.mjs";
import {
  contentDeletionFingerprints,
  rollbackStagedContentUnit,
  stageContentUnitForDeletion,
  stripContentFromLibrary,
} from "../server/library-hard-delete.mjs";

const RESIDUAL_INSPIRATION_IDS = ["I000012", "I000024", "I000025", "I000030"];
const TOMBSTONE_ONLY_IDS = ["I000022", "I000026", "I000028", "I000029"];
const EMPTY_RECOVERED_PROJECT_IDS = ["C000020", "C000021"];
const PUBLISHED_PROJECT_IDS = ["C000002", "C000005"];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function manifestFor(libraryDir, contentId) {
  const filePath = path.join(libraryDir, "content-units", contentId, "manifest.json");
  return readJson(filePath).catch(() => null);
}

function recordLocation(data, contentId) {
  if ((data.inspirations || []).some((item) => item?.id === contentId)) return "inspirations";
  if ((data.projects || []).some((item) => item?.id === contentId)) return "projects";
  if ((data.archive || []).some((item) => item?.id === contentId)) return "archive";
  if (data.activeProject?.id === contentId) return "activeProject";
  return "none";
}

async function assertRecoveredProjectIsEmpty(libraryDir, data, contentId) {
  const project = (data.projects || []).find((item) => item?.id === contentId);
  if (!project) return;
  const manifest = await manifestFor(libraryDir, contentId);
  const meaningful = [
    project.body,
    project.transcript,
    ...(project.covers || []),
    ...(project.mediaAssets || []),
    manifest?.body,
    manifest?.transcript,
    ...(manifest?.mediaAssets || []),
    ...(manifest?.presentation?.covers || []),
  ].some((value) => Array.isArray(value) ? value.length > 0 : Boolean(String(value || "").trim()));
  const allowedTitle = ["", "未命名创作"].includes(String(project.title || "").trim())
    && ["", "未命名创作"].includes(String(manifest?.title || "").trim());
  if (meaningful || !allowedTitle) fail(`${contentId} 不再是空白恢复项目，拒绝自动删除`);
}

async function buildReconciledLibrary(libraryDir, current) {
  for (const contentId of EMPTY_RECOVERED_PROJECT_IDS) {
    await assertRecoveredProjectIsEmpty(libraryDir, current, contentId);
  }
  for (const contentId of PUBLISHED_PROJECT_IDS) {
    const manifest = await manifestFor(libraryDir, contentId);
    if (manifest?.workflow?.stage !== "published") fail(`${contentId} manifest 未标记 published，拒绝移入归档`);
  }

  const deleteIds = [...RESIDUAL_INSPIRATION_IDS, ...TOMBSTONE_ONLY_IDS, ...EMPTY_RECOVERED_PROJECT_IDS];
  let next = current;
  const fingerprints = [];
  for (const contentId of deleteIds) {
    fingerprints.push(...contentDeletionFingerprints(next, contentId), contentId);
    next = stripContentFromLibrary(next, contentId).next;
  }

  const published = [];
  const remainingProjects = [];
  for (const project of next.projects || []) {
    if (!PUBLISHED_PROJECT_IDS.includes(project?.id)) {
      remainingProjects.push(project);
      continue;
    }
    const manifest = await manifestFor(libraryDir, project.id);
    published.push({
      ...project,
      workflow: { ...(project.workflow || {}), ...(manifest?.workflow || {}), stage: "published" },
    });
  }
  const archiveById = new Map([...(next.archive || []), ...published].map((item) => [item.id, item]));
  next = {
    ...next,
    projects: remainingProjects,
    archive: ["C000001", "C000002", "C000005", "C000007"].map((id) => archiveById.get(id)).filter(Boolean),
    inspirationTombstones: undefined,
    libraryRecovery: undefined,
    libraryRevision: (Number(current.libraryRevision) || 1) + 1,
    libraryEpoch: (Number(current.libraryEpoch) || 1) + 1,
    updatedAt: new Date().toISOString(),
  };
  delete next.inspirationTombstones;
  delete next.libraryRecovery;
  delete next.storage;
  delete next.libraryOpen;
  delete next.revision;
  return { next, deleteIds, fingerprints: Array.from(new Set(fingerprints.filter(Boolean))) };
}

async function legacyBackups(libraryDir) {
  const candidates = [];
  for (const directory of [libraryDir, path.join(libraryDir, "metadata", "index-backups")]) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith("library.json") || !entry.name.endsWith(".bak")) continue;
      candidates.push(path.join(directory, entry.name));
    }
  }
  return candidates;
}

async function writeAtomic(filePath, text) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, text, { encoding: "utf8", flag: "wx" });
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function verifyNoFingerprint(libraryDir, fingerprints) {
  const violations = [];
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const relative = path.relative(libraryDir, target).split(path.sep).join("/");
        if (
          relative === "assets"
          || relative === "exports"
          || relative === "trash"
          || relative.startsWith("metadata/auth-browser")
          || /(?:^|\/)media(?:\/|$)/.test(relative)
        ) continue;
        await walk(target);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(target).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!stat) continue;
      if (stat.size > 16 * 1024 * 1024) continue;
      const text = await fs.readFile(target, "utf8").catch(() => "");
      const matches = fingerprints.filter((needle) => text.includes(needle));
      if (matches.length) violations.push({ file: target, matches });
    }
  }
  await walk(libraryDir);
  return violations;
}

async function main() {
  const libraryArg = argument("--library");
  const expectedHash = argument("--expected-sha256");
  const dryRun = process.argv.includes("--dry-run");
  const confirm = process.argv.includes("--confirm");
  if (!libraryArg || (!dryRun && !confirm) || (dryRun && confirm)) {
    fail("用法：node scripts/reconcile-nas-incident.mjs --library /path/to/Max\ 创作台.library --dry-run|--confirm [--expected-sha256 HASH]");
  }
  const libraryDir = path.resolve(libraryArg);
  if (libraryDir === path.parse(libraryDir).root || !libraryDir.endsWith(".library")) fail("资料库路径无效");
  const indexPath = path.join(libraryDir, "library.json");
  const currentText = await fs.readFile(indexPath, "utf8");
  const currentHash = sha256(currentText);
  if (expectedHash && expectedHash !== currentHash) fail(`library.json 已变化：预期 ${expectedHash}，实际 ${currentHash}`);
  const current = JSON.parse(currentText);
  if (current.libraryKind !== LIBRARY_KIND) fail("资料库类型不匹配");
  const { next, deleteIds, fingerprints } = await buildReconciledLibrary(libraryDir, current);
  const backups = await legacyBackups(libraryDir);
  const report = {
    libraryDir,
    currentHash,
    currentCounts: {
      inspirations: current.inspirations?.length || 0,
      projects: current.projects?.length || 0,
      archive: current.archive?.length || 0,
      contentUnits: current.contentUnits?.length || 0,
      assets: current.assets?.length || 0,
    },
    finalCounts: {
      inspirations: next.inspirations?.length || 0,
      projects: next.projects?.length || 0,
      archive: next.archive?.length || 0,
      contentUnits: next.contentUnits?.length || 0,
      assets: next.assets?.length || 0,
    },
    deleteIds,
    moveToArchive: PUBLISHED_PROJECT_IDS,
    removeLegacyBackupCount: backups.length,
    locations: Object.fromEntries(deleteIds.map((id) => [id, recordLocation(current, id)])),
  };
  if (dryRun) {
    console.log(JSON.stringify({ ...report, dryRun: true }, null, 2));
    return;
  }

  const lease = createLibraryWriteLease();
  const leaseState = await lease.configure(libraryDir);
  if (!leaseState.owned) fail("资料库正被另一台电脑写入，拒绝清理");
  const staged = [];
  let physicalDeletionStarted = false;
  const rollbackPath = path.join(path.dirname(indexPath), `.incident-reconcile-rollback-${process.pid}-${Date.now()}.json`);
  await fs.writeFile(rollbackPath, currentText, { encoding: "utf8", flag: "wx" });
  try {
    for (const contentId of deleteIds) staged.push(await stageContentUnitForDeletion(libraryDir, contentId));
    const nextText = `${JSON.stringify(next, null, 2)}\n`;
    await writeAtomic(indexPath, nextText);
    if (sha256(await fs.readFile(indexPath, "utf8")) !== sha256(nextText)) fail("索引在清理提交后被外部写入，已中止物理删除");
    physicalDeletionStarted = true;
    for (const item of staged) {
      if (item.staged) await fs.rm(item.stagingPath, { recursive: true, force: false });
    }
    await Promise.all(backups.map((filePath) => fs.rm(filePath, { force: false })));
    await purgeSensitiveMetadataFiles(libraryDir, fingerprints);
    const cleanBackup = await createLibraryIndexBackup(libraryDir, `${JSON.stringify(next, null, 2)}\n`, { label: "post-incident-reconcile" });
    const violations = await verifyNoFingerprint(libraryDir, fingerprints);
    if (violations.length) fail(`删除验证失败：${violations.length} 个文件仍包含已删除内容标识`);
    if (sha256(await fs.readFile(indexPath, "utf8")) !== sha256(nextText)) fail("清理后 library.json 被另一客户端覆盖");
    await fs.rm(rollbackPath, { force: false });
    console.log(JSON.stringify({ ...report, dryRun: false, cleanBackup, finalHash: sha256(await fs.readFile(indexPath, "utf8")) }, null, 2));
  } catch (error) {
    if (!physicalDeletionStarted) {
      const rollbackText = await fs.readFile(rollbackPath, "utf8").catch(() => "");
      if (rollbackText) await writeAtomic(indexPath, rollbackText).catch(() => {});
      for (const item of staged.reverse()) await rollbackStagedContentUnit(item).catch(() => {});
    }
    throw error;
  } finally {
    await fs.rm(rollbackPath, { force: true }).catch(() => {});
    await lease.release();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
