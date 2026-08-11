import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibraryManager } from "../server/library-manager.mjs";
import { removeProjectIndex } from "../server/project-index.mjs";

test("removing a project index preserves its physical content directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-studio-index-"));
  const libraryManager = createLibraryManager({ initialLibraryDir: null, qaMode: true });
  try {
    const opened = await libraryManager.manage("new", { path: path.join(root, "fixture.library") });
    await libraryManager.writeLibrary({
      projects: [{ id: "C000901", title: "双账号选题", body: "", covers: [], mediaAssets: [] }],
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
    assert.equal(result.library.projects.length, 0);
    assert.equal(await fs.readFile(marker, "utf8"), "keep");
  } finally {
    await libraryManager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
