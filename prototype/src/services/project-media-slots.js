export const PROJECT_MEDIA_ROLES = Object.freeze(["source_video", "finished_video"]);
export const PROJECT_ACCOUNT_ROLES = Object.freeze(["blogger", "ip"]);

export const PROJECT_MEDIA_SLOTS = Object.freeze([
  Object.freeze({ key: "source_video:blogger", role: "source_video", accountRole: "blogger", label: "原素材 · 博主号" }),
  Object.freeze({ key: "source_video:ip", role: "source_video", accountRole: "ip", label: "原素材 · IP 号" }),
  Object.freeze({ key: "finished_video:blogger", role: "finished_video", accountRole: "blogger", label: "成品视频 · 博主号" }),
  Object.freeze({ key: "finished_video:ip", role: "finished_video", accountRole: "ip", label: "成品视频 · IP 号" }),
]);

const ROLE_ALIASES = Object.freeze({
  raw: "source_video",
  original: "source_video",
  source: "source_video",
  final: "finished_video",
  refined: "finished_video",
  refined_video: "finished_video",
  finished: "finished_video",
});

export function normalizeProjectMediaRole(value = "") {
  const normalized = ROLE_ALIASES[String(value || "").toLowerCase()] || String(value || "");
  return PROJECT_MEDIA_ROLES.includes(normalized) ? normalized : normalized;
}

export function normalizeProjectAccountRole(value = "") {
  const normalized = String(value || "").toLowerCase();
  return PROJECT_ACCOUNT_ROLES.includes(normalized) ? normalized : "";
}

export function projectMediaSlotKey(role, accountRole) {
  const normalizedRole = normalizeProjectMediaRole(role);
  const normalizedAccountRole = normalizeProjectAccountRole(accountRole);
  return normalizedRole && normalizedAccountRole ? `${normalizedRole}:${normalizedAccountRole}` : "";
}

export function projectMediaSlotOrder(accountRole) {
  return normalizeProjectAccountRole(accountRole) === "ip" ? 2 : 1;
}

export function projectMediaSlotLabel(role, accountRole) {
  return PROJECT_MEDIA_SLOTS.find((slot) => (
    slot.role === normalizeProjectMediaRole(role)
    && slot.accountRole === normalizeProjectAccountRole(accountRole)
  ))?.label || "视频素材";
}

function assetIdentity(asset = {}, fallback = "") {
  return String(
    asset.id
    || asset.relativePath
    || asset.src
    || asset.localPath
    || fallback,
  );
}

export function normalizedProjectMediaAssets(project = {}) {
  const canonical = Array.isArray(project.mediaAssets)
    ? project.mediaAssets.filter((item) => item?.src || item?.localPath || item?.relativePath)
    : [];
  const candidates = canonical.length
    ? canonical
    : [
        ...(project.rawMaterial?.src ? [{ ...project.rawMaterial, role: "source_video" }] : []),
        ...(Array.isArray(project.finishedVideos) && project.finishedVideos.length
          ? project.finishedVideos
          : (Array.isArray(project.finalVideos) && project.finalVideos.length
            ? project.finalVideos
            : (project.finalVideo?.src ? [project.finalVideo] : [])))
          .map((item) => ({ ...item, role: "finished_video" })),
      ];
  const seen = new Set();
  let sourceOrder = 0;
  let finishedOrder = 0;
  return candidates.map((item, index) => {
    const role = normalizeProjectMediaRole(item.role) || "source_video";
    const accountRole = normalizeProjectAccountRole(item.accountRole);
    const roleOrder = role === "finished_video" ? ++finishedOrder : ++sourceOrder;
    const normalized = {
      ...item,
      role,
      order: Number(item.order) || Number(item.version) || roleOrder || index + 1,
    };
    if (accountRole) normalized.accountRole = accountRole;
    else delete normalized.accountRole;
    return normalized;
  }).filter((item, index) => {
    const identity = assetIdentity(item, `${item.role}:${index}`);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function projectMediaSlotProjection(project = {}) {
  const videoAssets = normalizedProjectMediaAssets(project)
    .filter((asset) => PROJECT_MEDIA_ROLES.includes(asset.role))
    .sort((left, right) => (Number(left.order) || 0) - (Number(right.order) || 0));
  const remaining = [...videoAssets];
  const slots = PROJECT_MEDIA_SLOTS.map((slot) => {
    const explicitIndex = remaining.findIndex((asset) => (
      asset.role === slot.role
      && normalizeProjectAccountRole(asset.accountRole) === slot.accountRole
    ));
    const asset = explicitIndex >= 0 ? remaining.splice(explicitIndex, 1)[0] : null;
    return { ...slot, asset, legacy: false };
  });

  for (const role of PROJECT_MEDIA_ROLES) {
    const legacyAssets = remaining.filter((asset) => (
      asset.role === role && !normalizeProjectAccountRole(asset.accountRole)
    ));
    for (const legacyAsset of legacyAssets) {
      const openSlot = slots.find((slot) => slot.role === role && !slot.asset);
      if (!openSlot) continue;
      openSlot.asset = { ...legacyAsset, legacyAccountRole: true };
      openSlot.legacy = true;
      remaining.splice(remaining.indexOf(legacyAsset), 1);
    }
  }

  return {
    slots,
    legacyOverflow: remaining.map((asset) => ({
      ...asset,
      legacyAccountRole: !normalizeProjectAccountRole(asset.accountRole),
      slotConflict: Boolean(normalizeProjectAccountRole(asset.accountRole)),
    })),
  };
}

export function mergeProjectMediaSlot(project, {
  role,
  accountRole,
  media,
  replacementId = "",
}) {
  const normalizedRole = normalizeProjectMediaRole(role);
  const normalizedAccountRole = normalizeProjectAccountRole(accountRole);
  if (!PROJECT_MEDIA_ROLES.includes(normalizedRole) || !normalizedAccountRole) return project;
  const assets = normalizedProjectMediaAssets(project);
  const nextAssets = assets.filter((asset) => {
    if (replacementId && String(asset.id || "") === String(replacementId)) return false;
    return !(
      asset.role === normalizedRole
      && normalizeProjectAccountRole(asset.accountRole) === normalizedAccountRole
    );
  });
  nextAssets.push({
    ...media,
    role: normalizedRole,
    accountRole: normalizedAccountRole,
    order: projectMediaSlotOrder(normalizedAccountRole),
  });
  return {
    ...project,
    unitSchemaVersion: Math.max(1, Number(project?.unitSchemaVersion || project?.contentUnitVersion) || 0),
    mediaAssets: nextAssets,
    modified: "刚刚",
  };
}

export function removeProjectMediaSlotReference(project, {
  role,
  accountRole,
  mediaId = "",
  relativePath = "",
  legacyAccountRole = false,
}) {
  const normalizedRole = normalizeProjectMediaRole(role);
  const normalizedAccountRole = normalizeProjectAccountRole(accountRole);
  return {
    ...project,
    unitSchemaVersion: Math.max(1, Number(project?.unitSchemaVersion || project?.contentUnitVersion) || 0),
    mediaAssets: normalizedProjectMediaAssets(project).filter((asset) => {
      if (asset.role !== normalizedRole) return true;
      const assetAccountRole = normalizeProjectAccountRole(asset.accountRole);
      if (legacyAccountRole ? assetAccountRole : assetAccountRole !== normalizedAccountRole) return true;
      if (mediaId && asset.id && String(asset.id) !== String(mediaId)) return true;
      const assetPath = String(asset.relativePath || "").replace(/^\/+/, "");
      return relativePath && assetPath !== relativePath;
    }),
    modified: "刚刚",
  };
}
