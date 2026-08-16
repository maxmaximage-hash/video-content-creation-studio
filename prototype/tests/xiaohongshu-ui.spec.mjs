import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/library", {
    data: {
      categories: [],
      userDefinedCategories: [],
      projects: [],
      archive: [],
      activeProject: null,
      inspirations: [{
        id: "I000701",
        type: "inspiration",
        originalUrl: "https://www.xiaohongshu.com/explore/demo701",
        resolvedUrl: "https://www.xiaohongshu.com/explore/demo701",
        platform: "小红书",
        platformItemId: "demo701",
        contentType: "image",
        author: "本地样本",
        title: "多图笔记会完整进入创作",
        body: "",
        category: "",
        categoryAssignedByUser: false,
        capturedAt: "2026.07.23 14:00",
        updatedAt: "2026.07.23 14:00",
        parseState: "success",
        parseStatus: "视频已本地入库",
        parseStage: "扒取完成",
        stats: { likes: "120", favorites: "18", comments: "9", shares: "3", views: "" },
        publishedAt: "2026.07.22 10:30",
        images: [
          { id: "demo701-image-1", localPath: "/assets/covers/coffee-alley.png", sourceUrl: "https://img.example/1.jpg" },
          { id: "demo701-image-2", localPath: "/assets/covers/mountain-trail.png", sourceUrl: "https://img.example/2.jpg" },
          { id: "demo701-image-3", localPath: "/assets/covers/creator-desk.png", sourceUrl: "https://img.example/3.jpg" },
        ],
        coverLocalPath: "/assets/covers/coffee-alley.png",
        coverUrl: "https://img.example/1.jpg",
        parseEvidence: [],
      }],
    },
  });
  expect(response.ok()).toBeTruthy();
});

test("multi-image inspiration stays browseable as a reference without becoming a creation cover", async ({ page }) => {
  await page.goto("/");
  const card = page.locator(".inspiration-card");
  await expect(card.locator(".image-count-badge")).toHaveText("1/3");
  await expect(card.locator(".media-play")).toHaveCount(0);
  await expect(card.locator(".media-preview > img")).toHaveAttribute("src", "/assets/covers/coffee-alley.png");

  await card.getByRole("button", { name: "下一张图片" }).click();
  await expect(card.locator(".image-count-badge")).toHaveText("2/3");
  await expect(card.locator(".media-preview > img")).toHaveAttribute("src", "/assets/covers/mountain-trail.png");

  await card.getByRole("button", { name: "创作", exact: true }).click();
  await page.getByRole("button", { name: /开始新的创作/ }).click();
  await expect(page.locator(".cover-option")).toHaveCount(0);
  const referenceCard = page.locator(".creation-reference-grid .inspiration-card");
  await expect(referenceCard).toHaveCount(1);
  await expect(referenceCard.locator(".image-count-badge")).toHaveText("1/3");
  await referenceCard.getByRole("button", { name: "下一张图片" }).click();
  await expect(referenceCard.locator(".image-count-badge")).toHaveText("2/3");
});

test("successful capture becomes an editable body card and stays consistent in creation", async ({ page, request, context }) => {
  await page.goto("/");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });

  const card = page.locator(".inspiration-card");
  await expect(card.locator(".parse-status-line")).toHaveCount(0);
  await expect(card.getByText("视频已本地入库", { exact: true })).toHaveCount(0);

  const body = card.getByRole("textbox", { name: "灵感正文" });
  await expect(body).toHaveValue("");
  await expect(card.getByRole("button", { name: "复制全文" })).toBeDisabled();

  const fullText = "这是手动补录的完整正文。第二句继续验证缩略输入与自动保存。";
  await body.fill(fullText);
  await expect(card.getByRole("button", { name: "复制全文" })).toBeEnabled();
  await card.getByRole("button", { name: "复制全文" }).click();
  await expect(page.locator(".toast")).toContainText("已复制全文");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(fullText);
  await expect.poll(async () => {
    const library = await (await request.get("/api/library")).json();
    return library.inspirations[0]?.body;
  }).toBe(fullText);

  await card.getByRole("button", { name: "创作", exact: true }).click();
  await page.getByRole("button", { name: /开始新的创作/ }).click();

  const referenceCard = page.locator(".creation-reference-grid .inspiration-card");
  await expect(referenceCard).toHaveCount(1);
  await expect(referenceCard.getByRole("textbox", { name: "灵感正文" })).toHaveValue(fullText);
  await expect(referenceCard.getByRole("button", { name: "复制全文" })).toBeVisible();
  await expect(referenceCard.getByRole("button", { name: "复制原链接" })).toBeVisible();
  await expect(referenceCard.getByRole("button", { name: "创作", exact: true })).toHaveCount(0);

  const revisedText = `${fullText} 创作页补充。`;
  await referenceCard.getByRole("textbox", { name: "灵感正文" }).fill(revisedText);
  await expect.poll(async () => {
    const library = await (await request.get("/api/library")).json();
    return {
      source: library.inspirations[0]?.body,
      reference: library.activeProject?.references?.[0]?.body,
    };
  }).toEqual({ source: revisedText, reference: revisedText });
});

test("duplicate title is not shown as body text", async ({ page, request }) => {
  const duplicateTitle = "标题只应该显示在标题区";
  const response = await request.post("/api/library", {
    data: {
      categories: [],
      userDefinedCategories: [],
      projects: [],
      archive: [],
      activeProject: null,
      inspirations: [{
        id: "I000702",
        type: "inspiration",
        originalUrl: "https://www.douyin.com/video/702",
        resolvedUrl: "https://www.douyin.com/video/702",
        platform: "抖音",
        contentType: "video",
        author: "",
        title: duplicateTitle,
        body: duplicateTitle,
        category: "",
        capturedAt: "2026.07.23 14:30",
        updatedAt: "2026.07.23 14:30",
        parseState: "success",
        parseStatus: "已扒取公开信息",
        parseStage: "扒取完成",
        stats: { likes: "", favorites: "", comments: "", shares: "", views: "" },
        images: [],
        parseEvidence: [],
      }],
    },
  });
  expect(response.ok()).toBeTruthy();

  await page.goto("/");
  const card = page.locator(".inspiration-card");
  await expect(card.locator("h3")).toHaveText(duplicateTitle);
  await expect(card.getByRole("textbox", { name: "灵感正文" })).toHaveValue("");
  await expect(card.getByRole("button", { name: "复制全文" })).toBeDisabled();
});

test("xhslink.cn share text is recognized as Xiaohongshu before extraction", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "主页或作品链接" }).fill(
    "去湘湖吃漂亮饭咯 http://xhslink.cn/o/N3xcFGE7Ed 复制这段，去【小红书】发现更多好内容~",
  );
  await expect(page.getByRole("button", { name: "添加灵感" })).toBeEnabled();
  await page.getByRole("button", { name: "添加灵感" }).click();

  const newestCard = page.locator(".inspiration-card").first();
  await expect(newestCard.locator(".media-badges .status-pill")).toHaveText("小红书");
  await expect(newestCard.getByText("未识别", { exact: true })).toHaveCount(0);
});
