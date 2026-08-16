import assert from "node:assert/strict";
import test from "node:test";
import {
  applyExtraction,
  collectReferencedInspirationIds,
  requiresInspirationAttention,
  sortInspirationItems,
  usesEagleAnnotation,
} from "../src/features/inspirations/inspiration-model.js";

test("failed and waiting recaptures preserve prior successful copy and local media", () => {
  const card = {
    id: "I000991",
    title: "上次成功标题",
    body: "上次成功正文",
    author: "作者",
    coverLocalPath: "/library-assets/content-units/I000991/covers/cover.jpg",
    videoLocalPath: "/library-assets/content-units/I000991/media/captured-video/video.mp4",
    stats: { likes: "10" },
    parseState: "success",
  };
  for (const parseState of ["failed", "retry_wait", "waiting_login", "waiting_verification"]) {
    const next = applyExtraction(card, {
      parseState,
      parseStatus: "本次不可用",
      title: "空壳标题",
      coverUrl: "https://shell.test/cover.jpg",
      parseEvidence: ["诊断"],
    });
    assert.equal(next.title, card.title);
    assert.equal(next.body, card.body);
    assert.equal(next.coverLocalPath, card.coverLocalPath);
    assert.equal(next.videoLocalPath, card.videoLocalPath);
    assert.equal(next.parseState, parseState);
  }
});

test("retry_wait keeps generation and retry schedule on the original card", () => {
  const card = {
    id: "I000038",
    generation: 4,
    title: "待整理：抖音链接",
    parseState: "extracting",
  };
  const next = applyExtraction(card, {
    parseState: "retry_wait",
    captureState: "retry_wait",
    parseStatus: "抖音暂时不可用，稍后自动继续",
    errorCode: "PLATFORM_UNAVAILABLE",
    retryable: true,
    attempt: 3,
    retryAfterMs: 45000,
    nextRetryAt: "2026-07-29T10:00:45.000Z",
  });
  assert.equal(next.id, "I000038");
  assert.equal(next.generation, 4);
  assert.equal(next.parseState, "retry_wait");
  assert.equal(next.attempt, 3);
  assert.equal(next.nextRetryAt, "2026-07-29T10:00:45.000Z");
});

test("legacy reference objects accept canonical ID fields and discard invalid IDs", () => {
  const ids = collectReferencedInspirationIds({
    activeProject: { references: [{ contentId: "I000101" }, { referenceContentId: "I000102" }, { id: "C000001" }] },
    projects: [{ relationships: { referenceContentIds: ["I000103", "bad"] } }],
  });
  assert.deepEqual([...ids].sort(), ["I000101", "I000102", "I000103"]);
});

test("inspiration sorting is deterministic and keeps collection time independent from later edits", () => {
  const items = [
    { id: "I000003", capturedAt: "2026.08.03 10:00", updatedAt: "2026.08.06 10:00", publishedAt: "2026.07.01 10:00", stats: { likes: "1.2万", favorites: "20" } },
    { id: "I000001", capturedAt: "2026.08.05 10:00", updatedAt: "2026.08.05 10:00", publishedAt: "2026.08.01 10:00", stats: { likes: "999", favorites: "2.3万" } },
    { id: "I000002", capturedAt: "2026.08.04 10:00", updatedAt: "2026.08.04 10:00", publishedAt: "", stats: { likes: "15000", favorites: "3" } },
  ];
  assert.deepEqual(sortInspirationItems(items).map((item) => item.id), ["I000001", "I000002", "I000003"]);
  assert.deepEqual(sortInspirationItems(items, { sort: "collected_asc" }).map((item) => item.id), ["I000003", "I000002", "I000001"]);
  assert.deepEqual(sortInspirationItems(items, { sort: "published_desc" }).map((item) => item.id), ["I000001", "I000003", "I000002"]);
  assert.deepEqual(sortInspirationItems(items, { sort: "likes_desc" }).map((item) => item.id), ["I000002", "I000003", "I000001"]);
  assert.deepEqual(sortInspirationItems(items, { sort: "favorites_desc" }).map((item) => item.id), ["I000001", "I000003", "I000002"]);
  assert.deepEqual(sortInspirationItems(items, {
    sort: "recently_referenced",
    linkedInspirationIds: new Set(["I000003"]),
  }).map((item) => item.id), ["I000003", "I000001", "I000002"]);
});

test("recent collection keeps new ISO cards ahead of legacy dotted timestamps", () => {
  const items = [
    { id: "I000023", capturedAt: "2026.07.26 00:04" },
    { id: "I000056", capturedAt: "2026-08-06T12:03:12.783Z" },
  ];
  assert.deepEqual(sortInspirationItems(items).map((item) => item.id), ["I000056", "I000023"]);
});

test("attention filter finds unfinished captures, missing media, and local videos without a transcript", () => {
  assert.equal(requiresInspirationAttention({ parseState: "waiting_login" }), true);
  assert.equal(requiresInspirationAttention({ refreshState: "retry_wait", parseState: "success" }), true);
  assert.equal(requiresInspirationAttention({ mediaAvailability: "missing" }), true);
  assert.equal(requiresInspirationAttention({ videoLocalPath: "/library-assets/content-units/I000001/media/captured-video/video.mp4" }), true);
  assert.equal(requiresInspirationAttention({ videoLocalPath: "/library-assets/content-units/I000001/media/captured-video/video.mp4", transcript: "已有逐字稿" }), false);
  assert.equal(requiresInspirationAttention({ parseState: "success", mediaAvailability: "available" }), false);
});

test("Eagle video media does not make a Library body depend on Eagle annotation", () => {
  const importedVideo = {
    eagleItemId: "MSVH3PO1X15ZC",
    captionStorage: "library_body",
    body: "腾讯云已生成的逐字稿",
    transcript: "腾讯云已生成的逐字稿",
  };
  assert.equal(usesEagleAnnotation(importedVideo), false);
  assert.equal(usesEagleAnnotation({ ...importedVideo, captionStorage: "eagle_annotation" }), true);
  assert.equal(usesEagleAnnotation({ ...importedVideo, captionEagleItemId: "MSVH3PO1X15ZC" }), true);
});
