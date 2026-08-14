import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibraryManager, LIBRARY_FOLDERS, LIBRARY_KIND } from "../server/library-manager.mjs";
import { createLibraryWriteLease } from "../server/library-lock.mjs";

test("new, rename, close and reopen preserve one library without stale writes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-library-manager-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateChanges = [];
  const manager = createLibraryManager({
    initialLibraryDir: null,
    onStateChange: async (state) => stateChanges.push(state),
  });

  assert.equal((await manager.readLibrary()).libraryOpen, false);
  const created = await manager.manage("new", { path: path.join(root, "内容选题") });
  assert.equal(created.storage.libraryName, "内容选题.library");
  assert.equal(created.categories.length, 0);
  for (const folder of LIBRARY_FOLDERS) {
    assert.equal((await fs.stat(path.join(created.storage.libraryDir, folder))).isDirectory(), true);
  }

  const firstSessionId = created.storage.sessionId;
  await manager.writeLibrary({
    categories: ["情感"],
    inspirations: [{ id: "I-0001", title: "真实保留内容" }],
    projects: [],
    archive: [],
    activeProject: null,
  }, firstSessionId);

  const renamed = await manager.manage("rename", { name: "品牌视频库", sessionId: firstSessionId });
  assert.equal(renamed.storage.libraryName, "品牌视频库.library");
  assert.notEqual(renamed.storage.sessionId, firstSessionId);
  assert.equal(renamed.inspirations[0].title, "真实保留内容");
  await assert.rejects(
    manager.writeLibrary({ inspirations: [] }, firstSessionId),
    (error) => error.statusCode === 409,
  );

  const renamedDir = renamed.storage.libraryDir;
  const secondSessionId = renamed.storage.sessionId;
  const closed = await manager.manage("close", { sessionId: secondSessionId });
  assert.equal(closed.libraryOpen, false);
  await assert.rejects(manager.writeLibrary({}, secondSessionId), (error) => error.statusCode === 409);

  const reopened = await manager.manage("open", { path: renamedDir });
  assert.equal(reopened.inspirations[0].id, "I-0001");
  assert.equal(reopened.categories[0], "情感");
  assert.deepEqual(stateChanges.map((state) => state.closed), [false, false, true, false]);
});

test("invalid libraries and rename collisions are rejected without changing the active library", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-library-validation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = createLibraryManager({ initialLibraryDir: null });
  const active = await manager.manage("new", { path: path.join(root, "当前.library") });

  const invalidDir = path.join(root, "其他.library");
  await fs.mkdir(invalidDir);
  await fs.writeFile(path.join(invalidDir, "library.json"), JSON.stringify({ libraryKind: "other-product" }));
  await assert.rejects(manager.manage("open", { path: invalidDir }), /不是 Video Hub 资料库/);

  const collisionDir = path.join(root, "已存在.library");
  await fs.mkdir(collisionDir);
  await fs.writeFile(path.join(collisionDir, "library.json"), JSON.stringify({ libraryKind: LIBRARY_KIND }));
  await assert.rejects(
    manager.manage("rename", { name: "已存在", sessionId: active.storage.sessionId }),
    (error) => error.statusCode === 409,
  );
  assert.equal((await manager.readLibrary()).storage.libraryName, "当前.library");
});

test("missing NAS index is protected and never replaced with an empty library", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-library-index-protection-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = createLibraryManager({ initialLibraryDir: null });
  t.after(() => manager.dispose());
  const created = await manager.manage("new", { path: path.join(root, "受保护资料库") });
  await manager.writeLibrary({
    inspirations: [{ id: "I000001", title: "必须保留" }],
    projects: [],
    archive: [],
    activeProject: null,
  }, created.storage.sessionId);
  const indexPath = path.join(created.storage.libraryDir, "library.json");
  const hiddenPath = `${indexPath}.temporarily-unavailable`;
  await fs.rename(indexPath, hiddenPath);
  await assert.rejects(
    manager.readLibrary(),
    (error) => error.statusCode === 503 && error.code === "LIBRARY_INDEX_UNAVAILABLE",
  );
  assert.equal(await fs.stat(indexPath).catch(() => null), null);
  assert.equal(JSON.parse(await fs.readFile(hiddenPath, "utf8")).inspirations[0].title, "必须保留");
});

