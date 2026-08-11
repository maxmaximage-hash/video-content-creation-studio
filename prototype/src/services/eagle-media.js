export function eagleItemIdFrom(item = {}) {
  if (item?.eagleItemId) return String(item.eagleItemId);
  if (Array.isArray(item?.mediaAssets)) {
    const eagleAsset = item.mediaAssets.find((asset) => asset?.eagleItemId);
    return eagleAsset?.eagleItemId ? String(eagleAsset.eagleItemId) : "";
  }
  return "";
}

export function eagleFolderIdFrom(item = {}) {
  if (item?.eagleFolderId) return String(item.eagleFolderId);
  if (Array.isArray(item?.mediaAssets)) {
    const eagleAsset = item.mediaAssets.find((asset) => asset?.eagleItemId);
    return eagleAsset?.eagleFolderId ? String(eagleAsset.eagleFolderId) : "";
  }
  return "";
}

export function eagleMediaSource(item = {}) {
  const itemId = eagleItemIdFrom(item);
  if (!itemId) return "";
  const query = new URLSearchParams();
  const folderId = eagleFolderIdFrom(item);
  if (folderId) query.set("folderId", folderId);
  return `/api/eagle-media/${encodeURIComponent(itemId)}${query.size ? `?${query}` : ""}`;
}

export async function fetchEagleAnnotation(itemId) {
  const response = await fetch(`/api/eagle-items/${encodeURIComponent(itemId)}/annotation`);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "文案暂不可读取");
  return result.annotation || "";
}

export async function saveEagleAnnotation({ itemId, annotation, sessionId = "" }) {
  const response = await fetch(`/api/eagle-items/${encodeURIComponent(itemId)}/annotation`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-library-session-id": sessionId,
    },
    body: JSON.stringify({ annotation }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "文案暂不可保存");
  return result.annotation || "";
}
