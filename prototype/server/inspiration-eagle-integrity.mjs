import fs from "node:fs/promises";
import path from "node:path";

export const INSPIRATION_VIDEO_FOLDER_ID = "MSOSVPR2743KV";

export function inspirationEagleAsset(item = {}) {
  const assets = Array.isArray(item.mediaAssets) ? item.mediaAssets : [];
  return assets.find((asset) => (
    asset?.eagleItemId
    && ["captured_video", "inspiration_video"].includes(String(asset.role || "captured_video"))
  )) || (item.eagleItemId ? item : null);
}

export function isDefinitiveEagleMissingError(error) {
  return error?.statusCode === 404
    || error?.code === "EAGLE_ITEM_MISSING"
    || /File does not exist|file does not exist|Eagle 文件不可用\/重新关联/i.test(String(error?.message || ""));
}

export function eagleItemBelongsToFolder(item = {}, folderId = INSPIRATION_VIDEO_FOLDER_ID) {
  return Boolean(
    item?.id
    && !item.isDeleted
    && Array.isArray(item.folders)
    && item.folders.includes(folderId),
  );
}

function libraryRelativeVideoPath(item = {}) {
  const asset = (Array.isArray(item.mediaAssets) ? item.mediaAssets : []).find((candidate) => (
    ["captured_video", "inspiration_video"].includes(String(candidate?.role || ""))
    && (candidate?.relativePath || candidate?.localPath || String(candidate?.src || "").startsWith("/library-assets/"))
  ));
  const value = String(
    asset?.relativePath
      || asset?.localPath
      || asset?.src
      || item.videoLocalPath
      || "",
  );
  return value.replace(/^\/library-assets\//, "").replace(/^\/+/, "");
}

async function readableLocalVideo(item, libraryDir) {
  const relativePath = libraryRelativeVideoPath(item);
  if (!relativePath || !libraryDir) return null;
  const root = path.resolve(libraryDir);
  const target = path.resolve(root, relativePath);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) return null;
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 64 * 1024) return null;
    await fs.access(target);
    return { path: target, size: stat.size };
  } catch {
    return null;
  }
}

export async function auditInspirationVideo(item = {}, options = {}) {
  const isVideo = item.contentType === "video"
    || Boolean(item.eagleItemId)
    || (Array.isArray(item.mediaAssets) && item.mediaAssets.some((asset) => (
      ["captured_video", "inspiration_video"].includes(String(asset?.role || ""))
    )));
  if (!isVideo) return { state: "not_video", contentId: item.id || "" };

  const local = await readableLocalVideo(item, options.libraryDir);
  const asset = inspirationEagleAsset(item);
  if (!asset?.eagleItemId) {
    return local
      ? { state: "local_only", contentId: item.id || "", local }
      : { state: "missing", contentId: item.id || "", reason: "no_eagle_or_local_video" };
  }

  if (options.eagleItemInfoFromLibrary) {
    try {
      const localEagleItem = await options.eagleItemInfoFromLibrary(asset.eagleItemId);
      if (!eagleItemBelongsToFolder(localEagleItem, options.folderId || INSPIRATION_VIDEO_FOLDER_ID)) {
        return { state: "wrong_folder", contentId: item.id || "", eagleItem: localEagleItem };
      }
      if (Number(localEagleItem.size) <= 64 * 1024) {
        return { state: "invalid_eagle_file", contentId: item.id || "", eagleItem: localEagleItem };
      }
      if (options.resolveEagleOriginalPath) {
        const resolved = await options.resolveEagleOriginalPath(localEagleItem);
        if (!resolved?.stat?.isFile?.() || resolved.stat.size !== Number(localEagleItem.size)) {
          return { state: "invalid_eagle_file", contentId: item.id || "", eagleItem: localEagleItem };
        }
      }
      return { state: "available", contentId: item.id || "", eagleItem: localEagleItem, source: "library" };
    } catch {
      // A locally mounted Eagle Library can be briefly unavailable. Fall through
      // to the Eagle API so a local lookup failure can never delete a card.
    }
  }

  try {
    const eagleItem = await options.eagleItemInfo(asset.eagleItemId);
    if (!eagleItemBelongsToFolder(eagleItem, options.folderId || INSPIRATION_VIDEO_FOLDER_ID)) {
      return { state: "wrong_folder", contentId: item.id || "", eagleItem };
    }
    if (Number(eagleItem.size) <= 64 * 1024) {
      return { state: "invalid_eagle_file", contentId: item.id || "", eagleItem };
    }
    if (options.resolveEagleOriginalPath) {
      try {
        const resolved = await options.resolveEagleOriginalPath(eagleItem);
        if (!resolved?.stat?.isFile?.() || resolved.stat.size !== Number(eagleItem.size)) {
          return { state: "invalid_eagle_file", contentId: item.id || "", eagleItem };
        }
      } catch (error) {
        return { state: "unknown", contentId: item.id || "", error };
      }
    }
    return { state: "available", contentId: item.id || "", eagleItem };
  } catch (error) {
    if (isDefinitiveEagleMissingError(error)) {
      return local
        ? { state: "local_only", contentId: item.id || "", local, error }
        : { state: "missing", contentId: item.id || "", reason: "eagle_item_missing", error };
    }
    return { state: "unknown", contentId: item.id || "", error };
  }
}

export async function findDefinitivelyMissingInspirationVideos(items = [], options = {}) {
  const candidates = items.filter((item) => (
    item?.contentType === "video"
    || item?.eagleItemId
    || item?.mediaAssets?.some?.((asset) => ["captured_video", "inspiration_video"].includes(String(asset?.role || "")))
  ));
  const missing = [];
  const concurrency = Math.max(1, Math.min(12, Number(options.concurrency) || 6));
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const index = cursor;
      cursor += 1;
      const item = candidates[index];
      const result = await auditInspirationVideo(item, options);
      if (result.state === "missing") missing.push({ item, result });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length || 1) }, () => worker()));
  return missing.sort((left, right) => String(left.item.id).localeCompare(String(right.item.id)));
}
