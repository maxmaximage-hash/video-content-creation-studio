export function libraryRelativePath(asset) {
  if (asset?.relativePath) return String(asset.relativePath).replace(/^\/+/, "");
  const src = String(asset?.src || asset?.localPath || asset?.coverLocalPath || "");
  return src.startsWith("/library-assets/") ? src.slice("/library-assets/".length) : "";
}

export function uploadProjectMediaFile({
  file,
  projectId,
  role,
  accountRole,
  uploadId,
  sessionId,
  onProgress = () => {},
}) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const query = new URLSearchParams({
      projectId,
      role,
      accountRole,
      uploadId,
    });
    request.open("POST", `/api/project-media?${query}`);
    request.setRequestHeader("content-type", file.type || "application/octet-stream");
    request.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    request.setRequestHeader("x-library-session-id", sessionId || "");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => reject(new Error("视频上传中断，请重试"));
    request.onload = () => {
      let result = {};
      try {
        result = JSON.parse(request.responseText || "{}");
      } catch {}
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(result.error || `视频上传失败：HTTP ${request.status}`));
        return;
      }
      onProgress(100);
      resolve(result.media);
    };
    request.send(file);
  });
}

export async function uploadProjectCoverFile({ file, projectId, accountRole = "blogger", sessionId }) {
  const query = new URLSearchParams({ projectId, accountRole });
  const response = await fetch(`/api/covers?${query}`, {
    method: "POST",
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-file-name": encodeURIComponent(file.name),
      "x-library-session-id": sessionId || "",
    },
    body: file,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `封面上传失败：HTTP ${response.status}`);
  return result.cover;
}

export async function revealProjectTarget({ projectId, relativePath = "", scope = "project", sessionId = "" }) {
  const response = await fetch("/api/project-actions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-library-session-id": sessionId,
    },
    body: JSON.stringify({ action: "reveal", projectId, relativePath, scope }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "无法在访达中显示");
  return result;
}

export async function deleteProjectMediaFile({
  projectId,
  role,
  accountRole,
  mediaId = "",
  relativePath,
  eagleItemId = "",
  legacyAccountRole = false,
  sessionId = "",
}) {
  const response = await fetch("/api/project-media", {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      "x-library-session-id": sessionId,
    },
    body: JSON.stringify({
      projectId,
      role,
      accountRole,
      mediaId,
      relativePath,
      eagleItemId,
      legacyAccountRole,
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "视频永久删除失败");
  return result;
}

export async function fetchProjectAssetStates({ projectId, assets, sessionId = "" }) {
  const response = await fetch("/api/project-assets/status", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-library-session-id": sessionId,
    },
    body: JSON.stringify({ projectId, assets }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "无法检查素材状态");
  return result;
}

export function canStartNativeFileDrag(asset) {
  return Boolean(libraryRelativePath(asset) && window.videoContentDesktop?.startFileDrag);
}

export function startNativeFileDrag(event, { projectId, asset, scope, sessionId = "" }) {
  const relativePath = libraryRelativePath(asset);
  if (!relativePath || !window.videoContentDesktop?.startFileDrag) return false;
  event.stopPropagation();
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("text/plain", asset?.name || "");
  window.videoContentDesktop.startFileDrag({
    projectId,
    relativePath,
    scope,
    sessionId,
    name: asset?.name || "",
  });
  return true;
}
