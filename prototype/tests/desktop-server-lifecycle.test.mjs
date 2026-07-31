import assert from "node:assert/strict";
import test from "node:test";
import { createReusableServerLifecycle } from "../desktop/server-lifecycle.mjs";

test("desktop windows reuse one local server and close it once", async () => {
  let starts = 0;
  let closes = 0;
  const lifecycle = createReusableServerLifecycle(
    async () => ({ id: ++starts }),
    async () => { closes += 1; },
  );

  const [first, second] = await Promise.all([lifecycle.get(), lifecycle.get()]);
  const reopened = await lifecycle.get();
  assert.equal(starts, 1);
  assert.equal(first, second);
  assert.equal(reopened, first);

  await lifecycle.close();
  await lifecycle.close();
  assert.equal(closes, 1);
});

test("desktop local server can retry after startup failure", async () => {
  let starts = 0;
  const lifecycle = createReusableServerLifecycle(
    async () => {
      starts += 1;
      if (starts === 1) throw new Error("temporary startup failure");
      return { id: starts };
    },
    async () => {},
  );

  await assert.rejects(lifecycle.get(), /temporary startup failure/);
  assert.deepEqual(await lifecycle.get(), { id: 2 });
});
