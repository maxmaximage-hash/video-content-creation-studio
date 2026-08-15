import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIBRARY_NAME } from "../server/library-manager.mjs";

const prototypeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const qaLibraryRoot = process.env.VIDEO_CONTENT_LIBRARY_ROOT || path.join(prototypeRoot, ".qa-library");

const covers = [
  "/assets/covers/coffee-alley.png",
  "/assets/covers/creator-desk.png",
  "/assets/covers/mountain-trail.png",
  "/assets/covers/coffee-alley.png",
  "/assets/covers/creator-desk.png",
  "/assets/covers/mountain-trail.png",
];

const projects = [
  {
    id: "C000127",
    title: "一条视频从选题到开拍的 24 小时",
    body: "把创作者看不见的准备工作拍出来：资料、故事板、场景确认与拍摄清单。这个摘要特意足够长，用于验证待发布卡片只显示开头两行，完整正文仍保留在继续创作页面。还要继续记录器材检查、现场沟通、光线变化、收音测试、备选机位、拍摄节奏和临时调整，让文本长度在宽屏卡片中也稳定超过两行。",
    covers: covers.slice(0, 2),
    references: [{ id: "I000101" }, { id: "I000102" }],
    category: "教程",
    categoryAssignedByUser: true,
    modified: "今天 10:24",
    createdAt: "2026.07.23 10:24",
  },
  {
    id: "C000128",
    title: "城市醒来之前，我走进了一条老街",
    body: "清晨六点，店铺还没有完全开门。沿着梧桐树下的小路，记录咖啡机启动、卷帘门升起和第一班公交经过的声音。",
    covers,
    references: [{ id: "I000103" }, { id: "I000104" }],
    category: "展示面",
    categoryAssignedByUser: true,
    modified: "刚刚",
    createdAt: "2026.07.23 10:26",
  },
  {
    id: "C000126",
    title: "在山脊上等一场云海",
    body: "用自然声和长镜头记录一次清晨徒步，让画面保留真实的停顿。",
    covers: covers.slice(1, 3),
    references: [{ id: "I000099" }, { id: "I000100" }],
    category: "旅行记录",
    categoryAssignedByUser: true,
    modified: "昨天 18:40",
    createdAt: "2026.07.22 18:40",
  },
];
const inspirations = [
  {
    id: "I000301",
    platform: "抖音",
    contentType: "image",
    originalUrl: "https://www.douyin.com/video/reference-301",
    resolvedUrl: "https://www.douyin.com/video/reference-301",
    title: "灵感标题只应出现在参考卡片中",
    body: "这是用来验证创作页保持空白的灵感正文。",
    author: "参考作者",
    coverLocalPath: "/assets/covers/coffee-alley.png",
    category: "认知",
    categoryAssignedByUser: true,
    stats: { likes: 1234, comments: 56, favorites: 78 },
  },
  {
    id: "I000302",
    platform: "小红书",
    contentType: "image",
    originalUrl: "https://www.xiaohongshu.com/explore/reference-302",
    title: "第二条完整灵感卡片",
    body: "用于验证多列参考区。",
    author: "作者二",
    coverLocalPath: "/assets/covers/creator-desk.png",
    category: "展示面",
    categoryAssignedByUser: true,
    stats: { likes: 456, comments: 21 },
  },
  {
    id: "I000303",
    platform: "Bilibili",
    contentType: "image",
    originalUrl: "https://www.bilibili.com/video/reference-303",
    title: "第三条完整灵感卡片",
    body: "用于验证三列参考区。",
    author: "作者三",
    coverLocalPath: "/assets/covers/mountain-trail.png",
    category: "教程",
    categoryAssignedByUser: true,
    stats: { likes: 789, favorites: 34 },
  },
];
const browserErrors = new WeakMap();

