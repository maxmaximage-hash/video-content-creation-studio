import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { mockEagleUploads } from "./eagle-upload-mock.mjs";

const projectId = "C000981";

test.beforeEach(async ({ page }) => {
  await mockEagleUploads(page);
});

async function seedProject(request, patch = {}) {
  const response = await request.post("/api/library", {
    data: {
      categories: [],
      userDefinedCategories: [],
      inspirations: [],
      projects: [],
      archive: [],
      activeProject: {
        id: projectId,
        unitSchemaVersion: 1,
        origin: "original",
        title: "双账号视频测试",
        body: "博主号和 IP 号必须各自保留原素材与成品视频。",
        covers: [],
        references: [],
        category: "",
        mediaAssets: [],
        creationStatus: "completed",
        workflow: { stage: "creating", creationStatus: "completed", completedAt: "2026-07-30T00:00:00.000Z" },
        ...patch,
      },
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function uploadByButton(page, label, name) {
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: `上传${label}`, exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name,
    mimeType: "video/mp4",
    buffer: Buffer.from(`00000020ftypisom-${name}`),
  });
  await expect(page.locator(".toast")).toContainText("已保存到资料库");
}

test("four Eagle account slots persist through creation, queue, and archive", async ({ page, request }) => {
  await seedProject(request);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.addInitScript(() => {
    window.__dragPayloads = [];
    window.videoContentDesktop = {
      startFileDrag(payload) {
        window.__dragPayloads.push(payload);
      },
    };
  });
  await page.goto("/");
  await page.getByLabel("主导航").getByRole("button", { name: "编辑", exact: true }).click();

  await uploadByButton(page, "原素材 · 博主号", "source-blogger.mp4");
  await uploadByButton(page, "成品视频 · 博主号", "finished-blogger.mp4");
  await page.getByLabel("编辑账号").getByRole("button", { name: "IP 号", exact: true }).click();
  await uploadByButton(page, "原素材 · IP 号", "source-ip.mp4");

  const finishedIpSlot = page.getByRole("button", { name: "上传成品视频 · IP 号", exact: true });
  await finishedIpSlot.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(
      [new TextEncoder().encode("00000020ftypisom-finished-ip")],
      "finished-ip.mp4",
      { type: "video/mp4" },
    ));
    element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });

  await expect.poll(async () => {
    const library = await (await request.get("/api/library")).json();
    return library.activeProject?.mediaAssets?.map((asset) => `${asset.role}:${asset.accountRole}`).sort();
  }).toEqual([
    "finished_video:blogger",
    "finished_video:ip",
    "source_video:blogger",
    "source_video:ip",
  ]);
  await expect(page.locator(".project-media-slot.has-media")).toHaveCount(2);

  await page.getByRole("button", { name: "保存到创作台", exact: true }).click();
  const queueCard = page.locator(`[data-project-id="${projectId}"]`);
  for (const [accountRole, labels] of [
    ["blogger", ["原素材", "成品"]],
    ["ip", ["原素材", "成品"]],
  ]) {
    const accountMedia = queueCard.locator(`[data-account-role="${accountRole}"] .queue-account-media`);
    for (const label of labels) {
      await expect(accountMedia.locator(".queue-media-card").filter({ hasText: label })).toHaveCount(1);
    }
  }
  const queueCoverBase64 = (await fs.readFile(path.join(process.cwd(), "public/assets/covers/coffee-alley.png"))).toString("base64");
  const emptyQueueCoverTarget = queueCard.getByLabel("博主号封面图片区域", { exact: true });
  await emptyQueueCoverTarget.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "queue-external-drop.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, queueCoverBase64);
  await expect(queueCard.getByTestId(`expanded-covers-${projectId}`).locator("img")).toHaveCount(1);
  await expect.poll(async () => {
    const library = await (await request.get("/api/library")).json();
    return library.projects.find((project) => project.id === projectId)?.covers?.[0]?.name;
  }).toBe("queue-external-drop.png");
  const mediaRects = await queueCard.locator(".queue-account-media > .queue-media-card").evaluateAll((cards) => (
    cards.map((card) => {
      const rect = card.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
      };
    })
  ));
  const mediaRows = mediaRects.reduce((counts, rect) => counts.set(rect.top, (counts.get(rect.top) || 0) + 1), new Map());
  expect([...mediaRows.values()].sort()).toEqual([2, 2]);
  expect(mediaRects.every((rect) => rect.width >= 120)).toBe(true);
  expect(mediaRects.some((rect, index) => mediaRects.slice(index + 1).some((other) => (
    rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top
  )))).toBe(false);
  await page.screenshot({ path: path.join(process.cwd(), "qa/dual-account-queue-1920.png"), fullPage: true });

  const finishedIpCard = queueCard.locator('[data-account-role="ip"] .queue-media-card').filter({ hasText: "finished-ip.mp4" });
  await expect(finishedIpCard).toHaveAttribute("draggable", "false");
  await finishedIpCard.evaluate((surface) => {
    surface.dispatchEvent(new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer: new DataTransfer(),
    }));
  });
  expect(await page.evaluate(() => window.__dragPayloads)).toEqual([]);

  await queueCard.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: /^归档库/ }).click();
  const archiveRecord = page.locator(`[data-archive-id="${projectId}"]`);
  await expect(archiveRecord.locator(".archive-video")).toHaveCount(2);
  await expect(archiveRecord.getByText("成品视频 · 博主号", { exact: true })).toBeVisible();
  await expect(archiveRecord.getByText("成品视频 · IP 号", { exact: true })).toBeVisible();

  let library;
  await expect.poll(async () => {
    library = await (await request.get("/api/library")).json();
    return library.archive.some((item) => item.id === projectId);
  }).toBe(true);
  const archived = library.archive.find((item) => item.id === projectId);
  expect(archived.mediaAssets.map((asset) => `${asset.role}:${asset.accountRole}`).sort()).toEqual([
    "finished_video:blogger",
    "finished_video:ip",
    "source_video:blogger",
    "source_video:ip",
  ]);
  expect(archived.mediaAssets.every((asset) => asset.eagleItemId && !asset.relativePath)).toBe(true);
  const manifestPath = path.join(library.storage.libraryDir, "content-units", projectId, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  expect(manifest.mediaAssets.map((asset) => `${asset.role}:${asset.accountRole}`).sort()).toEqual([
    "finished_video:blogger",
    "finished_video:ip",
    "source_video:blogger",
    "source_video:ip",
  ]);
  expect(manifest.mediaAssets.every((asset) => asset.eagleItemId && !asset.relativePath)).toBe(true);
});

