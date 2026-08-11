import fs from "node:fs/promises";
import path from "node:path";

function contentNumber(id) {
  const match = String(id || "").match(/^C(\d+)$/);
  return match ? Number(match[1]) || 0 : 0;
}

export async function createProjectIndex({ project = {}, sessionId = "", expectedRevision = "", libraryManager }) {
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    const error = new Error("内容数据无效");
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
    const id = `C${String(nextNumber).padStart(6, "0")}`;
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
  }, sessionId, expectedRevision);
  return {
    createdProject: committed.createdProject,
    revision: committed.library.revision,
    storage: committed.library.storage,
  };
}

export async function removeProjectIndex({ projectId, sessionId = "", expectedRevision = "", libraryManager }) {
  const id = String(projectId || "").trim();
  if (!/^C[A-Za-z0-9._-]+$/.test(id)) {
    const error = new Error("内容 ID 无效");
    error.statusCode = 400;
    throw error;
  }
  const committed = await libraryManager.mutateLibrary(async ({ current }) => {
    const projects = (current.projects || []).filter((project) => project.id !== id);
    const activeProject = current.activeProject?.id === id ? null : current.activeProject;
    const existed = projects.length !== (current.projects || []).length || activeProject !== current.activeProject;
    if (!existed) {
      const error = new Error("找不到要删除的内容索引");
      error.statusCode = 404;
      throw error;
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
      },
    };
  }, sessionId, expectedRevision);
  return {
    removedProjectId: committed.removedProjectId,
    filesPreserved: committed.filesPreserved,
    revision: committed.library.revision,
    storage: committed.library.storage,
  };
}
