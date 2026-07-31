import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibraryManager } from "../server/library-manager.mjs";
import { deleteInspirationContentUnit } from "../vite.config.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inspiration-delete-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = createLibraryManager({ initialLibraryDir: null });
  const created = await manager.manage("new", { path: path.join(root, "fixture.library") });
  const sessionId = created.storage.sessionId;
  await manager.writeLibrary({
    inspirations: [{ id: "I000901", title: "待删除灵感" }, { id: "I000902", title: "保留灵感" }],
    projects: [{ id: "C000901", references: ["I000901", { id: "I000902" }], relationships: { referenceContentIds: ["I000901", "I000902"] } }],
    archive: [
      { id: "C000902", references: [{ contentId: "I000901" }, "I000902"] },
      { id: "C000904", references: 3, relationships: { referenceContentIds: 3 } },
      { id: "C000905", references: "I000901", relationships: { referenceContentIds: { id: "I000901" } } },
    ],
    activeProject: { id: "C000903", references: [{ referenceContentId: "I000901" }, { id: "I000902" }] },
  }, sessionId);
  return { manager, created, sessionId };
}

test("deletion removes only the canonical I unit, index record and matching references", async (t) => {
  const { manager, created, sessionId } = await fixture(t);
  const unit = path.join(created.storage.libraryDir, "content-units", "I000901");
  await fs.mkdir(path.join(unit, "media"), { recursive: true });
  await fs.writeFile(path.join(unit, "media", "asset.jpg"), "fixture");
  const result = await deleteInspirationContentUnit({ id: "I000901" }, sessionId, manager);
  assert.ok(["deleted", "cleanup_pending"].includes(result.contentUnitState));
  assert.equal(await fs.stat(unit).catch(() => null), null);
  const library = await manager.readLibrary();
  assert.deepEqual(library.inspirations.map((item) => item.id), ["I000902"]);
  assert.deepEqual(library.projects[0].references, [{ id: "I000902" }]);
  assert.deepEqual(library.projects[0].relationships.referenceContentIds, ["I000902"]);
  assert.deepEqual(library.archive[0].references, ["I000902"]);
  assert.equal(library.archive[1].references, 3);
  assert.equal(library.archive[1].relationships.referenceContentIds, 3);
  assert.deepEqual(library.archive[2].references, []);
  assert.deepEqual(library.archive[2].relationships.referenceContentIds, []);
  assert.deepEqual(library.activeProject.references, [{ id: "I000902" }]);
});

test("missing unit removes the index, while invalid IDs, sessions and symlinks are rejected", async (t) => {
  const { manager, created, sessionId } = await fixture(t);
  assert.equal((await deleteInspirationContentUnit({ id: "I000901" }, sessionId, manager)).contentUnitState, "missing");
  await assert.rejects(deleteInspirationContentUnit({ id: "C000901" }, sessionId, manager), /只能删除灵感/);
  await assert.rejects(deleteInspirationContentUnit({ id: "I000902" }, "stale-session", manager), /资料库已经切换/);

  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "inspiration-delete-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "keep.txt"), "keep");
  await fs.symlink(outside, path.join(created.storage.libraryDir, "content-units", "I000902"));
  await assert.rejects(deleteInspirationContentUnit({ id: "I000902" }, sessionId, manager), /符号链接/);
  assert.equal(await fs.readFile(path.join(outside, "keep.txt"), "utf8"), "keep");
  assert.equal((await manager.readLibrary()).inspirations.some((item) => item.id === "I000902"), true);
});
