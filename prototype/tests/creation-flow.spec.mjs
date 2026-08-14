import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { fulfillMockEagleMediaUpload, mockEagleUploads } from "./eagle-upload-mock.mjs";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const coffeeCover = path.join(testRoot, "../public/assets/covers/coffee-alley.png");
const mountainCover = path.join(testRoot, "../public/assets/covers/mountain-trail.png");

async function seedCreation(request) {
  const response = await request.post("/api/library", {
    data: {
      categories: [],
      userDefinedCategories: [],
      inspirations: [],
      projects: [],
      archive: [],
      activeProject: {
        id: "C000901",
        title: "可上传封面的完整创作",
        body: "这条内容用于验证封面从本地上传一直贯穿到发布归档。",
        covers: [],
        primaryCoverId: null,
        references: [],
        category: "",
        categoryAssignedByUser: false,
        modified: "刚刚",
        createdAt: "2026.07.23 12:00",
      },
    },
  });
  expect(response.ok()).toBeTruthy();
}

test.beforeEach(async ({ page, request }) => {
  await mockEagleUploads(page);
  await seedCreation(request);
});

test("uploaded cover opens full preview and persists through queue and archive", async ({ page, request }) => {
  const browserErrors = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/");
  await page.getByLabel("主导航").getByRole("button", { name: "编辑", exact: true }).click();
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "添加封面", exact: true }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles([coffeeCover, mountainCover]);

  await expect(page.locator(".cover-option")).toHaveCount(2);
  await expect(page.locator(".toast")).toContainText("已导入 Eagle 并添加 2 张封面");

  expect((await page.locator(".cover-option").allTextContents()).join("")).not.toMatch(/主封面|coffee-alley|mountain-trail/);
  await page.getByRole("button", { name: "放大封面 2", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "封面预览" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "封面预览" }).locator("img")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "封面预览" })).toHaveCount(0);
  await page.locator(".cover-option").first().hover();
  await page.getByRole("button", { name: "移除封面 coffee-alley.png", exact: true }).click();
  await expect(page.locator(".cover-option")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "放大封面 1", exact: true })).toBeVisible();

  let activeProject;
  await expect.poll(async () => {
    const library = await (await request.get("/api/library")).json();
    activeProject = library.activeProject;
    return {
      coverCount: activeProject.covers.length,
      remainingName: activeProject.covers[0]?.name,
    };
  }).toEqual({
    coverCount: 1,
    remainingName: "mountain-trail.png",
  });

  const retainedSource = `/api/eagle-media/${activeProject.covers[0].eagleItemId}`;
  expect(retainedSource).toMatch(/^\/api\/eagle-media\//);
  expect(activeProject.covers[0].eagleItemId).toBeTruthy();
  expect(activeProject.covers[0].relativePath).toBeUndefined();

  await page.getByRole("button", { name: "保存到创作台", exact: true }).click();
  await expect(page.getByTestId("collapsed-covers-C000901")).toContainText("1 张");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: /^归档库/ }).click();

  await expect(page.locator(".archive-record .archive-fallback img")).toHaveAttribute("src", retainedSource);
  let archivedLibrary;
  await expect.poll(async () => {
    archivedLibrary = await (await request.get("/api/library")).json();
    return archivedLibrary.archive.length;
  }).toBe(1);
  expect(archivedLibrary.archive[0].coverLocalPath).toBeUndefined();
  expect(archivedLibrary.archive[0].covers).toHaveLength(1);
  expect(archivedLibrary.archive[0].covers[0].eagleItemId).toBe(activeProject.covers[0].eagleItemId);
  expect(archivedLibrary.activeProject).toBeNull();
  expect(browserErrors).toEqual([]);
});

test("frameless cover target accepts external image drops", async ({ page, request }) => {
  await page.goto("/");
  await page.getByLabel("主导航").getByRole("button", { name: "编辑", exact: true }).click();

  const uploadButton = page.getByRole("button", { name: "添加封面", exact: true });
  await expect(uploadButton).toBeVisible();
  await expect(uploadButton).toHaveCSS("border-top-style", "none");
  await expect(uploadButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(uploadButton).not.toContainText("添加封面");

  const imageBase64 = fs.readFileSync(coffeeCover).toString("base64");
  const dropZone = page.getByLabel("封面图片区域", { exact: true });
  await dropZone.evaluate((element, payload) => {
    const bytes = Uint8Array.from(atob(payload.base64), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], payload.name, { type: "image/png" }));
    window.__coverDropTransfer = transfer;
    element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { base64: imageBase64, name: "external-drop.png" });
  await expect(dropZone).toHaveClass(/is-file-dragging/);

  await dropZone.evaluate((element) => {
    element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: window.__coverDropTransfer }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.__coverDropTransfer }));
    delete window.__coverDropTransfer;
  });

  await expect(dropZone).not.toHaveClass(/is-file-dragging/);
  await expect(page.locator(".cover-option")).toHaveCount(1);
  await expect(page.locator(".toast")).toContainText("已导入 Eagle 并添加 1 张封面");
  await expect.poll(async () => {
    const library = await (await request.get("/api/library")).json();
    return library.activeProject?.covers?.[0]?.name;
  }).toBe("external-drop.png");
});

