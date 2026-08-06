const INSPIRATION_ID_PATTERN = /^I\d{6,}$/;

export const inspirationSortOptions = Object.freeze([
  { value: "collected_desc", label: "最近收集" },
  { value: "collected_asc", label: "最早收集" },
  { value: "published_desc", label: "最新发布" },
  { value: "likes_desc", label: "点赞最高" },
  { value: "favorites_desc", label: "收藏最高" },
  { value: "recently_referenced", label: "最近用于创作" },
]);

const ATTENTION_CAPTURE_STATES = new Set([
  "waiting_login",
  "waiting_verification",
  "retry_wait",
  "failed",
  "blocked",
  "unsupported",
  "content_unavailable",
]);

export const platformTone = {
  抖音: "black",
  小红书: "red",
  B站: "blue",
  视频号: "green",
  YouTube: "red",
  Instagram: "violet",
  未识别: "amber",
};

function formatNow() {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date()).replaceAll("/", ".");
}

function nextId(items, prefix) {
  const max = items.reduce((value, item) => {
    const numeric = Number(String(item.id || "").replace(/\D/g, ""));
    return Number.isFinite(numeric) ? Math.max(value, numeric) : value;
  }, 0);
  return `${prefix}${String(max + 1).padStart(6, "0")}`;
}

function normalizeComparableText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function timestamp(value) {
  if (!value) return 0;
  // Legacy cards use `YYYY.MM.DD HH:mm`; newly ingested cards use ISO-8601
  // timestamps whose milliseconds also contain a dot. Only normalize the date
  // separators, never the ISO milliseconds part (for example `.783Z`).
  const normalized = String(value).trim().replace(
    /^(\d{4})[./](\d{1,2})[./](\d{1,2})(?=$|[T\s])/,
    "$1-$2-$3",
  );
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function contentIdNumber(item = {}) {
  return Number(String(item.id || "").match(/^I(\d+)$/)?.[1]) || Number.MAX_SAFE_INTEGER;
}

function metricNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value ?? "").trim().replaceAll(",", "");
  if (!raw) return 0;
  const match = raw.match(/^([\d.]+)\s*([万亿kKmM])?$/);
  if (!match) return Number(raw) || 0;
  const base = Number(match[1]) || 0;
  const multiplier = ({ 万: 10_000, 亿: 100_000_000, k: 1_000, K: 1_000, m: 1_000_000, M: 1_000_000 })[match[2]] || 1;
  return base * multiplier;
}

function collectedTimestamp(item = {}) {
  return timestamp(item.capturedAt || item.createdAt || item.intake?.createdAt || item.updatedAt);
}

function publishedTimestamp(item = {}) {
  return timestamp(item.publishedAt || item.source?.publishedAt);
}

function compareNewest(left, right, getTimestamp) {
  const a = getTimestamp(left);
  const b = getTimestamp(right);
  if (a !== b) return b - a;
  return contentIdNumber(left) - contentIdNumber(right);
}

export function requiresInspirationAttention(item = {}) {
  const captureState = item.refreshState && item.refreshState !== "success"
    ? item.refreshState
    : item.parseState;
  if (ATTENTION_CAPTURE_STATES.has(captureState)) return true;
  if (item.mediaAvailability === "missing") return true;
  const hasLocalVideo = String(item.videoLocalPath || "").startsWith("/library-assets/");
  return hasLocalVideo && !String(item.transcript || "").trim() && Boolean(item.transcriptState || hasLocalVideo);
}

export function sortInspirationItems(items = [], {
  sort = "collected_desc",
  linkedInspirationIds = new Set(),
} = {}) {
  const linked = linkedInspirationIds instanceof Set ? linkedInspirationIds : new Set(linkedInspirationIds || []);
  return [...items].sort((left, right) => {
    if (sort === "collected_asc") {
      const a = collectedTimestamp(left);
      const b = collectedTimestamp(right);
      if (a !== b) return a - b;
      return contentIdNumber(left) - contentIdNumber(right);
    }
    if (sort === "published_desc") return compareNewest(left, right, publishedTimestamp);
    if (sort === "likes_desc" || sort === "favorites_desc") {
      const key = sort === "likes_desc" ? "likes" : "favorites";
      const difference = metricNumber(right.stats?.[key]) - metricNumber(left.stats?.[key]);
      return difference || compareNewest(left, right, collectedTimestamp);
    }
    if (sort === "recently_referenced") {
      const leftLinked = linked.has(left.id);
      const rightLinked = linked.has(right.id);
      if (leftLinked !== rightLinked) return leftLinked ? -1 : 1;
      return compareNewest(left, right, (item) => timestamp(item.referenceUpdatedAt || item.updatedAt || item.capturedAt));
    }
    return compareNewest(left, right, collectedTimestamp);
  });
}

function referenceContentId(reference) {
  const value = typeof reference === "string"
    ? reference
    : reference?.id || reference?.contentId || reference?.referenceContentId;
  const id = String(value || "").trim();
  return INSPIRATION_ID_PATTERN.test(id) ? id : "";
}

