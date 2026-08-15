import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mockEagleUploads } from "./eagle-upload-mock.mjs";

const projectId = "C000951";
const prototypeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test.beforeEach(async ({ page }) => {
  await mockEagleUploads(page);
});

async function storage(request) {
  const response = await request.get("/api/library");
  expect(response.ok()).toBeTruthy();
  return (await response.json()).storage;
}

async function seedQueue(request, projectPatch = {}) {
  const response = await request.post("/api/library", {
    data: {
      categories: ["教程", "旅行记录"],
      userDefinedCategories: ["教程", "旅行记录"],
      inspirations: [],
      archive: [],
      activeProject: null,
      projects: [{
        id: projectId,
        unitSchemaVersion: 1,
        origin: "original",
        title: "待发布直传测试",
        body: "用于验证上传、分类、预览和原生拖拽的隔离内容。",
        category: "教程",
        categoryAssignedByUser: true,
        covers: [],
        references: [],
        mediaAssets: [],
        creationStatus: "in_progress",
        workflow: { stage: "ready_to_publish", creationStatus: "in_progress", completedAt: null },
        ...projectPatch,
      }],
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function openQueue(page) {
  await page.goto("/");
  await page.getByRole("button", { name: /^创作台/ }).click();
  await expect(page.locator(`[data-project-id="${projectId}"]`)).toBeVisible();
  return page.locator(`[data-project-id="${projectId}"]`);
}

async function uploadFromCard(page, card, label, files) {
  const accountRole = label.includes("IP 号") ? "ip" : "blogger";
  const displayLabel = label.startsWith("原素材") ? "原素材" : "成品";
  const chooserPromise = page.waitForEvent("filechooser");
  await card.locator(`[data-account-role="${accountRole}"] .queue-account-media`)
    .getByRole("button", { name: new RegExp(`${displayLabel}.*点击或拖入视频`) })
    .click();
  const chooser = await chooserPromise;
  await chooser.setFiles(files);
}

test("queue uploads source and ordered finished videos, then persists category", async ({ page, request }) => {
  await seedQueue(request);
  const card = await openQueue(page);
  const makeVideo = (name, marker) => ({ name, mimeType: "video/mp4", buffer: Buffer.from(`fixture-${marker}`) });

  await uploadFromCard(page, card, "原素材 · 博主号", makeVideo("source.mp4", "source"));
  await expect(card.locator(".queue-media-card").filter({ hasText: "source.mp4" })).toBeVisible();
  await uploadFromCard(page, card, "成品视频 · 博主号", makeVideo("finished-a.mp4", "a"));
  await uploadFromCard(page, card, "成品视频 · IP 号", makeVideo("finished-b.mp4", "b"));
  await expect(card.locator(".queue-media-card").filter({ hasText: "finished-a.mp4" })).toBeVisible();
  await expect(card.locator(".queue-media-card").filter({ hasText: "finished-b.mp4" })).toBeVisible();
  await expect(card.locator('[data-account-role="blogger"]')).toContainText("成品");
  await expect(card.locator('[data-account-role="ip"]')).toContainText("成品");
  await expect(card).not.toContainText(/精修|V1|V2/);

  await card.getByLabel("待发布直传测试分类").selectOption("旅行记录");
  await expect.poll(async () => {
    const response = await request.get("/api/library");
    const project = (await response.json()).projects.find((item) => item.id === projectId);
    return {
      category: project.category,
      roles: project.mediaAssets.map((asset) => asset.role),
      accountRoles: project.mediaAssets.map((asset) => asset.accountRole),
      orders: project.mediaAssets.filter((asset) => asset.role === "finished_video").map((asset) => asset.order),
      eagleItemIds: project.mediaAssets.map((asset) => asset.eagleItemId),
      paths: project.mediaAssets.map((asset) => asset.relativePath || ""),
    };
  }).toEqual({
    category: "旅行记录",
    roles: ["source_video", "finished_video", "finished_video"],
    accountRoles: ["blogger", "blogger", "ip"],
    orders: [1, 2],
    eagleItemIds: [
      expect.stringMatching(/^EAGLE-(?:MEDIA|UI)-/),
      expect.stringMatching(/^EAGLE-(?:MEDIA|UI)-/),
      expect.stringMatching(/^EAGLE-(?:MEDIA|UI)-/),
    ],
    paths: ["", "", ""],
  });

  await page.reload();
  await page.getByRole("button", { name: /^创作台/ }).click();
  await expect(page.getByLabel("待发布直传测试分类")).toHaveValue("旅行记录");
  await expect(page.locator(`[data-project-id="${projectId}"] .queue-media-card`).filter({ hasText: "finished-b.mp4" })).toBeVisible();
});

test("media cards keep fixed geometry across hover preview and click playback", async ({ page, request }) => {
  const currentStorage = await storage(request);
  const relativePath = `content-units/${projectId}/media/source-video/source.mp4`;
  const filePath = path.join(currentStorage.libraryDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "fixture-video");
  await seedQueue(request, {
    mediaAssets: [{
      id: "source-1",
      role: "source_video",
      order: 1,
      name: "source.mp4",
      src: `/library-assets/${relativePath}`,
      relativePath,
    }],
  });
  await page.addInitScript(() => {
    const playing = new WeakSet();
    Object.defineProperty(HTMLMediaElement.prototype, "paused", {
      configurable: true,
      get() {
        return !playing.has(this);
      },
    });
    HTMLMediaElement.prototype.play = function play() {
      playing.add(this);
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function pause() {
      playing.delete(this);
      this.dispatchEvent(new Event("pause"));
    };
  });

  const card = await openQueue(page);
  const mediaCard = card.locator(".queue-media-card").filter({ hasText: "source.mp4" });
  const before = await mediaCard.boundingBox();
  await mediaCard.hover();
  await page.waitForTimeout(340);
  await expect.poll(() => mediaCard.locator("video").evaluate((video) => ({ paused: video.paused, muted: video.muted }))).toEqual({ paused: false, muted: true });
  await page.mouse.move(10, 10);
  await expect.poll(() => mediaCard.locator("video").evaluate((video) => video.paused)).toBe(true);
  await mediaCard.click();
  await expect.poll(() => mediaCard.locator("video").evaluate((video) => ({ paused: video.paused, muted: video.muted }))).toEqual({ paused: false, muted: false });
  expect(await mediaCard.boundingBox()).toEqual(before);
});

test("surfaces have no overlay tools and right-click exposes only Finder in browser preview", async ({ page, request }) => {
  const currentStorage = await storage(request);
  const relativePath = `content-units/${projectId}/covers/cover.png`;
  const filePath = path.join(currentStorage.libraryDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.copyFile(path.join(prototypeRoot, "public/assets/covers/coffee-alley.png"), filePath);
  await seedQueue(request, {
    covers: [{ id: "cover-1", name: "cover.png", src: `/library-assets/${relativePath}`, relativePath }],
  });
  const card = await openQueue(page);
  await expect(card.getByRole("button", { name: "在访达中显示", exact: true })).toHaveCount(0);
  await expect(card.locator(".queue-native-drag-handle")).toHaveCount(0);
  await expect(card.locator(".queue-cover-sort-handle, .queue-target-menu-button")).toHaveCount(0);
  await expect(card.locator(".queue-cover-remove")).toHaveCount(1);
  await expect(card.locator(".queue-cover-remove")).toHaveCSS("opacity", "0");
  await expect(card.locator("svg.lucide-ellipsis, svg.lucide-more-horizontal")).toHaveCount(0);
  await expect(card).not.toContainText("拖到 Finder 或剪映");

  await card.click({ button: "right", position: { x: 16, y: 16 } });
  await expect(page.getByRole("menu", { name: "项目目录操作" })).toBeVisible();
  await expect(page.getByRole("menu", { name: "项目目录操作" }).getByRole("menuitem")).toHaveCount(1);
  await expect(page.getByRole("menuitem", { name: /在访达中显示/ })).toBeEnabled();
  await page.keyboard.press("Escape");

  const cover = card.locator(".queue-cover-item").first();
  await expect(cover).toHaveAttribute("draggable", "false");
  await cover.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "封面 1操作" })).toBeVisible();
  await expect(page.getByRole("menu", { name: "封面 1操作" }).getByRole("menuitem")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await cover.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: /在访达中显示/ })).toBeVisible();
});

test("mocked Electron bridge receives structured drag payload from media and cover surfaces", async ({ page, request }) => {
  const currentStorage = await storage(request);
  const coverRelativePath = `content-units/${projectId}/covers/cover.png`;
  const mediaRelativePath = `content-units/${projectId}/media/finished-video/final.mp4`;
  await fs.mkdir(path.dirname(path.join(currentStorage.libraryDir, coverRelativePath)), { recursive: true });
  await fs.mkdir(path.dirname(path.join(currentStorage.libraryDir, mediaRelativePath)), { recursive: true });
  await fs.copyFile(path.join(prototypeRoot, "public/assets/covers/coffee-alley.png"), path.join(currentStorage.libraryDir, coverRelativePath));
  await fs.writeFile(path.join(currentStorage.libraryDir, mediaRelativePath), "video");
  await seedQueue(request, {
    covers: [{ id: "cover-1", name: "cover.png", src: `/library-assets/${coverRelativePath}`, relativePath: coverRelativePath }],
    mediaAssets: [{ id: "finished-1", role: "finished_video", order: 1, name: "final.mp4", src: `/library-assets/${mediaRelativePath}`, relativePath: mediaRelativePath }],
  });
  await page.addInitScript(() => {
    window.__dragPayloads = [];
    window.videoContentDesktop = {
      startFileDrag(payload) {
        window.__dragPayloads.push(payload);
      },
    };
  });
  const card = await openQueue(page);
  const mediaSurface = card.locator(".queue-media-card").filter({ hasText: "final.mp4" });
  await expect(mediaSurface).toHaveAttribute("draggable", "true");
  await mediaSurface.evaluate((surface) => {
    surface.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  });
  await expect.poll(() => page.evaluate(() => window.__dragPayloads)).toEqual([{
    projectId,
    relativePath: mediaRelativePath,
    scope: "finished_video",
    sessionId: currentStorage.sessionId,
    name: "final.mp4",
  }]);

  const cover = card.locator(".queue-cover-item").first();
  await expect(cover).toHaveAttribute("draggable", "true");
  await cover.evaluate((surface) => {
    surface.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  });
  await expect.poll(() => page.evaluate(() => window.__dragPayloads)).toEqual([
    {
      projectId,
      relativePath: mediaRelativePath,
      scope: "finished_video",
      sessionId: currentStorage.sessionId,
      name: "final.mp4",
    },
    {
      projectId,
      relativePath: coverRelativePath,
      scope: "cover",
      sessionId: currentStorage.sessionId,
      name: "cover.png",
    },
  ]);
  await expect(card.locator(".queue-cover-sort-handle, .queue-native-drag-handle")).toHaveCount(0);
});

test("queue inline edits persist without activeProject duplication", async ({ page, request }) => {
  await seedQueue(request, {
    title: "同源编辑初始标题",
    body: "同源编辑初始正文",
    category: "教程",
  });
  const seeded = await (await request.get("/api/library")).json();
  const reseed = await request.post("/api/library", {
    data: {
      ...seeded,
      projects: [{
        id: "C000950",
        title: "保持在队首的项目",
        body: "用于验证保存不改变排序",
        category: "教程",
        covers: [],
        references: [],
        mediaAssets: [],
        creationStatus: "in_progress",
        workflow: { stage: "ready_to_publish", creationStatus: "in_progress" },
      }, ...seeded.projects],
    },
  });
  expect(reseed.ok()).toBeTruthy();
  const card = await openQueue(page);
  const title = card.getByLabel("博主号标题", { exact: true });
  const body = card.getByLabel("博主号正文", { exact: true });
  await title.fill("Queue 修改后的完整标题不会截断");
  await body.fill("Queue 修改后的正文，进入创作页必须立即可见。");
  await card.getByLabel("Queue 修改后的完整标题不会截断分类").selectOption("旅行记录");

  const bodyGeometry = await body.evaluate((element) => {
    const style = getComputedStyle(element);
    return { overflowY: style.overflowY, resize: style.resize, minHeight: style.minHeight, maxHeight: style.maxHeight };
  });
  expect(bodyGeometry).toEqual({ overflowY: "auto", resize: "vertical", minHeight: "110px", maxHeight: "260px" });
  await expect.poll(async () => {
    const library = await (await request.get("/api/library")).json();
    const edited = library.projects.find((project) => project.id === projectId);
    return {
      title: edited?.title,
      body: edited?.body,
      category: edited?.category,
      activeProject: library.activeProject,
    };
  }).toEqual({
    title: "Queue 修改后的完整标题不会截断",
    body: "Queue 修改后的正文，进入创作页必须立即可见。",
    category: "旅行记录",
    activeProject: null,
  });

  await page.reload();
  await page.getByRole("button", { name: /^创作台/ }).click();

  const returnedCard = page.locator(`[data-project-id="${projectId}"]`);
  await expect(returnedCard).toBeVisible();
  await expect(returnedCard.getByLabel("博主号标题", { exact: true })).toHaveValue("Queue 修改后的完整标题不会截断");
  await expect(returnedCard.getByLabel("博主号正文", { exact: true })).toHaveValue("Queue 修改后的正文，进入创作页必须立即可见。");
  await expect(returnedCard.getByLabel("Queue 修改后的完整标题不会截断分类")).toHaveValue("旅行记录");
  await expect.poll(async () => {
    const library = await (await request.get("/api/library")).json();
    const edited = library.projects.find((project) => project.id === projectId);
    return {
      projectIds: library.projects.map((project) => project.id),
      title: edited?.title,
      activeProject: library.activeProject,
    };
  }).toEqual({ projectIds: ["C000950", projectId], title: "Queue 修改后的完整标题不会截断", activeProject: null });
});

test("legacy ready_to_publish active project deterministically merges into projects", async ({ page, request }) => {
  await seedQueue(request, { title: "旧 projects 副本" });
  const response = await request.post("/api/library", {
    data: {
      categories: ["教程"],
      userDefinedCategories: ["教程"],
      inspirations: [],
      archive: [],
      projects: [
        { id: "C000950", title: "前一项", body: "", covers: [], references: [], mediaAssets: [] },
        { id: projectId, title: "旧 projects 副本", body: "", covers: [], references: [], mediaAssets: [] },
      ],
      activeProject: {
        id: projectId,
        title: "active 中的最新版本",
        body: "必须归并回原索引",
        covers: [],
        references: [],
        mediaAssets: [],
        creationStatus: "in_progress",
        workflow: { stage: "ready_to_publish", creationStatus: "in_progress" },
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto("/");
  await page.getByRole("button", { name: /^创作台/ }).click();
  await expect(page.locator(`[data-project-id="${projectId}"]`).getByLabel("博主号标题")).toHaveValue("active 中的最新版本");
  const library = await (await request.get("/api/library")).json();
  expect({
    ids: library.projects.map((project) => project.id),
    title: library.projects.find((project) => project.id === projectId)?.title,
    activeTitle: library.activeProject?.title,
  }).toEqual({ ids: ["C000950", projectId], title: "旧 projects 副本", activeTitle: "active 中的最新版本" });
});

test("Vite rejects invalid IDs, traversal and symlink escapes for uploads and reads", async ({ request }) => {
  const invalidUpload = await request.post("/api/project-media?projectId=C..%2Foutside&role=source_video&accountRole=blogger&uploadId=test-invalid-0001", {
    headers: {
      "content-type": "video/mp4",
      "x-file-name": encodeURIComponent("source.mp4"),
    },
    data: Buffer.from("fixture"),
  });
  expect(invalidUpload.status()).toBe(400);

  const traversal = await request.get("/library-assets/content-units/C000951/%2e%2e%2flibrary.json");
  expect([400, 403]).toContain(traversal.status());

  const currentStorage = await storage(request);
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-vite-outside-"));
  const outsideVideo = path.join(outsideDir, "outside.mp4");
  const readLink = path.join(currentStorage.libraryDir, "assets/videos/escape.mp4");
  const writeLink = path.join(currentStorage.libraryDir, "content-units/C000954");
  await fs.writeFile(outsideVideo, "outside");
  await fs.mkdir(path.dirname(readLink), { recursive: true });
  await fs.rm(readLink, { force: true });
  await fs.symlink(outsideVideo, readLink);
  await fs.rm(writeLink, { recursive: true, force: true });
  await fs.symlink(outsideDir, writeLink);
  try {
    const escapedRead = await request.get("/library-assets/assets/videos/escape.mp4");
    expect(escapedRead.status()).toBe(403);
    const escapedWrite = await request.post("/api/project-media?projectId=C000954&role=source_video&accountRole=blogger&uploadId=test-escape-0001", {
      headers: {
        "content-type": "video/mp4",
        "x-file-name": encodeURIComponent("source.mp4"),
      },
      data: Buffer.from("fixture"),
    });
    expect([403, 502, 503]).toContain(escapedWrite.status());
    expect((await fs.readdir(outsideDir)).sort()).toEqual(["outside.mp4"]);
  } finally {
    await fs.rm(readLink, { force: true });
    await fs.rm(writeLink, { force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});