test("two computers can open the same library and take short write locks only while mutating", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-library-writer-lease-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = createLibraryManager({ initialLibraryDir: null });
  const second = createLibraryManager({ initialLibraryDir: null });
  t.after(() => first.dispose());
  t.after(() => second.dispose());
  const created = await first.manage("new", { path: path.join(root, "团队资料库") });
  const opened = await second.manage("open", { path: created.storage.libraryDir });
  assert.equal(created.storage.mode, "read_write");
  assert.equal(opened.storage.mode, "read_write");

  await first.mutateLibrary(({ current }) => ({
    payload: {
      ...current,
      inspirations: [{ id: "I000101", title: "第一台写入" }, ...(current.inspirations || [])],
    },
  }), created.storage.sessionId);
  const saved = await second.mutateLibrary(({ current }) => ({
    payload: {
      ...current,
      inspirations: [...(current.inspirations || []), { id: "I000102", title: "第二台写入" }],
    },
  }), opened.storage.sessionId);

  assert.equal(saved.library.storage.mode, "read_write");
  assert.deepEqual((await first.readLibrary()).inspirations.map((item) => item.id), ["I000101", "I000102"]);
});

test("concurrent mutations from independent managers serialize through a short lock", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-library-concurrent-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = createLibraryManager({ initialLibraryDir: null });
  const second = createLibraryManager({ initialLibraryDir: null });
  t.after(() => first.dispose());
  t.after(() => second.dispose());
  const created = await first.manage("new", { path: path.join(root, "并发资料库") });
  const opened = await second.manage("open", { path: created.storage.libraryDir });

  await Promise.all([
    first.mutateLibrary(({ current }) => ({
      payload: {
        ...current,
        projects: [...(current.projects || []), { id: "C000201", title: "A", covers: [], mediaAssets: [] }],
      },
    }), created.storage.sessionId),
    second.mutateLibrary(({ current }) => ({
      payload: {
        ...current,
        projects: [...(current.projects || []), { id: "C000202", title: "B", covers: [], mediaAssets: [] }],
      },
    }), opened.storage.sessionId),
  ]);

  assert.deepEqual((await first.readLibrary()).projects.map((item) => item.id).sort(), ["C000201", "C000202"]);
});

test("an expired writer lock is reclaimed automatically after a crashed client", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-library-expired-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = createLibraryManager({ initialLibraryDir: null });
  const second = createLibraryManager({
    initialLibraryDir: null,
    writeLease: { ownerId: "second-client", ttlMs: 300, heartbeatMs: 100, waitTimeoutMs: 50 },
  });
  t.after(() => first.dispose());
  t.after(() => second.dispose());
  const created = await first.manage("new", { path: path.join(root, "崩溃资料库") });
  const opened = await second.manage("open", { path: created.storage.libraryDir });
  const lockPath = path.join(created.storage.libraryDir, "metadata", "library-writer.lock.json");
  const now = Date.now();
  await fs.writeFile(lockPath, `${JSON.stringify({
    schemaVersion: 1,
    ownerId: "crashed-client",
    host: "nas-client",
    pid: 999999,
    acquiredAt: new Date(now - 1_000).toISOString(),
    heartbeatAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 300).toISOString(),
  }, null, 2)}\n`, "utf8");

  await assert.rejects(
    second.mutateLibrary(({ current }) => ({
      payload: { ...current, inspirations: [{ id: "I000301" }] },
    }), opened.storage.sessionId),
    (error) => error.statusCode === 423 && error.code === "LIBRARY_WRITE_LOCKED",
  );

  await new Promise((resolve) => setTimeout(resolve, 420));
  await second.mutateLibrary(({ current }) => ({
    payload: { ...current, inspirations: [{ id: "I000301" }] },
  }), opened.storage.sessionId);
  assert.deepEqual((await second.readLibrary()).inspirations.map((item) => item.id), ["I000301"]);
});

