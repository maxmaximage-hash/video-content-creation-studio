import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { fulfillMockEagleMediaUpload, mockEagleUploads } from "./eagle-upload-mock.mjs";

const prototypeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const coffeeCover = path.join(prototypeRoot, "public/assets/covers/coffee-alley.png");
const creatorCover = path.join(prototypeRoot, "public/assets/covers/creator-desk.png");
const mountainCover = path.join(prototypeRoot, "public/assets/covers/mountain-trail.png");

test.beforeEach(async ({ page }) => {
  await mockEagleUploads(page);
});

function richProject(id = "C009901") {
  return {
    id,
    unitSchemaVersion: 1,
    origin: "original",
    title: "需要完整保留的创作标题",
    body: "正文、分类、封面、参考、原素材和成品视频都必须一起保留。",
    covers: [
      { id: `${id}-cover-a`, name: "coffee.png", src: "/assets/covers/coffee-alley.png" },
      { id: `${id}-cover-b`, name: "creator.png", src: "/assets/covers/creator-desk.png" },
      { id: `${id}-cover-c`, name: "mountain.png", src: "/assets/covers/mountain-trail.png" },
    ],
    primaryCoverId: `${id}-cover-a`,
    references: [{ id: "I009901", title: "参考灵感", body: "灵感正文", platform: "小红书" }],
    category: "教程",
    categoryAssignedByUser: true,
    creationStatus: "completed",
    completedAt: "2026-07-23T12:00:00.000Z",
    workflow: {
      stage: "creating",
      creationStatus: "completed",
      completedAt: "2026-07-23T12:00:00.000Z",
    },
    mediaAssets: [
      { id: `${id}-raw`, role: "source_video", order: 1, name: "source.mov", src: "/assets/source.mov" },
      { id: `${id}-finished`, role: "finished_video", order: 1, name: "finished.mp4", src: "/assets/finished.mp4" },
    ],
    modified: "刚刚",
    createdAt: "2026.07.23 12:00",
  };
}

async function seedLibrary(request, activeProject = richProject()) {
  const response = await request.post("/api/library", {
    data: {
      categories: ["教程", "旅行记录"],
      userDefinedCategories: ["教程", "旅行记录"],
      inspirations: activeProject?.references || [],
      projects: [],
      archive: [],
      activeProject,
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function seedInspirationEntryLibrary(request) {
  const inspiration = {
    id: "I009991",
    title: "只作为参考的灵感",
    body: "灵感正文不应复制到创作正文",
    platform: "小红书",
    cover: "/assets/covers/coffee-alley.png",
  };
  const queuedProject = {
    ...richProject("C009980"),
    title: "必须保留的待发布项目",
    body: "不能被新建创作覆盖",
    references: [],
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
      inspirations: [inspiration],
      projects: [queuedProject],
      archive: [],
      activeProject: null,
    },
  });
  expect(response.ok()).toBeTruthy();
  return { inspiration, queuedProject };
}

async function openCreation(page) {
  await page.goto("/");
  await page.getByLabel("主导航").getByRole("button", { name: "创作", exact: true }).click();
}

async function libraryState(request) {
  return (await request.get("/api/library")).json();
}

async function coverNames(request, projectId = "C009901") {
  const library = await libraryState(request);
  const project = library.activeProject?.id === projectId
    ? library.activeProject
    : library.projects.find((item) => item.id === projectId);
  return project?.covers?.map((cover) => cover.name) || [];
}

async function dragCover(page, sourceIndex, targetIndex) {
  const source = page.locator(".cover-option").nth(sourceIndex).locator(".cover-select-button");
  const target = page.locator(".cover-option").nth(targetIndex);
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Cover drag target is not visible");
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 8, sourceBox.y + sourceBox.height / 2, { steps: 3 });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function startGatedVideoUpload(page, fileName) {
  let releaseUpload;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  await page.route("**/api/project-media**", async (route) => {
    markStarted();
    await gate;
    await fulfillMockEagleMediaUpload(route);
  });
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传成品视频 · 博主号", exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: fileName,
    mimeType: "video/mp4",
    buffer: Buffer.alloc(256 * 1024, 7),
  });
  await started;
  await expect(page.locator(".project-media-progress")).toBeVisible();
  return releaseUpload;
}

