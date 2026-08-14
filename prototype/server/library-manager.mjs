import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isPathInside } from "./path-security.mjs";
import { withContentModelV2 } from "./content-model-v2.mjs";
import { createLibraryWriteLease } from "./library-lock.mjs";
import { createLibraryIndexBackup } from "./library-backups.mjs";

export const LIBRARY_KIND = "video-content-creation-demo";
export const DEFAULT_LIBRARY_NAME = "视频内容创作中台 Demo.library";
export const LIBRARY_FOLDERS = ["content-units", "assets/originals", "assets/covers", "assets/videos", "exports", "metadata", "trash"];

function libraryError(message, statusCode = 400, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

function normalizedLibraryName(value) {
  const name = String(value || "").trim();
  if (!name) throw libraryError("资料库名称不能为空");
  if (name === "." || name === ".." || /[\\/:]/.test(name)) throw libraryError("资料库名称不能包含路径分隔符");
  return name.endsWith(".library") ? name : `${name}.library`;
}

function pathsFor(libraryDir) {
  const resolved = path.resolve(libraryDir);
  return {
    root: path.dirname(resolved),
    libraryDir: resolved,
    libraryName: path.basename(resolved),
    indexFile: path.join(resolved, "library.json"),
  };
}

function emptyLibrary(libraryName) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    libraryRevision: 1,
    libraryEpoch: 1,
    libraryKind: LIBRARY_KIND,
    libraryName,
    createdAt: now,
    updatedAt: now,
    categories: [],
    inspirations: [],
    projects: [],
    archive: [],
    activeProject: null,
    contentIdCounters: { I: 0, C: 0 },
    assets: [],
    contentUnits: [],
    assetLinks: [],
    contentRelations: [],
    contentRevisions: [],
    metricsSnapshots: [],
    duplicateGroups: [],
    captureBatches: [],
  };
}

function parseLibraryData(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < raw.length; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") inString = true;
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = raw.slice(0, index + 1);
          const data = JSON.parse(candidate);
          data.libraryRepair = {
            repairedAt: new Date().toISOString(),
            reason: error.message,
            originalBytes: raw.length,
            recoveredBytes: candidate.length,
          };
          return data;
        }
      }
    }
    throw error;
  }
}

function persistedShape(data = {}) {
  return {
    categories: Array.isArray(data.categories) ? data.categories : [],
    userDefinedCategories: Array.isArray(data.userDefinedCategories) ? data.userDefinedCategories : undefined,
    inspirations: Array.isArray(data.inspirations) ? data.inspirations : [],
    projects: Array.isArray(data.projects) ? data.projects : [],
    archive: Array.isArray(data.archive) ? data.archive : [],
    activeProject: data.activeProject || null,
    contentIdCounters: {
      I: Number(data.contentIdCounters?.I) || 0,
      C: Number(data.contentIdCounters?.C) || 0,
    },
    assets: Array.isArray(data.assets) ? data.assets : [],
    contentUnits: Array.isArray(data.contentUnits) ? data.contentUnits : [],
    assetLinks: Array.isArray(data.assetLinks) ? data.assetLinks : [],
    contentRelations: Array.isArray(data.contentRelations) ? data.contentRelations : [],
    contentRevisions: Array.isArray(data.contentRevisions) ? data.contentRevisions : [],
    metricsSnapshots: Array.isArray(data.metricsSnapshots) ? data.metricsSnapshots : [],
    duplicateGroups: Array.isArray(data.duplicateGroups) ? data.duplicateGroups : [],
    captureBatches: Array.isArray(data.captureBatches) ? data.captureBatches : [],
    libraryRevision: Number(data.libraryRevision) || 1,
    libraryEpoch: Number(data.libraryEpoch) || 1,
  };
}

function persistedCount(data = {}) {
  return ["inspirations", "projects", "archive"].reduce((total, key) => total + (Array.isArray(data[key]) ? data[key].length : 0), 0);
}

function isEmptyReplacement(payload = {}) {
  return ["inspirations", "projects", "archive"].every((key) => Array.isArray(payload[key]) && payload[key].length === 0)
    && !payload.activeProject;
}

