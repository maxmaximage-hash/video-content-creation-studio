export const EAGLE_ASSET_FOLDERS = Object.freeze({
  blogger: Object.freeze({
    cover: "MS8R943CBJV6L",
    photo: "MS8R943CBJV6L",
    source_video: "MSOSLZLAY5RGP",
    source_material: "MSOSLZLAY5RGP",
    finished_video: "MS8R943CBJV6L",
  }),
  ip: Object.freeze({
    cover: "MSHM7I3KNXBML",
    photo: "MSHM7I3KNXBML",
    source_video: "MSOSM8ESCD2D0",
    source_material: "MSOSM8ESCD2D0",
    finished_video: "MSHM7I3KNXBML",
  }),
  inspiration_video: "MSOSVPR2743KV",
});

const ASSET_ROLE_ALIASES = Object.freeze({
  cover: "cover",
  photo: "cover",
  image: "cover",
  raw: "source_video",
  original: "source_video",
  source: "source_video",
  source_video: "source_video",
  source_material: "source_video",
  original_material: "source_video",
  finished: "finished_video",
  final: "finished_video",
  refined: "finished_video",
  refined_video: "finished_video",
  finished_video: "finished_video",
  inspiration: "inspiration_video",
  inspiration_video: "inspiration_video",
});

export function normalizeEagleAssetRole(value = "") {
  const role = String(value || "").trim().toLowerCase();
  return ASSET_ROLE_ALIASES[role] || role;
}

export function normalizeEagleAccountRole(value = "") {
  const role = String(value || "").trim().toLowerCase();
  return ["blogger", "ip"].includes(role) ? role : "";
}

export function eagleFolderIdForAsset({ accountRole = "", assetRole = "" } = {}) {
  const normalizedAssetRole = normalizeEagleAssetRole(assetRole);
  if (normalizedAssetRole === "inspiration_video") return EAGLE_ASSET_FOLDERS.inspiration_video;

  const normalizedAccountRole = normalizeEagleAccountRole(accountRole);
  if (!normalizedAccountRole) return "";

  return EAGLE_ASSET_FOLDERS[normalizedAccountRole]?.[normalizedAssetRole] || "";
}
