import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { eagleItemInfo, importPathToEagle, serveEagleMedia, setEagleAnnotation } from "../server/eagle-adapter.mjs";
import { eagleFolderIdForAsset } from "../src/services/eagle-asset-routing.js";
import { eagleMediaSource } from "../src/services/eagle-media.js";
import { eagleItemBelongsToFolder } from "../server/inspiration-eagle-integrity.mjs";
import { deleteProjectMediaContent, downloadVideo, projectAssetStates } from "../vite.config.mjs";

test("Eagle folder routing is fixed by account role and asset role", () => {
  assert.equal(eagleFolderIdForAsset({ accountRole: "blogger", assetRole: "cover" }), "MS8R943CBJV6L");
  assert.equal(eagleFolderIdForAsset({ accountRole: "blogger", assetRole: "source_material" }), "MSOSLZLAY5RGP");
  assert.equal(eagleFolderIdForAsset({ accountRole: "blogger", assetRole: "source_video" }), "MSOSLZLAY5RGP");
  assert.equal(eagleFolderIdForAsset({ accountRole: "blogger", assetRole: "finished_video" }), "MS8R943CBJV6L");
  assert.equal(eagleFolderIdForAsset({ accountRole: "ip", assetRole: "cover" }), "MSHM7I3KNXBML");
  assert.equal(eagleFolderIdForAsset({ accountRole: "ip", assetRole: "source_material" }), "MSOSM8ESCD2D0");
  assert.equal(eagleFolderIdForAsset({ accountRole: "ip", assetRole: "source_video" }), "MSOSM8ESCD2D0");
  assert.equal(eagleFolderIdForAsset({ accountRole: "ip", assetRole: "finished_video" }), "MSHM7I3KNXBML");
  assert.equal(eagleFolderIdForAsset({ assetRole: "inspiration_video" }), "MSOSVPR2743KV");
  assert.equal(eagleFolderIdForAsset({ accountRole: "blogger", assetRole: "unknown" }), "");
});

test("Eagle V1 import is verified by stable item ID and preview keeps only an Eagle reference", async (t) => {
  let receivedImport = null;
  const server = http.createServer(async (req, res) => {
    if (req.url?.startsWith("/api/item/info")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        status: "success",
        data: { id: "MSOTJV3L8V1WM", size: 64, ext: "mp4", folders: ["MSOSVPR2743KV"], isDeleted: false },
      }));
      return;
    }
    if (req.url === "/api/item/addFromPath" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      receivedImport = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "success", data: "MSOTJV3L8V1WM" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const options = { eagleApiBase: `http://127.0.0.1:${port}/api` };

  const imported = await importPathToEagle({
    filePath: "/private/tmp/source.mp4",
    folderId: "MSOSVPR2743KV",
    name: "source.mp4",
    tags: ["视频中台", "content:I000085"],
    options,
  });
  const item = await eagleItemInfo(imported.id, options);

  assert.equal(receivedImport.folderId, "MSOSVPR2743KV");
  assert.equal(receivedImport.path, "/private/tmp/source.mp4");
  assert.equal(item.id, "MSOTJV3L8V1WM");
  assert.equal(item.folders[0], "MSOSVPR2743KV");
  assert.equal(eagleMediaSource({ eagleItemId: item.id, eagleFolderId: item.folders[0] }), "/api/eagle-media/MSOTJV3L8V1WM");
});

