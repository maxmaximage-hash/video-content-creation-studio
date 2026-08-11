import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibraryManager } from "../server/library-manager.mjs";
import { createProjectIndex, removeProjectIndex } from "../server/project-index.mjs";

test("creating a project index atomically allocates an ID without replacing existing projects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-studio-index-create-"));
  const libraryManager = createLibraryManager({ initialLibraryDir: null, qaMode: true });
  try {
    const opened = await libraryManager.manage("new", { path: path.join(root, "fixture.library") });
    await libraryManager.writeLibrary({
      projects: [{ id: "C000901", title: "保留内容", covers: [], mediaAssets: [] }],
      inspirations: [],
      archive: [],
      activeProject: null,
      contentIdCounters: { I: 0, C: 900 },
    }, opened.storage.sessionId);
    await fs.mkdir(path.join(opened.storage.libraryDir, "content-units", "C000909"), { recursive: true });

    const result = await createProjectIndex({
      project: { title: "新建内容", body: "", covers: [], mediaAssets: [] },
      sessionId: opened.storage.sessionId,
      expectedRevision: (await libraryManager.readLibrary()).revision,
      libraryManager,
    });

    assert.equal(result.createdProject.id, "C000910");
    assert.equal(result.createdProject.title, "新建内容");
    assert.equal(Object.hasOwn(result, "library"), false);
    const persisted = await libraryManager.readLibrary();
    assert.deepEqual(persisted.projects.map((project) => project.id), ["C000910", "C000901"]);
    assert.equal(persisted.contentIdCounters.C, 910);
  } finally {
    await libraryManager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("removing one project index preserves its physical files and every other project", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-studio-index-"));
  const libraryManager = createLibraryManager({ initialLibraryDir: null, qaMode: true });
  try {
    const opened = await libraryManager.manage("new", { path: path.join(root, "fixture.library") });
    await libraryManager.writeLibrary({
      projects: [
        { id: "C000901", title: "删除目标", body: "", covers: [], mediaAssets: [] },
        { id: "C000902", title: "保留目标", body: "", covers: [], mediaAssets: [] },
      ],
      inspirations: [],
      archive: [],
      activeProject: null,
    }, opened.storage.sessionId);
    const marker = path.join(opened.storage.libraryDir, "content-units", "C000901", "keep.txt");
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, "keep");

    const result = await removeProjectIndex({
      projectId: "C000901",
      sessionId: opened.storage.sessionId,
      libraryManager,
    });

    assert.equal(result.filesPreserved, true);
    assert.equal(result.removedProjectId, "C000901");
    assert.equal(Object.hasOwn(result, "library"), false);
    const persisted = await libraryManager.readLibrary();
    assert.deepEqual(persisted.projects.map((project) => project.id), ["C000902"]);
    assert.equal(await fs.readFile(marker, "utf8"), "keep");
  } finally {
    await libraryManager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("stale project index mutations reject without replacing the current library", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-studio-index-conflict-"));
  const libraryManager = createLibraryManager({ initialLibraryDir: null, qaMode: true });
  try {
    const opened = await libraryManager.manage("new", { path: path.join(root, "fixture.library") });
    await libraryManager.writeLibrary({
      projects: [{ id: "C000901", title: "当前内容", covers: [], mediaAssets: [] }],
      inspirations: [],
      archive: [],
      activeProject: null,
    }, opened.storage.sessionId);
    const revision = (await libraryManager.readLibrary()).revision;

    await assert.rejects(
      createProjectIndex({
        project: { title: "过期页面新建", covers: [], mediaAssets: [] },
        sessionId: opened.storage.sessionId,
        expectedRevision: revision - 1,
        libraryManager,
      }),
      (error) => error.statusCode === 409,
    );
    await assert.rejects(
      removeProjectIndex({
        projectId: "C000901",
        sessionId: opened.storage.sessionId,
        expectedRevision: revision - 1,
        libraryManager,
      }),
      (error) => error.statusCode === 409,
    );

    const persisted = await libraryManager.readLibrary();
    assert.deepEqual(persisted.projects.map((project) => project.id), ["C000901"]);
  } finally {
    await libraryManager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
