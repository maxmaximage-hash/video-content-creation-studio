import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const prototypeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function currentStorage(request) {
  const response = await request.get("/api/library");
  expect(response.ok()).toBeTruthy();
  return (await response.json()).storage;
}

async function writeFixtureFile(storage, relativePath, content = "fixture-video") {
  const targetPath = path.join(storage.libraryDir, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content);
}

async function seedLibrary(request, { projects = [], archive = [], inspirations = [] }) {
  const response = await request.post("/api/library", {
    data: {
      categories: ["教程", "旅行记录"],
      userDefinedCategories: ["教程", "旅行记录"],
      inspirations,
      projects,
      archive,
      activeProject: null,
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function openArchive(page) {
  await page.goto("/");
  await page.getByRole("button", { name: /^归档/ }).click();
  await expect(page.getByRole("heading", { name: "归档", exact: true })).toBeVisible();
}

test("publish immediately archives ordered videos and preserves canonical relationships", async ({ page, request }) => {
  const storage = await currentStorage(request);
  const firstPath = "content-units/C000971/media/finished-video/first.mp4";
  const secondPath = "content-units/C000971/media/finished-video/second.mp4";
  await writeFixtureFile(storage, firstPath, "first-video");
  await writeFixtureFile(storage, secondPath, "second-video");
  await seedLibrary(request, {
    inspirations: [
      { id: "I000701", title: "关系一" },
      { id: "I000702", title: "关系二" },
      { id: "I000703", title: "关系三" },
    ],
    projects: [{
      id: "C000971",
      unitSchemaVersion: 1,
      origin: "original",
      title: "发布后立即归档",
      body: "完整正文用于验证复制全文和发布快照持久化。",
      category: "教程",
      categoryAssignedByUser: true,
      covers: ["/assets/covers/coffee-alley.png"],
      relationships: { referenceContentIds: ["I000701"] },
      references: ["I000702", { id: "I000703" }, { id: "I000701" }],
      mediaAssets: [
        { id: "finished-second", role: "finished_video", order: 2, name: "second.mp4", src: `/library-assets/${secondPath}`, relativePath: secondPath },
        { id: "finished-first", role: "finished_video", order: 1, name: "first.mp4", src: `/library-assets/${firstPath}`, relativePath: firstPath },
      ],
      creationStatus: "completed",
      workflow: { stage: "ready_to_publish", creationStatus: "completed", completedAt: "2026-07-24T01:00:00.000Z" },
    }],
  });

  await page.addInitScript(() => {
    window.__archiveCopied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(value) {
          window.__archiveCopied.push(value);
        },
      },
    });
  });
  const revealPayloads = [];
  await page.route("**/api/project-actions", async (route) => {
    revealPayloads.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ revealed: true, state: "available" }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /^待发布/ }).click();
  const queueCard = page.locator('[data-project-id="C000971"]');
  await queueCard.getByRole("button", { name: "发布", exact: true }).click();
  await page.getByRole("button", { name: "发布并进入归档", exact: true }).click();

  const record = page.locator('[data-archive-id="C000971"]');
  await expect(record).toBeVisible();
  await expect(page.getByRole("heading", { name: "归档", exact: true })).toBeVisible();
  await expect(queueCard).toHaveCount(0);
  await expect(record.locator(".archive-video")).toHaveCount(2);
  await expect(record.locator(".archive-video video")).toHaveCount(2);
  await expect(record.locator(".archive-video-grid img")).toHaveCount(0);
  await expect(record.locator(".archive-video figcaption span")).toHaveText(["first.mp4", "second.mp4"]);
  await expect(record).not.toContainText(/精修|V1|V2/);
  await expect(page.getByText("测试资料库在线")).toHaveCount(0);
  await expect(page.getByText("模拟匹配媒体")).toHaveCount(0);

  await record.getByRole("button", { name: "复制标题", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("标题已复制");
  await record.getByRole("button", { name: "复制全文", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("全文已复制");
  await expect.poll(() => page.evaluate(() => window.__archiveCopied)).toEqual([
    "发布后立即归档",
    "完整正文用于验证复制全文和发布快照持久化。",
  ]);

  const firstVideo = record.locator(".archive-video").first();
  await firstVideo.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "成品视频 · 账号未标注 1操作" })).toBeVisible();
  await page.getByRole("menuitem", { name: "在访达中显示", exact: true }).click();
  await expect.poll(() => revealPayloads.length).toBe(1);

  await firstVideo.getByRole("button", { name: "更多操作：成品视频 · 账号未标注 1", exact: true }).click();
  await page.getByRole("menuitem", { name: "在访达中显示", exact: true }).click();
  await expect.poll(() => revealPayloads.length).toBe(2);
  expect(revealPayloads).toEqual([
    {
      action: "reveal",
      projectId: "C000971",
      relativePath: firstPath,
      scope: "finished_video",
    },
    {
      action: "reveal",
      projectId: "C000971",
      relativePath: firstPath,
      scope: "finished_video",
    },
  ]);

  let library;
  await expect.poll(async () => {
    library = await (await request.get("/api/library")).json();
    return {
      projects: library.projects.length,
      archiveIds: library.archive.map((item) => item.id),
    };
  }).toEqual({ projects: 0, archiveIds: ["C000971"] });
  expect(library.archive[0].workflow.stage).toBe("published");
  expect(library.archive[0].matched).toBe(false);
  expect(library.archive[0].relationships.referenceContentIds).toEqual(["I000701", "I000702", "I000703"]);
  expect(library.archive[0].references).toEqual(["I000701", "I000702", "I000703"]);
  expect(library.archive[0].referenceCount).toBe(3);
  expect(library.inspirations.every((item) => !Object.hasOwn(item, "isLinked"))).toBeTruthy();

  const manifest = JSON.parse(await fs.readFile(
    path.join(storage.libraryDir, "content-units/C000971/manifest.json"),
    "utf8",
  ));
  expect(manifest.relationships.referenceContentIds).toEqual(["I000701", "I000702", "I000703"]);

  await page.reload();
  await page.getByRole("button", { name: /^归档/ }).click();
  await expect(page.locator('[data-archive-id="C000971"] .archive-video')).toHaveCount(2);
});

test("archive renders zero, canonical and all legacy finished video shapes without fake slots", async ({ page, request }) => {
  const storage = await currentStorage(request);
  const availablePath = "content-units/C000973/media/finished-video/available.mp4";
  const legacyAPath = "content-units/C000974/final/legacy-a.mp4";
  const legacyMissingPath = "content-units/C000974/final/legacy-missing.mp4";
  const finishedLegacyPath = "assets/projects/C000975/finished-legacy.mp4";
  await writeFixtureFile(storage, availablePath);
  await writeFixtureFile(storage, legacyAPath);
  await writeFixtureFile(storage, finishedLegacyPath);

  await seedLibrary(request, {
    archive: [
      {
        id: "C000972",
        unitSchemaVersion: 1,
        title: "没有成品视频",
        body: "封面只在没有成品视频时作为后备。",
        covers: ["/assets/covers/mountain-trail.png"],
        workflow: { stage: "published" },
        publishedAt: "07.24 09:00",
      },
      {
        id: "C000973",
        unitSchemaVersion: 1,
        title: "旧单条成品",
        body: "兼容 finalVideo。",
        finalVideo: { id: "legacy-single", name: "available.mp4", src: `/library-assets/${availablePath}`, relativePath: availablePath },
        workflow: { stage: "published" },
        publishedAt: "07.24 09:01",
      },
      {
        id: "C000974",
        unitSchemaVersion: 1,
        title: "旧多条成品",
        body: "兼容 finalVideos。",
        finalVideos: [
          { id: "legacy-a", order: 2, name: "legacy-a.mp4", src: `/library-assets/${legacyAPath}`, relativePath: legacyAPath },
          { id: "legacy-missing", order: 1, name: "legacy-missing.mp4", src: `/library-assets/${legacyMissingPath}`, relativePath: legacyMissingPath },
        ],
        workflow: { stage: "published" },
        publishedAt: "07.24 09:02",
      },
      {
        id: "C000975",
        unitSchemaVersion: 1,
        title: "旧 finishedVideos",
        body: "兼容 finishedVideos 且不创建版本槽。",
        finishedVideos: [
          { id: "finished-legacy", name: "finished-legacy.mp4", src: `/library-assets/${finishedLegacyPath}`, relativePath: finishedLegacyPath },
        ],
        workflow: { stage: "published" },
        publishedAt: "07.24 09:03",
      },
      {
        id: "C000976",
        unitSchemaVersion: 1,
        title: "无合法托管路径",
        body: "可以保留媒体引用，但不能伪装可在访达定位。",
        mediaAssets: [
          { id: "external-finished", role: "finished_video", order: 1, name: "external.mp4", src: "https://example.invalid/external.mp4" },
        ],
        workflow: { stage: "published" },
        publishedAt: "07.24 09:04",
      },
    ],
  });

  await openArchive(page);
  const emptyRecord = page.locator('[data-archive-id="C000972"]');
  const finalVideoRecord = page.locator('[data-archive-id="C000973"]');
  const finalVideosRecord = page.locator('[data-archive-id="C000974"]');
  const finishedVideosRecord = page.locator('[data-archive-id="C000975"]');
  const invalidRecord = page.locator('[data-archive-id="C000976"]');

  await expect(emptyRecord.locator(".archive-video")).toHaveCount(0);
  await expect(emptyRecord.getByText("未添加成品视频", { exact: true })).toBeVisible();
  await expect(emptyRecord.getByText("未上传", { exact: true })).toBeVisible();
  await expect(emptyRecord.locator(".archive-fallback img")).toHaveCount(1);
  await expect(finalVideoRecord.locator(".archive-video")).toHaveCount(1);
  await expect(finalVideosRecord.locator(".archive-video")).toHaveCount(2);
  await expect(finalVideosRecord.locator(".archive-video figcaption span")).toHaveText(["legacy-missing.mp4", "legacy-a.mp4"]);
  await expect(finishedVideosRecord.locator(".archive-video")).toHaveCount(1);
  await expect(finalVideoRecord.getByText("可用", { exact: true })).toBeVisible();
  await expect(finalVideosRecord.locator(".archive-asset-state.state-missing")).toHaveText("文件缺失");
  await expect(finishedVideosRecord.getByText("可用", { exact: true })).toBeVisible();
  await expect(page.locator(".archive-phase1")).not.toContainText(/精修|V1|V2/);

  await invalidRecord.getByRole("button", { name: "更多操作：成品视频 · 账号未标注 1", exact: true }).click();
  const invalidMenuItem = page.getByRole("menuitem", { name: /在访达中显示/ });
  await expect(invalidMenuItem).toBeDisabled();
  await expect(invalidMenuItem.locator("small")).toHaveText("无托管路径");
});

test("offline is display-only and never rewrites the archived reference as missing", async ({ page, request }) => {
  const offlinePath = "content-units/C000977/media/finished-video/offline.mp4";
  const archived = {
    id: "C000977",
    unitSchemaVersion: 1,
    title: "网络卷离线记录",
    body: "离线时仍保留发布快照和媒体引用。",
    mediaAssets: [{
      id: "offline-video",
      role: "finished_video",
      order: 1,
      name: "offline.mp4",
      src: `/library-assets/${offlinePath}`,
      relativePath: offlinePath,
    }],
    relationships: { referenceContentIds: ["I000777"] },
    references: ["I000777"],
    referenceCount: 1,
    matched: true,
    path: "legacy/archive/C000977",
    workflow: { stage: "published" },
    publishedAt: "07.24 09:05",
  };
  await seedLibrary(request, { archive: [archived] });
  await page.route("**/api/project-assets/status", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "当前资料库或所在卷不可访问", assetState: "offline" }),
    });
  });

  await openArchive(page);
  const record = page.locator('[data-archive-id="C000977"]');
  await expect(record.locator(".archive-asset-state.state-offline")).toHaveText("离线");
  await expect(record).not.toContainText("文件缺失");
  await record.locator(".archive-video").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /在访达中显示/ })).toBeDisabled();

  const library = await (await request.get("/api/library")).json();
  expect(library.archive).toHaveLength(1);
  expect(library.archive[0].mediaAssets[0].relativePath).toBe(offlinePath);
  expect(library.archive[0].matched).toBe(true);
  expect(library.archive[0].path).toBe("legacy/archive/C000977");
  expect(library.archive[0].relationships.referenceContentIds).toEqual(["I000777"]);
  expect(library.archive[0].mediaAssets[0].assetState).toBeUndefined();
});

