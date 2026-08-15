import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibraryManager } from "../server/library-manager.mjs";
import { createProjectIndex, moveProjectIndex, removeProjectIndex } from "../server/project-index.mjs";

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

test("archiving and restoring one project rebase on the newest library without changing Eagle links", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-studio-index-archive-"));
  const libraryManager = createLibraryManager({ initialLibraryDir: null, qaMode: true });
  try {
    const opened = await libraryManager.manage("new", { path: path.join(root, "fixture.library") });
    await libraryManager.writeLibrary({
      projects: [
        { id: "C000601", title: "完成目标", body: "本地正文", covers: [{ eagleItemId: "EAGLE-COVER-601", eagleFolderId: "MS8R943CBJV6L" }], mediaAssets: [{ id: "finished", role: "finished_video", eagleItemId: "EAGLE-VIDEO-601", eagleFolderId: "MS8R943CBJV6L" }] },
        { id: "C000602", title: "保留内容", covers: [], mediaAssets: [] },
      ],
      inspirations: [], archive: [], activeProject: null,
    }, opened.storage.sessionId);
    const indexFile = path.join(opened.storage.libraryDir, "library.json");
    const current = persistedFixture(await libraryManager.readLibrary());
    await fs.writeFile(indexFile, `${JSON.stringify({ ...current, libraryRevision: current.libraryRevision + 1, projects: [...current.projects, { id: "C000603", title: "另一台新增", covers: [], mediaAssets: [] }] }, null, 2)}\n`);

    const archived = await moveProjectIndex({ projectId: "C000601", destination: "archive", sessionId: opened.storage.sessionId, expectedRevision: 1, libraryManager });
    assert.equal(archived.destination, "archive");
    let persisted = await libraryManager.readLibrary();
    assert.deepEqual(persisted.projects.map((item) => item.id), ["C000602", "C000603"]);
    assert.deepEqual(persisted.archive.map((item) => item.id), ["C000601"]);
    assert.equal(persisted.archive[0].covers[0].eagleItemId, "EAGLE-COVER-601");
    assert.equal(persisted.archive[0].mediaAssets[0].eagleItemId, "EAGLE-VIDEO-601");

    const restored = await moveProjectIndex({ projectId: "C000601", destination: "projects", sessionId: opened.storage.sessionId, expectedRevision: 1, libraryManager });
    assert.equal(restored.destination, "projects");
    persisted = await libraryManager.readLibrary();
    assert.deepEqual(persisted.projects.map((item) => item.id), ["C000601", "C000602", "C000603"]);
    assert.deepEqual(persisted.archive, []);
    assert.equal(persisted.projects[0].covers[0].eagleItemId, "EAGLE-COVER-601");
  } finally {
    await libraryManager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("archive move accepts the complete project snapshot when queue autosave has not landed yet", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-studio-index-archive-race-"));
  const libraryManager = createLibraryManager({ initialLibraryDir: null, qaMode: true });
  try {
    const opened = await libraryManager.manage("new", { path: path.join(root, "fixture.library") });
    const fallbackProject = {
      id: "C000611",
      title: "立即完成的内容",
      body: "博主号正文",
      accountVariants: { ip: { title: "IP 标题", body: "IP 正文" } },
      covers: [{ id: "cover-611", eagleItemId: "EAGLE-COVER-611", eagleFolderId: "MS8R943CBJV6L" }],
      mediaAssets: [{ id: "video-611", role: "finished_video", accountRole: "ip", eagleItemId: "EAGLE-VIDEO-611", eagleFolderId: "MS8R943CBJV6L" }],
      references: [{ id: "I000611", title: "参考灵感" }],
      workflow: { stage: "ready_to_publish", creationStatus: "in_progress" },
    };
    await libraryManager.writeLibrary({
      projects: [{
        ...fallbackProject,
        title: "自动保存前的旧标题",
        body: "自动保存前的旧正文",
        accountVariants: {},
        covers: [],
        mediaAssets: [],
        references: [],
      }],
      inspirations: [],
      archive: [],
      activeProject: fallbackProject,
    }, opened.storage.sessionId);

    const result = await moveProjectIndex({
      projectId: fallbackProject.id,
      destination: "archive",
      fallbackProject,
      sessionId: opened.storage.sessionId,
      expectedRevision: 1,
      libraryManager,
    });

    assert.equal(result.project.id, fallbackProject.id);
    const persisted = await libraryManager.readLibrary();
    assert.deepEqual(persisted.projects, []);
    assert.equal(persisted.activeProject, null);
    assert.equal(persisted.archive[0].title, "立即完成的内容");
    assert.equal(persisted.archive[0].body, "博主号正文");
    assert.equal(persisted.archive[0].accountVariants.ip.body, "IP 正文");
    assert.equal(persisted.archive[0].covers[0].eagleItemId, "EAGLE-COVER-611");
    assert.equal(persisted.archive[0].mediaAssets[0].eagleItemId, "EAGLE-VIDEO-611");
    assert.deepEqual(persisted.archive[0].relationships.referenceContentIds, ["I000611"]);
    assert.deepEqual(persisted.archive[0].references, ["I000611"]);
    assert.equal(persisted.archive[0].workflow.stage, "archived");
  } finally {
    await libraryManager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("archive move promotes IP-only copy into the archive display fields", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-studio-index-ip-archive-"));
  const libraryManager = createLibraryManager({ initialLibraryDir: null, qaMode: true });
  try {
    const opened = await libraryManager.manage("new", { path: path.join(root, "fixture.library") });
    const project = {
      id: "C000612",
      title: "",
      body: "",
      accountVariants: { ip: { title: "只有 IP 标题", body: "只有 IP 正文" } },
      covers: [],
      mediaAssets: [],
      references: [],
      workflow: { stage: "ready_to_publish", creationStatus: "in_progress" },
    };
    await libraryManager.writeLibrary({ projects: [project], inspirations: [], archive: [], activeProject: null }, opened.storage.sessionId);

    await moveProjectIndex({
      projectId: project.id,
      destination: "archive",
      fallbackProject: project,
      sessionId: opened.storage.sessionId,
      libraryManager,
    });

    const persisted = await libraryManager.readLibrary();
    assert.equal(persisted.archive[0].title, "只有 IP 标题");
    assert.equal(persisted.archive[0].body, "只有 IP 正文");
    assert.equal(persisted.archive[0].mediaAssets.length, 0);
  } finally {
    await libraryManager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
