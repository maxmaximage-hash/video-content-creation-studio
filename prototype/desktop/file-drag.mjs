import path from "node:path";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import {
  isPathInside,
  validateProjectAssetPath,
} from "../server/path-security.mjs";

export function resolveDragFile({ libraryDir, activeSessionId = "", payload }) {
  if (!libraryDir) throw new Error("当前没有打开资料库");
  const legacyPayload = typeof payload === "string";
  const request = legacyPayload
    ? { relativePath: payload, projectId: String(payload).split("/")[1] || "", scope: "asset" }
    : (payload || {});
  if (!legacyPayload && activeSessionId && request.sessionId !== activeSessionId) {
    throw new Error("资料库已经切换，请刷新后重试");
  }
  if (request.scope === "project") throw new Error("项目目录不能作为文件拖出");
  const relativePath = validateProjectAssetPath({
    contentId: request.projectId,
    relativePath: request.relativePath,
    scope: request.scope || "asset",
  });
  const realLibraryDir = realpathSync(libraryDir);
  const requestedPath = path.resolve(realLibraryDir, relativePath);
  if (!isPathInside(realLibraryDir, requestedPath)) throw new Error("素材路径不在当前资料库内");
  const realFilePath = realpathSync(requestedPath);
  if (!isPathInside(realLibraryDir, realFilePath)) throw new Error("素材路径不在当前资料库内");
  if (!statSync(realFilePath).isFile()) throw new Error("只能拖出素材文件");
  const extension = path.extname(realFilePath).toLowerCase();
  const allowedExtensions = request.scope === "cover"
    ? new Set([".jpg", ".jpeg", ".png", ".webp"])
    : request.scope === "source_video" || request.scope === "finished_video"
      ? new Set([".mp4", ".mov", ".m4v", ".webm"])
      : new Set([".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov", ".m4v", ".webm"]);
  if (!allowedExtensions.has(extension)) throw new Error("素材文件类型不允许拖出");
  accessSync(realFilePath, constants.R_OK);
  return realFilePath;
}
