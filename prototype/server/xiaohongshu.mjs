function decodeHtmlEntities(value = "") {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function firstUrl(value) {
  if (isHttpUrl(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstUrl(item);
      if (found) return found;
    }
  }
  if (value && typeof value === "object") {
    for (const key of ["urlDefault", "url_default", "urlPre", "url_pre", "url", "masterUrl", "master_url", "urlList", "url_list", "backupUrls", "backup_urls"]) {
      const found = firstUrl(value[key]);
      if (found) return found;
    }
  }
  return "";
}

function extractBalancedObject(source, startAt) {
  const start = source.indexOf("{", startAt);
  if (start < 0) return "";
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  return "";
}

function replaceUndefinedTokens(source) {
  let output = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      output += char;
      index += 1;
      continue;
    }
    if (source.startsWith("undefined", index)) {
      output += "null";
      index += "undefined".length;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function parseObject(source) {
  if (!source) return null;
  for (const candidate of [source, replaceUndefinedTokens(source)]) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return null;
}

export function collectXiaohongshuJson(html = "") {
  const source = decodeHtmlEntities(html);
  const results = [];
  const seen = new Set();
  const markerPattern = /(?:window\.)?__INITIAL_STATE__\s*=|["']noteDetailMap["']\s*:/g;
  let marker;
  while ((marker = markerPattern.exec(source))) {
    const raw = extractBalancedObject(source, marker.index + marker[0].length);
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    const parsed = parseObject(raw);
    if (parsed) results.push(parsed);
  }
  const scriptPattern = /<script[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((marker = scriptPattern.exec(source))) {
    const parsed = parseObject(marker[1].trim());
    if (parsed) results.push(parsed);
  }
  return results;
}

function noteCandidates(value, candidates = [], mapId = "", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return candidates;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => noteCandidates(item, candidates, mapId, seen));
    return candidates;
  }

  const direct = value.note;
  if (direct && typeof direct === "object") candidates.push({ ...direct, _mapNoteId: mapId || direct.noteId || "" });
  const noteCard = value.noteCard || value.note_card;
  if (noteCard && typeof noteCard === "object") {
    candidates.push({ ...noteCard, _mapNoteId: value.id || value.noteId || value.note_id || mapId || "" });
  }
  const noteMap = value.noteDetailMap || value.note_detail_map;
  if (noteMap && typeof noteMap === "object") {
    for (const [noteId, item] of Object.entries(noteMap)) {
      if (!item || typeof item !== "object") continue;
      const note = item.note || item.noteDetail || item.detail || item;
      if (note && typeof note === "object") candidates.push({ ...note, _mapNoteId: noteId });
    }
  }
  for (const child of Object.values(value)) noteCandidates(child, candidates, mapId, seen);
  return candidates;
}

function noteIdFromUrl(url = "") {
  return String(url).match(/\/(?:explore|item|discovery\/item)\/([A-Za-z0-9]+)/)?.[1] || "";
}

function scoreNote(note, targetId) {
  const noteId = String(note.noteId || note.note_id || note.id || note._mapNoteId || "");
  return (targetId && noteId === targetId ? 1000 : 0)
    + (note.title || note.displayTitle ? 10 : 0)
    + (note.interactInfo || note.interact_info ? 8 : 0)
    + (note.video || note.videoInfo || note.video_info ? 6 : 0)
    + (note.imageList || note.image_list || note.images ? 4 : 0);
}

function imageRecords(note) {
  const list = note.imageList || note.image_list || note.images || [];
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const images = [];
  for (const image of list) {
    const url = firstUrl(image);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    images.push({
      sourceUrl: url,
      width: Number(image?.width) || null,
      height: Number(image?.height) || null,
    });
  }
  return images;
}

function findVideoUrl(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideoUrl(item, seen);
      if (found) return found;
    }
    return "";
  }
  for (const key of ["masterUrl", "playUrl", "play_url", "videoUrl", "video_url", "url"]) {
    const candidate = firstUrl(value[key]);
    if (candidate && /(?:\.mp4|\.m3u8)(?:\?|$)/i.test(candidate)) return candidate;
  }
  for (const child of Object.values(value)) {
    const found = findVideoUrl(child, seen);
    if (found) return found;
  }
  return "";
}

