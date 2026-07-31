import {
  mergeProjectMediaSlot,
  normalizedProjectMediaAssets,
  PROJECT_MEDIA_SLOTS,
  projectMediaSlotKey,
  projectMediaSlotLabel,
  projectMediaSlotProjection,
  removeProjectMediaSlotReference,
} from "../../services/project-media-slots.js";

export function coverSource(item) {
  return item?.src || item?.localPath || item?.cover || item?.coverLocalPath || item?.sourceUrl || item?.coverUrl || item?.url || item?.image || item?.thumbnail || "";
}

export function projectCoverCandidates(project) {
  const removedCoverIds = new Set(project?.removedCoverIds || []);
  const uploaded = (project?.covers || []).map((item, index) => (
    typeof item === "string"
      ? { id: `${project?.id || "project"}-upload-${index}`, src: item, name: `封面 ${index + 1}`, coverKind: "uploaded" }
      : { ...item, id: item.id || `${project?.id || "project"}-upload-${index}`, coverKind: "uploaded" }
  ));
  return uploaded.filter((item, index, items) => {
    if (!coverSource(item)) return false;
    if (removedCoverIds.has(item.id)) return false;
    return items.findIndex((candidate) => candidate.id === item.id) === index;
  });
}

export function primaryProjectCover(project) {
  return projectCoverCandidates(project)[0] || null;
}

export function isCreationComplete(project) {
  return project?.creationStatus === "completed";
}

export function projectMediaAssets(project) {
  return normalizedProjectMediaAssets(project);
}

export function projectOriginalMediaItems(project) {
  const projection = projectMediaSlotProjection(project);
  return [
    ...projection.slots.filter((slot) => slot.role === "source_video" && slot.asset).map((slot) => slot.asset),
    ...projection.legacyOverflow.filter((item) => item.role === "source_video"),
  ];
}

export function projectOriginalMedia(project) {
  return projectOriginalMediaItems(project)[0] || null;
}

export function projectFinishedVideos(project) {
  const projection = projectMediaSlotProjection(project);
  return [
    ...projection.slots.filter((slot) => slot.role === "finished_video" && slot.asset).map((slot) => slot.asset),
    ...projection.legacyOverflow.filter((item) => item.role === "finished_video"),
  ];
}

export {
  PROJECT_MEDIA_SLOTS,
  projectMediaSlotKey,
  projectMediaSlotLabel,
  projectMediaSlotProjection,
};

export function hasManagedContentUnit(item) {
  if (Number(item?.unitSchemaVersion || item?.contentUnitVersion) >= 1) return true;
  const paths = [
    ...projectMediaAssets(item).map((asset) => asset.relativePath || ""),
    ...(item?.covers || []).map((asset) => asset?.relativePath || ""),
  ];
  return paths.some((relativePath) => String(relativePath).startsWith(`content-units/${item?.id}/`));
}

export function projectMaterialCount(project) {
  return [
    project?.title?.trim(),
    project?.body?.trim(),
    projectCoverCandidates(project).length,
    projectOriginalMedia(project)?.src,
    projectFinishedVideos(project).length,
  ].filter(Boolean).length;
}

export function hasProjectContent(project, uploads = {}) {
  if (!project) return false;
  return Boolean(
    project.title?.trim()
    || project.body?.trim()
    || project.category?.trim()
    || projectCoverCandidates(project).length
    || project.references?.length
    || projectMediaAssets(project).length
    || isCreationComplete(project)
    || Object.keys(uploads || {}).length
  );
}

export function makeOriginalProject({ id, reference = null, category = "", createdAt }) {
  return {
    id,
    unitSchemaVersion: 1,
    origin: "original",
    title: "",
    body: "",
    covers: [],
    primaryCoverId: null,
    references: reference ? [reference] : [],
    category,
    categoryAssignedByUser: Boolean(category),
    creationStatus: "in_progress",
    completedAt: null,
    mediaAssets: [],
    metricsSnapshots: [],
    source: { platform: "", originalUrl: "", accountName: "", publishedAt: "" },
    workflow: { stage: "creating", creationStatus: "in_progress", completedAt: null },
    modified: "刚刚",
    createdAt,
  };
}

export function clearProjectContent(project) {
  return {
    ...project,
    unitSchemaVersion: 1,
    title: "",
    body: "",
    covers: [],
    removedCoverIds: [],
    primaryCoverId: null,
    references: [],
    category: "",
    categoryAssignedByUser: false,
    creationStatus: "in_progress",
    completedAt: null,
    mediaAssets: [],
    rawMaterial: null,
    finalVideo: null,
    finalVideos: [],
    workflow: {
      ...(project.workflow || {}),
      stage: "creating",
      creationStatus: "in_progress",
      completedAt: null,
    },
    modified: "刚刚",
  };
}

export function queueProject(project) {
  return {
    ...project,
    unitSchemaVersion: 1,
    workflow: {
      ...(project.workflow || {}),
      stage: "ready_to_publish",
      creationStatus: project.creationStatus || "in_progress",
      completedAt: project.completedAt || null,
    },
  };
}

export function mergeUploadedMedia(project, {
  role,
  accountRole,
  media,
  replacementId = "",
}) {
  return mergeProjectMediaSlot(project, {
    role,
    accountRole,
    media,
    replacementId,
  });
}

export function removeMediaReference(project, target) {
  return removeProjectMediaSlotReference(project, target);
}
