import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchYoutubeCaption,
  parseGenericPlatformCapture,
  platformItemId,
  youtubeCaptionTrackUrl,
} from "../server/multi-platform-extractor.mjs";

test("platform item identities are stable for Bilibili, YouTube and Instagram", () => {
  assert.equal(platformItemId("bilibili", "https://www.bilibili.com/video/BV1Ab411c7de"), "BV1Ab411c7de");
  assert.equal(platformItemId("youtube", "https://youtu.be/abc123?t=4"), "abc123");
  assert.equal(platformItemId("instagram", "https://www.instagram.com/reel/ABC_12/"), "ABC_12");
});

test("generic capture keeps extended engagement metrics and platform transcript", () => {
  const capture = parseGenericPlatformCapture({
    platform: "bilibili",
    originalUrl: "https://www.bilibili.com/video/BV1Ab411c7de",
    finalUrl: "https://www.bilibili.com/video/BV1Ab411c7de",
    responseJsonCandidates: [{
      title: "标题",
      owner: { name: "作者" },
      transcript: "这是一段平台提供的完整字幕文本。",
      stat: { like: 12, view: 34, danmaku: 5 },
    }],
  });
  assert.equal(capture.title, "标题");
  assert.equal(capture.transcript, "这是一段平台提供的完整字幕文本。");
  assert.equal(capture.stats.likes, "12");
  assert.equal(capture.stats.views, "34");
});

test("YouTube caption track prefers Chinese and converts json3 to plain transcript", async () => {
  const url = youtubeCaptionTrackUrl([{ captions: { playerCaptionsTracklistRenderer: { captionTracks: [
    { languageCode: "en", baseUrl: "https://captions.test/en" },
    { languageCode: "zh-CN", baseUrl: "https://captions.test/zh" },
  ] } } }]);
  assert.equal(url, "https://captions.test/zh");
  const text = await fetchYoutubeCaption(url, {}, async (requestUrl) => {
    assert.equal(new URL(requestUrl).searchParams.get("fmt"), "json3");
    return new Response(JSON.stringify({ events: [
      { segs: [{ utf8: "你好" }, { utf8: "世界" }] },
      { segs: [{ utf8: "世界" }] },
    ] }), { status: 200 });
  });
  assert.equal(text, "你好 世界");
});
