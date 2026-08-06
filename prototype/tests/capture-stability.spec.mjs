import { expect, test } from "@playwright/test";

function inspiration(overrides = {}) {
  return {
    id: "I000801",
    type: "inspiration",
    originalUrl: "https://www.douyin.com/video/801",
    resolvedUrl: "https://www.douyin.com/video/801",
    platform: "抖音",
    platformItemId: "801",
    contentType: "video",
    author: "",
    title: "等待采集的灵感",
    body: "",
    category: "",
    capturedAt: "2026.07.25 10:00",
    updatedAt: "2026.07.25 10:00",
    parseState: "waiting_login",
    parseStatus: "需要登录后继续采集",
    parseStage: "等待登录",
    parseProgress: 0,
    stats: {},
    images: [],
    ...overrides,
  };
}

async function seed(request, overrides = {}) {
  const response = await request.post("/api/library", { data: {
    categories: [],
    userDefinedCategories: [],
    projects: [],
    archive: [],
    activeProject: null,
    inspirations: [inspiration(overrides)],
  } });
  expect(response.ok()).toBeTruthy();
}

test("waiting login becomes authenticated and resumes the same content ID once", async ({ page, request }) => {
  await seed(request);
  let opened = false;
  let probesAfterOpen = 0;
  let extractionCount = 0;
  const extractedIds = [];
  await page.route("**/api/auth/**", async (route) => {
    if (route.request().url().includes("/open")) {
      opened = true;
      await route.fulfill({ json: { platform: "douyin", status: "登录窗口已打开" } });
      return;
    }
    if (opened) probesAfterOpen += 1;
    const authenticated = opened && probesAfterOpen >= 2;
    await route.fulfill({ json: {
      douyin: {
        label: "抖音",
        hasProfile: opened,
        browserState: opened ? "online" : "offline",
        authState: authenticated ? "authenticated" : "login_required",
        needsUserAction: !authenticated,
        lastCheckedAt: "2026-07-25T10:00:00.000Z",
        errorCode: authenticated ? "" : "AUTH_LOGIN_REQUIRED",
      },
      xiaohongshu: { label: "小红书", hasProfile: false, browserState: "offline", authState: "login_required", needsUserAction: true, errorCode: "AUTH_PROFILE_MISSING" },
    } });
  });
  await page.route("**/api/extract", async (route) => {
    extractionCount += 1;
    const body = route.request().postDataJSON();
    extractedIds.push(body.id);
    await route.fulfill({ json: {
      platform: "抖音",
      originalUrl: body.url,
      resolvedUrl: body.url,
      platformItemId: "801",
      contentType: "video",
      title: "登录后采集成功",
      body: "真实正文",
      author: "真实作者",
      videoLocalPath: "/assets/demo-video.mp4",
      parseState: "success",
      parseStatus: "采集成功",
      stats: {},
    } });
  });

  await page.goto("/");
  const card = page.locator('[data-inspiration-id="I000801"]');
  await expect(card.getByText("等待登录", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "打开登录" }).click();
  await expect(card.locator(".parse-status-line")).toHaveCount(0, { timeout: 10000 });
  await expect(card.locator("h3")).toHaveText("等待采集的灵感");
  expect(extractionCount).toBe(1);
  expect(extractedIds).toEqual(["I000801"]);
  await expect(page.locator(".inspiration-card")).toHaveCount(1);
});

test("partial remains visible, is not stored as 100 percent and does not show a success toast", async ({ page, request }) => {
  await seed(request, { parseState: "failed", parseStatus: "上次采集失败", parseStage: "采集失败" });
  await page.route("**/api/auth/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/extract", (route) => route.fulfill({ json: {
    platform: "抖音",
    platformItemId: "801",
    contentType: "image",
    title: "只拿到标题",
    images: [{ localPath: "/assets/covers/coffee-alley.png" }],
    parseState: "partial",
    parseStatus: "部分采集：已保存媒体",
    stats: {},
  } }));
  await page.goto("/");
  const card = page.locator('[data-inspiration-id="I000801"]');
  await card.getByRole("button", { name: "重试" }).click();
  await expect(card.locator(".parse-status-line.partial")).toBeVisible();
  await expect(page.locator(".toast")).toContainText("部分信息仍未获取");
  await expect(page.locator(".toast")).not.toContainText("成功");
  await expect.poll(async () => {
    const library = await (await request.get("/api/library")).json();
    return library.inspirations[0]?.parseProgress;
  }).not.toBe(100);
});

