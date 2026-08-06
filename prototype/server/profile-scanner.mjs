function absoluteUrl(href, baseUrl) {
  try {
    return baseUrl
      ? new URL(String(href || ""), baseUrl).toString()
      : new URL(String(href || "")).toString();
  } catch { return ""; }
}

export function canonicalProfileWorkUrl(platform, href, baseUrl = "") {
  const absolute = absoluteUrl(href, baseUrl);
  if (!absolute) return "";
  let parsed;
  try { parsed = new URL(absolute); } catch { return ""; }
  if (platform === "douyin") {
    const id = absolute.match(/\/(?:video|share\/video)\/(\d{8,})/)?.[1]
      || parsed.searchParams.get("modal_id")
      || parsed.searchParams.get("aweme_id");
    return id ? `https://www.douyin.com/video/${id}` : "";
  }
  if (platform === "xiaohongshu") {
    const id = parsed.pathname.match(/\/(?:explore|item|discovery\/item)\/([A-Za-z0-9]+)/)?.[1];
    return id ? `https://www.xiaohongshu.com/explore/${id}` : "";
  }
  if (platform === "bilibili") {
    const bvid = absolute.match(/\/(BV[0-9A-Za-z]+)/i)?.[1];
    const aid = absolute.match(/\/av(\d+)/i)?.[1];
    return bvid ? `https://www.bilibili.com/video/${bvid}` : aid ? `https://www.bilibili.com/video/av${aid}` : "";
  }
  if (platform === "youtube") {
    const id = parsed.hostname.endsWith("youtu.be")
      ? parsed.pathname.split("/").filter(Boolean)[0]
      : parsed.searchParams.get("v") || parsed.pathname.match(/\/(?:shorts|embed)\/([^/?#]+)/)?.[1];
    if (!id) return "";
    return parsed.pathname.startsWith("/shorts/")
      ? `https://www.youtube.com/shorts/${id}`
      : `https://www.youtube.com/watch?v=${id}`;
  }
  if (platform === "instagram") {
    const match = parsed.pathname.match(/^\/(p|reel|tv)\/([^/?#]+)/i);
    return match ? `https://www.instagram.com/${match[1].toLowerCase()}/${match[2]}/` : "";
  }
  if (platform === "wechat-channels") {
    if (!/(?:weixin\.qq\.com|channels\.weixin)/i.test(parsed.hostname)) return "";
    if (!/(?:\/post|\/feed|\/detail)|(?:feed_id|objectId|exportkey)=/i.test(`${parsed.pathname}?${parsed.searchParams}`)) return "";
    parsed.hash = "";
    return parsed.toString();
  }
  return "";
}

export function normalizeProfileEntries(platform, entries = [], baseUrl = "") {
  const byUrl = new Map();
  for (const entry of entries) {
    if (platform === "douyin" && entry.profileMatch === false) continue;
    if (platform === "xiaohongshu" && /页面不见了|页面不存在/.test(String(entry.text || ""))) continue;
    const url = canonicalProfileWorkUrl(platform, entry.href, baseUrl);
    if (!url || byUrl.has(url)) continue;
    byUrl.set(url, {
      url,
      title: String(entry.text || "").replace(/\s+/g, " ").trim().slice(0, 160),
      coverUrl: String(entry.coverUrl || ""),
    });
  }
  return [...byUrl.values()];
}

export function profileContainerSelector(platform) {
  if (platform === "douyin") return '[data-e2e="user-post-list"], [data-e2e="user-post-list-container"]';
  if (platform === "xiaohongshu") return '#userPostedFeeds, [id*="userPostedFeeds"], [class*="user-posted"]';
  return "body";
}
