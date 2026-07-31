import assert from "node:assert/strict";
import test from "node:test";
import {
  createInFlightDeduper,
  evaluateExtractionQuality,
  retryAfterMs,
  retryWithBackoff,
  isUsableCapturedPage,
  sanitizeDiagnostic,
  xiaohongshuShellReason,
} from "../server/extraction-quality.mjs";
import { extractXiaohongshuFromObjects } from "../server/xiaohongshu.mjs";

test("quality gate rejects shells and requires trustworthy local media", () => {
  assert.equal(xiaohongshuShellReason({ resolvedUrl: "https://www.xiaohongshu.com/explore?undertake_note_error=x", candidateCount: 0 }), "CONTENT_UNAVAILABLE");
  assert.equal(evaluateExtractionQuality({ platformItemId: "1", title: "标题", images: [{ sourceUrl: "https://cdn.test/1.jpg" }] }, {
    authState: "unknown", shellReason: "PUBLIC_SHELL", targetMatched: false,
  }).parseState, "waiting_login");
  assert.equal(evaluateExtractionQuality({ platformItemId: "1", title: "标题", images: [{ sourceUrl: "https://cdn.test/1.jpg" }] }, {
    authState: "authenticated", targetMatched: true,
  }).errorCode, "MEDIA_DOWNLOAD_FAILED");
});

test("success and partial both require local media while partial stays distinct", () => {
  const partial = evaluateExtractionQuality({ platformItemId: "1", title: "标题", images: [{ localPath: "/library-assets/1.jpg" }] }, {
    authState: "authenticated", targetMatched: true,
  });
  assert.equal(partial.parseState, "partial");
  const success = evaluateExtractionQuality({ platformItemId: "1", title: "标题", body: "正文", author: "作者", images: [{ localPath: "/library-assets/1.jpg" }] }, {
    authState: "authenticated", targetMatched: true,
  });
  assert.equal(success.parseState, "success");
});

test("challenge quality uses result.platform and returns waiting_verification without throwing", () => {
  const douyin = evaluateExtractionQuality({ platform: "抖音", platformItemId: "1" }, {
    authState: "challenge",
    targetMatched: false,
  });
  assert.equal(douyin.parseState, "waiting_verification");
  assert.equal(douyin.errorCode, "AUTH_CHALLENGE");
  assert.match(douyin.parseStatus, /抖音/);

  const xiaohongshu = evaluateExtractionQuality({ platform: "小红书", platformItemId: "2" }, {
    authState: "challenge",
    targetMatched: true,
  });
  assert.equal(xiaohongshu.parseState, "waiting_verification");
  assert.match(xiaohongshu.parseStatus, /小红书/);
});

test("challenge capture HTML is never considered usable extraction input", () => {
  assert.equal(isUsableCapturedPage({
    authState: "challenge",
    html: "<html>验证码页面</html>",
    resources: ["https://cdn.test/wrong.mp4"],
  }), false);
  assert.equal(isUsableCapturedPage({
    authState: "authenticated",
    html: "<html>目标内容</html>",
  }), true);
});

test("capture, login, contract, parser, and media failures remain distinct", () => {
  const capture = evaluateExtractionQuality({ platform: "抖音", platformItemId: "1" }, {
    authState: "unknown",
    targetMatched: true,
    captureFailure: {
      stage: "navigation",
      causeCode: "CDP_TARGET_CLOSED",
      error: "Target closed token=secret",
      finalUrl: "https://www.douyin.com/video/1?token=secret",
    },
  });
  assert.equal(capture.errorCode, "AUTH_CAPTURE_FAILED");
  assert.equal(capture.captureStage, "navigation");
  assert.match(capture.diagnosticMessage, /Target closed/);
  assert.doesNotMatch(JSON.stringify(capture), /secret/);

  const contract = evaluateExtractionQuality({ platform: "抖音", platformItemId: "1" }, {
    authState: "unknown",
    targetMatched: true,
    platformFailure: {
      errorCode: "PLATFORM_CONTRACT_CHANGED",
      message: "抖音备用接口签名契约已变化",
      parserContractFailure: true,
    },
  });
  assert.equal(contract.parseState, "blocked");
  assert.equal(contract.errorCode, "PLATFORM_CONTRACT_CHANGED");
  assert.equal(contract.parserContractFailure, true);

  const primaryWins = evaluateExtractionQuality({ platform: "抖音", platformItemId: "1" }, {
    authState: "unknown",
    targetMatched: true,
    captureFailure: {
      stage: "navigation",
      causeCode: "CDP_TARGET_CLOSED",
      error: "Target closed",
    },
    platformFailure: {
      errorCode: "PLATFORM_CONTRACT_CHANGED",
      message: "encrypt_data_miss/11110",
      parserContractFailure: true,
    },
  });
  assert.equal(primaryWins.errorCode, "AUTH_CAPTURE_FAILED");
  assert.equal(primaryWins.captureCauseCode, "CDP_TARGET_CLOSED");

  assert.equal(evaluateExtractionQuality({ platform: "小红书", platformItemId: "1" }, {
    authState: "authenticated",
    targetMatched: true,
  }).errorCode, "MEDIA_DOWNLOAD_FAILED");
  assert.equal(evaluateExtractionQuality({ platform: "小红书" }, {
    authState: "authenticated",
    targetMatched: false,
  }).errorCode, "PARSER_CHANGED");
  assert.match(evaluateExtractionQuality({ platform: "小红书" }, {
    authState: "login_required",
    hasProfile: true,
    targetMatched: false,
  }).errorCode, /AUTH_LOGIN_REQUIRED/);
});

