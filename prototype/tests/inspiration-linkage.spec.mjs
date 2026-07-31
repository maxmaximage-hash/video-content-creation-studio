import { expect, test } from "@playwright/test";
import { collectReferencedInspirationIds } from "../src/features/inspirations/inspiration-model.js";

const inspirations = [
  {
    id: "I001001",
    platform: "抖音",
    contentType: "image",
    originalUrl: "https://www.douyin.com/video/linkage-1001",
    title: "Active canonical 关联",
    body: "来自当前创作的 canonical relationship。",
    author: "作者一",
    coverLocalPath: "/assets/covers/coffee-alley.png",
    category: "选题",
    categoryAssignedByUser: true,
    stats: { likes: 1001 },
  },
  {
    id: "I001002",
    platform: "小红书",
    contentType: "image",
    originalUrl: "https://www.xiaohongshu.com/explore/linkage-1002",
    title: "多创作重复引用",
    body: "当前创作与待发布创作同时引用。",
    author: "作者二",
    coverLocalPath: "/assets/covers/creator-desk.png",
    category: "选题",
    categoryAssignedByUser: true,
    stats: { favorites: 2002 },
  },
  {
    id: "I001003",
    platform: "抖音",
    contentType: "image",
    originalUrl: "https://www.douyin.com/video/linkage-1003",
    title: "待发布 canonical 关联",
    body: "来自待发布创作的 canonical relationship。",
    author: "作者三",
    coverLocalPath: "/assets/covers/mountain-trail.png",
    category: "拍摄",
    categoryAssignedByUser: true,
    stats: { comments: 33 },
  },
  {
    id: "I001004",
    platform: "小红书",
    contentType: "image",
    originalUrl: "https://www.xiaohongshu.com/explore/linkage-1004",
    title: "归档 canonical 关联",
    body: "来自已发布归档的 canonical relationship。",
    author: "作者四",
    coverLocalPath: "/assets/covers/coffee-alley.png",
    category: "拍摄",
    categoryAssignedByUser: true,
    stats: { likes: 4004 },
  },
  {
    id: "I001005",
    platform: "Bilibili",
    contentType: "image",
    originalUrl: "https://www.bilibili.com/video/linkage-1005",
    title: "归档 legacy 关联",
    body: "来自已发布归档的 legacy references。",
    author: "作者五",
    coverLocalPath: "/assets/covers/creator-desk.png",
    category: "选题",
    categoryAssignedByUser: true,
    stats: { shares: 55 },
  },
  {
    id: "I001006",
    platform: "抖音",
    contentType: "image",
    originalUrl: "https://www.douyin.com/video/linkage-1006",
    title: "未关联专属灵感",
    body: "不应进入已关联筛选。",
    author: "作者六",
    coverLocalPath: "/assets/covers/mountain-trail.png",
    category: "选题",
    categoryAssignedByUser: true,
    stats: { likes: 66 },
  },
];

function libraryFixture() {
  return {
    categories: ["选题", "拍摄"],
    userDefinedCategories: ["选题", "拍摄"],
    inspirations,
    activeProject: {
      id: "C001000",
      unitSchemaVersion: 1,
      origin: "original",
      title: "当前创作",
      body: "",
      category: "",
      categoryAssignedByUser: false,
      covers: [],
      mediaAssets: [],
      creationStatus: "in_progress",
      relationships: {
        referenceContentIds: ["I001001", "I001001", "I12", "C001999"],
      },
      references: [inspirations[1]],
      workflow: { stage: "creating", creationStatus: "in_progress", completedAt: null },
    },
    projects: [{
      id: "C001001",
      unitSchemaVersion: 1,
      origin: "original",
      title: "待发布创作",
      body: "删除后应释放最后一处 legacy 引用。",
      category: "选题",
      categoryAssignedByUser: true,
      covers: [],
      mediaAssets: [],
      creationStatus: "in_progress",
      relationships: {
        referenceContentIds: ["I001003", "not-an-id"],
      },
      references: ["I001002"],
      workflow: { stage: "ready_to_publish", creationStatus: "in_progress", completedAt: null },
    }],
    archive: [{
      id: "C001002",
      unitSchemaVersion: 1,
      origin: "original",
      title: "已发布创作",
      body: "归档关系仍参与灵感关联计算。",
      category: "拍摄",
      categoryAssignedByUser: true,
      covers: [],
      mediaAssets: [],
      creationStatus: "completed",
      relationships: {
        referenceContentIds: ["I001004", "I001001"],
      },
      references: [{ id: "I001005" }, "X001005"],
      referenceCount: 3,
      workflow: { stage: "published", creationStatus: "completed", completedAt: "2026-07-24T08:00:00.000Z" },
    }],
  };
}

async function seedLibrary(request) {
  const response = await request.post("/api/library", { data: libraryFixture() });
  expect(response.ok()).toBeTruthy();
}

function inspirationCard(page, id) {
  return page.locator(`[data-inspiration-id="${id}"]`);
}

test.beforeEach(async ({ request }) => {
  await seedLibrary(request);
});

test("关系选择器兼容 active、projects、archive、canonical 与 legacy 并去重非法 ID", () => {
  const fixture = libraryFixture();
  const ids = collectReferencedInspirationIds({
    activeProject: fixture.activeProject,
    projects: fixture.projects,
    archiveItems: fixture.archive,
  });

  expect([...ids].sort()).toEqual([
    "I001001",
    "I001002",
    "I001003",
    "I001004",
    "I001005",
  ]);
});