async function seedLibrary(request) {
  const response = await request.post("/api/library", {
    data: {
      categories: ["情感", "展示面", "认知", "教程", "旅行记录"],
      inspirations,
      projects,
      archive: [],
      activeProject: null,
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function openQueue(page) {
  await page.goto("/");
  await page.getByRole("button", { name: /^创作台/ }).click();
  await expect(page.locator("[data-project-id]")).toHaveCount(3);
}

test("账号编辑入口穿透到同一项目并同步回创作台", async ({ page, request }) => {
  await openQueue(page);
  const card = page.locator('[data-project-id="C000127"]');
  const bloggerTitle = await card.getByLabel("博主号标题", { exact: true }).inputValue();
  const bloggerBody = await card.getByLabel("博主号正文", { exact: true }).inputValue();

  await card.getByRole("button", { name: "编辑IP 号内容", exact: true }).click();
  await expect(page.getByRole("heading", { name: "编辑", exact: true })).toBeVisible();
  await expect(page.getByLabel("编辑账号").getByRole("button", { name: "IP 号", exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.getByLabel("IP 号编辑标题").fill("IP 号深度编排标题");
  await page.getByLabel("IP 号编辑正文").fill("这是只属于 IP 号的深度编排正文。\n\n不会覆盖博主号内容。");
  await page.getByRole("button", { name: "添加灵感", exact: true }).click();
  await page.getByRole("dialog", { name: "添加灵感参考" }).getByRole("button", { name: /灵感标题只应出现在参考卡片中/ }).click();
  await page.getByRole("button", { name: "完成编辑", exact: true }).click();

  await expect(page.getByRole("heading", { name: "创作台", exact: true })).toBeVisible();
  const updatedCard = page.locator('[data-project-id="C000127"]');
  await expect(updatedCard.getByLabel("IP 号标题", { exact: true })).toHaveValue("IP 号深度编排标题");
  await expect(updatedCard.getByLabel("IP 号正文", { exact: true })).toHaveValue("这是只属于 IP 号的深度编排正文。\n\n不会覆盖博主号内容。");
  await expect(updatedCard.getByLabel("博主号标题", { exact: true })).toHaveValue(bloggerTitle);
  await expect(updatedCard.getByLabel("博主号正文", { exact: true })).toHaveValue(bloggerBody);

  await expect.poll(async () => {
    const library = await (await request.get("/api/library")).json();
    const project = library.projects.find((item) => item.id === "C000127");
    return {
      rootTitle: project?.title,
      ipTitle: project?.accountVariants?.ip?.title,
      ipBody: project?.accountVariants?.ip?.body,
      referenceIds: project?.references?.map((item) => item.id),
      stage: project?.workflow?.stage,
      archiveCount: library.archive.length,
    };
  }).toEqual({
    rootTitle: bloggerTitle,
    ipTitle: "IP 号深度编排标题",
    ipBody: "这是只属于 IP 号的深度编排正文。\n\n不会覆盖博主号内容。",
    referenceIds: ["I000101", "I000102", "I000301"],
    stage: "ready_to_publish",
    archiveCount: 0,
  });
});

async function order(page) {
  return page.locator("[data-project-id]").evaluateAll((cards) => cards.map((card) => card.dataset.projectId));
}

async function orderWithPriority(page) {
  return page.locator("[data-project-id]").evaluateAll((cards) => cards.map((card) => ({
    id: card.dataset.projectId,
    priority: card.querySelector(".queue-card-number")?.textContent.trim(),
  })));
}

async function dragToCard(page, sourceId, targetId, sourceMode = "handle") {
  const handle = sourceMode === "card"
    ? page.locator(`[data-project-id="${sourceId}"]`)
    : page.locator(`[data-project-id="${sourceId}"] .drag-zone`);
  const sourceCard = page.locator(`[data-project-id="${sourceId}"]`);
  const target = page.locator(`[data-project-id="${targetId}"]`);
  const currentOrder = await order(page);
  const movingUp = currentOrder.indexOf(sourceId) > currentOrder.indexOf(targetId);
  await handle.scrollIntoViewIfNeeded();
  const sourceBox = await handle.boundingBox();
  const sourceCardBox = await sourceCard.boundingBox();
  let targetBox = await target.boundingBox();
  if (!sourceBox || !sourceCardBox || !targetBox) throw new Error("Drag target is not visible");
  const pointerStartY = sourceBox.y + sourceBox.height / 2;
  const pointerToCardCenter = sourceCardBox.y + sourceCardBox.height / 2 - pointerStartY;

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, pointerStartY);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, pointerStartY + 10, { steps: 3 });
  for (let attempt = 0; attempt < 12 && (targetBox.y < 40 || targetBox.y + targetBox.height > 860); attempt += 1) {
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y < 40 ? 60 : 840, { steps: 4 });
    await page.waitForTimeout(90);
    targetBox = await target.boundingBox();
    if (!targetBox) throw new Error("Drag target disappeared");
  }
  const direction = movingUp ? -1 : 1;
  const crossTargetCenter = () => (
    targetBox.y
    + targetBox.height / 2
    - pointerToCardCenter
    + direction * Math.max(24, targetBox.height / 2 - 24)
  );
  await page.mouse.move(targetBox.x + targetBox.width / 2, crossTargetCenter(), { steps: 14 });
  await page.waitForTimeout(90);
  targetBox = await target.boundingBox();
  if (!targetBox) throw new Error("Drag target disappeared");
  const viewport = page.viewportSize();
  const edgeY = movingUp ? 32 : (viewport?.height || 900) - 32;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const current = await order(page);
    const sourceIndex = current.indexOf(sourceId);
    const targetIndex = current.indexOf(targetId);
    if (movingUp ? sourceIndex < targetIndex : sourceIndex > targetIndex) break;
    await page.mouse.move(
      targetBox.x + targetBox.width / 2,
      edgeY + (attempt % 2 ? (movingUp ? 2 : -2) : 0),
      { steps: 3 },
    );
    await page.waitForTimeout(90);
  }
}

test.beforeEach(async ({ request, page }) => {
  const errors = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${message.text()} @ ${message.location().url || "unknown"}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await seedLibrary(request);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) || []).toEqual([]);
});

test("创作台空态和页头都能新建内容并自动保存", async ({ page, request }) => {
  const response = await request.post("/api/library", {
    data: {
      categories: ["情感", "展示面", "认知", "教程"],
      userDefinedCategories: ["情感", "展示面", "认知", "教程"],
      inspirations: [],
      projects: [],
      archive: [],
      activeProject: null,
      contentIdCounters: { I: 0, C: 0 },
    },
  });
  expect(response.ok()).toBeTruthy();

  await page.goto("/");
  await page.getByRole("button", { name: "创作台", exact: true }).click();
  await expect(page.getByRole("heading", { name: "创作台", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "新建内容", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新建第一条内容", exact: true }).click();

  const firstCard = page.locator("[data-project-id]").first();
  await expect(firstCard).toBeVisible();
  const firstId = await firstCard.getAttribute("data-project-id");
  expect(firstId).toMatch(/^C\d{6,}$/);
  await expect.poll(() => order(page)).toEqual([firstId]);
  await expect(firstCard.locator('[data-account-role="blogger"]')).toBeVisible();
  await expect(firstCard.locator('[data-account-role="ip"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("博主号标题");

  await firstCard.getByLabel("博主号标题").fill("新建内容验收");
  await expect.poll(async () => {
    const library = await (await request.get("/api/library")).json();
    const created = library.projects.find((project) => project.id === firstId);
    return {
      firstId: library.projects[0]?.id,
      title: created?.title,
      bloggerTitle: created?.accountVariants?.blogger?.title,
      stage: created?.workflow?.stage,
    };
  }).toEqual({
    firstId,
    title: "新建内容验收",
    bloggerTitle: "新建内容验收",
    stage: "ready_to_publish",
  });

  await page.reload();
  await page.getByRole("button", { name: "创作台", exact: true }).click();
  await expect(page.locator(`[data-project-id="${firstId}"]`).getByLabel("博主号标题")).toHaveValue("新建内容验收");

  await page.setViewportSize({ width: 390, height: 780 });
  const headerCreate = page.getByRole("button", { name: "新建内容", exact: true });
  await expect(headerCreate).toBeVisible();
  const headerMetrics = await page.locator(".queue-header-actions").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: Math.floor(rect.left),
      right: Math.ceil(rect.right),
      viewportWidth: window.innerWidth,
    };
  });
  expect(headerMetrics.left).toBeGreaterThanOrEqual(0);
  expect(headerMetrics.right).toBeLessThanOrEqual(headerMetrics.viewportWidth);

  await headerCreate.click();
  await expect(page.locator("[data-project-id]")).toHaveCount(2);
  const secondId = await page.locator("[data-project-id]").first().getAttribute("data-project-id");
  expect(secondId).toMatch(/^C\d{6,}$/);
  expect(secondId).not.toBe(firstId);
  await expect.poll(() => order(page)).toEqual([secondId, firstId]);
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("博主号标题");
});

test("正文格式规整支持预览确认、撤销、幂等和自动保存", async ({ page, request }) => {
  await openQueue(page);
  const card = page.locator('[data-project-id="C000127"]');
  const body = card.getByLabel("博主号正文", { exact: true });
  const original = "> **王的姿态**  \n\n\n保留 > 和 *普通星号*\n数字 123  ";
  const formatted = "王的姿态\n保留 > 和 *普通星号*\n数字 123";

  await body.fill(original);
  const formatButton = card.getByRole("button", { name: "规整博主号正文格式", exact: true });
  await expect(formatButton).toHaveText("");
  await expect(formatButton.locator("svg.lucide-wand-sparkles")).toHaveCount(1);
  await formatButton.click();
  const preview = page.getByRole("dialog", { name: "格式规整预览" });
  await expect(preview.getByLabel("原文")).toHaveValue(original);
  await expect(preview.getByLabel("规整后")).toHaveValue(formatted);
  await preview.getByRole("button", { name: "确认规整", exact: true }).click();
  await expect(body).toHaveValue(formatted);
  await expect(card.getByRole("button", { name: "撤销博主号正文格式规整", exact: true })).toBeVisible();

  await card.getByRole("button", { name: "撤销博主号正文格式规整", exact: true }).click();
  await expect(body).toHaveValue(original);
  await card.getByRole("button", { name: "规整博主号正文格式", exact: true }).click();
  await preview.getByRole("button", { name: "确认规整", exact: true }).click();
  await expect(body).toHaveValue(formatted);
  await formatButton.click();
  await expect(preview).toBeVisible();
  await expect(preview.getByText("当前正文无需调整", { exact: true })).toBeVisible();
  await expect(preview.getByRole("button", { name: "确认规整", exact: true })).toHaveCount(0);
  await preview.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(preview).toHaveCount(0);

  await expect.poll(async () => {
    const library = await (await request.get("/api/library")).json();
    return library.projects.find((project) => project.id === "C000127")?.accountVariants?.blogger?.body;
  }).toBe(formatted);
  await page.reload();
  await page.getByRole("button", { name: /^创作台/ }).click();
  await expect(page.locator('[data-project-id="C000127"]').getByLabel("博主号正文", { exact: true })).toHaveValue(formatted);
});

test("正文规整后立即完成仍归档最新内容", async ({ page, request }) => {
  await openQueue(page);
  const card = page.locator('[data-project-id="C000127"]');
  const original = "> **立即归档正文**   \n\n\n> 数字 2026 保持不变   ";
  const formatted = "立即归档正文\n数字 2026 保持不变";

  await card.getByLabel("博主号正文", { exact: true }).fill(original);
  await card.getByRole("button", { name: "规整博主号正文格式", exact: true }).click();
  await page.getByRole("dialog", { name: "格式规整预览" }).getByRole("button", { name: "确认规整", exact: true }).click();
  await card.getByRole("button", { name: "完成", exact: true }).click();

  await expect.poll(async () => {
    const library = await (await request.get("/api/library")).json();
    const archived = library.archive.find((project) => project.id === "C000127");
    return {
      body: archived?.body,
      bloggerBody: archived?.accountVariants?.blogger?.body,
      stillCreating: library.projects.some((project) => project.id === "C000127"),
    };
  }).toEqual({ body: formatted, bloggerBody: formatted, stillCreating: false });
});

test("card hierarchy, editable copy, large cover surfaces and button isolation", async ({ page, request }) => {
  await openQueue(page);
  await expect(page.locator(".brand-copy span")).toHaveText("V1.9");

  const firstCard = page.locator('[data-project-id="C000127"]');
  await expect(firstCard.locator(".queue-card-number")).toHaveText("01");
  await expect(firstCard.locator(".queue-card-number")).not.toContainText("优先级");
  await expect(page.getByRole("button", { name: /^(上移|下移)$/ })).toHaveCount(0);
  await expect(firstCard).not.toContainText(/C\d{6}/);
  await expect(firstCard.locator(".queue-card-header")).toContainText("正在创作");
  await expect(firstCard.getByLabel("一条视频从选题到开拍的 24 小时分类")).toHaveValue("教程");
  await expect(firstCard.getByTestId("collapsed-covers-C000127")).toContainText("2 张封面");
  const emptyIpCovers = firstCard.getByTestId("collapsed-covers-C000127-ip");
  await expect(emptyIpCovers.getByText("添加封面", { exact: true })).toHaveCount(1);
  await expect(emptyIpCovers.locator(".queue-cover-gallery-header")).toHaveCount(0);
  await expect(firstCard.getByLabel("博主号标题", { exact: true })).toHaveValue(projects[0].title);
  await expect(firstCard.getByLabel("博主号正文", { exact: true })).toHaveValue(projects[0].body);

  const editorMetrics = await firstCard.evaluate((card) => {
    const title = card.querySelector('[data-account-role="blogger"] .queue-title-editor');
    const body = card.querySelector('[data-account-role="blogger"] .queue-body-editor');
    const cover = card.querySelector(".queue-cover-item");
    return {
      titleFits: title.scrollHeight <= title.clientHeight + 1,
      bodyOverflow: getComputedStyle(body).overflowY,
      bodyResize: getComputedStyle(body).resize,
      bodyMinHeight: getComputedStyle(body).minHeight,
      bodyMaxHeight: getComputedStyle(body).maxHeight,
      coverWidth: Math.round(cover.getBoundingClientRect().width),
      coverHeight: Math.round(cover.getBoundingClientRect().height),
    };
  });
  expect(editorMetrics).toMatchObject({
    titleFits: true,
    bodyOverflow: "auto",
    bodyResize: "vertical",
    bodyMinHeight: "110px",
    bodyMaxHeight: "260px",
  });
  expect(editorMetrics.coverWidth).toBeGreaterThanOrEqual(100);
  expect(editorMetrics.coverHeight).toBeGreaterThanOrEqual(145);

  const originalOrder = await order(page);
  await firstCard.locator('[data-account-role="blogger"] .queue-account-title-row button[aria-label="复制"]').click();
  await firstCard.locator('[data-account-role="blogger"] .queue-account-body-row button[aria-label="复制"]').click();
  await expect(page.locator(".toast")).toContainText(/已(模拟)?复制/);
  expect(await order(page)).toEqual(originalOrder);
  await expect(firstCard).not.toHaveClass(/dragging/);
  const fieldStyles = await firstCard.locator('[data-account-role="blogger"] .queue-title-editor, [data-account-role="blogger"] .queue-body-editor').evaluateAll((fields) => fields.map((field) => ({
    borderStyle: getComputedStyle(field).borderTopStyle,
    borderWidth: getComputedStyle(field).borderTopWidth,
  })));
  expect(fieldStyles).toEqual([
    { borderStyle: "none", borderWidth: "0px" },
    { borderStyle: "none", borderWidth: "0px" },
  ]);

  const dormantCoverControls = firstCard.locator(".queue-cover-sort-handle, .queue-native-drag-handle, .queue-target-menu-button, .queue-cover-remove");
  expect(await dormantCoverControls.evaluateAll((controls) => controls.every((control) => {
    const style = getComputedStyle(control);
    return style.opacity === "0" && style.pointerEvents === "none";
  }))).toBe(true);
  await firstCard.getByRole("button", { name: "展开封面 2 张" }).first().click();
  await expect(firstCard.getByTestId("expanded-covers-C000127").locator("img")).toHaveCount(2);
  await expect(firstCard.getByTestId("add-cover-C000127")).toBeVisible();

  await firstCard.getByRole("button", { name: "预览封面 1" }).click();
  const lightbox = page.locator(".queue-cover-lightbox");
  await expect(page.getByRole("dialog", { name: "封面预览" })).toBeVisible();
  await expect(lightbox).not.toContainText("查看封面大图");
  await expect(page.getByRole("dialog", { name: "封面预览" }).locator("img")).toBeVisible();
  await expect(lightbox).toHaveCSS("background-color", "rgba(0, 0, 0, 0.88)");
  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);

  await firstCard.getByRole("button", { name: "预览封面 1" }).click();
  await page.mouse.click(24, 24);
  await expect(lightbox).toHaveCount(0);

  await firstCard.getByRole("button", { name: "展开封面 2 张" }).first().click();
  await firstCard.getByRole("button", { name: "预览封面 1" }).click();
  await page.getByRole("button", { name: "关闭封面预览" }).click();
  await expect(lightbox).toHaveCount(0);

  const fileChooserPromise = page.waitForEvent("filechooser");
  const uploadedCoverBytes = await readFile(path.join(prototypeRoot, "public/assets/covers/mountain-trail.png"));
  await page.route("**/api/covers?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cover: {
          id: "EAGLE-QUEUE-COVER",
          eagleItemId: "EAGLE-QUEUE-COVER",
          eagleFolderId: "MS8R943CBJV6L",
          name: "mountain-trail.png",
          contentType: "image/png",
          size: uploadedCoverBytes.length,
        },
      }),
    });
  });
  await page.route("**/api/eagle-media/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: uploadedCoverBytes });
  });
  await page.route("**/api/project-assets/status", async (route) => {
    const payload = route.request().postDataJSON();
    const states = Object.fromEntries((payload.assets || []).map((asset) => [asset.key, {
      state: asset.eagleItemId || asset.relativePath ? "available" : "not_added",
      eagleItemId: asset.eagleItemId || "",
      relativePath: asset.relativePath || "",
    }]));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ states }) });
  });
  await firstCard.getByTestId("add-cover-C000127").click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(path.join(prototypeRoot, "public/assets/covers/mountain-trail.png"));
  await expect(firstCard.getByTestId("expanded-covers-C000127").locator("img")).toHaveCount(3);
  expect(await order(page)).toEqual(originalOrder);
  await expect.poll(async () => {
    const response = await request.get("/api/library");
    return (await response.json()).projects.find((project) => project.id === "C000127")?.covers.length;
  }).toBe(3);

  const sixCoverCard = page.locator('[data-project-id="C000128"]');
  await sixCoverCard.getByRole("button", { name: "展开封面 6 张" }).first().click();
  const expanded = sixCoverCard.getByTestId("expanded-covers-C000128");
  await expect(expanded.locator("img")).toHaveCount(6);
  const addButtonShape = await sixCoverCard.getByTestId("add-cover-C000128").evaluate((button) => ({
    text: button.textContent.trim(),
    svgCount: button.querySelectorAll("svg").length,
  }));
  expect(addButtonShape).toEqual({ text: "", svgCount: 1 });

  const visualProperties = await expanded.evaluate((element) => {
    const style = getComputedStyle(element);
    return { backgroundColor: style.backgroundColor, borderTopStyle: style.borderTopStyle };
  });
  expect(visualProperties.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(visualProperties.borderTopStyle).toBe("none");
  await expect(expanded.locator(".queue-cover-sort-handle")).toHaveCount(0);
});

