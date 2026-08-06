import assert from "node:assert/strict";
import test from "node:test";
import { canonicalProfileWorkUrl, normalizeProfileEntries } from "../server/profile-scanner.mjs";

test("profile entries normalize and deduplicate six-platform work URLs", () => {
  assert.equal(canonicalProfileWorkUrl("douyin", "/video/7617795110478627401", "https://www.douyin.com/user/test"), "https://www.douyin.com/video/7617795110478627401");
  assert.equal(canonicalProfileWorkUrl("xiaohongshu", "https://www.xiaohongshu.com/discovery/item/6a641c850000000013027c49"), "https://www.xiaohongshu.com/explore/6a641c850000000013027c49");
  assert.equal(canonicalProfileWorkUrl("bilibili", "https://www.bilibili.com/video/BV1Ab411c7de?p=2"), "https://www.bilibili.com/video/BV1Ab411c7de");
  assert.equal(canonicalProfileWorkUrl("youtube", "https://www.youtube.com/shorts/abc123?feature=share"), "https://www.youtube.com/shorts/abc123");
  assert.equal(canonicalProfileWorkUrl("instagram", "https://www.instagram.com/reel/ABC_12/?igsh=secret"), "https://www.instagram.com/reel/ABC_12/");
  const deduped = normalizeProfileEntries("youtube", [
    { href: "https://youtu.be/abc123", text: "one" },
    { href: "https://www.youtube.com/watch?v=abc123", text: "duplicate" },
  ]);
  assert.equal(deduped.length, 1);
});
