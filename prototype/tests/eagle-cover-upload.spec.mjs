import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

const projectId = "C009991";
const folderId = "MS8R943CBJV6L";
const coverSourceFiles = [
  path.join(process.cwd(), "public/assets/covers/coffee-alley.png"),
  path.join(process.cwd(), "public/assets/covers/mountain-trail.png"),
  path.join(process.cwd(), "public/assets/covers/creator-desk.png"),
];

async function filesBelow(directory, prefix = "") {
  let entries = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name);
    if (entry.isFile()) files.push(relativePath);
    if (entry.isDirectory()) files.push(...await filesBelow(path.join(directory, entry.name), relativePath));
  }
  return files.sort();
}

test("三张博主号封面逐文件导入 Eagle 后才显示并写入索引", async ({ page, request }, testInfo) => {
  test.skip(process.env.VIDEO_STUDIO_EAGLE_LIVE !== "1", "需要显式启用本机 Eagle 实测");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-studio-eagle-cover-"));
  const coverFiles = await Promise.all(coverSourceFiles.map(async (source, index) => {
    const target = path.join(tempDir, `eagle-cover-${testInfo.workerIndex}-${Date.now()}-${index}.png`);
    const bytes = await fs.readFile(source);
    // Eagle deduplicates byte-identical files. Keep each real-test image valid while
    // making the three import fixtures unique, so the folder-count contract is testable.
    await fs.writeFile(target, Buffer.concat([bytes, Buffer.from(`\\nvideo-studio-e2e-${Date.now()}-${index}`)]));
    return target;
  }));
  const eagleBase = "http://127.0.0.1:41595/api";
  const listEagleItems = async () => {
    const response = await request.get(`${eagleBase}/item/list?folders=${folderId}&limit=1000`);
    expect(response.ok()).toBeTruthy();
    const payload = await response.json();
    return Array.isArray(payload.data) ? payload.data : [];
  };
  const before = await listEagleItems();
  const qaCoverDirectory = path.join(process.cwd(), ".qa-library", "视频内容创作中台 Demo.library", "content-units", projectId, "covers");
  const localCoverFilesBefore = await filesBelow(qaCoverDirectory);

  const seed = await request.post("/api/library", {
    data: {
      categories: [],
      userDefinedCategories: [],
      inspirations: [],
      projects: [],
      archive: [],
      activeProject: {
        id: projectId,
        title: "Eagle 封面逐文件验收",
        body: "",
        covers: [],
        mediaAssets: [],
        references: [],
        createdAt: "2026.08.11 12:00",
      },
    },
  });
  expect(seed.ok()).toBeTruthy();

  await page.goto("/");
  await page.getByLabel("主导航").getByRole("button", { name: "创作", exact: true }).click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "添加封面", exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(coverFiles);

  await expect(page.getByRole("status").filter({ hasText: "已导入 Eagle 并添加 3 张封面" })).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".cover-option")).toHaveCount(3);
  await expect.poll(async () => (await listEagleItems()).length).toBe(before.length + 3);

  const after = await listEagleItems();
  const newItems = after.filter((item) => !before.some((oldItem) => oldItem.id === item.id));
  expect(newItems).toHaveLength(3);
  for (const item of newItems) {
    const infoResponse = await request.get(`${eagleBase}/item/info?id=${encodeURIComponent(item.id)}`);
    expect(infoResponse.ok()).toBeTruthy();
    const info = (await infoResponse.json()).data;
    expect(info.folders).toContain(folderId);
    expect(info.size).toBeGreaterThan(0);
    expect(String(info.ext || "").toLowerCase()).toMatch(/png|jpg|jpeg|webp/);
  }

  await expect.poll(async () => {
    const library = await (await request.get("/api/library")).json();
    return library.activeProject?.covers?.length || 0;
  }).toBe(3);
  const library = await (await request.get("/api/library")).json();
  const covers = library.activeProject.covers;
  expect(covers).toHaveLength(3);
  expect(covers.every((cover) => cover.eagleItemId && cover.eagleFolderId === folderId)).toBe(true);
  expect(covers.every((cover) => !cover.relativePath && !String(cover.src || "").startsWith("/library-assets/"))).toBe(true);
  const libraryDir = library.storage?.libraryDir;
  if (libraryDir) expect(await filesBelow(path.join(libraryDir, "content-units", projectId, "covers"))).toEqual(localCoverFilesBefore);
  await fs.rm(tempDir, { recursive: true, force: true });
});