test("灵感库显示克制的关联层级且参考卡片不继承关联边框", async ({ page }) => {
  await page.goto("/");

  const linked = inspirationCard(page, "I001001");
  const unlinked = inspirationCard(page, "I001006");
  await expect(linked).toHaveAttribute("data-linked", "true");
  await expect(linked).toHaveClass(/is-linked/);
  await expect(unlinked).toHaveAttribute("data-linked", "false");
  await expect(unlinked).not.toHaveClass(/is-linked/);

  const beforeHover = await linked.boundingBox();
  const visual = await linked.evaluate((card) => {
    const style = getComputedStyle(card);
    return {
      borderColor: style.borderColor,
      borderWidth: style.borderWidth,
      boxShadow: style.boxShadow,
    };
  });
  const unlinkedVisual = await unlinked.evaluate((card) => {
    const style = getComputedStyle(card);
    return {
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
    };
  });
  expect(visual.borderColor).not.toBe(unlinkedVisual.borderColor);
  expect(visual.boxShadow).not.toBe(unlinkedVisual.boxShadow);
  expect(visual.borderWidth).toBe("1px");

  await linked.hover();
  const afterHover = await linked.boundingBox();
  expect(afterHover.width).toBeCloseTo(beforeHover.width, 1);
  expect(afterHover.height).toBeCloseTo(beforeHover.height, 1);

  await page.getByLabel("主导航").getByRole("button", { name: "创作", exact: true }).click();
  const referenceCard = page.locator(`.creation-reference-grid [data-inspiration-id="I001002"]`);
  await expect(referenceCard).toBeVisible();
  await expect(referenceCard).toHaveAttribute("data-linked", "false");
  await expect(referenceCard).not.toHaveClass(/is-linked/);
});

test("已关联筛选与搜索、用户分类组合工作且空结果不误报清空", async ({ page }) => {
  await page.goto("/");
  const platformFilter = page.getByLabel("平台筛选");
  await platformFilter.getByRole("button", { name: "已关联", exact: true }).click();
  await expect(page.locator(".inspiration-grid .inspiration-card")).toHaveCount(5);
  await expect(inspirationCard(page, "I001006")).toHaveCount(0);

  const search = page.locator('.inspiration-toolbar input[placeholder*="搜索标题"]');
  await search.fill("归档");
  await expect(page.locator(".inspiration-grid .inspiration-card")).toHaveCount(2);
  await expect(inspirationCard(page, "I001004")).toBeVisible();
  await expect(inspirationCard(page, "I001005")).toBeVisible();

  await page.getByLabel("分类筛选").getByRole("button", { name: /拍摄/ }).click();
  await expect(page.locator(".inspiration-grid .inspiration-card")).toHaveCount(1);
  await expect(inspirationCard(page, "I001004")).toBeVisible();

  await search.fill("未关联专属");
  await expect(page.getByRole("heading", { name: "没有匹配的灵感" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "灵感库已清空" })).toHaveCount(0);
});

test("移除一处重复引用仍保持关联，最后一处移除后状态消失", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("主导航").getByRole("button", { name: "创作", exact: true }).click();

  const referenceCard = page.locator(`.creation-reference-grid [data-inspiration-id="I001002"]`);
  await referenceCard.locator('summary[aria-label="更多操作"]').click();
  await referenceCard.getByRole("button", { name: "移除灵感参考", exact: true }).click();

  await page.getByLabel("主导航").getByRole("button", { name: "灵感库", exact: true }).click();
  await expect(inspirationCard(page, "I001002")).toHaveAttribute("data-linked", "true");

  await page.getByLabel("主导航").getByRole("button", { name: /^待发布/ }).click();
  const queueCard = page.locator('[data-project-id="C001001"]');
  page.once("dialog", (dialog) => dialog.accept());
  await queueCard.getByRole("button", { name: "删除", exact: true }).click();

  await page.getByLabel("主导航").getByRole("button", { name: "灵感库", exact: true }).click();
  await expect(inspirationCard(page, "I001002")).toHaveAttribute("data-linked", "false");
  await expect(inspirationCard(page, "I001003")).toHaveAttribute("data-linked", "false");
  await expect(inspirationCard(page, "I001004")).toHaveAttribute("data-linked", "true");
});

test("刷新后从关系重算且不持久化派生关联字段", async ({ page, request }) => {
  await page.goto("/");
  await page.getByLabel("平台筛选").getByRole("button", { name: "已关联", exact: true }).click();
  await expect(page.locator(".inspiration-grid .inspiration-card")).toHaveCount(5);

  await page.reload();
  await page.getByLabel("平台筛选").getByRole("button", { name: "已关联", exact: true }).click();
  await expect(page.locator(".inspiration-grid .inspiration-card")).toHaveCount(5);

  const library = await (await request.get("/api/library")).json();
  const forbiddenKeys = [];
  const inspect = (value, path = "library") => {
    if (!value || typeof value !== "object") return;
    Object.entries(value).forEach(([key, child]) => {
      if (key === "isLinked" || key === "linked") forbiddenKeys.push(`${path}.${key}`);
      inspect(child, `${path}.${key}`);
    });
  };
  inspect(library);
  expect(forbiddenKeys).toEqual([]);
});

test("1280、1440、1600 桌面宽度无横向溢出且关联样式不改变网格尺寸", async ({ page }) => {
  for (const width of [1280, 1440, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(inspirationCard(page, "I001001")).toBeVisible();
    await expect(inspirationCard(page, "I001006")).toBeVisible();
    const layout = await page.evaluate(() => {
      const linked = document.querySelector('[data-inspiration-id="I001001"]');
      const unlinked = document.querySelector('[data-inspiration-id="I001006"]');
      const linkedRect = linked.getBoundingClientRect();
      const unlinkedRect = unlinked.getBoundingClientRect();
      return {
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        linkedWidth: linkedRect.width,
        unlinkedWidth: unlinkedRect.width,
      };
    });
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.linkedWidth).toBeCloseTo(layout.unlinkedWidth, 1);
  }
});