test("concurrent writes from the same app share one library lease heartbeat", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-library-heartbeat-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lease = createLibraryWriteLease();
  t.after(() => lease.release());

  await lease.configure(root);
  const states = await Promise.all(Array.from({ length: 64 }, () => lease.ensureOwned()));
  assert.equal(states.every((state) => state.owned && state.mode === "read_write"), true);

  const metadataEntries = await fs.readdir(path.join(root, "metadata"));
  assert.deepEqual(metadataEntries.filter((name) => name.endsWith(".tmp")), []);
});

test("content ids are monotonic across indexed, abandoned and on-disk units", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-content-id-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = createLibraryManager({ initialLibraryDir: null });
  const created = await manager.manage("new", { path: path.join(root, "编号测试") });
  const firstSessionId = created.storage.sessionId;

  await manager.writeLibrary({
    inspirations: [{ id: "I000009" }],
    projects: [{ id: "C000004" }],
    archive: [{ id: "C000007" }],
    activeProject: { id: "C000006" },
  }, firstSessionId);
  await fs.mkdir(path.join(created.storage.libraryDir, "content-units", "C000012"), { recursive: true });

  assert.equal((await manager.allocateContentId("C", firstSessionId)).contentId, "C000013");
  assert.equal((await manager.allocateContentId("C", firstSessionId)).contentId, "C000014");
  assert.equal((await manager.allocateContentId("I", firstSessionId)).contentId, "I000010");

  const renamed = await manager.manage("rename", { name: "编号测试重命名", sessionId: firstSessionId });
  const secondSessionId = renamed.storage.sessionId;
  await assert.rejects(
    manager.allocateContentId("C", firstSessionId),
    (error) => error.statusCode === 409,
  );
  assert.equal((await manager.allocateContentId("C", secondSessionId)).contentId, "C000015");

  const libraryDir = renamed.storage.libraryDir;
  await manager.manage("close", { sessionId: secondSessionId });
  const reopened = await manager.manage("open", { path: libraryDir });
  assert.equal((await manager.allocateContentId("C", reopened.storage.sessionId)).contentId, "C000016");
});