test("只有 IP 号文案且没有视频的内容完成后立即进入归档库", async ({ page, request }) => {
  await openQueue(page);
  const firstCard = page.locator('[data-project-id="C000127"]');
  await firstCard.getByLabel("博主号标题").fill("");
  await firstCard.getByLabel("博主号正文", { exact: true }).fill("");
  await firstCard.getByLabel("IP 号标题").fill("只有 IP 号的归档标题");
  await firstCard.getByLabel("IP 号正文", { exact: true }).fill("只有 IP 号的归档正文");
  await firstCard.getByRole("button", { name: "完成", exact: true }).click();
  await expect(firstCard).toHaveCount(0);
  await expect.poll(async () => {
    const response = await request.get("/api/library");
    const library = await response.json();
    const archived = library.archive.find((item) => item.id === "C000127");
    return {
      queueIds: library.projects.map((project) => project.id),
      archiveIds: library.archive.map((item) => item.id),
      title: archived?.title,
      body: archived?.body,
      mediaCount: archived?.mediaAssets?.length,
    };
  }).toEqual({
    queueIds: ["C000128", "C000126"],
    archiveIds: ["C000127"],
    title: "只有 IP 号的归档标题",
    body: "只有 IP 号的归档正文",
    mediaCount: 0,
  });
  await page.getByRole("button", { name: "归档库", exact: true }).click();
  await expect(page.getByRole("heading", { name: "只有 IP 号的归档标题" })).toBeVisible();
  await expect(page.getByText("只有 IP 号的归档正文", { exact: true })).toBeVisible();
});

