import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibraryManager } from "../server/library-manager.mjs";
import { createProjectIndex, removeProjectIndex } from "../server/project-index.mjs";

function persistedFixture(library, overrides = {}) {
  const {
    storage: _storage,
    libraryOpen: _libraryOpen,
    sessionId: _sessionId,
    revision: _revision,
    ...persisted
  } = library;
  return {
    ...persisted,
    ...overrides,
  };
}

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

test("stale project index creation rebases a client-generated ID without replacing the current library", async () => {
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

    const result = await createProjectIndex({
      project: { id: "C123456789012345", title: "过期页面新建", covers: [], mediaAssets: [] },
      sessionId: opened.storage.sessionId,
      expectedRevision: revision - 1,
      libraryManager,
    });

    const persisted = await libraryManager.readLibrary();
    assert.equal(result.createdProject.id, "C123456789012345");
    assert.deepEqual(persisted.projects.map((project) => project.id), ["C123456789012345", "C000901"]);
  } finally {
    await libraryManager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("stale project index deletion rebases external fields and local dirty edits without a whole-library save", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-studio-index-rebase-"));
  const libraryManager = createLibraryManager({ initialLibraryDir: null, qaMode: true });
  try {
    const opened = await libraryManager.manage("new", { path: path.join(root, "fixture.library") });
    const indexFile = path.join(opened.storage.libraryDir, "library.json");
    const base = persistedFixture(await libraryManager.readLibrary(), {
      libraryRevision: 475,
      projects: [
        { id: "C000022", title: "删除目标", body: "旧页面目标", covers: [], mediaAssets: [] },
        { id: "C000023", title: "旧页面保留", body: "客户端本地文案", covers: [], mediaAssets: [] },
      ],
      inspirations: [{ id: "I000010", title: "旧页面灵感" }],
      archive: [],
      activeProject: null,
    });
    await fs.writeFile(indexFile, `${JSON.stringify(base, null, 2)}\n`, "utf8");
    const concurrent = {
      ...base,
      libraryRevision: 476,
      projects: [
        base.projects[0],
        {
          ...base.projects[1],
          title: "迁移专项已修改",
          body: "服务端最新文案",
          eagleRouting: { bloggerSourceFolderId: "MSOSLZLAY5RGP" },
          mediaAssets: [{ id: "asset-external", role: "source_video", accountRole: "blogger", eagleItemId: "EAGLE-C000023-SOURCE" }],
        },
        { id: "C000024", title: "迁移专项新增", body: "", covers: [], mediaAssets: [] },
      ],
      inspirations: [...base.inspirations, { id: "I000011", title: "迁移专项新增灵感" }],
    };
    await fs.writeFile(indexFile, `${JSON.stringify(concurrent, null, 2)}\n`, "utf8");

    const result = await removeProjectIndex({
      projectId: "C000022",
      sessionId: opened.storage.sessionId,
      expectedRevision: 475,
      projectPatches: [{
        projectId: "C000023",
        operations: [{ path: ["title"], value: "本地未保存标题" }],
      }],
      libraryManager,
    });

    assert.equal(result.removedProjectId, "C000022");
    assert.equal(result.filesPreserved, true);
    assert.equal(result.revision, 477);
    assert.equal(Object.hasOwn(result, "library"), false);
    assert.deepEqual(result.reconciledProjects.map((project) => project.id), ["C000023"]);
    const persisted = await libraryManager.readLibrary();
    assert.equal(persisted.revision, 477);
    assert.deepEqual(persisted.projects.map((project) => project.id), ["C000023", "C000024"]);
    const preserved = persisted.projects.find((project) => project.id === "C000023");
    assert.equal(preserved.title, "本地未保存标题");
    assert.equal(preserved.body, "服务端最新文案");
    assert.equal(preserved.eagleRouting.bloggerSourceFolderId, "MSOSLZLAY5RGP");
    assert.equal(preserved.mediaAssets[0].eagleItemId, "EAGLE-C000023-SOURCE");
    assert.deepEqual(persisted.inspirations.map((item) => item.id), ["I000010", "I000011"]);
  } finally {
    await libraryManager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("removing an already-missing project index is idempotent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-studio-index-idempotent-"));
  const libraryManager = createLibraryManager({ initialLibraryDir: null, qaMode: true });
  try {
    const opened = await libraryManager.manage("new", { path: path.join(root, "fixture.library") });
    await libraryManager.writeLibrary({
      projects: [{ id: "C000901", title: "保留内容", covers: [], mediaAssets: [] }],
      inspirations: [],
      archive: [],
      activeProject: null,
    }, opened.storage.sessionId);
    const before = (await libraryManager.readLibrary()).revision;

    const result = await removeProjectIndex({
      projectId: "C000999",
      sessionId: opened.storage.sessionId,
      expectedRevision: before - 1,
      libraryManager,
    });

    assert.equal(result.removedProjectId, "C000999");
    assert.equal(result.filesPreserved, true);
    assert.equal(result.alreadyRemoved, true);
    assert.equal(result.revision, before);
    assert.deepEqual((await libraryManager.readLibrary()).projects.map((project) => project.id), ["C000901"]);
  } finally {
    await libraryManager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
