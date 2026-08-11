export async function removeProjectIndex({ projectId, sessionId = "", expectedRevision = "", libraryManager }) {
  const id = String(projectId || "").trim();
  if (!/^C[A-Za-z0-9._-]+$/.test(id)) {
    const error = new Error("内容 ID 无效");
    error.statusCode = 400;
    throw error;
  }
  return libraryManager.mutateLibrary(async ({ current }) => {
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
}
