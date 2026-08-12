import fs from "node:fs/promises";
import path from "node:path";

function contentNumber(id) {
  const match = String(id || "").match(/^C(\d+)$/);
  const value = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(value) ? value : 0;
}

function invalidPatch() {
  const error = new Error("内容编辑补丁无效");
  error.statusCode = 400;
  return error;
}

function safePatchPath(value) {
  if (!Array.isArray(value) || value.length > 16 || !value.every((part) => typeof part === "string" && part && part.length <= 120)) {
    throw invalidPatch();
  }
  if (value.some((part) => ["__proto__", "constructor", "prototype"].includes(part))) throw invalidPatch();
  if (value[0] === "id") throw invalidPatch();
  return value;
}

function normalizeProjectPatches(value, removedProjectId) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 200) throw invalidPatch();
  return value.map((patch) => {
    const projectId = String(patch?.projectId || "").trim();
    if (!/^C[A-Za-z0-9._-]+$/.test(projectId) || projectId === removedProjectId || !Array.isArray(patch.operations) || patch.operations.length > 200) {
      throw invalidPatch();
    }
    return {
      projectId,
      operations: patch.operations.map((operation) => {
        const path = safePatchPath(operation?.path);
        if (operation?.remove === true) return { path, remove: true };
        if (!Object.hasOwn(operation || {}, "value")) throw invalidPatch();
        return { path, value: operation.value };
      }),
    };
  });
}

function applyProjectOperations(project, operations) {
  const next = structuredClone(project);
  for (const operation of operations) {
    let target = next;
    for (const part of operation.path.slice(0, -1)) {
      if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) target[part] = {};
      target = target[part];
    }
    const field = operation.path.at(-1);
    if (operation.remove) delete target[field];
    else target[field] = structuredClone(operation.value);
  }
  return next;
}

export async function createProjectIndex({ project = {}, sessionId = "", expectedRevision = "", libraryManager }) {
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    const error = new Error("内容数据无效");
    error.statusCode = 400;
    throw error;
  }
  // New cards arrive with a client-generated numeric ID so the UI can show and
  // edit them before a NAS round trip. Creation still serializes on the latest
  // server snapshot and rejects only an actual ID collision.
  void expectedRevision;
  const requestedId = String(project.id || "").trim();
  if (requestedId && !/^C\d{6,}$/.test(requestedId)) {
    const error = new Error("内容 ID 无效");
    error.statusCode = 400;
    throw error;
  }
  const committed = await libraryManager.mutateLibrary(async ({ current, paths }) => {
    const unitEntries = await fs.readdir(path.join(paths.libraryDir, "content-units"), { withFileTypes: true });
    const occupiedMaximum = [
      ...(current.projects || []).map((item) => item.id),
      ...(current.archive || []).map((item) => item.id),
      current.activeProject?.id,
      ...unitEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    ].reduce((maximum, id) => Math.max(maximum, contentNumber(id)), 0);
    const nextNumber = Math.max(Number(current.contentIdCounters?.C) || 0, occupiedMaximum) + 1;
    const occupiedIds = new Set([
      ...(current.projects || []).map((item) => item.id),
      ...(current.archive || []).map((item) => item.id),
      current.activeProject?.id,
      ...unitEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    ].filter(Boolean));
    if (requestedId && occupiedIds.has(requestedId)) {
      const error = new Error("内容 ID 已被占用");
      error.statusCode = 409;
      throw error;
    }
    const id = requestedId || `C${String(nextNumber).padStart(6, "0")}`;
    const createdProject = {
      ...project,
      id,
      createdAt: project.createdAt || new Date().toISOString(),
    };
    return {
      payload: {
        ...current,
        projects: [createdProject, ...(current.projects || [])],
        contentIdCounters: {
          I: Number(current.contentIdCounters?.I) || 0,
          C: nextNumber,
        },
      },
      result: { createdProject },
    };
  }, sessionId, "");
  return {
    createdProject: committed.createdProject,
    revision: committed.library.revision,
    storage: committed.library.storage,
  };
}

export async function removeProjectIndex({ projectId, sessionId = "", expectedRevision = "", projectPatches, libraryManager }) {
  const id = String(projectId || "").trim();
  if (!/^C[A-Za-z0-9._-]+$/.test(id)) {
    const error = new Error("内容 ID 无效");
    error.statusCode = 400;
    throw error;
  }
  // A delete is intentionally rebased onto the newest server snapshot. The client
  // sends only fields it changed locally, never an old whole-library replacement.
  void expectedRevision;
  const patches = normalizeProjectPatches(projectPatches, id);
  const committed = await libraryManager.mutateLibrary(async ({ current }) => {
    const patchesById = new Map(patches.map((patch) => [patch.projectId, patch.operations]));
    const projects = (current.projects || [])
      .filter((project) => project.id !== id)
      .map((project) => patchesById.has(project.id) ? applyProjectOperations(project, patchesById.get(project.id)) : project);
    const activeProject = current.activeProject?.id === id
      ? null
      : (current.activeProject && patchesById.has(current.activeProject.id)
        ? applyProjectOperations(current.activeProject, patchesById.get(current.activeProject.id))
        : current.activeProject);
    const existed = projects.length !== (current.projects || []).length || activeProject !== current.activeProject;
    if (!existed) {
      return {
        payload: current,
        allowDestructiveShrink: true,
        backupLabel: "remove-project-index",
        result: {
          removedProjectId: id,
          filesPreserved: true,
          alreadyRemoved: true,
          reconciledProjects: projects.filter((project) => patchesById.has(project.id)),
        },
      };
    }
    return {
      payload: {
        ...current,
        projects,
        activeProject,
      },
      allowDestructiveShrink: true,
      backupLabel: "remove-project-index",
      result: {
        removedProjectId: id,
        filesPreserved: true,
        reconciledProjects: projects.filter((project) => patchesById.has(project.id)),
      },
    };
  }, sessionId, "");
  return {
    removedProjectId: committed.removedProjectId,
    filesPreserved: committed.filesPreserved,
    alreadyRemoved: committed.alreadyRemoved === true,
    reconciledProjects: committed.reconciledProjects || [],
    revision: committed.library.revision,
    storage: committed.library.storage,
  };
}
