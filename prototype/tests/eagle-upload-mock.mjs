import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const previewPath = path.join(testRoot, "../public/assets/covers/coffee-alley.png");

const FOLDERS = {
  "cover:blogger": "MS8R943CBJV6L",
  "cover:ip": "MSHM7I3KNXBML",
  "source_video:blogger": "MSOSLZLAY5RGP",
  "source_video:ip": "MSOSM8ESCD2D0",
  "finished_video:blogger": "MS8R943CBJV6L",
  "finished_video:ip": "MSHM7I3KNXBML",
};

let sequence = 0;

function fileName(request) {
  const encoded = request.headers()["x-file-name"] || "fixture.bin";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export function mockEagleMediaForRequest(request) {
  const url = new URL(request.url());
  const role = url.searchParams.get("role") || "finished_video";
  const accountRole = url.searchParams.get("accountRole") || "blogger";
  const name = fileName(request);
  const eagleItemId = `EAGLE-UI-${Date.now()}-${sequence += 1}`;
  return {
    id: eagleItemId,
    eagleItemId,
    eagleFolderId: FOLDERS[`${role}:${accountRole}`],
    role,
    accountRole,
    order: accountRole === "ip" ? 2 : 1,
    name,
    contentType: request.headers()["content-type"] || "video/mp4",
    size: Number(request.headers()["content-length"] || 1),
    src: `/api/eagle-media/${eagleItemId}`,
  };
}

export async function fulfillMockEagleMediaUpload(route) {
  const media = mockEagleMediaForRequest(route.request());
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ media }),
  });
  return media;
}

export async function mockEagleUploads(page) {
  const preview = await fs.readFile(previewPath);

  await page.route("**/api/covers?*", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    const url = new URL(request.url());
    const accountRole = url.searchParams.get("accountRole") || "blogger";
    const name = fileName(request);
    const eagleItemId = `EAGLE-COVER-${Date.now()}-${sequence += 1}`;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cover: {
          id: eagleItemId,
          eagleItemId,
          eagleFolderId: FOLDERS[`cover:${accountRole}`],
          accountRole,
          name,
          contentType: request.headers()["content-type"] || "image/png",
          size: preview.length,
        },
      }),
    });
  });

  await page.route("**/api/project-media?*", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await fulfillMockEagleMediaUpload(route);
  });

  await page.route("**/api/eagle-media/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: preview });
  });

  await page.route("**/api/project-assets/status", async (route) => {
    const payload = route.request().postDataJSON();
    const states = Object.fromEntries((payload.assets || []).map((asset) => [asset.key, {
      state: asset.eagleItemId || asset.relativePath ? "available" : "not_added",
      eagleItemId: asset.eagleItemId || "",
      eagleFolderId: asset.eagleFolderId || "",
      relativePath: asset.relativePath || "",
    }]));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ states }),
    });
  });
}
