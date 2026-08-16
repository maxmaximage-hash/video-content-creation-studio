import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditInspirationVideo,
  eagleItemBelongsToFolder,
  findDefinitivelyMissingInspirationVideos,
  isDefinitiveEagleMissingError,
} from "../server/inspiration-eagle-integrity.mjs";

test("Eagle inspiration video is valid only in the fixed video inspiration folder", () => {
  assert.equal(eagleItemBelongsToFolder({ id: "MSOTJV3L8V1WM", folders: ["MSOSVPR2743KV"] }), true);
  assert.equal(eagleItemBelongsToFolder({ id: "MSOTJV3L8V1WM", folders: ["MS-MOVED"] }), false);
  assert.equal(eagleItemBelongsToFolder({ id: "MSOTJV3L8V1WM", folders: ["MSOSVPR2743KV"], isDeleted: true }), false);
});

test("bulk integrity audit returns only definitive missing records", async () => {
  const missing = await findDefinitivelyMissingInspirationVideos([
    { id: "I000001", contentType: "video", eagleItemId: "MSMISSING01" },
    { id: "I000002", contentType: "video", eagleItemId: "MSTEMPORARY2" },
  ], {
    libraryDir: "/tmp/does-not-exist",
    eagleItemInfo: async (itemId) => {
      if (itemId === "MSMISSING01") throw Object.assign(new Error("File does not exist."), { statusCode: 500 });
      throw Object.assign(new Error("connect ECONNREFUSED"), { statusCode: 503 });
    },
  });
  assert.deepEqual(missing.map(({ item }) => item.id), ["I000001"]);
});

test("definitive Eagle missing errors stay distinct from temporary unavailability", () => {
  assert.equal(isDefinitiveEagleMissingError(Object.assign(new Error("File does not exist."), { statusCode: 500 })), true);
  assert.equal(isDefinitiveEagleMissingError(Object.assign(new Error("connection refused"), { statusCode: 503 })), false);
});

test("missing Eagle and missing local video is eligible for permanent record deletion", async () => {
  const result = await auditInspirationVideo({
    id: "I000058",
    contentType: "video",
    eagleItemId: "MSOTG5LD638EX",
    mediaAssets: [{ role: "captured_video", eagleItemId: "MSOTG5LD638EX" }],
  }, {
    libraryDir: "/tmp/does-not-exist",
    eagleItemInfo: async () => { throw Object.assign(new Error("File does not exist."), { statusCode: 500 }); },
  });
  assert.equal(result.state, "missing");
});

test("temporary Eagle outage never deletes a record", async () => {
  const result = await auditInspirationVideo({
    id: "I000058",
    contentType: "video",
    eagleItemId: "MSOTG5LD638EX",
  }, {
    libraryDir: "/tmp/does-not-exist",
    eagleItemInfo: async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { statusCode: 503 }); },
  });
  assert.equal(result.state, "unknown");
});

test("valid local Eagle entities skip the per-item Eagle API request", async () => {
  let apiCalls = 0;
  const result = await auditInspirationVideo({
    id: "I000086",
    contentType: "video",
    eagleItemId: "MSVH27AEFAR3D",
  }, {
    eagleItemInfoFromLibrary: async () => ({
      id: "MSVH27AEFAR3D",
      folders: ["MSOSVPR2743KV"],
      size: 512 * 1024,
    }),
    resolveEagleOriginalPath: async () => ({
      stat: {
        isFile: () => true,
        size: 512 * 1024,
      },
    }),
    eagleItemInfo: async () => {
      apiCalls += 1;
      throw new Error("should not be called");
    },
  });
  assert.equal(result.state, "available");
  assert.equal(result.source, "library");
  assert.equal(apiCalls, 0);
});

test("local Eagle lookup failure falls back to API without treating outages as missing", async () => {
  let apiCalls = 0;
  const result = await auditInspirationVideo({
    id: "I000086",
    contentType: "video",
    eagleItemId: "MSVH27AEFAR3D",
  }, {
    eagleItemInfoFromLibrary: async () => {
      throw Object.assign(new Error("mount unavailable"), { statusCode: 404 });
    },
    eagleItemInfo: async () => {
      apiCalls += 1;
      throw Object.assign(new Error("connect ECONNREFUSED"), { statusCode: 503 });
    },
  });
  assert.equal(result.state, "unknown");
  assert.equal(apiCalls, 1);
});

test("a readable local source is preserved when Eagle is missing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inspiration-integrity-"));
  const relativePath = "content-units/I000086/media/captured-video/video.mp4";
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, Buffer.alloc(70 * 1024));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await auditInspirationVideo({
    id: "I000086",
    contentType: "video",
    videoLocalPath: `/library-assets/${relativePath}`,
  }, {
    libraryDir: root,
    eagleItemInfo: async () => { throw new Error("not called"); },
  });
  assert.equal(result.state, "local_only");
  assert.equal(result.local.size, 70 * 1024);
});