test("captured and original records share content-unit manifests and survive library rename", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-content-units-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = createLibraryManager({ initialLibraryDir: null });
  const created = await manager.manage("new", { path: path.join(root, "演示创作台") });
  const sessionId = created.storage.sessionId;

  await manager.writeLibrary({
    categories: [],
    inspirations: [{
      id: "I000701",
      unitSchemaVersion: 1,
      origin: "captured",
      contentType: "image_set",
      title: "小红书多图内容",
      body: "三张图片属于正文媒体，不是三张创作封面。",
      platform: "小红书",
      originalUrl: "https://example.test/note",
      author: "示例账号",
      publishedAt: "2026-07-23",
      capturedAt: "2026-07-23T10:00:00.000Z",
      stats: { likes: "12", favorites: "3", comments: "2", shares: "1", views: "" },
      images: [
        { id: "image-1", localPath: "/library-assets/content-units/I000701/media/images/01.jpg", relativePath: "content-units/I000701/media/images/01.jpg" },
        { id: "image-2", localPath: "/library-assets/content-units/I000701/media/images/02.jpg", relativePath: "content-units/I000701/media/images/02.jpg" },
      ],
    }],
    projects: [{
      id: "C000801",
      unitSchemaVersion: 1,
      origin: "original",
      title: "自主创作",
      body: "交给剪辑师的正文。",
      category: "展示面",
      creationStatus: "completed",
      completedAt: "2026-07-23T11:00:00.000Z",
      covers: [],
      primaryCoverId: null,
      references: [{ id: "I000701" }],
      mediaAssets: [
        { id: "source-1", role: "source_video", version: 1, name: "原片.mov", src: "/library-assets/content-units/C000801/media/source-video/source.mov", relativePath: "content-units/C000801/media/source-video/source.mov" },
        { id: "refined-1", role: "refined_video", version: 1, name: "旧成品.mp4", src: "/library-assets/content-units/C000801/media/refined-video/v1.mp4", relativePath: "content-units/C000801/media/refined-video/v1.mp4" },
      ],
    }],
    archive: [],
    activeProject: null,
  }, sessionId);

  const inspirationManifestPath = path.join(created.storage.libraryDir, "content-units/I000701/manifest.json");
  const projectManifestPath = path.join(created.storage.libraryDir, "content-units/C000801/manifest.json");
  const inspirationManifest = JSON.parse(await fs.readFile(inspirationManifestPath, "utf8"));
  const projectManifest = JSON.parse(await fs.readFile(projectManifestPath, "utf8"));
  assert.equal(inspirationManifest.origin, "captured");
  assert.deepEqual(inspirationManifest.mediaAssets.map((asset) => asset.role), ["content_image", "content_image"]);
  assert.equal(inspirationManifest.source.accountName, "示例账号");
  assert.equal(projectManifest.origin, "original");
  assert.deepEqual(projectManifest.mediaAssets.map((asset) => asset.role), ["source_video", "finished_video"]);
  assert.deepEqual(projectManifest.relationships.referenceContentIds, ["I000701"]);
  assert.equal(await fs.readFile(path.join(created.storage.libraryDir, "content-units/C000801/copy/title.txt"), "utf8"), "自主创作\n");
  assert.equal(await fs.readFile(path.join(created.storage.libraryDir, "content-units/C000801/copy/body.txt"), "utf8"), "交给剪辑师的正文。\n");

  const renamed = await manager.manage("rename", { name: "重命名后的创作台", sessionId });
  assert.equal(renamed.storage.libraryName, "重命名后的创作台.library");
  assert.equal(JSON.parse(await fs.readFile(path.join(renamed.storage.libraryDir, "content-units/C000801/manifest.json"), "utf8")).contentId, "C000801");
});

test("legacy records do not trigger bulk content-unit migration", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-content-units-legacy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = createLibraryManager({ initialLibraryDir: null });
  const created = await manager.manage("new", { path: path.join(root, "旧库") });
  await manager.writeLibrary({
    categories: [],
    inspirations: [{ id: "I000001", title: "旧灵感", coverLocalPath: "/library-assets/assets/covers/I000001.jpg" }],
    projects: [{ id: "C000001", title: "旧创作", covers: [] }],
    archive: [],
    activeProject: null,
  }, created.storage.sessionId);
  const entries = await fs.readdir(path.join(created.storage.libraryDir, "content-units"));
  assert.deepEqual(entries, []);
});

test("content-unit persistence rejects symlink write escape", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-content-unit-symlink-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "video-content-unit-outside-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const manager = createLibraryManager({ initialLibraryDir: null });
  const created = await manager.manage("new", { path: path.join(root, "隔离测试.library") });
  const linkedUnit = path.join(created.storage.libraryDir, "content-units", "C000901");
  await fs.symlink(outside, linkedUnit);

  await assert.rejects(
    manager.writeLibrary({
      categories: [],
      inspirations: [],
      archive: [],
      activeProject: null,
      projects: [{
        id: "C000901",
        unitSchemaVersion: 1,
        title: "不能写出资料库",
        body: "",
        covers: [],
        mediaAssets: [],
      }],
    }, created.storage.sessionId),
    /不能经过符号链接/,
  );
  assert.equal(await fs.stat(path.join(outside, "manifest.json")).catch(() => null), null);
});
