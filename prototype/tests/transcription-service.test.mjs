import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { transcriptionTestables } from "../server/transcription-service.mjs";

test("Tencent monthly usage check queries recording recognition in China date range", async () => {
  let payload;
  const seconds = await transcriptionTestables.tencentMonthlyUsage({
    secretId: "id",
    secretKey: "key",
    region: "ap-guangzhou",
  }, async (_url, options) => {
    payload = JSON.parse(options.body);
    assert.equal(options.headers["x-tc-action"], "GetUsageByDate");
    assert.equal(options.headers["x-tc-region"], "ap-guangzhou");
    return new Response(JSON.stringify({ Response: { Data: { UsageByDateInfoList: [
      { BizName: "asr_rec", Count: 2, Duration: 135 },
    ] } } }), { status: 200 });
  });
  assert.deepEqual(payload.BizNameList, ["asr_rec"]);
  assert.match(payload.StartDate, /^\d{4}-\d{2}-01$/);
  assert.match(payload.EndDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(seconds, 135);
});

test("cloud audio duration estimate is conservative and transcript formatting is readable", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "asr-estimate-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const audio = path.join(directory, "part.m4a");
  await fs.writeFile(audio, Buffer.alloc(3000));
  assert.ok(await transcriptionTestables.estimatedAudioSeconds([audio]) >= 1);
  assert.equal(transcriptionTestables.formatTranscript(" 你好 。  世界！ "), "你好。\n世界！");
});