test("permanent deletion removes exactly one account slot file and keeps the other three", async ({ page, request }) => {
  const library = await (await request.get("/api/library")).json();
  const mediaDefinitions = [
    ["source-blogger", "source_video", "blogger"],
    ["source-ip", "source_video", "ip"],
    ["finished-blogger", "finished_video", "blogger"],
    ["finished-ip", "finished_video", "ip"],
  ];
  const mediaAssets = [];
  for (const [id, role, accountRole] of mediaDefinitions) {
    const folder = role === "source_video" ? "source-video" : "finished-video";
    const relativePath = `content-units/${projectId}/media/${folder}/${id}.mp4`;
    await fs.mkdir(path.dirname(path.join(library.storage.libraryDir, relativePath)), { recursive: true });
    await fs.writeFile(path.join(library.storage.libraryDir, relativePath), id);
    mediaAssets.push({
      id,
      role,
      accountRole,
      order: accountRole === "ip" ? 2 : 1,
      name: `${id}.mp4`,
      src: `/library-assets/${relativePath}`,
      relativePath,
    });
  }
  await seedProject(request, {
    mediaAssets,
    workflow: { stage: "ready_to_publish", creationStatus: "completed", completedAt: "2026-07-30T00:00:00.000Z" },
  });
  const current = await (await request.get("/api/library")).json();
  const queued = await request.post("/api/library", {
    data: {
      ...current,
      activeProject: null,
      projects: [current.activeProject],
    },
  });
  expect(queued.ok()).toBeTruthy();

  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/");
  await page.getByRole("button", { name: /^创作台/ }).click();
  const queueCard = page.locator(`[data-project-id="${projectId}"]`);
  const target = queueCard.locator('[data-account-role="ip"] .queue-media-card').filter({ hasText: "原素材" });
  await target.hover();
  await target.getByRole("button", { name: "永久删除原素材 · IP 号", exact: true }).click();

  await expect.poll(async () => {
    const next = await (await request.get("/api/library")).json();
    return next.projects[0].mediaAssets.map((asset) => asset.id).sort();
  }).toEqual(["finished-blogger", "finished-ip", "source-blogger"]);
  await expect(queueCard.locator('[data-account-role="ip"] .queue-account-media').getByRole("button", { name: /原素材.*点击或拖入视频/ })).toBeVisible();
  expect(await fs.stat(path.join(library.storage.libraryDir, mediaAssets[1].relativePath)).then(() => true).catch(() => false)).toBe(false);
  for (const media of [mediaAssets[0], mediaAssets[2], mediaAssets[3]]) {
    expect(await fs.stat(path.join(library.storage.libraryDir, media.relativePath)).then(() => true).catch(() => false)).toBe(true);
  }
});
