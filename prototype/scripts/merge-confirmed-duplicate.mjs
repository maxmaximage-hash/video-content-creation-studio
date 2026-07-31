#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { withContentModelV2 } from "../server/content-model-v2.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const libraryDir = path.resolve(argument("--library") || "");
const keepId = argument("--keep");
const removeId = argument("--remove");
const confirm = process.argv.includes("--confirm");

if (!libraryDir || !keepId || !removeId || !confirm) {
  console.error("用法：node prototype/scripts/merge-confirmed-duplicate.mjs --library /path/to/库.library --keep I000024 --remove I000018 --confirm");
  process.exit(2);
}

const indexPath = path.join(libraryDir, "library.json");
const removeUnitPath = path.join(libraryDir, "content-units", removeId);
const keepUnitPath = path.join(libraryDir, "content-units", keepId);
const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, "utf8"));
const sha256 = async (filePath) => {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
};

const current = await readJson(indexPath);
const indexedItems = [
  ...(current.inspirations || []),
  ...(current.projects || []),
  ...(current.archive || []),
  current.activeProject,
].filter(Boolean);
const keepItem = indexedItems.find((item) => item.id === keepId);
if (!keepItem) throw new Error(`保留目标 ${keepId} 不在当前资料库索引中`);
if (indexedItems.some((item) => item.id === removeId)) throw new Error(`删除目标 ${removeId} 仍在索引中，拒绝隐式覆盖`);
const [keepManifest, removeManifest] = await Promise.all([
  readJson(path.join(keepUnitPath, "manifest.json")),
  readJson(path.join(removeUnitPath, "manifest.json")),
]);
const keepUrl = String(keepManifest.source?.originalUrl || "");
const removeUrl = String(removeManifest.source?.originalUrl || "");
const extractXhsId = (value) => value.match(/(?:item|explore)\/([0-9a-f]{20,})/i)?.[1] || "";
const keepSourceId = extractXhsId(keepUrl);
const removeSourceId = extractXhsId(removeUrl);
if (!keepSourceId || keepSourceId !== removeSourceId) {
  throw new Error(`两个内容单元的来源 ID 不一致：${keepSourceId || "空"} / ${removeSourceId || "空"}`);
}
const keepImages = (keepManifest.mediaAssets || []).filter((asset) => asset.role === "content_image").sort((a, b) => Number(a.order) - Number(b.order));
const removeImages = (removeManifest.mediaAssets || []).filter((asset) => asset.role === "content_image").sort((a, b) => Number(a.order) - Number(b.order));
if (keepImages.length !== removeImages.length || keepImages.length === 0) {
  throw new Error(`图片数量不一致或为空：${keepImages.length} / ${removeImages.length}`);
}
for (let index = 0; index < keepImages.length; index += 1) {
  const keepPath = path.join(libraryDir, keepImages[index].relativePath);
  const removePath = path.join(libraryDir, removeImages[index].relativePath);
  if (await sha256(keepPath) !== await sha256(removePath)) {
    throw new Error(`第 ${index + 1} 张图片哈希不一致，拒绝合并`);
  }
}

const replaceReference = (value) => {
  if (typeof value === "string") return value === removeId ? keepId : value;
  if (!value || typeof value !== "object") return value;
  return value.id === removeId ? { ...value, id: keepId } : value;
};
const dedupeReferences = (values) => {
  const seen = new Set();
  return values
    .map(replaceReference)
    .filter((value) => {
      const id = typeof value === "string" ? value : value?.id;
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
};
const rewriteItem = (item) => {
  if (!item || typeof item !== "object") return item;
  const next = { ...item };
  if (Array.isArray(item.references)) next.references = dedupeReferences(item.references);
  if (Array.isArray(item.relationships?.referenceContentIds)) {
    next.relationships = {
      ...item.relationships,
      referenceContentIds: dedupeReferences(item.relationships.referenceContentIds),
    };
  }
  return next;
};
const nextLibrary = withContentModelV2({
  ...current,
  inspirations: (current.inspirations || []).map(rewriteItem),
  projects: (current.projects || []).map(rewriteItem),
  archive: (current.archive || []).map(rewriteItem),
  activeProject: rewriteItem(current.activeProject),
});
nextLibrary.inspirations = nextLibrary.inspirations.filter((item) => item.id !== removeId);

const now = new Date().toISOString().replaceAll(":", "-");
const backupPath = `${indexPath}.pre-duplicate-merge-${Date.now()}.bak`;
const trashRoot = path.join(libraryDir, "trash", "migration", now);
const stagedRemovePath = path.join(trashRoot, removeId);
const manifestPaths = [];
const unitRoot = path.join(libraryDir, "content-units");
for (const entry of await fs.readdir(unitRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = path.join(unitRoot, entry.name, "manifest.json");
  try {
    const manifest = await readJson(manifestPath);
    if (JSON.stringify(manifest).includes(removeId)) manifestPaths.push({ manifestPath, manifest });
  } catch {}
}

await fs.copyFile(indexPath, backupPath);
await fs.mkdir(trashRoot, { recursive: true });
const manifestBackups = [];
try {
  for (const { manifestPath, manifest } of manifestPaths) {
    const rewritten = JSON.parse(JSON.stringify(manifest).replaceAll(removeId, keepId));
    const manifestBackup = `${manifestPath}.pre-duplicate-merge-${Date.now()}.bak`;
    await fs.copyFile(manifestPath, manifestBackup);
    manifestBackups.push({ manifestPath, manifestBackup });
    await fs.writeFile(manifestPath, `${JSON.stringify(rewritten, null, 2)}\n`, "utf8");
  }
  await fs.rename(removeUnitPath, stagedRemovePath);
  const temporaryPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(nextLibrary, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, indexPath);
  console.log(JSON.stringify({
    mode: "applied",
    keepId,
    removedId: removeId,
    sourceId: keepSourceId,
    backupPath,
    stagedRemovePath,
    rewrittenManifests: manifestPaths.map(({ manifestPath }) => manifestPath),
  }, null, 2));
} catch (error) {
  await fs.rm(stagedRemovePath, { recursive: true, force: true }).catch(() => {});
  for (const { manifestPath, manifestBackup } of manifestBackups) {
    await fs.copyFile(manifestBackup, manifestPath).catch(() => {});
  }
  await fs.copyFile(backupPath, indexPath).catch(() => {});
  throw error;
}
