import assert from "node:assert/strict";
import test from "node:test";
import { createPlatformTaskScheduler } from "../server/extraction-scheduler.mjs";

test("same platform content ID and generation deduplicate while generations stay isolated", async () => {
  const scheduler = createPlatformTaskScheduler();
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const task = () => scheduler.run({
    platform: "douyin",
    sessionId: "session-a",
    contentId: "I000038",
    generation: 4,
  }, async () => {
    runs += 1;
    await gate;
    return runs;
  });

  const first = task();
  const duplicate = task();
  release();
  assert.deepEqual(await Promise.all([first, duplicate]), [1, 1]);
  assert.equal(runs, 1);

  await scheduler.run({
    platform: "douyin",
    sessionId: "session-a",
    contentId: "I000038",
    generation: 5,
  }, async () => {
    runs += 1;
  });
  assert.equal(runs, 2);
});

test("Douyin and Xiaohongshu use independent platform queues", async () => {
  const scheduler = createPlatformTaskScheduler();
  const started = [];
  let releaseDouyin;
  const douyinGate = new Promise((resolve) => { releaseDouyin = resolve; });
  const douyin = scheduler.run({
    platform: "douyin",
    sessionId: "session-a",
    contentId: "I000038",
    generation: 1,
  }, async () => {
    started.push("douyin");
    await douyinGate;
  });
  const xiaohongshu = scheduler.run({
    platform: "xiaohongshu",
    sessionId: "session-a",
    contentId: "I000039",
    generation: 1,
  }, async () => {
    started.push("xiaohongshu");
  });

  await xiaohongshu;
  assert.deepEqual(started, ["douyin", "xiaohongshu"]);
  releaseDouyin();
  await douyin;
});
