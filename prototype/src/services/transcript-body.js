export function transcriptTargetEagleItemId(item = {}) {
  if (item?.eagleItemId) return String(item.eagleItemId);
  const asset = Array.isArray(item?.mediaAssets)
    ? item.mediaAssets.find((candidate) => candidate?.eagleItemId)
    : null;
  return asset?.eagleItemId ? String(asset.eagleItemId) : "";
}

export function transcriptBodyPatch(item = {}, transcript = "", sha256 = "") {
  const text = String(transcript || "").trim();
  if (!text) return {};
  const eagleItemId = transcriptTargetEagleItemId(item);
  if (!eagleItemId) {
    return {
      body: text,
      captionStorage: "library_body",
      captionLength: text.length,
      captionSha256: sha256,
    };
  }
  return {
    body: "",
    captionStorage: "eagle_annotation",
    captionEagleItemId: eagleItemId,
    captionLength: text.length,
    captionSha256: sha256,
  };
}