test("删除按钮彻底移除待发布内容并保留其它数据", async ({ page, request }) => {
  await openQueue(page);
  const firstCard = page.locator('[data-project-id="C000127"]');
  await expect(firstCard.getByRole("button", { name: "删除", exact: true })).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("不会删除 Eagle 中的任何文件");
    await dialog.dismiss();
  });
  await firstCard.getByRole("button", { name: "删除", exact: true }).click();
  await expect(firstCard).toHaveCount(1);
  expect(await order(page)).toEqual(["C000127", "C000128", "C000126"]);

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("确定从软件中删除");
    await dialog.accept();
  });
  await firstCard.getByRole("button", { name: "删除", exact: true }).click();
  await expect(firstCard).toHaveCount(0);
  await expect.poll(async () => {
    const response = await request.get("/api/library");
    const library = await response.json();
    return {
      queueIds: library.projects.map((project) => project.id),
      inspirationIds: library.inspirations.map((item) => item.id),
      archiveCount: library.archive.length,
    };
  }).toEqual({
    queueIds: ["C000128", "C000126"],
    inspirationIds: ["I000301", "I000302", "I000303"],
    archiveCount: 0,
  });
});

test("灵感卡片底部优先复制原链接，原视频入口收进三点菜单", async ({ page }) => {
  await page.goto("/");
  const firstInspiration = page.locator(".inspiration-card").filter({ hasText: "灵感标题只应出现在参考卡片中" });
  await expect(firstInspiration).toHaveCount(1);

  await expect(firstInspiration.locator(".card-quick-actions").getByRole("button", { name: "复制原链接", exact: true })).toBeVisible();
  await expect(firstInspiration.locator(".card-quick-actions").getByRole("link", { name: "原视频", exact: true })).toHaveCount(0);

  await firstInspiration.locator('summary[aria-label="更多操作"]').click();
  const menuSourceLink = firstInspiration.locator(".card-overflow-menu").getByRole("link", { name: "原视频", exact: true });
  await expect(menuSourceLink).toBeVisible();
  await expect(menuSourceLink).toHaveAttribute("href", "https://www.douyin.com/video/reference-301");
});

