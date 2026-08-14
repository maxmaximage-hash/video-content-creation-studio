import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { test, expect } from "@playwright/test";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("opening a library with a legacy active-project duplicate does not rewrite it", async ({ page, request }) => {
  const project = {
    id: "C000321",
    origin: "original",
    title: "只读启动保护",
    body: "",
    category: "",
    covers: [],
    references: [],
    mediaAssets: [],
    creationStatus: "in_progress",
    completedAt: null,
    workflow: {
      stage: "creating",
      creationStatus: "in_progress",
      completedAt: null,
    },
  };
  const response = await request.post("/api/library", {
    data: {
      categories: [],
      inspirations: [],
      projects: [project],
      archive: [],
      activeProject: project,
    },
  });
  expect(response.ok()).toBeTruthy();
  const library = await response.json();
  const indexPath = path.join(library.storage.libraryDir, "library.json");
  const before = await fs.readFile(indexPath);
  let writeRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/library") writeRequests += 1;
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "灵感库", exact: true })).toBeVisible();
  await page.waitForTimeout(900);

  const after = await fs.readFile(indexPath);
  expect(writeRequests).toBe(0);
  expect(sha256(after)).toBe(sha256(before));
});

test("cold startup keeps a queued legacy active project read-only and stays on inspirations", async ({ page, request }) => {
  const inspirations = [1, 2, 3].map((index) => ({
    id: `I00999${index}`,
    origin: "captured",
    title: `抖音成功卡 ${index}`,
    body: "",
    platform: "抖音",
    parseState: "success",
    acquisitionState: "acquired",
    parseStatus: "已获得本地素材",
    videoLocalPath: `/library-assets/content-units/I00999${index}/media/captured-video/video.mp4`,
    mediaAssets: [{
      id: `video-${index}`,
      role: "captured_video",
      order: 1,
      src: `/library-assets/content-units/I00999${index}/media/captured-video/video.mp4`,
      relativePath: `content-units/I00999${index}/media/captured-video/video.mp4`,
    }],
  }));
  const queuedActiveProject = {
    id: "C009991",
    origin: "original",
    title: "遗留待发布 active",
    body: "",
    covers: [],
    references: [],
    mediaAssets: [],
    creationStatus: "in_progress",
    workflow: {
      stage: "ready_to_publish",
      creationStatus: "in_progress",
      completedAt: null,
    },
  };
  const response = await request.post("/api/library", {
    data: {
      categories: [],
      userDefinedCategories: [],
      inspirations,
      projects: [],
      archive: [],
      activeProject: queuedActiveProject,
    },
  });
  expect(response.ok()).toBeTruthy();
  const library = await response.json();
  const indexPath = path.join(library.storage.libraryDir, "library.json");
  const before = await fs.readFile(indexPath);
  let writeRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/library") writeRequests += 1;
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "灵感库", exact: true })).toBeVisible();
  await expect(page.getByLabel("主导航").getByRole("button", { name: "灵感库", exact: true })).toHaveClass(/active/);
  await page.waitForTimeout(900);

  const after = await fs.readFile(indexPath);
  const current = await (await request.get("/api/library")).json();
  expect(writeRequests).toBe(0);
  expect(sha256(after)).toBe(sha256(before));
  expect(current.activeProject?.id).toBe(queuedActiveProject.id);
  expect(current.projects).toEqual([]);
  expect(current.inspirations.map((item) => item.id)).toEqual(inspirations.map((item) => item.id));
});

test("a real creation edit still autosaves after a read-only cold startup", async ({ page, request }) => {
  const activeProject = {
    id: "C009992",
    origin: "original",
    title: "修改前标题",
    body: "",
    covers: [],
    references: [],
    mediaAssets: [],
    creationStatus: "in_progress",
    workflow: {
      stage: "creating",
      creationStatus: "in_progress",
      completedAt: null,
    },
  };
  const response = await request.post("/api/library", {
    data: {
      categories: [],
      userDefinedCategories: [],
      inspirations: [],
      projects: [],
      archive: [],
      activeProject,
    },
  });
  expect(response.ok()).toBeTruthy();
  const library = await response.json();
  const indexPath = path.join(library.storage.libraryDir, "library.json");
  const before = await fs.readFile(indexPath);
  let writeRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/library") writeRequests += 1;
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "灵感库", exact: true })).toBeVisible();
  await page.waitForTimeout(700);
  expect(writeRequests).toBe(0);
  expect(sha256(await fs.readFile(indexPath))).toBe(sha256(before));

  await page.getByLabel("主导航").getByRole("button", { name: "编辑", exact: true }).click();
  await page.locator(".title-input").fill("用户修改后的标题");
  await expect.poll(async () => {
    const current = await (await request.get("/api/library")).json();
    return current.activeProject?.title;
  }).toBe("用户修改后的标题");

  expect(writeRequests).toBeGreaterThan(0);
  expect(sha256(await fs.readFile(indexPath))).not.toBe(sha256(before));
});