test("source and dynamic finished videos persist as one content unit and appear in the publish handoff", async ({ page, request }) => {
  await page.goto("/");
  await page.getByLabel("主导航").getByRole("button", { name: "编辑", exact: true }).click();

  const sourceChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传原素材 · 博主号", exact: true }).click();
  const sourceChooser = await sourceChooserPromise;
  await sourceChooser.setFiles({
    name: "source.mov",
    mimeType: "video/quicktime",
    buffer: Buffer.from("00000020ftypisomSOURCE"),
  });
  await expect(page.locator(".toast")).toContainText("已保存到资料库");

  const firstFinishedChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传成品视频 · 博主号", exact: true }).click();
  const firstFinishedChooser = await firstFinishedChooserPromise;
  await firstFinishedChooser.setFiles({
    name: "finished-a.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("00000020ftypisomFINISHED-A"),
  });
  await expect.poll(async () => {
    const current = await (await request.get("/api/library")).json();
    return current.activeProject?.mediaAssets?.filter((asset) => asset.role === "finished_video").length;
  }).toBe(1);
  await expect(page.locator(".project-media-slot.has-media").getByText("成品视频 · 博主号", { exact: true })).toHaveCount(1);

  await page.getByLabel("编辑账号").getByRole("button", { name: "IP 号", exact: true }).click();
  const secondFinishedChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传成品视频 · IP 号", exact: true }).click();
  const secondFinishedChooser = await secondFinishedChooserPromise;
  await secondFinishedChooser.setFiles({
    name: "finished-b.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("00000020ftypisomFINISHED-B"),
  });
  await expect(page.locator(".project-media-slot.has-media").getByText("成品视频 · IP 号", { exact: true })).toHaveCount(1);

  let library;
  await expect.poll(async () => {
    library = await (await request.get("/api/library")).json();
    return library.activeProject?.mediaAssets?.map((asset) => `${asset.role}:${asset.accountRole}:${asset.order}`);
  }).toEqual(["source_video:blogger:1", "finished_video:blogger:1", "finished_video:ip:2"]);

  const contentRoot = path.join(library.storage.libraryDir, "content-units", "C000901");
  const manifest = JSON.parse(fs.readFileSync(path.join(contentRoot, "manifest.json"), "utf8"));
  expect(manifest.mediaAssets.map((asset) => `${asset.role}:${asset.accountRole}:${asset.order}`)).toEqual([
    "source_video:blogger:1",
    "finished_video:blogger:1",
    "finished_video:ip:2",
  ]);
  expect(fs.readFileSync(path.join(contentRoot, "copy/title.txt"), "utf8")).toContain("可上传封面的完整创作");
  for (const asset of manifest.mediaAssets) {
    expect(asset.eagleItemId).toBeTruthy();
    expect(asset.eagleFolderId).toBeTruthy();
    expect(asset.relativePath || "").toBe("");
  }
  await page.screenshot({ path: path.join(testRoot, "../qa/creation-media-handoff.png"), fullPage: true });

  await page.getByRole("button", { name: "保存到创作台", exact: true }).click();
  const card = page.locator('[data-project-id="C000901"]');
  await expect(card.locator('[data-account-role="blogger"]').getByText("原素材", { exact: true })).toBeVisible();
  await expect(card.locator('[data-account-role="blogger"]').getByText("成品", { exact: true })).toBeVisible();
  await expect(card.locator('[data-account-role="ip"]').getByText("成品", { exact: true })).toBeVisible();
  await expect(card).not.toContainText(/精修|V1|V2/);
  await expect(card.getByRole("button", { name: "在访达中显示", exact: true })).toHaveCount(0);
  await expect(card.locator(".queue-native-drag-handle")).toHaveCount(0);
  await card.click({ button: "right", position: { x: 180, y: 24 } });
  await expect(page.getByRole("menu", { name: "项目目录操作" }).getByRole("menuitem")).toHaveCount(1);
  await expect(page.getByRole("menuitem", { name: /在访达中显示/ })).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: path.join(testRoot, "../qa/queue-media-handoff.png"), fullPage: true });
});

test("an in-progress video upload survives navigation away from creation", async ({ page, request }) => {
  let releaseUpload;
  let markUploadStarted;
  const uploadStarted = new Promise((resolve) => {
    markUploadStarted = resolve;
  });
  const uploadGate = new Promise((resolve) => {
    releaseUpload = resolve;
  });

  await page.route("**/api/project-media**", async (route) => {
    markUploadStarted();
    await uploadGate;
    await fulfillMockEagleMediaUpload(route);
  });

  await page.goto("/");
  await page.getByLabel("主导航").getByRole("button", { name: "编辑", exact: true }).click();

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传成品视频 · 博主号", exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "background-upload.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.alloc(256 * 1024, 1),
  });

  await uploadStarted;
  await expect(page.locator(".project-media-progress")).toBeVisible();
  await expect(page.locator(".project-media-progress")).toContainText("上传中");

  await page.getByLabel("主导航").getByRole("button", { name: "创作台", exact: true }).click();
  await expect(page.getByRole("heading", { name: "创作台", exact: true })).toBeVisible();
  await page.getByLabel("主导航").getByRole("button", { name: "编辑", exact: true }).click();

  await expect(page.locator(".project-media-progress")).toBeVisible();
  await expect(page.locator(".project-media-slot.has-media")).toHaveCount(0);

  releaseUpload();
  await expect(page.locator(".project-media-progress")).toHaveCount(0);
  await expect(page.locator(".project-media-slot.has-media").getByText("成品视频 · 博主号", { exact: true })).toHaveCount(1);
  await expect.poll(async () => {
    const library = await (await request.get("/api/library")).json();
    return library.activeProject?.mediaAssets?.filter((asset) => asset.role === "finished_video").length;
  }).toBe(1);
});
