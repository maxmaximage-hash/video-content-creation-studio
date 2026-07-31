import path from "node:path";

const CONTENT_ID_PATTERN = /^[IC]\d{6,}$/;
const LEGACY_READ_ROOTS = [
  "assets/covers/",
  "assets/originals/",
  "assets/projects/",
  "assets/videos/",
];

export function validateContentId(value) {
  const contentId = String(value || "").trim();
  if (!CONTENT_ID_PATTERN.test(contentId)) {
    const error = new Error("内容 ID 无效");
    error.statusCode = 400;
    throw error;
  }
  return contentId;
}

export function normalizeLibraryRelativePath(value, { allowEmpty = false } = {}) {
  const relativePath = String(value || "");
  if (!relativePath && allowEmpty) return "";
  if (
    !relativePath
    || relativePath.includes("\0")
    || relativePath.includes("\\")
    || path.isAbsolute(relativePath)
    || relativePath.startsWith("/")
  ) {
    const error = new Error("素材路径无效");
    error.statusCode = 400;
    throw error;
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    const error = new Error("素材路径无效");
    error.statusCode = 400;
    throw error;
  }
  return parts.join("/");
}

export function validateProjectAssetPath({ contentId: rawContentId, relativePath: rawRelativePath, scope = "asset" }) {
  const contentId = validateContentId(rawContentId);
  const unitRoot = `content-units/${contentId}`;
  const relativePath = normalizeLibraryRelativePath(rawRelativePath || unitRoot);
  if (!["project", "cover", "source_video", "finished_video", "asset"].includes(scope)) {
    const error = new Error("素材范围无效");
    error.statusCode = 400;
    throw error;
  }

  if (scope === "project") {
    if (relativePath !== unitRoot) {
      const error = new Error("项目目录路径无效");
      error.statusCode = 403;
      throw error;
    }
    return relativePath;
  }

  if (scope === "asset" && relativePath.startsWith(`${unitRoot}/`)) return relativePath;
  if (scope === "cover" && relativePath.startsWith(`${unitRoot}/covers/`)) return relativePath;
  if (scope === "source_video" && relativePath.startsWith(`${unitRoot}/media/source-video/`)) return relativePath;
  if (
    scope === "finished_video"
    && (
      relativePath.startsWith(`${unitRoot}/media/finished-video/`)
      || relativePath.startsWith(`${unitRoot}/media/refined-video/`)
      || relativePath.startsWith(`${unitRoot}/final/`)
    )
  ) return relativePath;
  if (scope === "cover" && relativePath.startsWith("assets/covers/")) return relativePath;
  if (
    scope === "source_video"
    && (
      relativePath.startsWith("assets/originals/")
      || relativePath.startsWith(`assets/projects/${contentId}/`)
    )
  ) return relativePath;
  if (scope === "finished_video" && relativePath.startsWith(`assets/projects/${contentId}/`)) return relativePath;

  const error = new Error("只能访问当前内容单元或受支持的旧版素材");
  error.statusCode = 403;
  throw error;
}

export function validateReadableLibraryAssetPath(rawRelativePath) {
  const relativePath = normalizeLibraryRelativePath(rawRelativePath);
  if (relativePath.startsWith("content-units/")) {
    const [, contentId, ...rest] = relativePath.split("/");
    validateContentId(contentId);
    if (!rest.length) {
      const error = new Error("素材路径无效");
      error.statusCode = 400;
      throw error;
    }
    return relativePath;
  }
  if (LEGACY_READ_ROOTS.some((root) => relativePath.startsWith(root))) return relativePath;
  const error = new Error("素材路径不在允许的资料库目录内");
  error.statusCode = 403;
  throw error;
}

export function isPathInside(rootPath, targetPath, { allowRoot = false } = {}) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  return (allowRoot && target === root) || target.startsWith(`${root}${path.sep}`);
}
