import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIBRARY_NAME } from "../server/library-manager.mjs";

const prototypeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const qaLibraryRoot = process.env.VIDEO_CONTENT_LIBRARY_ROOT || path.join(prototypeRoot, ".qa-library");
const defaultLibraryDir = path.join(qaLibraryRoot, DEFAULT_LIBRARY_NAME);
const managementRoot = path.join(prototypeRoot, ".qa-library-management");

test("library controls rename, close and reopen a real isolated library", async ({ page, request }) => {
  await fs.rm(managementRoot, { recursive: true, force: true });
  await fs.mkdir(managementRoot, { recursive: true });
  const initialPath = path.join(managementRoot, "选题资料库.library");
  const renamedPath = path.join(managementRoot, "品牌内容资料库.library");

  try {
    let response = await request.post("/api/library/manage", { data: { action: "new", path: initialPath } });
    expect(response.ok()).toBeTruthy();
    let library = await response.json();
    response = await request.post("/api/library", {
      headers: { "x-library-session-id": library.storage.sessionId },
      data: {
        categories: [],
        inspirations: [{ id: "I-9001", title: "切库后仍保留的灵感" }],
        projects: [],
        archive: [],
        activeProject: null,
      },
    });
    expect(response.ok()).toBeTruthy();

    await page.goto("/");
    await expect(page.getByRole("button", { name: /选题资料库\.library/ })).toBeVisible();
    await page.getByRole("button", { name: /选题资料库\.library/ }).click();
    await page.getByRole("menuitem", { name: "重命名资料库" }).click();
    await expect(page.getByRole("dialog", { name: "重命名资料库" })).toBeVisible();
    await page.getByLabel("资料库名称").fill("品牌内容资料库");
    await page.getByRole("button", { name: "确认重命名" }).click();
    await expect(page.getByRole("button", { name: /品牌内容资料库\.library/ })).toBeVisible();
    await expect(page.getByText("切库后仍保留的灵感")).toBeVisible();

    await page.getByRole("button", { name: /品牌内容资料库\.library/ }).click();
    await page.getByRole("menuitem", { name: "关闭资料库" }).click();
    await page.getByRole("dialog", { name: "关闭资料库" }).getByRole("button", { name: "关闭资料库" }).click();
    await expect(page.getByRole("heading", { name: "没有打开资料库" })).toBeVisible();

    response = await request.post("/api/library/manage", { data: { action: "open", path: renamedPath } });
    expect(response.ok()).toBeTruthy();
    await page.reload();
    await expect(page.getByText("切库后仍保留的灵感")).toBeVisible();
  } finally {
    await request.post("/api/library/manage", { data: { action: "open", path: defaultLibraryDir } });
    await fs.rm(managementRoot, { recursive: true, force: true });
  }
});