test("creation covers support pointer and keyboard sorting without external drop resetting order", async ({ page, request }) => {
  await seedLibrary(request);
  await openCreation(page);

  await dragCover(page, 0, 2);
  await expect.poll(() => coverNames(request)).toEqual(["creator.png", "mountain.png", "coffee.png"]);
  await dragCover(page, 2, 0);
  await expect.poll(() => coverNames(request)).toEqual(["coffee.png", "creator.png", "mountain.png"]);

  const secondCover = page.locator('[data-cover-id="C009901-cover-b"] .cover-select-button');
  await secondCover.focus();
  await page.keyboard.press("Space");
  await expect(secondCover).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => coverNames(request)).toEqual(["coffee.png", "mountain.png", "creator.png"]);
  await page.keyboard.press("Space");
  await expect(secondCover).not.toHaveAttribute("aria-pressed", "true");
  await secondCover.focus();
  await page.keyboard.press("Space");
  await expect(secondCover).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => coverNames(request)).toEqual(["coffee.png", "creator.png", "mountain.png"]);
  await page.keyboard.press("Space");
  await expect(secondCover).not.toHaveAttribute("aria-pressed", "true");

  const imageBase64 = fs.readFileSync(mountainCover).toString("base64");
  const dropZone = page.getByLabel("封面图片区域", { exact: true });
  await dropZone.evaluate((element, payload) => {
    const bytes = Uint8Array.from(atob(payload.base64), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "external-after-sort.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { base64: imageBase64 });
  await expect.poll(() => coverNames(request)).toEqual([
    "coffee.png",
    "creator.png",
    "mountain.png",
    "external-after-sort.png",
  ]);

  let library;
  await expect.poll(async () => {
    library = await libraryState(request);
    const manifestPath = path.join(library.storage.libraryDir, "content-units/C009901/manifest.json");
    if (!fs.existsSync(manifestPath)) return [];
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")).presentation?.covers?.map((cover) => cover.name) || [];
  }).toEqual(["coffee.png", "creator.png", "mountain.png", "external-after-sort.png"]);

  await page.reload();
  await page.getByLabel("主导航").getByRole("button", { name: "创作", exact: true }).click();
  await expect(page.locator(".cover-option")).toHaveCount(4);
  expect(await page.locator(".cover-option").evaluateAll((covers) => covers.map((cover) => cover.dataset.coverId))).toEqual(
    library.activeProject.covers.map((cover) => cover.id),
  );
});

test("cover delete control is hidden until hover or keyboard focus and layout stays stable", async ({ page, request }) => {
  await seedLibrary(request);
  await openCreation(page);

  const firstCover = page.locator(".cover-option").first();
  const remove = firstCover.locator(".cover-remove-button");
  await expect(remove).toHaveCSS("opacity", "0");
  await expect(remove).toHaveCSS("pointer-events", "none");
  await expect(remove).toHaveCSS("border-top-style", "none");
  await expect(remove).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  await firstCover.hover();
  await expect(remove).toHaveCSS("opacity", "1");
  await expect(remove).toHaveCSS("pointer-events", "auto");
  await page.mouse.move(0, 0);
  await firstCover.locator(".cover-select-button").focus();
  await expect(remove).toHaveCSS("opacity", "1");

  for (const width of [1280, 1440, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await page.locator(".cover-editor-grid").evaluate((grid) => {
      const items = [...grid.querySelectorAll(":scope > .cover-option, :scope > .upload-cover")];
      const boxes = items.map((item) => {
        const rect = item.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      });
      const overlaps = boxes.some((box, index) => boxes.slice(index + 1).some((other) => (
        box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top
      )));
      const image = grid.querySelector(".cover-option img");
      return {
        boxes,
        overlaps,
        objectFit: getComputedStyle(image).objectFit,
        gridHeight: grid.getBoundingClientRect().height,
      };
    });
    expect(geometry.overlaps).toBe(false);
    expect(geometry.objectFit).toBe("contain");
    expect(geometry.boxes.every((box) => Math.round(box.width) === 184)).toBe(true);
    expect(geometry.boxes.every((box) => Math.abs((box.width / box.height) - 0.75) < 0.01)).toBe(true);
    expect(geometry.gridHeight).toBeGreaterThanOrEqual(245);
    await page.screenshot({
      path: path.join(prototypeRoot, "qa", `creation-workspace-${width}x1000.png`),
      fullPage: true,
    });
  }
});

test("clear is confirmed, removes the old software unit, and opens a fresh ID", async ({ page, request }) => {
  await seedLibrary(request);
  await openCreation(page);

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "添加封面", exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(coffeeCover);
  let uploadedItemId;
  await expect.poll(async () => {
    const library = await libraryState(request);
    const uploaded = library.activeProject.covers.find((cover) => cover.name === "coffee-alley.png");
    uploadedItemId = uploaded?.eagleItemId;
    return {
      eagleItemId: uploaded?.eagleItemId || "",
      relativePath: uploaded?.relativePath || "",
    };
  }).toEqual({
    eagleItemId: expect.stringMatching(/^EAGLE-COVER-/),
    relativePath: "",
  });
  const library = await libraryState(request);

  await page.getByRole("button", { name: "清空全部", exact: true }).click();
  const clearDialog = page.getByRole("dialog", { name: "清空当前画板？" });
  await clearDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator(".title-input")).toHaveValue("需要完整保留的创作标题");

  await page.getByRole("button", { name: "清空全部", exact: true }).click();
  await clearDialog.getByRole("button", { name: "确认清空", exact: true }).click();
  await expect.poll(async () => {
    const current = await libraryState(request);
    const project = current.activeProject;
    if (!project) return null;
    return {
      hasFreshId: project.id !== "C009901",
      title: project.title,
      body: project.body,
      category: project.category,
      covers: project.covers,
      references: project.references,
      mediaAssets: project.mediaAssets,
      creationStatus: project.creationStatus,
      completedAt: project.completedAt,
      duplicateInQueue: current.projects.some((item) => item.id === project.id),
    };
  }).toEqual({
    hasFreshId: true,
    title: "",
    body: "",
    category: "",
    covers: [],
    references: [],
    mediaAssets: [],
    creationStatus: "in_progress",
    completedAt: null,
    duplicateInQueue: false,
  });
  expect(uploadedItemId).toBeTruthy();
  expect(fs.existsSync(path.join(library.storage.libraryDir, "content-units", "C009901"))).toBe(false);
});

test("inspiration entry releases its modal before ID allocation and the first new click handles the reference draft", async ({ page, request }) => {
  const { inspiration, queuedProject } = await seedInspirationEntryLibrary(request);
  let releaseIdAllocation;
  let markIdAllocationStarted;
  const idAllocationStarted = new Promise((resolve) => {
    markIdAllocationStarted = resolve;
  });
  const idAllocationGate = new Promise((resolve) => {
    releaseIdAllocation = resolve;
  });
  let gateFirstAllocation = true;
  await page.route("**/api/content-ids", async (route) => {
    if (gateFirstAllocation) {
      gateFirstAllocation = false;
      markIdAllocationStarted();
      await idAllocationGate;
    }
    await route.continue();
  });

  await page.goto("/");
  const inspirationCard = page.getByRole("article", { name: inspiration.title });
  await inspirationCard.getByRole("button", { name: "创作", exact: true }).click();
  const sourceDialog = page.getByRole("dialog", { name: "把灵感带入创作" });
  await sourceDialog.getByRole("button", { name: /开始新的创作/ }).click();
  await idAllocationStarted;
  await expect(sourceDialog).toHaveCount(0);
  releaseIdAllocation();

  const newButton = page.getByRole("button", { name: "新建创作", exact: true });
  await expect(newButton).toBeVisible();
  let referenceProjectId;
  await expect.poll(async () => {
    const library = await libraryState(request);
    referenceProjectId = library.activeProject?.id;
    return {
      title: library.activeProject?.title,
      body: library.activeProject?.body,
      covers: library.activeProject?.covers,
      references: library.activeProject?.references?.map((item) => item.id),
      queuedIds: library.projects.map((item) => item.id),
    };
  }).toEqual({
    title: "",
    body: "",
    covers: [],
    references: [inspiration.id],
    queuedIds: [queuedProject.id],
  });

  await newButton.click();
  const newDialog = page.getByRole("dialog", { name: "新建创作" });
  await expect(newDialog).toBeVisible();
  await newDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect.poll(async () => {
    const library = await libraryState(request);
    return {
      activeId: library.activeProject?.id,
      references: library.activeProject?.references?.map((item) => item.id),
      queuedIds: library.projects.map((item) => item.id),
    };
  }).toEqual({
    activeId: referenceProjectId,
    references: [inspiration.id],
    queuedIds: [queuedProject.id],
  });

  await newButton.click();
  await newDialog.getByRole("button", { name: /删除 \/ 放弃当前草稿/ }).click();
  let discardedReplacementId;
  await expect.poll(async () => {
    const library = await libraryState(request);
    discardedReplacementId = library.activeProject?.id;
    return {
      changed: discardedReplacementId !== referenceProjectId,
      title: library.activeProject?.title,
      body: library.activeProject?.body,
      covers: library.activeProject?.covers,
      references: library.activeProject?.references,
      queuedIds: library.projects.map((item) => item.id),
    };
  }).toEqual({
    changed: true,
    title: "",
    body: "",
    covers: [],
    references: [],
    queuedIds: [queuedProject.id],
  });

  await page.getByLabel("主导航").getByRole("button", { name: "灵感库", exact: true }).click();
  await inspirationCard.getByRole("button", { name: "创作", exact: true }).click();
  await sourceDialog.getByRole("button", { name: /开始新的创作/ }).click();
  await expect(newButton).toBeVisible();
  let queuedReferenceId;
  await expect.poll(async () => {
    const library = await libraryState(request);
    queuedReferenceId = library.activeProject?.id;
    return library.activeProject?.references?.map((item) => item.id);
  }).toEqual([inspiration.id]);

  await newButton.click();
  await newDialog.getByRole("button", { name: /保存到创作台/ }).click();
  let finalActiveId;
  await expect.poll(async () => {
    const library = await libraryState(request);
    finalActiveId = library.activeProject?.id;
    const queuedReference = library.projects.find((item) => item.id === queuedReferenceId);
    return {
      queuedIds: library.projects.map((item) => item.id).sort(),
      queuedReferenceTitle: queuedReference?.title,
      queuedReferenceBody: queuedReference?.body,
      queuedReferenceCovers: queuedReference?.covers,
      queuedReferenceIds: queuedReference?.references?.map((item) => item.id),
      activeTitle: library.activeProject?.title,
      activeReferences: library.activeProject?.references,
    };
  }).toEqual({
    queuedIds: [queuedProject.id, queuedReferenceId].sort(),
    queuedReferenceTitle: "",
    queuedReferenceBody: "",
    queuedReferenceCovers: [],
    queuedReferenceIds: [inspiration.id],
    activeTitle: "",
    activeReferences: [],
  });
  expect(new Set([
    referenceProjectId,
    discardedReplacementId,
    queuedReferenceId,
    finalActiveId,
  ]).size).toBe(4);
});

test("new creation handles cancel, queue, empty canvas, discard, restart, and never reuses IDs", async ({ page, request }) => {
  await seedLibrary(request);
  await openCreation(page);

  await page.getByRole("button", { name: "新建创作", exact: true }).click();
  const newDialog = page.getByRole("dialog", { name: "新建创作" });
  await newDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator(".title-input")).toHaveValue("需要完整保留的创作标题");

  await page.getByRole("button", { name: "新建创作", exact: true }).click();
  await newDialog.getByRole("button", { name: /保存到创作台/ }).click();
  let firstNewId;
  await expect.poll(async () => {
    const library = await libraryState(request);
    firstNewId = library.activeProject?.id;
    const queued = library.projects.find((project) => project.id === "C009901");
    return {
      activeId: firstNewId,
      queuedTitle: queued?.title,
      queuedBody: queued?.body,
      queuedCategory: queued?.category,
      coverCount: queued?.covers?.length,
      referenceCount: queued?.references?.length,
      mediaRoles: queued?.mediaAssets?.map((asset) => asset.role),
      activeDuplicate: library.projects.some((project) => project.id === firstNewId),
    };
  }).toEqual({
    activeId: expect.stringMatching(/^C\d{6,}$/),
    queuedTitle: "需要完整保留的创作标题",
    queuedBody: "正文、分类、封面、参考、原素材和成品视频都必须一起保留。",
    queuedCategory: "教程",
    coverCount: 3,
    referenceCount: 1,
    mediaRoles: ["source_video", "finished_video"],
    activeDuplicate: false,
  });
  expect(firstNewId).not.toBe("C009901");

  await page.getByRole("button", { name: "新建创作", exact: true }).click();
  await expect(newDialog).toHaveCount(0);
  let secondNewId;
  await expect.poll(async () => {
    const candidateId = (await libraryState(request)).activeProject?.id || "";
    if (candidateId === firstNewId || !/^C\d{6,}$/.test(candidateId)) return "";
    secondNewId = candidateId;
    return candidateId;
  }).toMatch(/^C\d{6,}$/);
  await expect(page.locator(".toast")).toContainText(secondNewId);

  await page.locator(".title-input").fill("这份草稿将被放弃");
  await expect.poll(async () => (await libraryState(request)).activeProject?.title).toBe("这份草稿将被放弃");
  await page.getByRole("button", { name: "新建创作", exact: true }).click();
  await newDialog.getByRole("button", { name: /删除 \/ 放弃当前草稿/ }).click();
  let thirdNewId;
  await expect.poll(async () => {
    const library = await libraryState(request);
    thirdNewId = library.activeProject?.id;
    return {
      activeId: thirdNewId,
      changed: thirdNewId !== secondNewId,
      discardedQueued: library.projects.some((project) => project.id === secondNewId),
    };
  }).toEqual({
    activeId: expect.stringMatching(/^C\d{6,}$/),
    changed: true,
    discardedQueued: false,
  });
  expect(new Set(["C009901", firstNewId, secondNewId, thirdNewId]).size).toBe(4);

  await page.reload();
  await page.getByLabel("主导航").getByRole("button", { name: "创作", exact: true }).click();
  await page.getByRole("button", { name: "新建创作", exact: true }).click();
  let fourthNewId;
  await expect.poll(async () => {
    const candidateId = (await libraryState(request)).activeProject?.id || "";
    if (candidateId === thirdNewId || !/^C\d{6,}$/.test(candidateId)) return "";
    fourthNewId = candidateId;
    return candidateId;
  }).toMatch(/^C\d{6,}$/);
  expect(new Set(["C009901", firstNewId, secondNewId, thirdNewId, fourthNewId]).size).toBe(5);
});

