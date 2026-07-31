import assert from "node:assert/strict";
import test from "node:test";
import { fetchLoggedPage } from "../vite.config.mjs";

test("fetchLoggedPage records challenge before HTML completion evidence", async () => {
  const evidence = [];
  const page = await fetchLoggedPage(
    "https://www.douyin.com/video/123",
    "douyin",
    evidence,
    {
      capturePage: async () => ({
        authState: "challenge",
        html: "<html><body>请完成验证码</body></html>",
        finalUrl: "https://rmc.bytedance.com/verify",
        responseJsonCandidates: [{ wrong: true }],
      }),
    },
  );

  assert.equal(page.authState, "challenge");
  assert.equal(evidence.some((line) => line.includes("需要手动验证")), true);
  assert.equal(evidence.some((line) => line.includes("抓取完成")), false);
  assert.equal(evidence.some((line) => line.includes("接口 JSON")), false);
});
