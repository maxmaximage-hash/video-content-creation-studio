const PLATFORM_LABELS = Object.freeze({
  bilibili: "B站",
  "wechat-channels": "视频号",
  youtube: "YouTube",
  instagram: "Instagram",
});

function clean(value) {
  return String(value ?? "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

function firstUrl(value) {
  if (typeof value === "string") return value.match(/https?:\/\/[^\s"'<>]+/)?.[0] || "";
  if (Array.isArray(value)) return value.map(firstUrl).find(Boolean) || "";
  if (value && typeof value === "object") return firstUrl(value.url || value.src || value.baseUrl || value.base_url || value[0]);
  return "";
}

function meta(html, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const forward = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i");
    const reverse = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name|itemprop)=["']${escaped}["'][^>]*>`, "i");
    const found = html.match(forward) || html.match(reverse);
    if (found?.[1]) return clean(found[1]);
  }
  return "";
}

function walk(value, visit, depth = 0) {
  if (depth > 9 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.slice(0, 500).forEach((item) => walk(item, visit, depth + 1));
    return;
  }
  if (typeof value !== "object") return;
  visit(value);
  Object.values(value).slice(0, 500).forEach((item) => walk(item, visit, depth + 1));
}

function assignCandidate(target, source = {}) {
  const take = (keys) => keys.map((key) => source[key]).find((value) => value !== undefined && value !== null && value !== "");
  target.title ||= clean(take(["title", "name", "headline", "displayTitle"]));
  target.body ||= clean(take(["description", "desc", "caption", "text"]));
  target.author ||= clean(take(["author", "authorName", "nickname", "name"]));
  target.authorId ||= clean(take(["authorId", "mid", "ownerId", "user_id", "username"]));
  target.authorUrl ||= firstUrl(take(["authorUrl", "channel_url", "profile_url"]));
  target.coverUrl ||= firstUrl(take(["thumbnailUrl", "thumbnail_url", "cover", "coverUrl", "pic", "display_url"]));
  target.videoUrl ||= firstUrl(take(["contentUrl", "videoUrl", "video_url", "playUrl", "play_url", "src"]));
  target.duration ||= take(["duration", "durationSeconds", "videoDuration"]);
  target.publishedAt ||= clean(take(["datePublished", "published_at", "publishTime", "pubdate", "timestamp"]));
  const transcript = take(["transcript", "subtitle", "captionText", "caption_text", "FinalSentence"]);
  if (!target.transcript && typeof transcript === "string" && transcript.trim().length > 8) target.transcript = clean(transcript);
  const stats = source.stat || source.stats || source.statistics || source.edge_media_preview_like || {};
  target.stats.likes ||= clean(stats.like || stats.likes || stats.like_count || stats.count || source.like_count || source.digg_count);
  target.stats.favorites ||= clean(stats.favorite || stats.favorites || stats.favorite_count || source.favorite_count || source.collect_count);
  target.stats.comments ||= clean(stats.reply || stats.comments || stats.comment_count || source.comment_count);
  target.stats.shares ||= clean(stats.share || stats.shares || stats.share_count || source.share_count || source.repost_count);
  target.stats.views ||= clean(stats.view || stats.views || stats.view_count || source.view_count || source.play_count);
}

export function youtubeCaptionTrackUrl(values = []) {
  const tracks = [];
  for (const candidate of values) {
    walk(candidate, (value) => {
      if (!Array.isArray(value.captionTracks)) return;
      for (const track of value.captionTracks) {
        const baseUrl = firstUrl(track?.baseUrl);
        if (baseUrl) tracks.push({ url: baseUrl, languageCode: String(track.languageCode || "") });
      }
    });
  }
  const preferred = tracks.find((track) => /^zh(?:-|$)/i.test(track.languageCode))
    || tracks.find((track) => /^en(?:-|$)/i.test(track.languageCode))
    || tracks[0];
  return preferred?.url || "";
}

function cleanCaptionLines(lines = []) {
  const output = [];
  for (const line of lines.map(clean).filter(Boolean)) {
    const previous = output[output.length - 1] || "";
    if (previous !== line && !previous.endsWith(line)) output.push(line);
  }
  return output.join(" ").replace(/\s+([,.!?。，！？])/g, "$1").trim();
}

export async function fetchYoutubeCaption(url, headers = {}, fetchImpl = fetch) {
  if (!url) return "";
  const target = new URL(url);
  target.searchParams.set("fmt", "json3");
  const response = await fetchImpl(target, {
    headers: {
      accept: "application/json,text/vtt,text/plain,*/*",
      ...(headers["user-agent"] ? { "user-agent": headers["user-agent"] } : {}),
      ...(headers.cookie ? { cookie: headers.cookie } : {}),
      referer: headers.referer || "https://www.youtube.com/",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return "";
  const raw = await response.text();
  try {
    const payload = JSON.parse(raw);
    return cleanCaptionLines((payload.events || []).flatMap((event) => (
      (event.segs || []).map((segment) => segment.utf8)
    )));
  } catch {
    return cleanCaptionLines(raw.split(/\r?\n/).filter((line) => (
      line && !/^WEBVTT|^\d+$|-->/.test(line.trim())
    )).map((line) => line.replace(/<[^>]+>/g, "")));
  }
}

function jsonCandidates(html = "") {
  const values = [];
  const scripts = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    const text = match[1].trim();
    if (!text || text.length > 8_000_000) continue;
    const candidates = [text];
    const assignment = text.match(/^[\s\S]*?=\s*({[\s\S]*}|\[[\s\S]*\])\s*;?$/);
    if (assignment?.[1]) candidates.push(assignment[1]);
    for (const candidate of candidates) {
      try {
        values.push(JSON.parse(candidate));
        break;
      } catch {}
    }
  }
  return values;
}

export function platformItemId(platform, url = "") {
  const text = String(url);
  if (platform === "bilibili") return text.match(/\/(BV[0-9A-Za-z]+)/i)?.[1] || text.match(/\/av(\d+)/i)?.[1] || "";
  if (platform === "youtube") {
    try {
      const parsed = new URL(text);
      return parsed.hostname.endsWith("youtu.be")
        ? parsed.pathname.split("/").filter(Boolean)[0] || ""
        : parsed.searchParams.get("v") || parsed.pathname.match(/\/(?:shorts|embed)\/([^/?#]+)/)?.[1] || "";
    } catch { return ""; }
  }
  if (platform === "instagram") return text.match(/\/(?:p|reel|tv)\/([^/?#]+)/i)?.[1] || "";
  if (platform === "wechat-channels") {
    try {
      const parsed = new URL(text);
      return parsed.searchParams.get("feed_id") || parsed.searchParams.get("objectId") || parsed.searchParams.get("id") || "";
    } catch { return ""; }
  }
  return "";
}

export function parseGenericPlatformCapture({ platform, originalUrl, finalUrl, html = "", bodyText = "", resources = [], responseJsonCandidates = [], videoDuration = "", mediaSnapshot = {} } = {}) {
  const result = {
    platform: PLATFORM_LABELS[platform] || platform,
    originalUrl,
    resolvedUrl: finalUrl || originalUrl,
    platformItemId: platformItemId(platform, finalUrl || originalUrl),
    title: meta(html, ["og:title", "twitter:title", "title"]),
    body: meta(html, ["og:description", "description", "twitter:description"]),
    author: meta(html, ["author", "og:site_name"]),
    authorId: "",
    authorUrl: "",
    coverUrl: meta(html, ["og:image", "twitter:image"]),
    videoUrl: meta(html, ["og:video", "og:video:url", "twitter:player:stream"]),
    duration: videoDuration || meta(html, ["video:duration", "og:video:duration"]),
    publishedAt: meta(html, ["article:published_time", "datePublished", "uploadDate"]),
    stats: { likes: "", favorites: "", comments: "", shares: "", views: "" },
    transcript: "",
    contentType: "video",
    parseEvidence: [],
  };
  for (const candidate of [...jsonCandidates(html), ...responseJsonCandidates]) walk(candidate, (value) => assignCandidate(result, value));
  result.videoUrl ||= mediaSnapshot?.videos?.find((item) => /^https?:\/\//i.test(item?.src || ""))?.src || "";
  result.coverUrl ||= mediaSnapshot?.videos?.find((item) => /^https?:\/\//i.test(item?.poster || ""))?.poster || "";
  if (!result.videoUrl) {
    result.videoUrl = resources.find((url) => /(?:\.(?:mp4|m3u8|m4s)(?:[?#]|$)|\/videoplayback[?])/i.test(String(url))) || "";
  }
  if (!result.title && bodyText) {
    result.title = clean(String(bodyText).split(/\n+/).find((line) => line.trim().length > 5) || "").slice(0, 160);
  }
  result.parseEvidence.push(`平台适配器: ${platform}`);
  result.parseEvidence.push(`页面 JSON: ${jsonCandidates(html).length + responseJsonCandidates.length}`);
  result.parseEvidence.push(`媒体候选: ${resources.length}`);
  return result;
}

export function captureJsonCandidates(html = "", responseJsonCandidates = []) {
  return [...jsonCandidates(html), ...responseJsonCandidates];
}

export async function bilibiliPublicMetadata(url, fetchImpl = fetch) {
  const id = platformItemId("bilibili", url);
  if (!id) return null;
  const query = /^BV/i.test(id) ? `bvid=${encodeURIComponent(id)}` : `aid=${encodeURIComponent(id)}`;
  const response = await fetchImpl(`https://api.bilibili.com/x/web-interface/view?${query}`, {
    headers: { accept: "application/json", referer: "https://www.bilibili.com/" },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) return null;
  const payload = await response.json();
  const data = payload?.data;
  if (!data?.bvid && !data?.aid) return null;
  return {
    platform: "B站",
    originalUrl: url,
    resolvedUrl: `https://www.bilibili.com/video/${data.bvid || `av${data.aid}`}`,
    platformItemId: data.bvid || String(data.aid),
    title: clean(data.title),
    body: clean(data.desc),
    author: clean(data.owner?.name),
    authorId: String(data.owner?.mid || ""),
    authorUrl: data.owner?.mid ? `https://space.bilibili.com/${data.owner.mid}` : "",
    coverUrl: data.pic || "",
    duration: data.duration || "",
    publishedAt: data.pubdate ? new Date(Number(data.pubdate) * 1000).toISOString() : "",
    stats: {
      likes: String(data.stat?.like ?? ""),
      favorites: String(data.stat?.favorite ?? ""),
      comments: String(data.stat?.reply ?? ""),
      shares: String(data.stat?.share ?? ""),
      views: String(data.stat?.view ?? ""),
      danmaku: String(data.stat?.danmaku ?? ""),
      coins: String(data.stat?.coin ?? ""),
    },
    contentType: "video",
    parseEvidence: ["B站公开详情接口"],
  };
}

export async function youtubePublicMetadata(url, fetchImpl = fetch) {
  const id = platformItemId("youtube", url);
  if (!id) return null;
  const response = await fetchImpl(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`, {
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) return null;
  const data = await response.json();
  return {
    platform: "YouTube",
    originalUrl: url,
    resolvedUrl: `https://www.youtube.com/watch?v=${id}`,
    platformItemId: id,
    title: clean(data.title),
    author: clean(data.author_name),
    authorUrl: data.author_url || "",
    coverUrl: data.thumbnail_url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    stats: { likes: "", favorites: "", comments: "", shares: "", views: "" },
    contentType: "video",
    parseEvidence: ["YouTube oEmbed"],
  };
}