test("delete preserves the card on API failure and removes it only after success", async ({ page, request }) => {
  await seed(request);
  const current = await (await request.get("/api/library")).json();
  current.inspirations.push(inspiration({ id: "I000802", title: "保留的灵感" }));
  let deleteAttempts = 0;
  await page.route("**/api/auth/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/content/I000801", async (route) => {
    deleteAttempts += 1;
    if (deleteAttempts === 1) {
      await route.fulfill({ status: 503, json: { error: "当前资料库不可访问" } });
      return;
    }
    await route.fulfill({ json: {
      deleted: true,
      contentId: "I000801",
      contentUnitState: "deleted",
      library: { ...current, inspirations: current.inspirations.filter((item) => item.id !== "I000801") },
    } });
  });
  await page.goto("/");
  const card = page.locator('[data-inspiration-id="I000801"]');
  await card.locator('summary[aria-label="更多操作"]').click();
  await card.getByRole("button", { name: "删除灵感" }).click();
  await expect(card).toBeVisible();
  await expect(page.locator(".toast")).toContainText("删除失败");

  const overflow = card.locator("details.card-overflow");
  if (!await overflow.evaluate((element) => element.open)) {
    await card.locator('summary[aria-label="更多操作"]').click();
  }
  await card.getByRole("button", { name: "删除灵感" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('[data-inspiration-id="I000802"]')).toBeVisible();
  expect(deleteAttempts).toBe(2);
});

test("retry_wait resumes once after restart with the same ID and generation", async ({ page, request }) => {
  await seed(request, {
    id: "I000038",
    generation: 4,
    parseState: "retry_wait",
    refreshState: "retry_wait",
    parseStatus: "抖音暂时不可用，稍后自动继续",
    refreshStatus: "冷却结束后自动继续",
    errorCode: "PLATFORM_UNAVAILABLE",
    retryable: true,
    attempt: 2,
    retryAfterMs: 1000,
    nextRetryAt: "2020-01-01T00:00:00.000Z",
  });
  await page.route("**/api/auth/**", (route) => route.fulfill({ json: {} }));
  const requests = [];
  await page.route("**/api/extract", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: {
      parseState: "retry_wait",
      captureState: "retry_wait",
      parseStatus: "抖音暂时不可用，稍后自动继续",
      errorCode: "PLATFORM_UNAVAILABLE",
      retryable: true,
      attempt: 3,
      retryAfterMs: 300000,
      nextRetryAt: "2099-01-01T00:00:00.000Z",
    } });
  });

  await page.goto("/");
  const card = page.locator('[data-inspiration-id="I000038"]');
  await expect(card.locator(".parse-status-line.retry_wait")).toBeVisible();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].id).toBe("I000038");
  expect(requests[0].generation).toBe(4);
  expect(requests[0].attempt).toBe(3);
  await page.waitForTimeout(1200);
  expect(requests).toHaveLength(1);
});

test("profile batch immediately promotes the active card and shows its live stage", async ({ page, request }) => {
  await seed(request, { id: "I000801", title: "其他灵感", parseState: "success", refreshState: "success" });
  const current = await (await request.get("/api/library")).json();
  current.inspirations.push(inspiration({
    id: "I000802",
    title: "正在采集的真实卡片",
    parseState: "success",
    refreshState: "success",
  }));
  await request.post("/api/library", { data: current });
  let statusPolls = 0;
  await page.route("**/api/profile-scans*", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 202, json: { batch: {
        id: "B-live-card",
        platform: "douyin",
        state: "scanning",
        foundCount: 0,
        processedCount: 0,
        updatedAt: "2026-08-04T07:00:00.000Z",
      } } });
      return;
    }
    if (!new URL(route.request().url()).searchParams.get("id")) {
      await route.fulfill({ json: { batches: [] } });
      return;
    }
    statusPolls += 1;
    await route.fulfill({ json: { batch: {
      id: "B-live-card",
      platform: "douyin",
      state: "collecting",
      foundCount: 1,
      processedCount: 0,
      existingCount: 1,
      currentContentId: "I000802",
      currentGeneration: 1,
      currentStage: "正在读取作品页面",
      currentProgress: 38,
      message: "正在采集 1/1",
      updatedAt: `2026-08-04T07:00:0${statusPolls}.000Z`,
    } } });
  });

  await page.goto("/");
  await page.getByRole("textbox", { name: "主页或作品链接" }).fill("https://www.douyin.com/video/802");
  await page.getByRole("button", { name: "扫描并自动扒取" }).click();
  const firstCard = page.locator(".inspiration-grid .inspiration-card").first();
  await expect(firstCard).toHaveAttribute("data-inspiration-id", "I000802", { timeout: 8000 });
  await expect(firstCard.locator(".parse-status-line.extracting")).toContainText("正在读取作品页面");
  await expect(firstCard.locator('[role="progressbar"]')).toHaveAttribute("aria-valuenow", "38");
});