test("archive records keep media and actions inside their desktop layout", async ({ page, request }) => {
  await seedLibrary(request, {
    archive: [
      {
        id: "C000978",
        unitSchemaVersion: 1,
        title: "多视频桌面布局不会挤压操作区",
        body: "这是一段足够长的正文，用于检查卡片在不同桌面宽度下不会覆盖复制按钮、媒体状态或相邻内容。".repeat(3),
        mediaAssets: [
          { id: "layout-1", role: "finished_video", order: 1, name: "一条名称较长的成品视频文件.mp4", src: "/assets/layout-1.mp4" },
          { id: "layout-2", role: "finished_video", order: 2, name: "第二条名称较长的成品视频文件.mp4", src: "/assets/layout-2.mp4" },
          { id: "layout-3", role: "finished_video", order: 3, name: "第三条名称较长的成品视频文件.mp4", src: "/assets/layout-3.mp4" },
        ],
        workflow: { stage: "published" },
        publishedAt: "07.24 09:06",
      },
      {
        id: "C000979",
        unitSchemaVersion: 1,
        title: "零视频后备布局",
        body: "封面后备与复制区保持稳定。",
        covers: ["/assets/covers/creator-desk.png"],
        workflow: { stage: "published" },
        publishedAt: "07.24 09:07",
      },
    ],
  });

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
    { width: 1600, height: 1000 },
  ]) {
    await page.setViewportSize(viewport);
    await openArchive(page);
    const layout = await page.locator(".archive-phase1").evaluate((root) => {
      const selectors = [
        ".archive-record",
        ".archive-video-grid",
        ".archive-copy-field",
        ".archive-copy-button",
      ];
      const elements = selectors.flatMap((selector) => [...root.querySelectorAll(selector)]);
      return {
        pageOverflow: root.scrollWidth > root.clientWidth + 1,
        overflowingElements: elements
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => element.className),
      };
    });
    expect(layout).toEqual({ pageOverflow: false, overflowingElements: [] });
  }
});