function numberValue(...values) {
  const value = values.find((item) => item !== undefined && item !== null && item !== "");
  return value === undefined ? "" : String(value);
}

function metaContent(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normal = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i");
  const reverse = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, "i");
  return decodeHtmlEntities((html.match(normal) || html.match(reverse))?.[1] || "").trim();
}

function extractXiaohongshuCandidates({ candidates = [], html = "", originalUrl = "", resolvedUrl = originalUrl } = {}) {
  const targetId = noteIdFromUrl(originalUrl) || noteIdFromUrl(resolvedUrl);
  const matchedCandidates = targetId
    ? candidates
        .filter((candidate) => String(candidate.noteId || candidate.note_id || candidate.id || candidate._mapNoteId || "") === targetId)
        .sort((left, right) => scoreNote(right, targetId) - scoreNote(left, targetId))
    : [];
  const note = matchedCandidates[0] || {};
  const selectedId = String(note.noteId || note.note_id || note.id || note._mapNoteId || "");
  const targetMatched = Boolean(targetId && selectedId === targetId);
  const interact = note.interactInfo || note.interact_info || {};
  const user = note.user || note.author || note.userInfo || {};
  const images = targetMatched ? imageRecords(note) : [];
  const videoUrl = targetMatched ? findVideoUrl(note.video || note.videoInfo || note.video_info || {}) : "";
  const metaCover = "";
  const body = targetMatched
    ? String(note.desc || note.description || "").trim()
    : "";
  const title = targetMatched
    ? String(note.title || note.displayTitle || body.slice(0, 80)).trim()
    : "";
  const publishedAt = targetMatched
    ? note.time || note.createTime || note.create_time || note.publishTime || note.publish_time || ""
    : "";

  return {
    platformItemId: targetMatched ? selectedId : targetId,
    contentType: targetMatched ? (videoUrl || String(note.type || "").toLowerCase() === "video" ? "video" : "image") : "",
    title,
    body,
    author: targetMatched ? String(user.nickname || user.nickName || user.name || user.userName || "") : "",
    images,
    imageProvenanceId: images.length && targetMatched ? selectedId : "",
    coverUrl: images[0]?.sourceUrl || metaCover,
    videoUrl,
    publishedAt,
    duration: targetMatched ? note.duration || note.videoDuration || note.video_duration || note.video?.duration || "" : "",
    stats: {
      likes: targetMatched ? numberValue(interact.likedCount, interact.likeCount, interact.liked_count, note.likedCount) : "",
      favorites: targetMatched ? numberValue(interact.collectedCount, interact.collectCount, interact.collect_count, note.collectedCount) : "",
      comments: targetMatched ? numberValue(interact.commentCount, interact.comment_count, note.commentCount) : "",
      shares: targetMatched ? numberValue(interact.shareCount, interact.share_count, note.shareCount) : "",
      views: targetMatched ? numberValue(interact.viewCount, interact.view_count, interact.playCount, note.viewCount) : "",
    },
    candidateCount: candidates.length,
    matchedCandidateCount: matchedCandidates.length,
    targetId,
    targetMatched,
  };
}

export function extractXiaohongshuFromObjects({ objects = [], originalUrl = "", resolvedUrl = originalUrl } = {}) {
  const candidates = (Array.isArray(objects) ? objects : [objects]).flatMap((object) => noteCandidates(object));
  return extractXiaohongshuCandidates({ candidates, originalUrl, resolvedUrl });
}

export function extractXiaohongshuFromHtml({ html = "", originalUrl = "", resolvedUrl = originalUrl } = {}) {
  const candidates = collectXiaohongshuJson(html).flatMap((object) => noteCandidates(object));
  return extractXiaohongshuCandidates({ candidates, html, originalUrl, resolvedUrl });
}