test("逐字稿直接进入正文且保留正文复制按钮", async ({ page, request }) => {
  const transcript = "名利场上的谈话会暴露一个人的家底、认知和价值观。";
  const response = await request.post("/api/library", {
    data: {
      categories: ["认知"],
      inspirations: [{
        ...inspirations[0],
        id: "I000903",
        title: "逐字稿正文合并测试",
        body: transcript,
        transcript,
        transcriptSource: "tencent_asr",
        transcriptState: "complete",
        transcriptStatus: "逐字稿已生成",
      }],
      projects: [],
      archive: [],
      activeProject: null,
    },
  });
  expect(response.ok()).toBeTruthy();

  await page.goto("/");
  const card = page.locator('[data-inspiration-id="I000903"]');
  await expect(card.getByLabel("灵感正文")).toHaveValue(transcript);
  await expect(card.locator(".card-transcript")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "复制全文", exact: true })).toBeEnabled();
});

test("灵感卡片不展示播放数据", async ({ page, request }) => {
  const response = await request.post("/api/library", {
    data: {
      categories: ["认知"],
      inspirations: [{
        ...inspirations[0],
        id: "I000904",
        title: "播放数据隐藏测试",
        stats: { views: "12.3万" },
      }],
      projects: [],
      archive: [],
      activeProject: null,
    },
  });
  expect(response.ok()).toBeTruthy();

  await page.goto("/");
  const card = page.locator('[data-inspiration-id="I000904"]');
  await expect(card).toBeVisible();
  await expect(card.locator(".card-extended-metrics")).toHaveCount(0);
});

