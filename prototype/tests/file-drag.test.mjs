import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDragFile } from "../desktop/file-drag.mjs";

test("native drag resolves a scoped readable file in the active library session", async (t) => {
  const libraryDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-drag-"));
  t.after(() => fs.rm(libraryDir, { recursive: true, force: true }));
  const filePath = path.join(libraryDir, "content-units/C000901/media/finished-video/final.mp4");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "video");

  const resolved = resolveDragFile({
    libraryDir,
    activeSessionId: "session-1",
    payload: {
      projectId: "C000901",
      relativePath: "content-units/C000901/media/finished-video/final.mp4",
      scope: "finished_video",
      sessionId: "session-1",
    },
  });
  assert.equal(resolved, await fs.realpath(filePath));

  assert.throws(() => resolveDragFile({
    libraryDir,
    activeSessionId: "session-2",
    payload: {
      projectId: "C000901",
      relativePath: "content-units/C000901/media/finished-video/final.mp4",
      scope: "finished_video",
      sessionId: "session-1",
    },
  }), /资料库已经切换/);
});

test("native drag rejects wrong roles, file types and symlink escape", async (t) => {
  const libraryDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-drag-security-"));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-drag-outside-"));
  t.after(() => fs.rm(libraryDir, { recursive: true, force: true }));
  t.after(() => fs.rm(outsideDir, { recursive: true, force: true }));
  const coverDir = path.join(libraryDir, "content-units/C000901/covers");
  await fs.mkdir(coverDir, { recursive: true });
  await fs.writeFile(path.join(coverDir, "cover.txt"), "not an image");
  const outsidePath = path.join(outsideDir, "outside.jpg");
  await fs.writeFile(outsidePath, "outside");
  await fs.symlink(outsidePath, path.join(coverDir, "linked.jpg"));

  const base = { libraryDir, activeSessionId: "session-1" };
  assert.throws(() => resolveDragFile({
    ...base,
    payload: {
      projectId: "C000901",
      relativePath: "content-units/C000901/covers/cover.txt",
      scope: "cover",
      sessionId: "session-1",
    },
  }), /文件类型不允许/);
  assert.throws(() => resolveDragFile({
    ...base,
    payload: {
      projectId: "C000901",
      relativePath: "content-units/C000901/covers/linked.jpg",
      scope: "cover",
      sessionId: "session-1",
    },
  }), /不在当前资料库内/);
  assert.throws(() => resolveDragFile({
    ...base,
    payload: {
      projectId: "C000901",
      relativePath: "content-units/C000901/covers/linked.jpg",
      scope: "project",
      sessionId: "session-1",
    },
  }), /项目目录不能作为文件拖出/);
});
