#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(root);
const outputRoot = path.join(repositoryRoot, "docs", "images");
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "video-content-studio-docs-"));
const port = 4188;
const baseURL = `http://127.0.0.1:${port}`;
const publicLibraryRoot = "/Users/Shared";

const inspirations = [
  {
    id: "I900001",
    unitSchemaVersion: 1,
    origin: "captured",
    type: "inspiration",
    platform: "抖音",
    contentType: "image_set",
    originalUrl: "https://example.invalid/douyin/demo-1",
    title: "镜头节奏与开场构图参考",
    body: "用于展示灵感卡片、分类、互动数据与创作关联。",
    author: "示例创作者",
    category: "镜头语言",
    categoryAssignedByUser: true,
    coverLocalPath: "/assets/covers/coffee-alley.png",
    images: [{ id: "demo-1", localPath: "/assets/covers/coffee-alley.png", role: "content_image", order: 1 }],
    stats: { likes: "1.2万", favorites: "860", comments: "126", shares: "94", views: "" },
    parseState: "success",
    parseStatus: "采集成功：本地素材可用",
    parseProgress: 100,
    workflow: { stage: "inspiration", creationStatus: null, completedAt: null },
  },
  {
    id: "I900002",
    unitSchemaVersion: 1,
    origin: "captured",
    type: "inspiration",
    platform: "小红书",
    contentType: "image_set",
    originalUrl: "https://example.invalid/xiaohongshu/demo-2",
    title: "一组封面如何保持统一视觉",
    body: "多图内容会按原顺序保存到同一内容单元。",
    author: "示例账号",
    category: "封面设计",
    categoryAssignedByUser: true,
    coverLocalPath: "/assets/covers/creator-desk.png",
    images: [{ id: "demo-2", localPath: "/assets/covers/creator-desk.png", role: "content_image", order: 1 }],
    stats: { likes: "3280", favorites: "1204", comments: "88", shares: "61", views: "" },
    parseState: "success",
    parseStatus: "采集成功：本地素材可用",
    parseProgress: 100,
    workflow: { stage: "inspiration", creationStatus: null, completedAt: null },
  },
  {
    id: "I900003",
    unitSchemaVersion: 1,
    origin: "captured",
    type: "inspiration",
    platform: "小红书",
    contentType: "image_set",
    originalUrl: "https://example.invalid/xiaohongshu/demo-3",
    title: "户外选题的画面层次参考",
    body: "示例数据不访问真实平台，也不包含真实用户信息。",
    author: "演示资料",
    category: "选题",
    categoryAssignedByUser: true,
    coverLocalPath: "/assets/covers/mountain-trail.png",
    images: [{ id: "demo-3", localPath: "/assets/covers/mountain-trail.png", role: "content_image", order: 1 }],
    stats: { likes: "940", favorites: "312", comments: "25", shares: "18", views: "" },
    parseState: "success",
    parseStatus: "采集成功：本地素材可用",
    parseProgress: 100,
    workflow: { stage: "inspiration", creationStatus: null, completedAt: null },
  },
];

const project = {
  id: "C900001",
  unitSchemaVersion: 1,
  origin: "original",
  title: "从灵感到成片的完整示例",
  body: "标题、正文、封面、参考灵感和四个视频槽位始终属于同一个内容单元。",
  category: "教程",
  categoryAssignedByUser: true,
  covers: [
    { id: "cover-1", src: "/assets/covers/coffee-alley.png", name: "coffee-alley.png" },
    { id: "cover-2", src: "/assets/covers/creator-desk.png", name: "creator-desk.png" },
    { id: "cover-3", src: "/assets/covers/mountain-trail.png", name: "mountain-trail.png" },
  ],
  mediaAssets: [],
  references: [inspirations[1]],
  relationships: { referenceContentIds: [inspirations[1].id] },
  creationStatus: "completed",
  workflow: { stage: "creating", creationStatus: "completed", completedAt: "2026-07-31T10:00:00.000Z" },
};

const library = {
  categories: ["选题", "镜头语言", "封面设计", "教程"],
  userDefinedCategories: ["选题", "镜头语言", "封面设计", "教程"],
  inspirations,
  activeProject: project,
  projects: [{ ...project, id: "C900002", title: "待发布：双账号视频内容", workflow: { ...project.workflow, stage: "ready_to_publish" } }],
  archive: [{
    ...project,
    id: "C900003",
    title: "已发布内容归档示例",
    publishedAt: "2026-07-31T11:00:00.000Z",
    workflow: { ...project.workflow, stage: "published" },
  }],
};

const server = spawn(process.execPath, [
  path.join(root, "node_modules/vite/bin/vite.js"),
  "--host", "127.0.0.1",
  "--port", String(port),
  "--strictPort",
], {
  cwd: root,
  env: {
    ...process.env,
    VIDEO_CONTENT_LIBRARY_ROOT: fixtureRoot,
    VIDEO_CONTENT_AUTH_ROOT: path.join(fixtureRoot, "auth-browser"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try {
      const response = await fetch(`${baseURL}/api/library`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("文档截图服务器启动超时");
}

async function replacePrivatePaths(page) {
  await page.evaluate(({ privateRoot, publicPath }) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.includes(privateRoot)) {
        node.textContent = node.textContent.replaceAll(privateRoot, publicPath);
      }
    }
  }, { privateRoot: fixtureRoot, publicPath: publicLibraryRoot });
}

let browser;
try {
  await waitForServer();
  const seedResponse = await fetch(`${baseURL}/api/library`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(library),
  });
  if (!seedResponse.ok) throw new Error(`示例资料库写入失败：${await seedResponse.text()}`);

  await fs.mkdir(outputRoot, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await replacePrivatePaths(page);
  await page.screenshot({ path: path.join(outputRoot, "inspirations.png"), fullPage: false });

  await page.getByLabel("主导航").getByRole("button", { name: "创作", exact: true }).click();
  await page.getByRole("heading", { name: "创作" }).waitFor();
  await replacePrivatePaths(page);
  await page.screenshot({ path: path.join(outputRoot, "creation.png"), fullPage: false });

  await page.getByLabel("主导航").getByRole("button", { name: /待发布/ }).click();
  await page.getByRole("heading", { name: "待发布" }).waitFor();
  await replacePrivatePaths(page);
  await page.screenshot({ path: path.join(outputRoot, "queue.png"), fullPage: false });

  await page.getByLabel("主导航").getByRole("button", { name: /归档/ }).click();
  await page.getByRole("heading", { name: "归档", exact: true }).waitFor();
  await replacePrivatePaths(page);
  await page.screenshot({ path: path.join(outputRoot, "archive.png"), fullPage: false });
  console.log(`文档截图已生成：${outputRoot}`);
} finally {
  await browser?.close().catch(() => {});
  server.kill("SIGTERM");
  await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
}