test("视频灵感预览默认开声，用户可手动关闭", async ({ page, request }) => {
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
      this.dispatchEvent(new Event("playing"));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function pause() {
      if (!playing.delete(this)) return;
      this.dispatchEvent(new Event("pause"));
    };
  });
  await request.post("/api/library", {
    data: {
      categories: ["情感", "展示面", "认知", "教程"],
      inspirations: [{
        ...inspirations[0],
        id: "I000901",
        contentType: "video",
        title: "默认开声的视频灵感",
        videoUrl: "https://video.example/temporary.mp4",
        videoPreviewUrl: "/library-proxy/media?url=https%3A%2F%2Fvideo.example%2Ftemporary.mp4",
        videoLocalPath: "/assets/covers/coffee-alley.png",
      }],
      projects: [],
      archive: [],
      activeProject: null,
    },
  });

  await page.goto("/");
  const videoCard = page.locator(".inspiration-card").filter({ hasText: "默认开声的视频灵感" });
  await expect(videoCard).toHaveCount(1);
  const videoState = await videoCard.locator("video").evaluate((video) => ({
    muted: video.muted,
    hasMutedAttribute: video.hasAttribute("muted"),
    objectFit: getComputedStyle(video).objectFit,
    preload: video.preload,
    src: video.getAttribute("src"),
  }));
  expect(videoState).toEqual({
    muted: false,
    hasMutedAttribute: false,
    objectFit: "cover",
    preload: "none",
    src: "/assets/covers/coffee-alley.png",
  });
  const mediaShape = await videoCard.evaluate((card) => ({
    cardWidth: card.style.getPropertyValue("--card-width"),
    mediaAspect: getComputedStyle(card.querySelector(".inspiration-media")).aspectRatio,
    objectPosition: getComputedStyle(card.querySelector("video")).objectPosition,
  }));
  expect(mediaShape).toEqual({ cardWidth: "", mediaAspect: "3 / 4", objectPosition: "50% 50%" });
  const mediaPreview = videoCard.locator(".media-preview");
  const previewVideo = videoCard.locator("video");
  await expect(mediaPreview).not.toHaveClass(/video-ready/);
  await expect(videoCard.locator(".media-preview > img")).toHaveCSS("opacity", "1");
  await previewVideo.dispatchEvent("loadeddata");
  await expect(mediaPreview).not.toHaveClass(/video-ready/);
  await previewVideo.dispatchEvent("waiting");
  await expect(videoCard.locator(".media-playback-status")).toHaveCount(0);
  await expect(videoCard).not.toContainText("正在加载视频");
  await expect(videoCard.getByRole("button", { name: "关闭声音", exact: true })).toHaveCount(1);
  await previewVideo.dispatchEvent("playing");
  await expect(mediaPreview).toHaveClass(/video-ready/);
  await expect(videoCard.getByRole("button", { name: "暂停预览", exact: true })).toBeVisible();
  await previewVideo.dispatchEvent("pause");
  await expect(videoCard.getByRole("button", { name: "播放预览", exact: true })).toBeVisible();
  await page.reload();
  await expect(videoCard).toHaveCount(1);
  await expect(videoCard.getByRole("button", { name: "播放预览", exact: true })).toBeVisible();
  await videoCard.locator("video").dispatchEvent("playing");
  await expect(videoCard.getByRole("button", { name: "暂停预览", exact: true })).toBeVisible();
});