function assertSafeReplacement(current = {}, next = {}) {
  const currentCount = persistedCount(current);
  const nextCount = persistedCount(next);
  if (currentCount > 0 && nextCount === 0 && !next.activeProject) {
    throw libraryError("非空资料库禁止被空数据覆盖；如需清理必须逐条走安全删除", 409, {
      code: "LIBRARY_EMPTY_REPLACEMENT_BLOCKED",
    });
  }
  const drop = currentCount - nextCount;
  if (currentCount >= 10 && drop >= 5 && drop / currentCount >= 0.5) {
    throw libraryError("本次写入将使资料库记录数异常骤降，已阻止保存", 409, {
      code: "LIBRARY_SUSPICIOUS_SHRINK_BLOCKED",
      previousCount: currentCount,
      nextCount,
    });
  }
}

function safeContentId(value) {
  const id = String(value || "").trim();
  if (!/^[IC][A-Za-z0-9._-]*$/.test(id)) throw libraryError("内容 ID 无效");
  return id;
}

function relativePathFromAsset(asset) {
  if (asset?.relativePath) return String(asset.relativePath).replace(/^\/+/, "");
  const src = String(asset?.src || "");
  return src.startsWith("/library-assets/") ? src.slice("/library-assets/".length) : "";
}

function canonicalMediaAssets(item = {}) {
  if (Array.isArray(item.mediaAssets) && item.mediaAssets.length) {
    let finishedOrder = 0;
    return item.mediaAssets.map((asset, index) => {
      const role = ({
        original: "source_video",
        raw: "source_video",
        refined: "finished_video",
        final: "finished_video",
        refined_video: "finished_video",
        finished: "finished_video",
      })[asset.role] || asset.role || "captured_video";
      const accountRole = ["blogger", "ip"].includes(String(asset.accountRole || "").toLowerCase())
        ? String(asset.accountRole).toLowerCase()
        : "";
      const order = ["source_video", "finished_video"].includes(role) && accountRole
        ? (accountRole === "ip" ? 2 : 1)
        : role === "finished_video"
        ? Number(asset.order) || Number(asset.version) || ++finishedOrder
        : Number(asset.order) || index + 1;
      if (role === "finished_video") finishedOrder = Math.max(finishedOrder, order);
      const normalized = {
        ...asset,
        role,
        order,
        relativePath: relativePathFromAsset(asset),
      };
      if (accountRole) normalized.accountRole = accountRole;
      else delete normalized.accountRole;
      return normalized;
    });
  }
  const contentImages = (item.images || []).map((asset, index) => ({
    ...asset,
    id: asset.id || `${item.id}-image-${index + 1}`,
    role: "content_image",
    order: index + 1,
    version: 1,
    relativePath: relativePathFromAsset({ ...asset, src: asset.localPath || asset.src }),
  }));
  const capturedVideo = item.videoLocalPath
    ? [{
        id: `${item.id}-captured-video`,
        role: "captured_video",
        version: 1,
        name: item.videoName || "",
        src: item.videoLocalPath,
        relativePath: relativePathFromAsset({ src: item.videoLocalPath }),
      }]
    : [];
  const original = item.rawMaterial?.src ? [{ ...item.rawMaterial, role: "source_video", version: 1 }] : [];
  const legacyRefined = Array.isArray(item.finishedVideos) && item.finishedVideos.length
    ? item.finishedVideos
    : (Array.isArray(item.finalVideos) && item.finalVideos.length
      ? item.finalVideos
      : (item.finalVideo?.src ? [item.finalVideo] : []));
  return [
    ...contentImages,
    ...capturedVideo,
    ...original,
    ...legacyRefined.map((asset, index) => ({
      ...asset,
      role: "finished_video",
      order: Number(asset.order) || Number(asset.version) || index + 1,
    })),
  ].map((asset) => ({ ...asset, relativePath: relativePathFromAsset(asset) }));
}

