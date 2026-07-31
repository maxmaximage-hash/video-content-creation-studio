import assert from "node:assert/strict";
import test from "node:test";
import { applyExtraction, collectReferencedInspirationIds } from "../src/features/inspirations/inspiration-model.js";

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