test("本地视频文件支持 Range 分段读取", async ({ request }) => {
  const videoDir = path.join(qaLibraryRoot, DEFAULT_LIBRARY_NAME, "assets/videos");
  await mkdir(videoDir, { recursive: true });
  await writeFile(path.join(videoDir, "range-test.mp4"), Buffer.alloc(128 * 1024, 7));

  const response = await request.get("/library-assets/assets/videos/range-test.mp4", {
    headers: { range: "bytes=100-1099" },
  });
  expect(response.status()).toBe(206);
  expect(response.headers()["accept-ranges"]).toBe("bytes");
  expect(response.headers()["content-range"]).toBe(`bytes 100-1099/${128 * 1024}`);
  expect(response.headers()["content-type"]).toContain("video/mp4");
  expect((await response.body()).length).toBe(1000);
});

test("灵感库宽屏最多显示五列", async ({ page, request }) => {
  const sixInspirations = Array.from({ length: 6 }, (_, index) => ({
    ...inspirations[index % inspirations.length],
    id: `I0008${index + 10}`,
    title: `五列上限验证 ${index + 1}`,
  }));
  await request.post("/api/library", {
    data: {
      categories: ["情感", "展示面", "认知", "教程"],
      inspirations: sixInspirations,
      projects: [],
      archive: [],
      activeProject: null,
    },
  });

  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/");
  const cards = page.locator(".inspiration-grid .inspiration-card");
  await expect(cards).toHaveCount(6);
  const rows = await cards.evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top)));
  expect(rows.filter((top) => top === rows[0])).toHaveLength(5);
  expect(new Set(rows).size).toBe(2);
  const layout = await page.locator(".inspiration-grid").evaluate((grid) => {
    const gridRect = grid.getBoundingClientRect();
    const firstCard = grid.querySelector(".inspiration-card").getBoundingClientRect();
    const columns = getComputedStyle(grid).gridTemplateColumns.split(" ");
    return {
      columnCount: columns.length,
      cardWidth: Math.round(firstCard.width),
      fillsGrid: Math.abs((firstCard.width * 5) + (14 * 4) - gridRect.width) <= 2,
    };
  });
  expect(layout.columnCount).toBe(5);
  expect(layout.cardWidth).toBeGreaterThan(228);
  expect(layout.fillsGrid).toBe(true);
});

test("创作页可以从灵感库手动添加灵感参考", async ({ page, request }) => {
  await request.post("/api/library", {
    data: {
      categories: ["情感", "展示面", "认知", "教程"],
      inspirations,
      projects: [],
      archive: [],
      activeProject: {
        id: "C000777",
        title: "手动补灵感的创作",
        body: "",
        covers: [],
        primaryCoverId: null,
        references: [],
        category: "",
        categoryAssignedByUser: false,
        modified: "刚刚",
      },
    },
  });

  await page.goto("/");
  await page.getByLabel("主导航").getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.locator(".creation-reference-grid .inspiration-card")).toHaveCount(0);
  await page.getByRole("button", { name: "添加灵感", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "添加灵感参考" });
  await expect(picker).toBeVisible();
  await expect(picker.locator(".inspiration-picker-item")).toHaveCount(3);
  const categoryFilter = picker.getByLabel("灵感参考分类筛选");
  await expect(categoryFilter.getByRole("button", { name: "全部分类 3", exact: true })).toBeVisible();
  await expect(categoryFilter.getByRole("button", { name: "展示面 1", exact: true })).toBeVisible();
  await categoryFilter.getByRole("button", { name: "展示面 1", exact: true }).click();
  await expect(picker.locator(".inspiration-picker-item")).toHaveCount(1);
  await expect(picker.locator(".inspiration-picker-item")).toContainText("第二条完整灵感卡片");
  await picker.getByRole("button", { name: /第二条完整灵感卡片/ }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.locator(".creation-reference-grid .inspiration-card")).toHaveCount(1);
  await expect(page.locator(".creation-reference-grid")).toContainText("第二条完整灵感卡片");
  await expect(page.locator(".references-section .section-heading")).toContainText("1 条关联灵感");

  await page.getByRole("button", { name: "添加灵感", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "添加灵感参考" }).locator(".inspiration-picker-item")).toHaveCount(2);
  await expect.poll(async () => {
    const library = await (await request.get("/api/library")).json();
    return library.activeProject.references.map((item) => item.id);
  }).toEqual(["I000302"]);
});

test("从灵感开始创作保持编辑区空白并展示完整参考卡片", async ({ page, request }) => {
  await page.goto("/");
  const firstInspiration = page.locator(".inspiration-card").first();
  await firstInspiration.getByRole("button", { name: "创作", exact: true }).click();
  await page.getByRole("button", { name: /开始新的创作/ }).click();

  await expect(page.locator(".creation-shell .title-input")).toHaveValue("");
  await expect(page.locator(".creation-shell .body-section textarea")).toHaveValue("");
  await expect(page.locator(".creation-shell .cover-option")).toHaveCount(0);
  await expect(page.locator(".creation-reference-grid .inspiration-card")).toHaveCount(1);
  await expect(page.locator(".creation-reference-grid")).toContainText("灵感标题只应出现在参考卡片中");
  await expect(page.locator(".creation-reference-grid .inspiration-media img")).toBeVisible();
  await expect(page.locator(".creation-shell")).not.toContainText(/C\d{6}/);

  await expect.poll(async () => {
    const response = await request.get("/api/library");
    const activeProject = (await response.json()).activeProject;
    if (!activeProject) return null;
    return {
      title: activeProject.title,
      body: activeProject.body,
      category: activeProject.category,
      covers: activeProject.covers,
      referenceIds: activeProject.references.map((item) => item.id),
    };
  }).toEqual({ title: "", body: "", category: "", covers: [], referenceIds: ["I000301"] });
});

