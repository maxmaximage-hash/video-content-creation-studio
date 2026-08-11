import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

function persistedLibrary(library, overrides = {}) {
  const {
    storage: _storage,
    libraryOpen: _libraryOpen,
    sessionId: _sessionId,
    revision: _revision,
    ...persisted
  } = library;
  return {
    ...persisted,
    ...overrides,
  };
}

test("stale client revision rebases a single ID delete without returning a full library", async ({ request }) => {
  const libraryResponse = await request.get("/api/library");
  expect(libraryResponse.ok()).toBeTruthy();
  const library = await libraryResponse.json();
  const indexFile = path.join(library.storage.libraryDir, "library.json");
  const clientRevision = 475;
  const base = persistedLibrary(library, {
    libraryRevision: clientRevision,
    projects: [
      { id: "C000022", title: "删除目标", body: "旧页面目标", covers: [], mediaAssets: [] },
      { id: "C000023", title: "旧页面保留", body: "客户端本地文案", covers: [], mediaAssets: [] },
    ],
    inspirations: [{ id: "I000010", title: "旧页面灵感" }],
    archive: [],
    activeProject: null,
  });
  const latest = {
    ...base,
    libraryRevision: 476,
    projects: [
      base.projects[0],
      { ...base.projects[1], title: "迁移专项已修改", body: "服务端最新文案" },
      { id: "C000024", title: "迁移专项新增", body: "", covers: [], mediaAssets: [] },
    ],
    inspirations: [...base.inspirations, { id: "I000011", title: "迁移专项新增灵感" }],
  };
  await fs.writeFile(indexFile, `${JSON.stringify(latest, null, 2)}\n`, "utf8");

  const deleteResponse = await request.delete("/api/projects/C000022/index", {
    headers: {
      "x-library-session-id": library.storage.sessionId,
      "x-library-revision": String(clientRevision),
    },
    data: {
      projectPatches: [{
        projectId: "C000023",
        operations: [{ path: ["title"], value: "本地未保存标题" }],
      }],
    },
  });
  expect(deleteResponse.ok()).toBeTruthy();
  const result = await deleteResponse.json();
  expect(result).toMatchObject({
    removedProjectId: "C000022",
    filesPreserved: true,
    revision: 477,
  });
  expect(result.library).toBeUndefined();
  expect(result.reconciledProjects).toEqual([expect.objectContaining({
    id: "C000023",
    title: "本地未保存标题",
  })]);

  const persisted = JSON.parse(await fs.readFile(indexFile, "utf8"));
  expect(persisted.libraryRevision).toBe(477);
  expect(persisted.projects.map((project) => project.id)).toEqual(["C000023", "C000024"]);
  expect(persisted.projects.find((project) => project.id === "C000023").title).toBe("本地未保存标题");
  expect(persisted.inspirations.map((item) => item.id)).toEqual(["I000010", "I000011"]);
});

test("single ID delete preserves external migration fields and local dirty edits without stale full saves", async ({ page, request }) => {
  const libraryResponse = await request.get("/api/library");
  expect(libraryResponse.ok()).toBeTruthy();
  const library = await libraryResponse.json();
  const indexFile = path.join(library.storage.libraryDir, "library.json");
  const clientRevision = 475;
  const clientLibrary = persistedLibrary(library, {
    libraryRevision: clientRevision,
    projects: [
      { id: "C000022", title: "删除目标", body: "旧页面目标", covers: [], mediaAssets: [] },
      {
        id: "C000023",
        title: "旧页面保留",
        body: "客户端加载时正文",
        covers: [],
        mediaAssets: [],
      },
    ],
    inspirations: [],
    archive: [],
    activeProject: null,
  });
  await fs.writeFile(indexFile, `${JSON.stringify(clientLibrary, null, 2)}\n`, "utf8");

  await page.goto("/");
  await page.getByRole("button", { name: "内容库" }).click();
  const preservedCard = page.locator('[data-project-id="C000023"]');
  await expect(preservedCard).toBeVisible();

  const latestLibrary = {
    ...clientLibrary,
    libraryRevision: 476,
    projects: [
      clientLibrary.projects[0],
      {
        ...clientLibrary.projects[1],
        title: "迁移专项已修改",
        body: "服务端最新正文",
        eagleRouting: {
          bloggerSourceFolderId: "MSOSLZLAY5RGP",
          bloggerOutputFolderId: "MS8R943CBJV6L",
          ipSourceFolderId: "MSOSM8ESCD2D0",
          ipOutputFolderId: "MSHM7I3KNXBML",
        },
        mediaAssets: [{
          id: "asset-external",
          role: "source_video",
          accountRole: "blogger",
          eagleItemId: "EAGLE-C000023-SOURCE",
          eagleFolderId: "MSOSLZLAY5RGP",
        }],
      },
      { id: "C000024", title: "迁移专项新增", body: "", covers: [], mediaAssets: [] },
    ],
  };
  await fs.writeFile(indexFile, `${JSON.stringify(latestLibrary, null, 2)}\n`, "utf8");

  const dirtyBody = "本地 dirty edit：用户还没保存，但删除索引不能把它清掉。";
  await preservedCard.getByLabel("博主号正文").fill(dirtyBody);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('[data-project-id="C000022"]').getByRole("button", { name: "删除" }).click();

  await expect(page.locator('[data-project-id="C000022"]')).toHaveCount(0);
  await expect(preservedCard.getByLabel("博主号正文")).toHaveValue(dirtyBody);
  await expect(page.locator(".toast")).toContainText("已删除软件索引");
  await expect(page.locator(".toast")).not.toContainText("版本已变化");
  await page.waitForTimeout(800);

  const persisted = JSON.parse(await fs.readFile(indexFile, "utf8"));
  expect(persisted.libraryRevision).toBe(477);
  expect(persisted.projects.map((project) => project.id)).toEqual(["C000023", "C000024"]);
  const preserved = persisted.projects.find((project) => project.id === "C000023");
  expect(preserved.title).toBe("迁移专项已修改");
  expect(preserved.body).toBe(dirtyBody);
  expect(preserved.eagleRouting).toMatchObject({
    bloggerSourceFolderId: "MSOSLZLAY5RGP",
    bloggerOutputFolderId: "MS8R943CBJV6L",
    ipSourceFolderId: "MSOSM8ESCD2D0",
    ipOutputFolderId: "MSHM7I3KNXBML",
  });
  expect(preserved.mediaAssets).toEqual(expect.arrayContaining([
    expect.objectContaining({
      eagleItemId: "EAGLE-C000023-SOURCE",
      eagleFolderId: "MSOSLZLAY5RGP",
    }),
  ]));
});
