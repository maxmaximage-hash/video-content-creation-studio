import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { projectAssetStates, revealProjectPath } from "../vite.config.mjs";

async function makeFixture(t) {
  const libraryDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-project-actions-"));
  t.after(() => fs.rm(libraryDir, { recursive: true, force: true }));
  const unitDir = path.join(libraryDir, "content-units/C000901");
  const sourcePath = path.join(unitDir, "media/source-video/source.mov");
  const finishedPath = path.join(unitDir, "media/finished-video/final.mp4");
  const coverPath = path.join(unitDir, "covers/cover.jpg");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.mkdir(path.dirname(finishedPath), { recursive: true });
  await fs.mkdir(path.dirname(coverPath), { recursive: true });
  await fs.writeFile(sourcePath, "source");
  await fs.writeFile(finishedPath, "finished");
  await fs.writeFile(coverPath, "cover");
  const libraryManager = {
    requireActive(sessionId) {
      assert.equal(sessionId, "session-1");
      return { libraryDir };
    },
  };
  return { libraryDir, unitDir, sourcePath, finishedPath, coverPath, libraryManager };
}

test("Finder reveal resolves canonical files and project directories", async (t) => {
  const fixture = await makeFixture(t);
  const revealed = [];
  const options = {
    async revealPath(targetPath, isFile) {
      revealed.push({ targetPath, isFile });
    },
  };

  const fileResult = await revealProjectPath({
    projectId: "C000901",
    relativePath: "content-units/C000901/media/source-video/source.mov",
    scope: "source_video",
  }, "session-1", fixture.libraryManager, options);
  assert.equal(fileResult.state, "available");
  assert.deepEqual(revealed[0], { targetPath: await fs.realpath(fixture.sourcePath), isFile: true });

  const folderResult = await revealProjectPath({
    projectId: "C000901",
    scope: "project",
  }, "session-1", fixture.libraryManager, options);
  assert.equal(folderResult.relativePath, "content-units/C000901");
  assert.deepEqual(revealed[1], { targetPath: await fs.realpath(fixture.unitDir), isFile: false });
});

test("Finder reveal permits only scoped legacy roots and rejects path escape", async (t) => {
  const fixture = await makeFixture(t);
  const legacyCover = path.join(fixture.libraryDir, "assets/covers/legacy.jpg");
  const legacySource = path.join(fixture.libraryDir, "assets/projects/C000901/source.mov");
  await fs.mkdir(path.dirname(legacyCover), { recursive: true });
  await fs.mkdir(path.dirname(legacySource), { recursive: true });
  await fs.writeFile(legacyCover, "cover");
  await fs.writeFile(legacySource, "source");

  const revealed = [];
  const options = { revealPath: async (targetPath, isFile) => revealed.push({ targetPath, isFile }) };
  await revealProjectPath({
    projectId: "C000901",
    relativePath: "assets/covers/legacy.jpg",
    scope: "cover",
  }, "session-1", fixture.libraryManager, options);
  await revealProjectPath({
    projectId: "C000901",
    relativePath: "assets/projects/C000901/source.mov",
    scope: "source_video",
  }, "session-1", fixture.libraryManager, options);
  assert.equal(revealed.length, 2);

  for (const payload of [
    { projectId: "C000901", relativePath: "../outside.mov", scope: "source_video" },
    { projectId: "C000901", relativePath: "/tmp/outside.mov", scope: "source_video" },
    { projectId: "C000901", relativePath: "content-units/C000902/media/source-video/other.mov", scope: "source_video" },
    { projectId: "C000901", relativePath: "assets/projects/C000902/final.mp4", scope: "finished_video" },
    { projectId: "C000901", relativePath: "assets/videos/captured.mp4", scope: "finished_video" },
  ]) {
    await assert.rejects(
      revealProjectPath(payload, "session-1", fixture.libraryManager, options),
      /素材路径无效|只能访问当前内容单元或受支持的旧版素材/,
    );
  }
});

test("Finder reveal rejects symlink escape", async (t) => {
  const fixture = await makeFixture(t);
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-project-actions-outside-"));
  t.after(() => fs.rm(outsideDir, { recursive: true, force: true }));
  const outsidePath = path.join(outsideDir, "outside.mov");
  const linkedPath = path.join(fixture.unitDir, "media/source-video/linked.mov");
  await fs.writeFile(outsidePath, "outside");
  await fs.symlink(outsidePath, linkedPath);
  await assert.rejects(
    revealProjectPath({
      projectId: "C000901",
      relativePath: "content-units/C000901/media/source-video/linked.mov",
      scope: "source_video",
    }, "session-1", fixture.libraryManager, { revealPath: async () => {} }),
    /素材路径不在当前资料库内/,
  );
});

test("asset status keeps available, missing, offline and not_added distinct", async (t) => {
  const fixture = await makeFixture(t);
  const result = await projectAssetStates({
    projectId: "C000901",
    assets: [
      { key: "project", relativePath: "content-units/C000901", scope: "project" },
      { key: "source", relativePath: "content-units/C000901/media/source-video/source.mov", scope: "source_video" },
      { key: "missing", relativePath: "content-units/C000901/media/finished-video/missing.mp4", scope: "finished_video" },
      { key: "empty", relativePath: "", scope: "finished_video" },
    ],
  }, "session-1", fixture.libraryManager);
  assert.deepEqual(Object.fromEntries(Object.entries(result.states).map(([key, value]) => [key, value.state])), {
    project: "available",
    source: "available",
    missing: "missing",
    empty: "not_added",
  });

  const offlineManager = {
    requireActive() {
      return { libraryDir: path.join(fixture.libraryDir, "offline.library") };
    },
  };
  await assert.rejects(
    projectAssetStates({
      projectId: "C000901",
      assets: [{ key: "source", relativePath: "content-units/C000901/media/source-video/source.mov", scope: "source_video" }],
    }, "", offlineManager),
    (error) => error.statusCode === 503 && error.assetState === "offline",
  );
});