export function collectReferencedInspirationIds({
  activeProject = null,
  projects = [],
  archiveItems = [],
} = {}) {
  const ids = new Set();
  const records = [activeProject, ...projects, ...archiveItems].filter(Boolean);

  records.forEach((record) => {
    const references = [
      ...(Array.isArray(record.relationships?.referenceContentIds)
        ? record.relationships.referenceContentIds
        : []),
      ...(Array.isArray(record.references) ? record.references : []),
    ];
    references.forEach((reference) => {
      const id = referenceContentId(reference);
      if (id) ids.add(id);
    });
  });

  return ids;
}

export function detectPlatform(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("douyin.com") || text.includes("iesdouyin.com")) return "抖音";
  if (text.includes("xiaohongshu.com") || text.includes("xhslink.com") || text.includes("xhslink.cn")) return "小红书";
  if (text.includes("bilibili.com") || text.includes("b23.tv") || text.includes("bili2233.cn")) return "B站";
  if (text.includes("channels.weixin.qq.com") || text.includes("weixin.qq.com")) return "视频号";
  if (text.includes("youtube.com") || text.includes("youtu.be")) return "YouTube";
  if (text.includes("instagram.com")) return "Instagram";
  return "未识别";
}

export function platformAuthKey(value) {
  const label = String(value || "");
  return ({
    抖音: "douyin",
    小红书: "xiaohongshu",
    B站: "bilibili",
    视频号: "wechat-channels",
    YouTube: "youtube",
    Instagram: "instagram",
  })[label] || "";
}

export function formatMetric(value) {
  if (value === undefined || value === null || value === "") return "";
  const numeric = Number(String(value).replaceAll(",", ""));
  if (!Number.isFinite(numeric)) return String(value);
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(numeric);
}