function canonicalReferenceContentIds(item = {}) {
  const candidates = [
    ...(Array.isArray(item.relationships?.referenceContentIds)
      ? item.relationships.referenceContentIds
      : []),
    ...(Array.isArray(item.references) ? item.references : []),
  ];
  return Array.from(new Set(candidates
    .map((reference) => (typeof reference === "string" ? reference : reference?.id))
    .map((contentId) => String(contentId || "").trim())
    .filter(Boolean)));
}

function usesContentUnit(item = {}) {
  if (!item?.id || !/^[IC]/.test(String(item.id))) return false;
  if (Number(item.unitSchemaVersion || item.contentUnitVersion) >= 1) return true;
  if (Array.isArray(item.mediaAssets) && item.mediaAssets.length) return true;
  return [...(item.covers || []), ...(item.images || [])]
    .some((asset) => relativePathFromAsset(asset).startsWith(`content-units/${item.id}/`));
}

async function writeAtomicText(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, value, { encoding: "utf8", flag: "wx" });
  await fs.rename(temporaryPath, filePath);
}

async function ensureSafeContentDirectory(libraryRoot, relativeDirectory) {
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
    if (existing.isSymbolicLink()) throw libraryError("内容单元写入路径不能经过符号链接", 403);
    if (!existing.isDirectory()) throw libraryError("内容单元写入路径不是目录", 409);
  }
  const realDirectory = await fs.realpath(currentPath);
  if (!isPathInside(libraryRoot, realDirectory, { allowRoot: true })) throw libraryError("内容单元写入路径不在当前资料库内", 403);
  return realDirectory;
}

function contentUnitItems(data) {
  const units = new Map();
  for (const item of [
    ...(data.inspirations || []),
    ...(data.archive || []),
    ...(data.projects || []),
    data.activeProject,
  ].filter(Boolean)) {
    if (usesContentUnit(item)) units.set(item.id, item);
  }
  return [...units.values()];
}

