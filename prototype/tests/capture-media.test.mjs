import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibraryManager } from "../server/library-manager.mjs";
import { downloadXiaohongshuImages } from "../vite.config.mjs";

test("Xiaohongshu media uses session headers, validates bytes, writes atomically and avoids duplicate downloads", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-session-media-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = createLibraryManager({ initialLibraryDir: null });
  const created = await manager.manage("new", { path: path.join(root, "fixture.library") });
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let seenHeaders;
  globalThis.fetch = async (_url, options) => {
    requests += 1;
    seenHeaders = options.headers;
    return new Response(Buffer.alloc(1024, 7), { status: 200, headers: { "content-type": "image/jpeg" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const evidence = [];
  const headers = { cookie: "web_session=memory-only", "user-agent": "session-agent", referer: "https://www.xiaohongshu.com/explore/note1" };
  const first = await downloadXiaohongshuImages([{ sourceUrl: "https://cdn.test/1.jpg" }], "I000951", evidence, manager, headers);
  assert.equal(requests, 1);
  assert.equal(seenHeaders.cookie, headers.cookie);
  assert.equal(seenHeaders["user-agent"], headers["user-agent"]);
  assert.equal(seenHeaders.referer, headers.referer);
  assert.match(first[0].localPath, /content-units\/I000951\/media\/images\/01\.jpg$/);
  const mediaDir = path.join(created.storage.libraryDir, "content-units", "I000951", "media", "images");
  assert.equal((await fs.stat(path.join(mediaDir, "01.jpg"))).size, 1024);
  assert.equal((await fs.readdir(mediaDir)).some((name) => name.endsWith(".tmp")), false);

  const second = await downloadXiaohongshuImages([{ sourceUrl: "https://cdn.test/1.jpg" }], "I000951", evidence, manager, headers);
  assert.equal(requests, 1);
  assert.equal(second[0].localPath, first[0].localPath);
  assert.doesNotMatch(JSON.stringify(await manager.readLibrary()), /web_session|memory-only|session-agent/);
});

test("identified images with zero valid downloads cannot become success or partial", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-invalid-media-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = createLibraryManager({ initialLibraryDir: null });
  await manager.manage("new", { path: path.join(root, "fixture.library") });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("shell", { status: 200, headers: { "content-type": "text/html" } });
  t.after(() => { globalThis.fetch = originalFetch; });
  const images = await downloadXiaohongshuImages([{ sourceUrl: "https://cdn.test/invalid" }], "I000952", [], manager, { cookie: "memory-only" });
  assert.equal(images.filter((image) => image.localPath).length, 0);
});