test("feed JSON extraction only marks the requested note as matched", () => {
  const feed = { data: { items: [{ id: "abc123", note_card: {
    title: "真实笔记", desc: "正文", user: { nickname: "Max" },
    image_list: [{ url_default: "https://cdn.test/1.jpg" }],
  } }] } };
  const matched = extractXiaohongshuFromObjects({ objects: [feed], originalUrl: "https://www.xiaohongshu.com/explore/abc123" });
  assert.equal(matched.targetMatched, true);
  assert.equal(matched.platformItemId, "abc123");
  assert.equal(matched.images.length, 1);
  const wrong = extractXiaohongshuFromObjects({ objects: [feed], originalUrl: "https://www.xiaohongshu.com/explore/other" });
  assert.equal(wrong.targetMatched, false);
});

test("retry respects retry hints, caps attempts and deduplicates concurrent work", async () => {
  const waits = [];
  let attempts = 0;
  const value = await retryWithBackoff(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("temporary"), { retryable: true, retryAfterMs: 25 });
    return "ok";
  }, { sleep: async (ms) => waits.push(ms), random: () => 0 });
  assert.equal(value, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [25, 25]);
  assert.equal(retryAfterMs({ headers: { get: () => "2" } }), 2000);

  const deduper = createInFlightDeduper();
  let runs = 0;
  const task = () => deduper.run("I000001", async () => { runs += 1; return "done"; });
  assert.deepEqual(await Promise.all([task(), task(), task()]), ["done", "done", "done"]);
  assert.equal(runs, 1);
});

test("diagnostics redact session material", () => {
  const sanitized = sanitizeDiagnostic("cookie=abc token:def https://cdn.test/a.jpg?xsec_token=secret&width=100");
  assert.doesNotMatch(sanitized, /abc|def|secret/);
  assert.match(sanitized, /width=100/);
});

test("recoverable platform and capture failures enter retry_wait with bounded metadata", () => {
  const now = new Date("2026-07-29T10:00:00.000Z");
  const platform = evaluateExtractionQuality({ platform: "抖音" }, {
    authState: "platform_unavailable",
    attempt: 2,
    now,
  });
  assert.equal(platform.parseState, "retry_wait");
  assert.equal(platform.captureState, "retry_wait");
  assert.equal(platform.errorCode, "PLATFORM_UNAVAILABLE");
  assert.equal(platform.retryable, true);
  assert.equal(platform.attempt, 2);
  assert.ok(platform.retryAfterMs > 0);
  assert.equal(platform.nextRetryAt, new Date(now.getTime() + platform.retryAfterMs).toISOString());

  const capture = evaluateExtractionQuality({ platform: "小红书" }, {
    authState: "unknown",
    attempt: 8,
    retryAfterMs: 900000,
    now,
    captureFailure: {
      stage: "navigation",
      causeCode: "CDP_CONNECTION_FAILED",
      error: "Connection closed",
    },
  });
  assert.equal(capture.parseState, "retry_wait");
  assert.equal(capture.errorCode, "AUTH_CAPTURE_FAILED");
  assert.ok(capture.retryAfterMs <= 300000);
});

test("only explicit unavailable content and parser failures become terminal states", () => {
  const unavailable = evaluateExtractionQuality({ platform: "小红书", platformItemId: "note1" }, {
    authState: "authenticated",
    shellReason: "CONTENT_UNAVAILABLE",
    targetMatched: true,
  });
  assert.equal(unavailable.parseState, "content_unavailable");
  assert.equal(unavailable.retryable, false);

  const parser = evaluateExtractionQuality({ platform: "抖音" }, {
    authState: "authenticated",
    targetMatched: false,
  });
  assert.equal(parser.parseState, "failed");
  assert.equal(parser.errorCode, "PARSER_CHANGED");
  assert.equal(parser.retryable, false);
});