async function syncContentUnitItems(paths, items) {
  const units = new Map();
  for (const item of (items || []).filter(Boolean)) {
    if (usesContentUnit(item)) units.set(item.id, item);
  }
  const libraryRoot = await fs.realpath(paths.libraryDir);
  for (const item of units.values()) {
    const contentId = safeContentId(item.id);
    const unitRelativeRoot = `content-units/${contentId}`;
    const unitRoot = await ensureSafeContentDirectory(libraryRoot, unitRelativeRoot);
    for (const folder of ["copy", "covers", "media/images", "media/captured-video", "media/source-video", "media/finished-video", "media/refined-video", "exports"]) {
      await ensureSafeContentDirectory(libraryRoot, `${unitRelativeRoot}/${folder}`);
    }
    const covers = (item.covers || []).map((cover) => ({
      id: cover.id || "",
      name: cover.name || "",
      relativePath: relativePathFromAsset(cover),
      contentType: cover.contentType || "",
      size: Number(cover.size) || 0,
      addedAt: cover.addedAt || "",
    }));
    const manifest = {
      schemaVersion: 1,
      contentId,
      origin: item.origin || (contentId.startsWith("I") ? "captured" : "original"),
      contentType: item.contentType || (item.images?.length ? "image_set" : (item.videoLocalPath || canonicalMediaAssets(item).some((asset) => asset.role.endsWith("_video")) ? "video" : "text")),
      title: item.title || "",
      body: item.body || "",
      transcript: item.transcript || "",
      transcriptSource: item.transcriptSource || "",
      transcriptState: item.transcriptState || "",
      transcriptStatus: item.transcriptStatus || "",
      category: item.category || "",
      source: {
        platform: item.source?.platform || item.platform || "",
        originalUrl: item.source?.originalUrl || item.originalUrl || "",
        canonicalSourceKey: item.source?.canonicalSourceKey || item.canonicalSourceKey || "",
        platformItemId: item.source?.platformItemId || item.platformItemId || "",
        accountId: item.source?.accountId || item.authorId || "",
        accountUrl: item.source?.accountUrl || item.authorUrl || "",
        accountName: item.source?.accountName || item.author || "",
        publishedAt: item.source?.publishedAt || item.publishedAt || "",
      },
      metricsSnapshots: Array.isArray(item.metricsSnapshots) && item.metricsSnapshots.length
        ? item.metricsSnapshots
        : (item.stats ? [{ capturedAt: item.capturedAt || item.updatedAt || "", ...item.stats }] : []),
      mediaAssets: canonicalMediaAssets(item),
      presentation: {
        primaryCoverAssetId: null,
        covers,
      },
      workflow: {
        stage: item.workflow?.stage || (contentId.startsWith("I") ? "inspiration" : (item.publishedAt ? "published" : "creating")),
        creationStatus: item.workflow?.creationStatus || item.creationStatus || null,
        completedAt: item.workflow?.completedAt || item.completedAt || null,
      },
      relationships: {
        referenceContentIds: canonicalReferenceContentIds(item),
      },
      updatedAt: new Date().toISOString(),
    };
    await Promise.all([
      writeAtomicText(path.join(unitRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
      writeAtomicText(path.join(unitRoot, "copy/title.txt"), `${item.title || ""}\n`),
      writeAtomicText(path.join(unitRoot, "copy/body.txt"), `${item.body || ""}\n`),
      writeAtomicText(path.join(unitRoot, "copy/transcript.txt"), `${item.transcript || ""}\n`),
    ]);
  }
}

async function syncContentUnits(paths, data) {
  await syncContentUnitItems(paths, contentUnitItems(data));
}

export function createLibraryManager(options = {}) {
  const allowImplicitCreate = options.allowImplicitCreate === true;
  const qaMode = options.qaMode === true || process.env.VIDEO_STUDIO_QA_MODE === "1";
  const configuredLibraryRoot = String(process.env.VIDEO_CONTENT_LIBRARY_ROOT || "").trim();
  const configuredInitialLibraryDir = options.initialLibraryDir === undefined
    ? (configuredLibraryRoot ? path.join(configuredLibraryRoot, DEFAULT_LIBRARY_NAME) : null)
    : options.initialLibraryDir;
  const initialLibraryDir = configuredInitialLibraryDir === null
    ? null
    : path.resolve(configuredInitialLibraryDir);
  let activePaths = initialLibraryDir ? pathsFor(initialLibraryDir) : null;
  let sessionId = randomUUID();
  let writeQueue = Promise.resolve();
  let revision = 1;
  let leaseLibraryDir = "";
  const writeLease = qaMode
    ? {
        state: () => ({ owned: true, mode: "read_write", owner: null }),
        configure: async () => ({ owned: true, mode: "read_write", owner: null }),
        ensureOwned: async () => ({ owned: true, mode: "read_write", owner: null }),
        release: async () => {},
      }
    : createLibraryWriteLease(options.writeLease || {});

  function storage() {
    return activePaths ? { ...activePaths, sessionId, ...writeLease.state() } : null;
  }

  function requireActive(expectedSessionId = "") {
    if (!activePaths) throw libraryError("当前没有打开资料库", 409);
    if (expectedSessionId && expectedSessionId !== sessionId) throw libraryError("资料库已经切换，请刷新后重试", 409);
    return { ...activePaths, sessionId };
  }

  async function requireWritable(expectedSessionId = "") {
    const paths = requireActive(expectedSessionId);
    await ensureCurrentLibrary();
    return { ...paths, sessionId, ...writeLease.state() };
  }

  async function ensureFolders(paths) {
    await fs.mkdir(paths.libraryDir, { recursive: true });
    await Promise.all(LIBRARY_FOLDERS.map((folder) => fs.mkdir(path.join(paths.libraryDir, folder), { recursive: true })));
  }

  async function ensureLeaseConfigured(paths) {
    if (leaseLibraryDir === paths.libraryDir) return writeLease.state();
    const state = await writeLease.configure(paths.libraryDir);
    leaseLibraryDir = paths.libraryDir;
    return state;
  }

  async function ensureWriteLease(paths) {
    await ensureLeaseConfigured(paths);
    return writeLease.ensureOwned();
  }

  async function releaseWriteLease() {
    await writeLease.release();
    leaseLibraryDir = "";
  }

  async function ensureCurrentLibrary() {
    const paths = requireActive();
    try {
      const directoryStat = await fs.stat(paths.libraryDir);
      if (!directoryStat.isDirectory()) throw libraryError("资料库路径不是目录", 503, { code: "LIBRARY_UNAVAILABLE" });
      const indexStat = await fs.stat(paths.indexFile);
      if (!indexStat.isFile()) throw libraryError("资料库索引不是文件", 503, { code: "LIBRARY_INDEX_UNAVAILABLE" });
    } catch (error) {
      if (allowImplicitCreate && error.code === "ENOENT") {
        await ensureFolders(paths);
        await fs.writeFile(paths.indexFile, `${JSON.stringify(emptyLibrary(paths.libraryName), null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
      } else {
        if (["LIBRARY_UNAVAILABLE", "LIBRARY_INDEX_UNAVAILABLE"].includes(error.code)) throw error;
        throw libraryError("资料库索引暂时不可用，已保护现有素材；请检查 NAS 挂载和资料库路径", 503, {
          code: "LIBRARY_INDEX_UNAVAILABLE",
          cause: error.code || "INDEX_READ_FAILED",
        });
      }
    }
    await ensureLeaseConfigured(paths);
    return paths;
  }

  async function cleanupTempFiles(paths) {
    const entries = await fs.readdir(paths.libraryDir);
    await Promise.all(entries
      .filter((entry) => entry.startsWith("library.json.") && entry.endsWith(".tmp"))
      .map((entry) => fs.rm(path.join(paths.libraryDir, entry), { force: true }).catch(() => {})));
    await fs.rm(`${paths.indexFile}.tmp`, { force: true }).catch(() => {});
  }

  async function validateLibraryDir(inputPath) {
    const selected = pathsFor(inputPath);
    if (!selected.libraryName.endsWith(".library")) throw libraryError("请选择以 .library 结尾的资料库目录");
    let stat;
    try {
      stat = await fs.stat(selected.libraryDir);
    } catch (error) {
      throw libraryError("所选资料库目录暂时不可用", 503, { code: "LIBRARY_UNAVAILABLE", cause: error.code || "STAT_FAILED" });
    }
    if (!stat.isDirectory()) throw libraryError("所选资料库路径不是目录");
    let raw;
    try {
      raw = await fs.readFile(selected.indexFile, "utf8");
    } catch (error) {
      throw libraryError("所选资料库的 library.json 暂时不可读，已禁止创建空索引", 503, {
        code: "LIBRARY_INDEX_UNAVAILABLE",
        cause: error.code || "INDEX_READ_FAILED",
      });
    }
    let data;
    try {
      data = parseLibraryData(raw);
    } catch {
      throw libraryError("library.json 无法读取或格式损坏");
    }
    if (data.libraryKind !== LIBRARY_KIND) throw libraryError("这不是 Video Hub 资料库");
    return { paths: selected, data };
  }

  async function readLibrary() {
    if (!activePaths) return { libraryOpen: false, sessionId, revision };
    const paths = await ensureCurrentLibrary();
    let raw;
    try {
      raw = await fs.readFile(paths.indexFile, "utf8");
    } catch (error) {
      throw libraryError("资料库索引暂时不可读，已进入保护状态", 503, {
        code: "LIBRARY_INDEX_UNAVAILABLE",
        cause: error.code || "INDEX_READ_FAILED",
      });
    }
    let data;
    try {
      data = withContentModelV2(parseLibraryData(raw));
    } catch (error) {
      throw libraryError("library.json 无法解析，已禁止任何覆盖写入", 503, {
        code: "LIBRARY_INDEX_CORRUPT",
        cause: error.code || "INDEX_PARSE_FAILED",
      });
    }
    if (data.libraryKind && data.libraryKind !== LIBRARY_KIND) throw libraryError("当前目录不是 Video Hub 资料库", 409);
    delete data.inspirationTombstones;
    revision = Number(data.libraryRevision) || 1;
    return {
      ...emptyLibrary(paths.libraryName),
      ...data,
      libraryOpen: true,
      storage: storage(),
      revision,
    };
  }

  async function currentRevisionConflict() {
    return libraryError("资料库内容已经更新，请使用最新内容继续操作", 409, {
      code: "LIBRARY_REVISION_CONFLICT",
      library: await readLibrary(),
    });
  }

  async function assertExpectedRevision(expectedRevision, current) {
    if (expectedRevision === "" || expectedRevision === undefined || expectedRevision === null) return;
    const parsed = Number(expectedRevision);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw libraryError("资料库版本号无效", 400);
    const currentRevision = Number(current?.libraryRevision) || revision || 1;
    if (parsed !== currentRevision) throw await currentRevisionConflict();
  }

  function persistedLibrary(paths, current, payload) {
    const now = new Date().toISOString();
    const next = {
      ...current,
      ...payload,
      storage: undefined,
      libraryOpen: undefined,
      sessionId: undefined,
      revision: undefined,
      libraryName: paths.libraryName,
      libraryKind: LIBRARY_KIND,
      schemaVersion: 2,
      libraryRevision: Number(current.libraryRevision) || 1,
      libraryEpoch: Number(current.libraryEpoch) || 1,
      updatedAt: now,
      createdAt: current.createdAt || now,
    };
    delete next.storage;
    delete next.libraryOpen;
    delete next.sessionId;
    delete next.revision;
    delete next.inspirationTombstones;
    return withContentModelV2(next);
  }

  async function writeIndex(paths, next, { label = "write" } = {}) {
    const currentText = await fs.readFile(paths.indexFile, "utf8");
    await createLibraryIndexBackup(paths.libraryDir, currentText, { label });
    const temporaryPath = `${paths.indexFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await fs.rename(temporaryPath, paths.indexFile);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  function runtimeLibrary(next) {
    return { ...next, libraryOpen: true, storage: storage(), revision };
  }

  async function performWriteLibrary(payload, expectedSessionId, expectedRevision) {
    const paths = requireActive(expectedSessionId);
    await ensureWriteLease(paths);
    try {
      const current = await readLibrary();
      await assertExpectedRevision(expectedRevision, current);
      await ensureFolders(paths);
      const next = persistedLibrary(paths, current, payload);
      if (JSON.stringify(persistedShape(current)) !== JSON.stringify(persistedShape(next))) {
        if (!qaMode) assertSafeReplacement(current, next);
        next.libraryRevision = (Number(current.libraryRevision) || 1) + 1;
        await writeIndex(paths, next, { label: "autosave" });
        await syncContentUnits(paths, next);
        await cleanupTempFiles(paths);
        revision = next.libraryRevision;
      } else {
        revision = Number(current.libraryRevision) || 1;
      }
      return runtimeLibrary(next);
    } finally {
      await releaseWriteLease();
    }
  }

  function writeLibrary(payload, expectedSessionId = "", expectedRevision = "") {
    const capturedSessionId = expectedSessionId || sessionId;
    const capturedRevision = expectedRevision;
    writeQueue = writeQueue.then(
      () => performWriteLibrary(payload, capturedSessionId, capturedRevision),
      () => performWriteLibrary(payload, capturedSessionId, capturedRevision),
    );
    return writeQueue;
  }

  async function performMutation(mutator, expectedSessionId, expectedRevision) {
    const paths = requireActive(expectedSessionId);
    await ensureWriteLease(paths);
    let current;
    let mutation;
    let committed = false;
    try {
      current = await readLibrary();
      await assertExpectedRevision(expectedRevision, current);
      await ensureFolders(paths);
      mutation = await mutator({
        current,
        paths,
        revision,
        syncContentUnitItems: (items) => syncContentUnitItems(paths, items),
      });
      const next = persistedLibrary(paths, current, mutation.payload || current);
      if (JSON.stringify(persistedShape(current)) !== JSON.stringify(persistedShape(next))) {
        if (!mutation.allowDestructiveShrink) assertSafeReplacement(current, next);
        if (mutation.syncItems?.length) await syncContentUnitItems(paths, mutation.syncItems);
        next.libraryRevision = (Number(current.libraryRevision) || 1) + 1;
        if (mutation.incrementEpoch) next.libraryEpoch = (Number(current.libraryEpoch) || 1) + 1;
        await writeIndex(paths, next, { label: mutation.backupLabel || "mutation" });
        await cleanupTempFiles(paths);
        revision = next.libraryRevision;
      } else {
        revision = Number(current.libraryRevision) || 1;
      }
      committed = true;
      await mutation.afterCommit?.({ library: runtimeLibrary(next), paths });
      return {
        ...(mutation.result || {}),
        library: runtimeLibrary(next),
      };
    } catch (error) {
      if (!committed) await Promise.resolve(mutation?.rollback?.({ current, paths })).catch(() => {});
      throw error;
    } finally {
      await releaseWriteLease();
    }
  }

  function mutateLibrary(mutator, expectedSessionId = "", expectedRevision = "") {
    const capturedSessionId = expectedSessionId || sessionId;
    const capturedRevision = expectedRevision;
    writeQueue = writeQueue.then(
      () => performMutation(mutator, capturedSessionId, capturedRevision),
      () => performMutation(mutator, capturedSessionId, capturedRevision),
    );
    return writeQueue;
  }

  async function performAllocateContentId(prefix, expectedSessionId, expectedRevision) {
    const normalizedPrefix = String(prefix || "").toUpperCase();
    if (!["I", "C"].includes(normalizedPrefix)) throw libraryError("内容 ID 前缀无效");
    const paths = requireActive(expectedSessionId);
    await ensureWriteLease(paths);
    try {
      const current = await readLibrary();
      await assertExpectedRevision(expectedRevision, current);
      await ensureFolders(paths);
      const indexedItems = [
        ...(current.inspirations || []),
        ...(current.projects || []),
        ...(current.archive || []),
        current.activeProject,
      ].filter(Boolean);
      const unitEntries = await fs.readdir(path.join(paths.libraryDir, "content-units"), { withFileTypes: true });
      const occupiedIds = [
        ...indexedItems.map((item) => String(item.id || "")),
        ...unitEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      ];
      const pattern = new RegExp(`^${normalizedPrefix}(\\d+)$`);
      const occupiedMaximum = occupiedIds.reduce((maximum, id) => {
        const match = id.match(pattern);
        return match ? Math.max(maximum, Number(match[1]) || 0) : maximum;
      }, 0);
      const currentCounter = Number(current.contentIdCounters?.[normalizedPrefix]) || 0;
      const nextNumber = Math.max(currentCounter, occupiedMaximum) + 1;
      const contentId = `${normalizedPrefix}${String(nextNumber).padStart(6, "0")}`;
      const next = {
        ...current,
        contentIdCounters: {
          I: Number(current.contentIdCounters?.I) || 0,
          C: Number(current.contentIdCounters?.C) || 0,
          [normalizedPrefix]: nextNumber,
        },
        storage: undefined,
        libraryOpen: undefined,
        sessionId: undefined,
        revision: undefined,
        updatedAt: new Date().toISOString(),
        libraryRevision: (Number(current.libraryRevision) || 1) + 1,
      };
      await writeIndex(paths, next, { label: "allocate-id" });
      await cleanupTempFiles(paths);
      revision = next.libraryRevision;
      return { contentId, contentIdCounters: next.contentIdCounters, storage: storage(), revision };
    } finally {
      await releaseWriteLease();
    }
  }

  function allocateContentId(prefix, expectedSessionId = "", expectedRevision = "") {
    const capturedSessionId = expectedSessionId || sessionId;
    const capturedRevision = expectedRevision;
    writeQueue = writeQueue.then(
      () => performAllocateContentId(prefix, capturedSessionId, capturedRevision),
      () => performAllocateContentId(prefix, capturedSessionId, capturedRevision),
    );
    return writeQueue;
  }

  async function notifyStateChange() {
    await options.onStateChange?.({ libraryDir: activePaths?.libraryDir || null, closed: !activePaths });
  }

  async function activate(paths) {
    activePaths = paths;
    sessionId = randomUUID();
    revision += 1;
    await ensureCurrentLibrary();
    await notifyStateChange();
    return readLibrary();
  }

  async function manage(action, payload = {}) {
    await writeQueue.catch(() => {});
    if (action === "new") {
      let selectedPath = payload.path;
      if (!selectedPath && !options.chooseLibraryPath) throw libraryError("请在 macOS 桌面应用中使用新建资料库");
      if (!selectedPath) selectedPath = await options.chooseLibraryPath({ action, currentDir: activePaths?.root || "" });
      if (!selectedPath) return { cancelled: true, libraryOpen: Boolean(activePaths), storage: storage() };
      const requestedPath = String(selectedPath).endsWith(".library")
        ? path.resolve(selectedPath)
        : path.resolve(`${selectedPath}.library`);
      const selected = pathsFor(requestedPath);
      const exists = await fs.stat(selected.libraryDir).catch(() => null);
      if (exists) throw libraryError("这个位置已经存在同名资料库", 409);
      await fs.mkdir(selected.libraryDir, { recursive: false });
      try {
        await ensureFolders(selected);
        await fs.writeFile(selected.indexFile, `${JSON.stringify(emptyLibrary(selected.libraryName), null, 2)}\n`, "utf8");
      } catch (error) {
        await fs.rm(selected.libraryDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return activate(selected);
    }
    if (action === "open") {
      let selectedPath = payload.path;
      if (!selectedPath && !options.chooseLibraryPath) throw libraryError("请在 macOS 桌面应用中使用打开资料库");
      if (!selectedPath) selectedPath = await options.chooseLibraryPath({ action, currentDir: activePaths?.root || "" });
      if (!selectedPath) return { cancelled: true, libraryOpen: Boolean(activePaths), storage: storage() };
      const validated = await validateLibraryDir(selectedPath);
      return activate(validated.paths);
    }
    if (action === "close") {
      await writeLease.release();
      leaseLibraryDir = "";
      activePaths = null;
      sessionId = randomUUID();
      revision += 1;
      await notifyStateChange();
      return { libraryOpen: false, sessionId, revision };
    }
    if (action === "rename") {
      const current = requireActive(payload.sessionId || "");
      await ensureWriteLease(current);
      let nextPaths = null;
      let renamed = false;
      try {
        const nextName = normalizedLibraryName(payload.name);
        if (nextName === current.libraryName) return readLibrary();
        nextPaths = pathsFor(path.join(current.root, nextName));
        const collision = await fs.stat(nextPaths.libraryDir).catch(() => null);
        if (collision) throw libraryError("同一位置已经存在这个名称", 409);
        await fs.rename(current.libraryDir, nextPaths.libraryDir);
        renamed = true;
        await releaseWriteLease();
        activePaths = nextPaths;
        sessionId = randomUUID();
        revision += 1;
        const data = await readLibrary();
        const persisted = { ...data, storage: undefined, libraryOpen: undefined, sessionId: undefined, revision: undefined, libraryName: nextName, updatedAt: new Date().toISOString() };
        await ensureWriteLease(nextPaths);
        persisted.libraryRevision = (Number(persisted.libraryRevision) || 1) + 1;
        await writeIndex(nextPaths, persisted, { label: "rename" });
        revision = persisted.libraryRevision;
        await notifyStateChange();
        return readLibrary();
      } catch (error) {
        await releaseWriteLease().catch(() => {});
        if (renamed && nextPaths) {
          await fs.rename(nextPaths.libraryDir, current.libraryDir).catch(() => {});
          activePaths = current;
          sessionId = randomUUID();
          revision += 1;
        }
        throw error;
      } finally {
        await releaseWriteLease();
      }
    }
    throw libraryError("未知的资料库操作");
  }

  return {
    storage,
    requireActive,
    requireWritable,
    ensureCurrentLibrary,
    readLibrary,
    writeLibrary,
    mutateLibrary,
    allocateContentId,
    manage,
    validateLibraryDir,
    async dispose() {
      await writeQueue.catch(() => {});
      await writeLease.release();
      leaseLibraryDir = "";
    },
  };
}