test("Eagle item read retries the transient V1 data-field indexing error", async (t) => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    res.setHeader("content-type", "application/json");
    if (calls < 3) {
      res.statusCode = 500;
      res.end(JSON.stringify({ status: "error", data: "File does not exist." }));
      return;
    }
    res.end(JSON.stringify({
      status: "success",
      data: { id: "MSOTJV3L8V1WM", size: 64, ext: "png", folders: ["MS8R943CBJV6L"], isDeleted: false },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const item = await eagleItemInfo("MSOTJV3L8V1WM", { eagleApiBase: `http://127.0.0.1:${server.address().port}/api` });
  assert.equal(item.id, "MSOTJV3L8V1WM");
  assert.equal(calls, 3);
});

test("Eagle media endpoint supports HEAD, Range, mime and unavailable states", async (t) => {
  const previousRoot = process.env.VIDEO_STUDIO_EAGLE_LIBRARY_ROOT;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eagle-media-test-"));
  const infoDir = path.join(root, "images", "MSOTJV3L8V1WM.info");
  await fs.mkdir(infoDir, { recursive: true });
  const bytes = Buffer.from("0123456789abcdef");
  await fs.writeFile(path.join(infoDir, "original.mp4"), bytes);
  process.env.VIDEO_STUDIO_EAGLE_LIBRARY_ROOT = root;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.VIDEO_STUDIO_EAGLE_LIBRARY_ROOT;
    else process.env.VIDEO_STUDIO_EAGLE_LIBRARY_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  });

  const eagleApi = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/item/info")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        status: "success",
        data: {
          id: "MSOTJV3L8V1WM",
          size: bytes.length,
          ext: "mp4",
          folders: ["MSOSVPR2743KV"],
          isDeleted: false,
        },
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ status: "error", message: "missing" }));
  });
  await new Promise((resolve) => eagleApi.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => eagleApi.close(resolve)));
  const apiOptions = { eagleApiBase: `http://127.0.0.1:${eagleApi.address().port}/api` };
  const mediaServer = http.createServer((req, res) => serveEagleMedia(req, res, apiOptions));
  await new Promise((resolve) => mediaServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => mediaServer.close(resolve)));
  const base = `http://127.0.0.1:${mediaServer.address().port}/api/eagle-media/MSOTJV3L8V1WM?folderId=AN-OLD-FOLDER-ID`;

  const head = await fetch(base, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "video/mp4");
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  assert.equal(head.headers.get("content-length"), String(bytes.length));

  const range = await fetch(base, { headers: { range: "bytes=2-5" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-type"), "video/mp4");
  assert.equal(range.headers.get("content-range"), `bytes 2-5/${bytes.length}`);
  assert.equal(await range.text(), "2345");

  const unavailable = await fetch(`http://127.0.0.1:${mediaServer.address().port}/api/eagle-media/MSOTJV3L8V1WM`, {
    headers: { range: "bytes=100-120" },
  });
  assert.equal(unavailable.status, 416);
});

test("Eagle media falls back to the fixed library when another Eagle library is active", async (t) => {
  const previousRoot = process.env.VIDEO_STUDIO_EAGLE_LIBRARY_ROOT;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eagle-fixed-library-test-"));
  const infoDir = path.join(root, "images", "MSOTJV3L8V1WM.info");
  await fs.mkdir(infoDir, { recursive: true });
  const bytes = Buffer.from("fixed-library-video");
  await fs.writeFile(path.join(infoDir, "fixed.mp4"), bytes);
  await fs.writeFile(path.join(infoDir, "metadata.json"), JSON.stringify({
    id: "MSOTJV3L8V1WM",
    size: bytes.length,
    ext: "mp4",
    folders: ["MSOSVPR2743KV"],
    isDeleted: false,
  }));
  process.env.VIDEO_STUDIO_EAGLE_LIBRARY_ROOT = root;

  let infoCalls = 0;
  const eagleApi = http.createServer((req, res) => {
    infoCalls += 1;
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "error", data: "File does not exist." }));
  });
  await new Promise((resolve) => eagleApi.listen(0, "127.0.0.1", resolve));
  const options = {
    eagleApiBase: `http://127.0.0.1:${eagleApi.address().port}/api`,
    eagleItemInfoAttempts: 1,
  };
  const mediaServer = http.createServer((req, res) => serveEagleMedia(req, res, options));
  await new Promise((resolve) => mediaServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.VIDEO_STUDIO_EAGLE_LIBRARY_ROOT;
    else process.env.VIDEO_STUDIO_EAGLE_LIBRARY_ROOT = previousRoot;
    await new Promise((resolve) => mediaServer.close(resolve));
    await new Promise((resolve) => eagleApi.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const response = await fetch(`http://127.0.0.1:${mediaServer.address().port}/api/eagle-media/MSOTJV3L8V1WM`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(await response.text(), bytes.toString());
  assert.equal(infoCalls, 0);
});

test("Eagle item remains readable after moving to another folder", async (t) => {
  const previousRoot = process.env.VIDEO_STUDIO_EAGLE_LIBRARY_ROOT;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eagle-moved-item-test-"));
  const infoDir = path.join(root, "images", "MSOTJV3L8V1WM.info");
  await fs.mkdir(infoDir, { recursive: true });
  const bytes = Buffer.from("moved-folder-item");
  await fs.writeFile(path.join(infoDir, "moved.mp4"), bytes);
  process.env.VIDEO_STUDIO_EAGLE_LIBRARY_ROOT = root;
  const eagleApi = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/item/info")) {
      res.end(JSON.stringify({ status: "success", data: {
        id: "MSOTJV3L8V1WM", size: bytes.length, ext: "mp4", folders: ["MS-MOVED-TO-OTHER-FOLDER"], isDeleted: false,
      } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ status: "error", message: "missing" }));
  });
  await new Promise((resolve) => eagleApi.listen(0, "127.0.0.1", resolve));
  const options = { eagleApiBase: `http://127.0.0.1:${eagleApi.address().port}/api` };
  const mediaServer = http.createServer((req, res) => serveEagleMedia(req, res, options));
  await new Promise((resolve) => mediaServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.VIDEO_STUDIO_EAGLE_LIBRARY_ROOT;
    else process.env.VIDEO_STUDIO_EAGLE_LIBRARY_ROOT = previousRoot;
    await new Promise((resolve) => mediaServer.close(resolve));
    await new Promise((resolve) => eagleApi.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const response = await fetch(`http://127.0.0.1:${mediaServer.address().port}/api/eagle-media/MSOTJV3L8V1WM?folderId=MS8R943CBJV6L`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), bytes.toString());
  assert.equal(eagleMediaSource({ eagleItemId: "MSOTJV3L8V1WM", eagleFolderId: "MS8R943CBJV6L" }), "/api/eagle-media/MSOTJV3L8V1WM");
});