test("创作页灵感参考保持固定三列和统一卡片宽度", async ({ page, request }) => {
  await request.post("/api/library", {
    data: {
      categories: ["情感", "展示面", "认知", "教程"],
      inspirations,
      projects,
      archive: [],
      activeProject: {
        id: "C000900",
        title: "",
        body: "",
        covers: [],
        primaryCoverId: null,
        references: inspirations,
        category: "",
        categoryAssignedByUser: false,
        modified: "刚刚",
      },
    },
  });
  await page.goto("/");
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "编辑", exact: true }).click();
  const grid = page.locator(".creation-reference-grid");
  await expect(grid.locator(".inspiration-card")).toHaveCount(3);
  const flowStyle = await grid.evaluate((element) => {
    const style = getComputedStyle(element);
    return { display: style.display, flexWrap: style.flexWrap, gridTemplateColumns: style.gridTemplateColumns };
  });
  expect(flowStyle).toMatchObject({ display: "grid", flexWrap: "nowrap", gridTemplateColumns: "228px 228px 228px" });
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(grid.locator(".inspiration-card")).toHaveCount(3);
  await expect(page.locator(".creation-shell")).not.toContainText(/C\d{6}/);
  await page.screenshot({ path: "qa/creation-references-1440x900.png", fullPage: true });
});

test("dragging 03 to 01 reorders before release and persists", async ({ page, request }) => {
  await openQueue(page);
  await dragToCard(page, "C000126", "C000127");
  await expect.poll(() => order(page)).toEqual(["C000126", "C000127", "C000128"]);
  await expect.poll(() => orderWithPriority(page)).toEqual([
    { id: "C000126", priority: "01" },
    { id: "C000127", priority: "02" },
    { id: "C000128", priority: "03" },
  ]);
  await page.mouse.up();

  await expect.poll(async () => {
    const response = await request.get("/api/library");
    return (await response.json()).projects.map((project) => project.id);
  }).toEqual(["C000126", "C000127", "C000128"]);

  await page.reload();
  await page.getByRole("button", { name: /^创作台/ }).click();
  await expect.poll(() => order(page)).toEqual(["C000126", "C000127", "C000128"]);
  await expect.poll(() => orderWithPriority(page)).toEqual([
    { id: "C000126", priority: "01" },
    { id: "C000127", priority: "02" },
    { id: "C000128", priority: "03" },
  ]);
});

test("dragging 01 to 03 reorders before release and persists", async ({ page, request }) => {
  await openQueue(page);
  await dragToCard(page, "C000127", "C000126", "card");
  await expect.poll(() => order(page)).toEqual(["C000128", "C000126", "C000127"]);
  await expect.poll(() => orderWithPriority(page)).toEqual([
    { id: "C000128", priority: "01" },
    { id: "C000126", priority: "02" },
    { id: "C000127", priority: "03" },
  ]);
  await page.mouse.up();

  await expect.poll(async () => {
    const response = await request.get("/api/library");
    return (await response.json()).projects.map((project) => project.id);
  }).toEqual(["C000128", "C000126", "C000127"]);

  await page.reload();
  await page.getByRole("button", { name: /^创作台/ }).click();
  await expect.poll(() => orderWithPriority(page)).toEqual([
    { id: "C000128", priority: "01" },
    { id: "C000126", priority: "02" },
    { id: "C000127", priority: "03" },
  ]);
});

test("desktop viewport screenshots remain free of overlap and overflow", async ({ page }) => {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
    { width: 1600, height: 1000 },
  ]) {
    await page.setViewportSize(viewport);
    await openQueue(page);
    const card = page.locator('[data-project-id="C000128"]');
    await card.getByRole("button", { name: "展开封面 6 张" }).first().click();
    await expect(card.getByTestId("expanded-covers-C000128").locator("img")).toHaveCount(6);

    const layout = await page.evaluate(() => {
      const cardElement = document.querySelector('[data-project-id="C000128"]');
      const coverElement = cardElement.querySelector(".queue-cover-gallery-expanded");
      const copyElement = cardElement.querySelector('[data-account-role="blogger"] .queue-account-body-row');
      const actionElement = cardElement.querySelector(".queue-card-actions");
      const rect = (element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      };
      const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const cover = rect(coverElement);
      const copy = rect(copyElement);
      const actions = rect(actionElement);
      const card = rect(cardElement);
      return {
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
        coverCopyOverlap: overlaps(cover, copy),
        coverActionOverlap: overlaps(cover, actions),
        copyActionOverlap: overlaps(copy, actions),
        cardHeight: Math.round(card.bottom - card.top),
      };
    });
    expect(layout).toMatchObject({
      horizontalOverflow: false,
      coverCopyOverlap: false,
      coverActionOverlap: false,
      copyActionOverlap: false,
    });
    expect(layout.cardHeight).toBeGreaterThan(0);

    await page.screenshot({
      path: `qa/queue-${viewport.width}x${viewport.height}.png`,
      fullPage: true,
    });
  }
});
