import assert from "node:assert/strict";
import test from "node:test";
import { extractXiaohongshuFromHtml } from "../server/xiaohongshu.mjs";

test("extracts every image and unified fields from the target Xiaohongshu note", () => {
  const html = `
    <html><head><meta property="og:image" content="https://fallback.example/cover.jpg"></head>
    <body><script>
      window.__INITIAL_STATE__ = {
        "note": {"noteDetailMap": {
          "other-note": {"note": {"noteId":"other-note","title":"错误候选","imageList":[{"urlDefault":"https://img.example/wrong.jpg"}]}},
          "abc123": {"note": {
            "noteId":"abc123",
            "title":"三张图完整笔记",
            "desc":"正文和话题都保留",
            "type":"normal",
            "user":{"nickname":"阿青"},
            "time":1784700000000,
            "interactInfo":{"likedCount":"1024","collectedCount":"88","commentCount":"31","shareCount":"9"},
            "imageList":[
              {"urlDefault":"https://img.example/01.webp","urlPre":"https://img.example/01-small.webp","width":1080,"height":1440},
              {"urlDefault":"https://img.example/02.webp","width":1080,"height":1440},
              {"urlPre":"https://img.example/03.webp","width":1080,"height":1440}
            ],
            "optional": undefined
          }}
        }}
      };
    </script></body></html>`;

  const result = extractXiaohongshuFromHtml({
    html,
    originalUrl: "https://www.xiaohongshu.com/explore/abc123",
  });

  assert.equal(result.platformItemId, "abc123");
  assert.equal(result.title, "三张图完整笔记");
  assert.equal(result.body, "正文和话题都保留");
  assert.equal(result.author, "阿青");
  assert.equal(result.contentType, "image");
  assert.deepEqual(result.images.map((image) => image.sourceUrl), [
    "https://img.example/01.webp",
    "https://img.example/02.webp",
    "https://img.example/03.webp",
  ]);
  assert.deepEqual(result.stats, { likes: "1024", favorites: "88", comments: "31", shares: "9", views: "" });
});

test("keeps the video branch separate from the image gallery", () => {
  const state = {
    note: {
      noteDetailMap: {
        video789: {
          note: {
            noteId: "video789",
            title: "视频笔记",
            type: "video",
            user: { nickname: "镜头作者" },
            imageList: [{ urlDefault: "https://img.example/video-cover.jpg" }],
            video: { media: { stream: { h264: [{ masterUrl: "https://video.example/main.mp4" }] } } },
          },
        },
      },
    },
  };
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>`;
  const result = extractXiaohongshuFromHtml({ html, resolvedUrl: "https://www.xiaohongshu.com/explore/video789" });

  assert.equal(result.contentType, "video");
  assert.equal(result.videoUrl, "https://video.example/main.mp4");
  assert.equal(result.images.length, 1);
});

test("public meta tags without a target note candidate remain unmatched diagnostics", () => {
  const result = extractXiaohongshuFromHtml({
    html: '<meta property="og:title" content="公开标题"><meta property="og:image" content="https://img.example/meta.jpg"><meta property="og:description" content="公开正文">',
    originalUrl: "https://www.xiaohongshu.com/explore/meta123",
  });

  assert.equal(result.platformItemId, "meta123");
  assert.equal(result.targetMatched, false);
  assert.equal(result.title, "");
  assert.equal(result.body, "");
  assert.equal(result.coverUrl, "");
  assert.equal(result.images.length, 0);
  assert.equal(result.candidateCount, 0);
});
