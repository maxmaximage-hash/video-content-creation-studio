import assert from "node:assert/strict";
import test from "node:test";
import { classifyDouyinFallbackResponse, douyinAdapter } from "../server/platforms/douyin.mjs";
import { xiaohongshuAdapter } from "../server/platforms/xiaohongshu.mjs";
import { bilibiliAdapter } from "../server/platforms/bilibili.mjs";
import { instagramAdapter } from "../server/platforms/instagram.mjs";
import { wechatChannelsAdapter } from "../server/platforms/wechat-channels.mjs";
import { youtubeAdapter } from "../server/platforms/youtube.mjs";
import { platformChallengeFromUrl, platformKeyFromValue } from "../server/platforms/index.mjs";

test("Douyin and Xiaohongshu policies keep ports, hosts, and challenge rules isolated", () => {
  assert.equal(douyinAdapter.port, 9331);
  assert.equal(xiaohongshuAdapter.port, 9332);
  assert.equal(douyinAdapter.matchesHost("www.douyin.com"), true);
  assert.equal(douyinAdapter.matchesHost("www.xiaohongshu.com"), false);
  assert.equal(xiaohongshuAdapter.matchesHost("www.xiaohongshu.com"), true);
  assert.equal(xiaohongshuAdapter.matchesHost("www.douyin.com"), false);
  assert.equal(platformChallengeFromUrl("https://rmc.bytedance.com/verify"), "douyin");
  assert.equal(platformChallengeFromUrl("https://www.xiaohongshu.com/website-login/captcha"), "xiaohongshu");
  assert.equal(platformKeyFromValue("https://v.douyin.com/abc"), "douyin");
  assert.equal(platformKeyFromValue("https://xhslink.com/abc"), "xiaohongshu");
});

test("six platform adapters keep independent profiles and host matching", () => {
  const adapters = [douyinAdapter, xiaohongshuAdapter, bilibiliAdapter, wechatChannelsAdapter, youtubeAdapter, instagramAdapter];
  assert.deepEqual(adapters.map((adapter) => adapter.port), [9331, 9332, 9333, 9334, 9335, 9336]);
  assert.equal(platformKeyFromValue("https://www.bilibili.com/video/BV1xx"), "bilibili");
  assert.equal(platformKeyFromValue("https://channels.weixin.qq.com/platform/post/abc"), "wechat-channels");
  assert.equal(platformKeyFromValue("https://youtu.be/abc"), "youtube");
  assert.equal(platformKeyFromValue("https://www.instagram.com/reel/abc/"), "instagram");
});

test("encrypt_data_miss/11110 is a retryable fallback outage", () => {
  const failure = classifyDouyinFallbackResponse({
    status_code: 11110,
    status_msg: "encrypt_data_miss",
  });
  assert.equal(failure.blocked, true);
  assert.equal(failure.parserContractFailure, false);
  assert.equal(failure.retryable, true);
  assert.equal(failure.errorCode, "FALLBACK_UNAVAILABLE");
});
