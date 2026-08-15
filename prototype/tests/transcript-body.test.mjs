import assert from "node:assert/strict";
import test from "node:test";
import { transcriptBodyPatch } from "../src/services/transcript-body.js";

test("completed transcripts become the library body when no Eagle video exists", () => {
  assert.deepEqual(transcriptBodyPatch({ id: "I000901" }, "  第一段。\n第二段。  ", "hash-1"), {
    body: "第一段。\n第二段。",
    captionStorage: "library_body",
    captionLength: 9,
    captionSha256: "hash-1",
  });
});

test("completed transcripts target the Eagle annotation when an Eagle video exists", () => {
  assert.deepEqual(transcriptBodyPatch({
    id: "I000902",
    mediaAssets: [{ role: "captured_video", eagleItemId: "MSOTJ12T8U5WG" }],
  }, "逐字稿正文", "hash-2"), {
    body: "",
    captionStorage: "eagle_annotation",
    captionEagleItemId: "MSOTJ12T8U5WG",
    captionLength: 5,
    captionSha256: "hash-2",
  });
});
