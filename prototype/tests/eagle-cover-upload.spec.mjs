import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

const projectId = "C009991";
const folderId = "MS8R943CBJV6L";
const ipProjectId = "C009992";
const ipFolderId = "MSHM7I3KNXBML";
test.setTimeout(300000);
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
  const uploadResponses = [];
  page.on("response", (response) => {
    if (response.url().includes(`/api/covers?projectId=${projectId}&accountRole=blogger`)) {
      uploadResponses.push(response);
    }
  });
  await chooser.setFiles(coverFiles);

  await expect.poll(() => uploadResponses.length, { timeout: 150000 }).toBe(3);
  for (const response of uploadResponses) {
    expect(response.status()).toBe(201);
  }
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

test("内容库 IP 号封面导入 IP Eagle 文件夹后才显示并写入索引", async ({ page, request }, testInfo) => {
  test.skip(process.env.VIDEO_STUDIO_EAGLE_LIVE !== "1", "需要显式启用本机 Eagle 实测");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-studio-eagle-ip-cover-"));
  const coverFile = path.join(tempDir, `eagle-ip-cover-${testInfo.workerIndex}-${Date.now()}.png`);
  const bytes = await fs.readFile(coverSourceFiles[0]);
  await fs.writeFile(coverFile, Buffer.concat([bytes, Buffer.from(`\\nvideo-studio-ip-e2e-${Date.now()}`)]));

  const eagleBase = "http://127.0.0.1:41595/api";
  const listEagleItems = async () => {
    const response = await request.get(`${eagleBase}/item/list?folders=${ipFolderId}&limit=1000`);
    expect(response.ok()).toBeTruthy();
    const payload = await response.json();
    return Array.isArray(payload.data) ? payload.data : [];
  };
  const before = await listEagleItems();
  const seed = await request.post("/api/library", {
    data: {
      categories: [],
      userDefinedCategories: [],
      inspirations: [],
      projects: [{
        id: ipProjectId,
        title: "IP Eagle 封面逐文件验收",
        body: "",
        covers: [],
        mediaAssets: [],
        workflow: { stage: "ready_to_publish", creationStatus: "in_progress", completedAt: null },
        createdAt: "2026.08.11 12:00",
      }],
      archive: [],
      activeProject: null,
    },
  });
  expect(seed.ok()).toBeTruthy();

  await page.goto("/");
  await page.getByRole("button", { name: "内容库", exact: true }).click();
  const ipColumn = page.locator(`[data-project-id="${ipProjectId}"] [data-account-role="ip"]`);
  const chooserPromise = page.waitForEvent("filechooser");
  await ipColumn.getByRole("button", { name: "添加封面", exact: true }).click();
  const chooser = await chooserPromise;
  const uploadResponsePromise = page.waitForResponse((response) => (
    response.url().includes(`/api/covers?projectId=${ipProjectId}&accountRole=ip`)
  ));
  await chooser.setFiles(coverFile);

  const uploadResponse = await uploadResponsePromise;
  expect(uploadResponse.status()).toBe(201);
  await expect(ipColumn.locator(".queue-cover-item")).toHaveCount(1);
  await expect.poll(async () => (await listEagleItems()).length).toBe(before.length + 1);

  const after = await listEagleItems();
  const newItem = after.find((item) => !before.some((oldItem) => oldItem.id === item.id));
  expect(newItem).toBeTruthy();
  const infoResponse = await request.get(`${eagleBase}/item/info?id=${encodeURIComponent(newItem.id)}`);
  expect(infoResponse.ok()).toBeTruthy();
  const info = (await infoResponse.json()).data;
  expect(info.folders).toContain(ipFolderId);
  expect(info.size).toBeGreaterThan(0);
  expect(String(info.ext || "").toLowerCase()).toMatch(/png|jpg|jpeg|webp/);

  await expect.poll(async () => {
    const library = await (await request.get("/api/library")).json();
    return library.projects?.find((project) => project.id === ipProjectId)?.covers?.length || 0;
  }).toBe(1);
  const library = await (await request.get("/api/library")).json();
  const cover = library.projects.find((project) => project.id === ipProjectId).covers[0];
  expect(cover).toMatchObject({ accountRole: "ip", eagleItemId: newItem.id, eagleFolderId: ipFolderId });
  expect(cover.relativePath).toBeFalsy();
  expect(String(cover.src || "")).not.toMatch(/^\/library-assets\//);
  if (library.storage?.libraryDir) {
    expect(await filesBelow(path.join(library.storage.libraryDir, "content-units", ipProjectId, "covers"))).toEqual([]);
  }
  await fs.rm(tempDir, { recursive: true, force: true });
});