test("queued upload completes on the old ID and never attaches to the new canvas", async ({ page, request }) => {
  const project = richProject("C009902");
  project.mediaAssets = [];
  await seedLibrary(request, project);
  await openCreation(page);

  const releaseUpload = await startGatedVideoUpload(page, "queued-late.mp4");
  await page.getByRole("button", { name: "新建创作", exact: true }).click();
  await page.getByRole("dialog", { name: "新建创作" }).getByRole("button", { name: /保存到创作台/ }).click();
  let newId;
  await expect.poll(async () => {
    const library = await libraryState(request);
    newId = library.activeProject?.id;
    return library.projects.some((item) => item.id === "C009902");
  }).toBe(true);

  releaseUpload();
  await expect.poll(async () => {
    const library = await libraryState(request);
    return {
      oldMedia: library.projects.find((item) => item.id === "C009902")?.mediaAssets?.map((asset) => asset.name),
      newMedia: library.activeProject?.mediaAssets,
      activeId: library.activeProject?.id,
    };
  }).toEqual({
    oldMedia: ["queued-late.mp4"],
    newMedia: [],
    activeId: newId,
  });
});

test("clear and discard invalidate old uploads so they cannot reattach", async ({ page, request }) => {
  const project = richProject("C009903");
  project.mediaAssets = [];
  await seedLibrary(request, project);
  await openCreation(page);

  const releaseClearedUpload = await startGatedVideoUpload(page, "cleared-late.mp4");
  await page.getByRole("button", { name: "清空全部", exact: true }).click();
  await page.getByRole("dialog", { name: "清空当前画板？" }).getByRole("button", { name: "确认清空", exact: true }).click();
  releaseClearedUpload();
  await expect.poll(async () => (await libraryState(request)).activeProject?.mediaAssets).toEqual([]);

  await page.unroute("**/api/project-media**");
  let beforeDiscardId;
  await expect.poll(async () => {
    const candidateId = (await libraryState(request)).activeProject?.id || "";
    if (!/^C\d{6,}$/.test(candidateId)) return "";
    beforeDiscardId = candidateId;
    return candidateId;
  }).toMatch(/^C\d{6,}$/);
  await page.locator(".title-input").fill("放弃时仍在上传");
  await expect.poll(async () => (await libraryState(request)).activeProject?.title).toBe("放弃时仍在上传");
  const releaseDiscardedUpload = await startGatedVideoUpload(page, "discarded-late.mp4");
  await page.getByRole("button", { name: "新建创作", exact: true }).click();
  await page.getByRole("dialog", { name: "新建创作" }).getByRole("button", { name: /删除 \/ 放弃当前草稿/ }).click();
  let newId;
  await expect.poll(async () => {
    const candidateId = (await libraryState(request)).activeProject?.id || "";
    if (candidateId === beforeDiscardId || !/^C\d{6,}$/.test(candidateId)) return "";
    newId = candidateId;
    return candidateId;
  }).toMatch(/^C\d{6,}$/);
  releaseDiscardedUpload();
  await expect.poll(async () => {
    const library = await libraryState(request);
    return {
      activeId: library.activeProject?.id,
      activeMedia: library.activeProject?.mediaAssets,
      oldQueued: library.projects.some((item) => item.id === "C009903"),
    };
  }).toEqual({
    activeId: newId,
    activeMedia: [],
    oldQueued: false,
  });
});
