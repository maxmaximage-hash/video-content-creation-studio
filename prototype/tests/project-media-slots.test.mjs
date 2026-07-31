import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeProjectMediaSlot,
  normalizedProjectMediaAssets,
  projectMediaSlotProjection,
  removeProjectMediaSlotReference,
} from "../src/services/project-media-slots.js";

function asset(id, role, accountRole = "") {
  return {
    id,
    role,
    ...(accountRole ? { accountRole } : {}),
    name: `${id}.mp4`,
    src: `/library-assets/content-units/C000901/media/${role === "source_video" ? "source-video" : "finished-video"}/${id}.mp4`,
    relativePath: `content-units/C000901/media/${role === "source_video" ? "source-video" : "finished-video"}/${id}.mp4`,
  };
}

test("projects four canonical media assets into stable role and account slots", () => {
  const project = {
    id: "C000901",
    mediaAssets: [
      asset("finished-ip", "finished_video", "ip"),
      asset("source-blogger", "source_video", "blogger"),
      asset("finished-blogger", "finished_video", "blogger"),
      asset("source-ip", "source_video", "ip"),
    ],
  };
  const projection = projectMediaSlotProjection(project);
  assert.deepEqual(
    projection.slots.map((slot) => [slot.key, slot.asset?.id]),
    [
      ["source_video:blogger", "source-blogger"],
      ["source_video:ip", "source-ip"],
      ["finished_video:blogger", "finished-blogger"],
      ["finished_video:ip", "finished-ip"],
    ],
  );
  assert.deepEqual(projection.legacyOverflow, []);
});

test("legacy assets are projected without mutating or inventing account ownership", () => {
  const project = {
    id: "C000901",
    mediaAssets: [
      asset("legacy-source", "source_video"),
      asset("legacy-finished-a", "finished_video"),
      asset("legacy-finished-b", "finished_video"),
      asset("legacy-finished-c", "finished_video"),
    ],
  };
  const before = JSON.stringify(project);
  const projection = projectMediaSlotProjection(project);
  assert.equal(projection.slots[0].asset.id, "legacy-source");
  assert.equal(projection.slots[0].legacy, true);
  assert.equal(projection.slots[2].asset.id, "legacy-finished-a");
  assert.equal(projection.slots[3].asset.id, "legacy-finished-b");
  assert.equal(projection.legacyOverflow[0].id, "legacy-finished-c");
  assert.equal(projection.legacyOverflow[0].legacyAccountRole, true);
  assert.equal(JSON.stringify(project), before);
});

test("replacing and deleting one slot preserves the other three assets", () => {
  const initial = {
    id: "C000901",
    unitSchemaVersion: 1,
    mediaAssets: [
      asset("source-blogger", "source_video", "blogger"),
      asset("source-ip", "source_video", "ip"),
      asset("finished-blogger", "finished_video", "blogger"),
      asset("finished-ip", "finished_video", "ip"),
    ],
  };
  const replacement = asset("source-blogger-new", "source_video", "blogger");
  const replaced = mergeProjectMediaSlot(initial, {
    role: "source_video",
    accountRole: "blogger",
    media: replacement,
    replacementId: "source-blogger",
  });
  assert.deepEqual(
    projectMediaSlotProjection(replaced).slots.map((slot) => slot.asset?.id),
    ["source-blogger-new", "source-ip", "finished-blogger", "finished-ip"],
  );

  const removed = removeProjectMediaSlotReference(replaced, {
    role: "finished_video",
    accountRole: "ip",
    mediaId: "finished-ip",
    relativePath: asset("finished-ip", "finished_video", "ip").relativePath,
  });
  assert.deepEqual(
    normalizedProjectMediaAssets(removed).map((item) => item.id).sort(),
    ["finished-blogger", "source-blogger-new", "source-ip"],
  );
});