test("an inspiration Eagle item moved out of the fixed folder cannot be reused", () => {
  assert.equal(eagleItemBelongsToFolder({
    id: "MSOTJV3L8V1WM",
    size: 4096,
    ext: "mp4",
    folders: ["MS-MOVED"],
    isDeleted: false,
  }, "MSOSVPR2743KV"), false);
});

test("missing Eagle items return a stable missing state", async (t) => {
  const previousApi = process.env.VIDEO_STUDIO_EAGLE_API_BASE;
  const server = http.createServer((req, res) => {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "error", message: "missing" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.VIDEO_STUDIO_EAGLE_API_BASE = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => {
    if (previousApi === undefined) delete process.env.VIDEO_STUDIO_EAGLE_API_BASE;
    else process.env.VIDEO_STUDIO_EAGLE_API_BASE = previousApi;
    await new Promise((resolve) => server.close(resolve));
  });
  const result = await projectAssetStates({
    projectId: "C000901",
    assets: [{ key: "cover", eagleItemId: "MSOTJV3L8V1WM", eagleFolderId: "MS8R943CBJV6L" }],
  }, "session-1", { requireActive: () => ({ libraryDir: "/tmp" }) });
  assert.deepEqual(result.states.cover, {
    state: "missing",
    eagleItemId: "MSOTJV3L8V1WM",
    eagleFolderId: "MS8R943CBJV6L",
  });
});

test("software media deletion only removes its index and never calls Eagle delete", async () => {
  const current = {
    projects: [{ id: "C000901", mediaAssets: [{
      id: "eagle-video", role: "source_video", accountRole: "blogger", eagleItemId: "MSOTJV3L8V1WM", eagleFolderId: "MSOSLZLAY5RGP",
    }] }],
    archive: [],
    activeProject: null,
  };
  let committedResult;
  const manager = {
    mutateLibrary: async (mutator) => {
      const mutation = await mutator({ current, paths: { libraryDir: "/tmp" } });
      committedResult = mutation.result;
      return mutation.result;
    },
  };
  const result = await deleteProjectMediaContent({
    projectId: "C000901", role: "source_video", accountRole: "blogger", mediaId: "eagle-video", eagleItemId: "MSOTJV3L8V1WM",
  }, "session-1", manager);
  assert.equal(result.eagleItemId, "MSOTJV3L8V1WM");
  assert.equal(result.fileDeleted, false);
  assert.equal(committedResult.fileDeleted, false);
});

test("Eagle annotation writes and reads back without truncation", async (t) => {
  let stored = "";
  const longCaption = "原平台文案：".repeat(200);
  const server = http.createServer(async (req, res) => {
    if (req.url === "/api/item/update" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      stored = JSON.parse(Buffer.concat(chunks).toString("utf8")).annotation;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        status: "success",
        data: { id: "MSOTJV3L8V1WM", annotation: stored, folders: ["MSOSVPR2743KV"], isDeleted: false },
      }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const item = await setEagleAnnotation("MSOTJV3L8V1WM", longCaption, {
    eagleApiBase: `http://127.0.0.1:${server.address().port}/api`,
  });
  assert.equal(item.annotation, longCaption);
  assert.equal(stored.length, longCaption.length);
});