export function formatDuration(value) {
  if (value === undefined || value === null || value === "") return "";
  if (String(value).includes(":")) return String(value);
  let seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return String(value);
  if (seconds > 10000) seconds /= 1000;
  seconds = Math.round(seconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function visibleBodyText(item = {}) {
  const body = String(item.body || "");
  if (!body.trim()) return "";
  return normalizeComparableText(body) === normalizeComparableText(item.title) ? "" : body;
}

export function makeInspiration(url, category, existing) {
  const platform = detectPlatform(url);
  return {
    id: nextId(existing, "I"),
    unitSchemaVersion: 1,
    origin: "captured",
    type: "inspiration",
    originalUrl: url.trim(),
    platform,
    author: "",
    authorId: "",
    authorUrl: "",
    title: `待整理：${platform} 链接`,
    body: "",
    transcript: "",
    transcriptSource: "",
    transcriptState: "",
    transcriptStatus: "",
    transcriptError: "",
    category: category || "",
    categoryAssignedByUser: Boolean(category),
    capturedAt: formatNow(),
    updatedAt: formatNow(),
    parseStatus: "",
    parseState: "idle",
    parseStage: "等待开始",
    parseProgress: 0,
    stats: {
      likes: "",
      favorites: "",
      comments: "",
      shares: "",
      views: "",
    },
    publishedAt: "",
    duration: "",
    resolvedUrl: "",
    platformItemId: "",
    coverUrl: "",
    coverLocalPath: "",
    contentType: "",
    images: [],
    videoUrl: "",
    videoPreviewUrl: "",
    videoLocalPath: "",
    parseEvidence: [],
    mediaAssets: [],
    metricsSnapshots: [],
    source: {
      platform,
      originalUrl: url.trim(),
      accountName: "",
      publishedAt: "",
    },
    workflow: {
      stage: "inspiration",
      creationStatus: null,
      completedAt: null,
    },
  };
}

export function applyExtraction(card, extraction) {
  const extractionBody = normalizeComparableText(extraction?.body) === normalizeComparableText(extraction?.title)
    ? ""
    : extraction?.body;
  if (!extraction || extraction.error) {
    return {
      ...card,
      parseState: extraction?.parseState || "failed",
      refreshState: extraction?.parseState || "failed",
      refreshStatus: extraction?.parseStatus || extraction?.error || "扒取失败",
      parseStatus: extraction?.error || "扒取失败",
      parseStage: "扒取失败",
      parseProgress: 0,
      errorCode: extraction?.errorCode || "",
      needsUserAction: Boolean(extraction?.needsUserAction),
      retryable: Boolean(extraction?.retryable),
      captureState: extraction?.captureState || extraction?.parseState || "failed",
      capturePhase: extraction?.capturePhase || "",
      attempt: Number(extraction?.attempt) || 0,
      retryAfterMs: Number(extraction?.retryAfterMs) || 0,
      nextRetryAt: extraction?.nextRetryAt || "",
      parseEvidence: extraction?.parseEvidence || card.parseEvidence || [],
      updatedAt: formatNow(),
    };
  }

  if (!["success", "partial"].includes(extraction.parseState)) {
    const stageByState = {
      waiting_login: "等待登录",
      waiting_verification: "等待验证",
      retry_wait: "等待自动重试",
      content_unavailable: "内容不可用",
    };
    return {
      ...card,
      parseState: extraction.parseState || "failed",
      refreshState: extraction.parseState || "failed",
      refreshStatus: extraction.parseStatus || "刷新未完成",
      parseStatus: extraction.parseStatus || "扒取失败",
      parseStage: stageByState[extraction.parseState] || "扒取失败",
      parseProgress: 0,
      errorCode: extraction.errorCode || "",
      needsUserAction: Boolean(extraction.needsUserAction),
      retryable: Boolean(extraction.retryable),
      captureState: extraction.captureState || extraction.parseState || "failed",
      capturePhase: extraction.capturePhase || "",
      attempt: Number(extraction.attempt) || 0,
      retryAfterMs: Number(extraction.retryAfterMs) || 0,
      nextRetryAt: extraction.nextRetryAt || "",
      parseEvidence: extraction.parseEvidence || card.parseEvidence || [],
      updatedAt: formatNow(),
    };
  }

  const isPlaceholderTitle = !card.title || card.title.startsWith("待整理：");
  return {
    ...card,
    unitSchemaVersion: 1,
    origin: "captured",
    platform: extraction.platform || card.platform,
    resolvedUrl: extraction.resolvedUrl || card.resolvedUrl,
    platformItemId: extraction.platformItemId || card.platformItemId,
    title: extraction.title && isPlaceholderTitle ? extraction.title : card.title,
    body: visibleBodyText(card) || extractionBody || "",
    transcript: extraction.transcript || card.transcript || "",
    transcriptSource: extraction.transcriptSource || card.transcriptSource || "",
    transcriptState: extraction.transcriptState || card.transcriptState || "",
    transcriptStatus: extraction.transcriptStatus || card.transcriptStatus || "",
    transcriptError: extraction.transcriptError || "",
    author: extraction.author && !card.author ? extraction.author : card.author,
    authorId: extraction.authorId || card.authorId || "",
    authorUrl: extraction.authorUrl || card.authorUrl || "",
    contentType: extraction.contentType || card.contentType || "",
    images: extraction.images?.length ? extraction.images : (card.images || []),
    coverUrl: extraction.coverUrl || card.coverUrl,
    coverLocalPath: extraction.coverLocalPath || card.coverLocalPath,
    videoUrl: extraction.videoUrl || card.videoUrl,
    videoPreviewUrl: extraction.videoLocalPath || extraction.videoPreviewUrl || card.videoLocalPath || card.videoPreviewUrl,
    videoLocalPath: extraction.videoLocalPath || card.videoLocalPath || "",
    publishedAt: extraction.publishedAt || card.publishedAt,
    duration: extraction.duration || card.duration || "",
    stats: {
      ...(card.stats || {}),
      ...(extraction.stats || {}),
      likes: extraction.stats?.likes || card.stats?.likes || "",
      favorites: extraction.stats?.favorites || card.stats?.favorites || "",
      comments: extraction.stats?.comments || card.stats?.comments || "",
      shares: extraction.stats?.shares || card.stats?.shares || "",
      views: extraction.stats?.views || card.stats?.views || "",
    },
    parseStatus: extraction.parseStatus || "已扒取公开信息",
    parseState: extraction.parseState || "success",
    refreshState: extraction.parseState || "success",
    refreshStatus: extraction.parseStatus || "已完成刷新",
    parseStage: extraction.parseState === "success"
      ? "扒取完成"
      : extraction.parseState === "partial"
        ? "部分完成"
        : extraction.parseState === "waiting_login"
          ? "等待登录"
          : extraction.parseState === "waiting_verification" ? "等待验证" : "扒取失败",
    parseProgress: extraction.parseState === "success" ? 100 : extraction.parseState === "partial" ? 72 : 0,
    errorCode: extraction.errorCode || "",
    needsUserAction: Boolean(extraction.needsUserAction),
    retryable: Boolean(extraction.retryable),
    captureState: extraction.captureState || extraction.parseState || "success",
    capturePhase: extraction.capturePhase || "",
    attempt: 0,
    retryAfterMs: 0,
    nextRetryAt: "",
    parseEvidence: extraction.parseEvidence || [],
    source: {
      platform: extraction.platform || card.platform || "",
      originalUrl: card.originalUrl || "",
      platformItemId: extraction.platformItemId || card.platformItemId || "",
      accountId: extraction.authorId || card.authorId || "",
      accountUrl: extraction.authorUrl || card.authorUrl || "",
      accountName: extraction.author || card.author || "",
      publishedAt: extraction.publishedAt || card.publishedAt || "",
    },
    metricsSnapshots: [
      ...(card.metricsSnapshots || []),
      {
        capturedAt: new Date().toISOString(),
        likes: extraction.stats?.likes || card.stats?.likes || "",
        favorites: extraction.stats?.favorites || card.stats?.favorites || "",
        comments: extraction.stats?.comments || card.stats?.comments || "",
        shares: extraction.stats?.shares || card.stats?.shares || "",
        views: extraction.stats?.views || card.stats?.views || "",
      },
    ],
    workflow: card.workflow || {
      stage: "inspiration",
      creationStatus: null,
      completedAt: null,
    },
    updatedAt: formatNow(),
  };
}
