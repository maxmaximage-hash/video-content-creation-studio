import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeLibraryRelativePath,
  validateContentId,
  validateProjectAssetPath,
  validateReadableLibraryAssetPath,
} from "../server/path-security.mjs";

test("content IDs and library-relative paths use strict canonical syntax", () => {
  assert.equal(validateContentId("C000001"), "C000001");
  assert.equal(validateContentId("I000001"), "I000001");
  for (const value of ["", "C1", "X000001", "C00000A", "C../../tmp", "C000001/other"]) {
    assert.throws(() => validateContentId(value), /内容 ID 无效/);
  }
  for (const value of ["../outside", "/tmp/file", "content-units//file", "content-units/./file", "content-units\\C000001\\file"]) {
    assert.throws(() => normalizeLibraryRelativePath(value), /素材路径无效/);
  }
});

test("project asset scopes cannot cross roles or content units", () => {
  assert.equal(validateProjectAssetPath({
    contentId: "C000001",
    relativePath: "content-units/C000001/covers/cover.jpg",
    scope: "cover",
  }), "content-units/C000001/covers/cover.jpg");
  assert.equal(validateProjectAssetPath({
    contentId: "C000001",
    relativePath: "assets/projects/C000001/final/final.mp4",
    scope: "finished_video",
  }), "assets/projects/C000001/final/final.mp4");
  assert.throws(() => validateProjectAssetPath({
    contentId: "C000001",
    relativePath: "content-units/C000001/manifest.json",
    scope: "cover",
  }), /只能访问当前内容单元/);
  assert.throws(() => validateProjectAssetPath({
    contentId: "C000001",
    relativePath: "content-units/C000002/covers/cover.jpg",
    scope: "cover",
  }), /只能访问当前内容单元/);
});

test("library asset reads are limited to canonical and explicit legacy roots", () => {
  assert.equal(
    validateReadableLibraryAssetPath("content-units/I000001/media/captured-video/video.mp4"),
    "content-units/I000001/media/captured-video/video.mp4",
  );
  assert.equal(validateReadableLibraryAssetPath("assets/videos/video.mp4"), "assets/videos/video.mp4");
  assert.throws(() => validateReadableLibraryAssetPath("library.json"), /不在允许的资料库目录/);
  assert.throws(() => validateReadableLibraryAssetPath("content-units/Cbad/file.mp4"), /内容 ID 无效/);
});
