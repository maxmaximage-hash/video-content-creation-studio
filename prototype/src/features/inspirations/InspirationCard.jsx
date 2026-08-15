import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  Heart,
  ImageOff,
  ImagePlus,
  MessageCircle,
  MoreHorizontal,
  Play,
  RefreshCw,
  Share2,
  Sparkles,
  Tags,
  Trash2,
} from "lucide-react";
import { coverSource } from "../../pages/creation/project-model.js";
import { eagleItemIdFrom, fetchEagleAnnotation, saveEagleAnnotation } from "../../services/eagle-media.js";
import {
  formatDuration,
  formatMetric,
  platformAuthKey,
  platformTone,
  visibleBodyText,
} from "./inspiration-model.js";

export function InspirationCard({
  item,
  onCreate,
  categories = [],
  onCategoryChange,
  onBodyChange,
  onRemove,
  onExtract,
  onRepairMissing,
  onTranscribe,
  showHistoricalTranscriptionAction = false,
  onOpenAuth,
  notify,
  sessionId = "",
  referenceMode = false,
  onDetach,
  isLinked = false,
  categoryValue,
  renderMediaPreview,
}) {
  const eagleItemId = eagleItemIdFrom(item);
  const images = useMemo(() => {
    const indexed = Array.isArray(item.images) ? item.images : [];
    const canonical = Array.isArray(item.mediaAssets)
      ? item.mediaAssets
        .filter((asset) => asset?.role === "content_image")
        .sort((left, right) => (Number(left.order) || 0) - (Number(right.order) || 0))
      : [];
    return (indexed.length ? indexed : canonical).filter((image) => coverSource(image));
  }, [item.images, item.mediaAssets]);
  const isVideoContent = item.contentType === "video" && Boolean(item.videoLocalPath || item.videoPreviewUrl || item.videoUrl || eagleItemId);
  const [activeImage, setActiveImage] = useState(0);
  const [annotationText, setAnnotationText] = useState("");
  const [annotationState, setAnnotationState] = useState(eagleItemId ? "loading" : "local");
  const annotationSaveTimerRef = useRef(null);
  const [missingImageIds, setMissingImageIds] = useState(() => new Set());
  const [retryClock, setRetryClock] = useState(() => Date.now());
  const decodedImageCacheRef = useRef(new Map());
  const bodyText = eagleItemId ? annotationText : visibleBodyText(item);
  const linkedInLibrary = isLinked && !referenceMode;
  const copyOriginalLink = () => {
    navigator.clipboard.writeText(item.originalUrl || "")
      .then(() => notify("已复制原链接"))
      .catch(() => notify("已模拟复制原链接"));
  };
  const copyFullBody = () => {
    navigator.clipboard.writeText(bodyText)
      .then(() => notify("已复制全文"))
      .catch(() => notify("已模拟复制全文"));
  };
  const transcriptText = String(item.transcript || "").trim();
  const transcriptIsBody = Boolean(transcriptText && bodyText.trim() === transcriptText);
  const transcriptCanRun = Boolean(
    onTranscribe
    && (String(item.videoLocalPath || "").startsWith("/library-assets/") || eagleItemId),
  );
  const isHistoricalTranscriptionCandidate = !item.transcriptState && transcriptCanRun;
  const showTranscriptPending = !transcriptText && (
    Boolean(item.transcriptState)
    || (showHistoricalTranscriptionAction && isHistoricalTranscriptionCandidate)
  );
  const transcriptSourceLabel = {
    platform_caption: "平台字幕",
    tencent_asr: "腾讯云免费额度",
    local_whisper: "本地转写",
  }[item.transcriptSource] || "逐字稿";
  const copyTranscript = () => {
    navigator.clipboard.writeText(transcriptText)
      .then(() => notify("已复制逐字稿"))
      .catch(() => notify("逐字稿复制失败"));
  };

  useEffect(() => {
    if (activeImage >= images.length) setActiveImage(0);
  }, [activeImage, images.length]);

  useEffect(() => {
    clearTimeout(annotationSaveTimerRef.current);
    if (!eagleItemId) {
      setAnnotationText(visibleBodyText(item));
      setAnnotationState("local");
      return undefined;
    }
    let cancelled = false;
    setAnnotationState("loading");
    fetchEagleAnnotation(eagleItemId)
      .then((text) => {
        if (cancelled) return;
        setAnnotationText(text);
        setAnnotationState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setAnnotationText("");
        setAnnotationState("unavailable");
      });
    return () => {
      cancelled = true;
      clearTimeout(annotationSaveTimerRef.current);
    };
  }, [eagleItemId, item.id, item.captionSha256, item.transcript]);

  const hashCaption = async (value) => {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };

  const updateBodyText = (value) => {
    if (!eagleItemId) {
      onBodyChange?.(item.id, value);
      return;
    }
    setAnnotationText(value);
    setAnnotationState("saving");
    clearTimeout(annotationSaveTimerRef.current);
    annotationSaveTimerRef.current = setTimeout(async () => {
      try {
        const annotation = await saveEagleAnnotation({ itemId: eagleItemId, annotation: value, sessionId });
        const sha256 = await hashCaption(annotation);
        setAnnotationText(annotation);
        setAnnotationState("ready");
        onBodyChange?.(item.id, {
          body: "",
          captionStorage: "eagle_annotation",
          captionEagleItemId: eagleItemId,
          captionLength: annotation.length,
          captionSha256: sha256,
        });
      } catch (error) {
        setAnnotationState("unavailable");
        notify?.(error.message || "文案暂不可保存");
      }
    }, 450);
  };

  const activeImageRecord = images[activeImage] || null;
  const activeImageId = activeImageRecord?.id || `${item.id}-image-${activeImage + 1}`;
  const activeLocalPath = activeImageRecord?.localPath
    || (String(activeImageRecord?.src || "").startsWith("/library-assets/") ? activeImageRecord.src : "");
  const versionedImagePaths = useMemo(() => images.map((image) => {
    const localPath = image?.localPath
      || (String(image?.src || "").startsWith("/library-assets/") ? image.src : "");
    if (!localPath) return "";
    if (!String(localPath).startsWith("/library-assets/")) return localPath;
    const assetVersion = image?.assetVersion
      || image?.version
      || item.mediaVersion
      || image?.relativePath
      || localPath
      || "1";
    return `${localPath}${localPath.includes("?") ? "&" : "?"}assetVersion=${encodeURIComponent(assetVersion)}`;
  }), [images, item.mediaVersion]);
  const versionedLocalPath = versionedImagePaths[activeImage] || "";

  useEffect(() => {
    if (versionedImagePaths.length < 2) return undefined;
    const retainedIndexes = new Set([
      activeImage,
      (activeImage - 1 + versionedImagePaths.length) % versionedImagePaths.length,
      (activeImage + 1) % versionedImagePaths.length,
    ]);
    const retainedSources = new Set([...retainedIndexes]
      .map((index) => versionedImagePaths[index])
      .filter(Boolean));
    retainedSources.forEach((src) => {
      if (!decodedImageCacheRef.current.has(src)) {
        const image = new Image();
        image.decoding = "async";
        image.src = src;
        image.decode?.().catch(() => {});
        decodedImageCacheRef.current.set(src, image);
      }
    });
    decodedImageCacheRef.current.forEach((image, src) => {
      if (retainedSources.has(src)) return;
      image.src = "";
      decodedImageCacheRef.current.delete(src);
    });
    return undefined;
  }, [activeImage, versionedImagePaths]);

  useEffect(() => () => {
    decodedImageCacheRef.current.forEach((image) => {
      image.src = "";
    });
    decodedImageCacheRef.current.clear();
  }, []);
  const activeImageMissing = Boolean(activeLocalPath && missingImageIds.has(activeImageId));
  const markActiveImageMissing = () => {
    if (!activeLocalPath) return;
    setMissingImageIds((current) => new Set(current).add(activeImageId));
  };
  const markActiveImageLoaded = () => {
    setMissingImageIds((current) => {
      if (!current.has(activeImageId)) return current;
      const next = new Set(current);
      next.delete(activeImageId);
      return next;
    });
  };
  const activeMedia = images.length
    ? {
      ...item,
      src: "",
      localPath: "",
      cover: "",
      coverLocalPath: versionedLocalPath,
      coverUrl: activeImageRecord?.sourceUrl || "",
      videoUrl: activeImage === 0 ? item.videoUrl : "",
      videoPreviewUrl: activeImage === 0 ? item.videoPreviewUrl : "",
      videoLocalPath: activeImage === 0 ? item.videoLocalPath : "",
      eagleItemId: activeImage === 0 ? item.eagleItemId : "",
      eagleFolderId: activeImage === 0 ? item.eagleFolderId : "",
      onMediaMissing: markActiveImageMissing,
      onMediaLoaded: markActiveImageLoaded,
    }
    : item;
  const metrics = [
    { key: "likes", label: "点赞", Icon: Heart },
    { key: "comments", label: "评论", Icon: MessageCircle },
    { key: "favorites", label: "收藏", Icon: Bookmark },
    { key: "shares", label: "转发", Icon: Share2 },
  ].map((metric) => ({ ...metric, value: formatMetric(item.stats?.[metric.key]) })).filter((metric) => metric.value);
  const extendedMetrics = [
    ["弹幕", item.stats?.danmaku],
    ["投币", item.stats?.coins],
  ].map(([label, value]) => [label, formatMetric(value)]).filter(([, value]) => value);
  const meta = [item.author ? `@${item.author.replace(/^@/, "")}` : "", item.publishedAt || ""].filter(Boolean);
  const duration = formatDuration(item.duration);
  const parseState = item.refreshState && item.refreshState !== "success"
    ? item.refreshState
    : item.parseState || (item.parseStatus?.includes("阻断") ? "blocked" : item.parseStatus?.includes("失败") ? "failed" : item.parseStatus?.includes("成功") ? "success" : "idle");
  const isExtracting = parseState === "extracting";
  useEffect(() => {
    if (parseState !== "retry_wait") return undefined;
    setRetryClock(Date.now());
    const timer = window.setInterval(() => setRetryClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [parseState, item.nextRetryAt]);
  const retrySeconds = Number.isFinite(Date.parse(item.nextRetryAt || ""))
    ? Math.max(0, Math.ceil((Date.parse(item.nextRetryAt) - retryClock) / 1000))
    : Math.max(1, Math.ceil((Number(item.retryAfterMs) || 1000) / 1000));
  const localMediaAvailable = images.some((image) => (
    image?.localPath
    || image?.relativePath
    || String(image?.src || "").startsWith("/library-assets/")
  )) || String(item.videoLocalPath || "").startsWith("/library-assets/");
  const showParseStatus = isExtracting || ["partial", "blocked", "failed", "unsupported", "waiting_login", "waiting_verification", "retry_wait", "content_unavailable"].includes(parseState);
  const canRetry = Boolean(onExtract) && ["partial", "blocked", "failed", "unsupported", "retry_wait"].includes(parseState);
  const canOpenLogin = Boolean(onOpenAuth) && parseState === "waiting_login";
  const progress = Number.isFinite(Number(item.parseProgress)) ? Math.min(100, Math.max(0, Number(item.parseProgress))) : 0;
  const cardStyle = referenceMode ? { "--card-width": "228px" } : undefined;

  return (
    <article
      className={`inspiration-card real-card ${referenceMode ? "reference-inspiration-card" : ""} ${linkedInLibrary ? "is-linked" : ""}`}
      style={cardStyle}
      data-inspiration-id={item.id}
      data-linked={linkedInLibrary ? "true" : "false"}
      aria-label={`${item.title || "未命名灵感"}${linkedInLibrary ? "，已关联创作" : ""}`}
    >
      <div className="inspiration-media">
        {renderMediaPreview(activeMedia)}
        {activeImageMissing && (
          <div className="inspiration-media-missing" role="status">
            <ImageOff size={24} />
            <strong>本地图片缺失</strong>
            <small>原卡片仍保留，修复后继续使用同一内容 ID</small>
            {!referenceMode && onRepairMissing && (
              <button type="button" onClick={() => onRepairMissing(item)}>
                <RefreshCw size={14} />修复素材
              </button>
            )}
          </div>
        )}
        <div className="media-topline">
          <div className="media-badges">
            <span className={`status-pill ${platformTone[item.platform] || "neutral"}`}>{item.platform}</span>
            {images.length > 1 && <span className="image-count-badge"><ImagePlus size={12} />{activeImage + 1}/{images.length}</span>}
          </div>
          <details className="card-overflow">
            <summary className="glass-button" aria-label="更多操作"><MoreHorizontal size={17} /></summary>
            <div className="card-overflow-menu">
              <a href={item.resolvedUrl || item.originalUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />原视频</a>
              {onExtract && <button type="button" onClick={() => onExtract(item)}><RefreshCw size={15} />重新扒取</button>}
              {referenceMode
                ? <button type="button" className="danger" onClick={() => onDetach(item.id)}><Trash2 size={15} />移除灵感参考</button>
                : <button type="button" className="danger" onClick={() => onRemove(item.id)}><Trash2 size={15} />删除灵感</button>}
              <small>{item.id}</small>
            </div>
          </details>
        </div>
        {images.length > 1 && (
          <div className="image-carousel-controls" aria-label={`${images.length} 张图片`}>
            <button type="button" className="icon-button" aria-label="上一张图片" title="上一张图片" onClick={() => setActiveImage((current) => (current - 1 + images.length) % images.length)}><ChevronLeft size={17} /></button>
            <button type="button" className="icon-button" aria-label="下一张图片" title="下一张图片" onClick={() => setActiveImage((current) => (current + 1) % images.length)}><ChevronRight size={17} /></button>
          </div>
        )}
        {isVideoContent && <div className="media-play preview-ready"><Play size={18} fill="currentColor" /></div>}
        <div className="media-bottomline">
          <div className="media-stats" aria-label="互动数据快照">
            {metrics.map(({ key, label, Icon, value }) => (
              <span key={key} title={label}><Icon size={15} strokeWidth={2.2} />{value}</span>
            ))}
          </div>
          {duration && <span className="media-duration">{duration}</span>}
        </div>
      </div>
      <div className="inspiration-content compact-content">
        <h3 title={item.title}>{item.title || "未命名灵感"}</h3>
        <p className="card-byline">{meta.length ? meta.join(" · ") : item.platform}</p>
        {extendedMetrics.length ? (
          <p className="card-extended-metrics"><Eye size={11} />{extendedMetrics.map(([label, value]) => `${label} ${value}`).join(" · ")}</p>
        ) : null}
        {showParseStatus && (
          <div className={`parse-status-line ${parseState}`} aria-live="polite">
            <div className="parse-status-heading">
              <span>
                {isExtracting && <RefreshCw size={12} className="spin" />}
                {item.parseStage || item.parseStatus || "正在扒取"}
              </span>
              {canRetry && (
                <button type="button" className="parse-retry-button" onClick={() => onExtract(item)}>
                  <RefreshCw size={12} />重试
                </button>
              )}
              {canOpenLogin && (
                <button
                  type="button"
                  className="parse-login-button"
                  onClick={() => onOpenAuth(platformAuthKey(item.platform))}
                >
                  <ExternalLink size={12} />打开登录
                </button>
              )}
            </div>
            <small>
              {parseState === "retry_wait"
                ? `${item.platform}采集通道正在冷却，${retrySeconds} 秒后自动继续`
                : localMediaAvailable && ["blocked", "failed", "unsupported"].includes(parseState)
                ? "上次刷新失败，本地素材可用"
                : item.refreshStatus || item.parseStatus || "正在扒取公开信息"}
            </small>
            {isExtracting && (
              <div className="parse-progress" role="progressbar" aria-label="扒取进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress}>
                <i style={{ width: `${progress}%` }} />
              </div>
            )}
          </div>
        )}
        {transcriptText && !transcriptIsBody && (
          <details className="card-transcript">
            <summary>
              <span><FileText size={13} />逐字稿</span>
              <small>{transcriptSourceLabel}</small>
            </summary>
            <div className="card-transcript-content">
              <p>{transcriptText}</p>
              <button type="button" onClick={copyTranscript}><Copy size={13} />复制逐字稿</button>
            </div>
          </details>
        )}
        {showTranscriptPending && (
          <div className={`card-transcript-pending is-${item.transcriptState || "waiting_media"}`}>
            <span><FileText size={13} />{item.transcriptStatus || "本地视频已保存，可生成逐字稿"}</span>
            {transcriptCanRun ? (
              <button type="button" onClick={() => onTranscribe(item)}><RefreshCw size={12} />{isHistoricalTranscriptionCandidate ? "生成逐字稿" : "重试转写"}</button>
            ) : null}
          </div>
        )}
        <div className="card-body-editor">
          {annotationState === "unavailable" && <div className="card-body-state">文案暂不可读取</div>}
          <textarea
            aria-label="灵感正文"
            value={bodyText}
            placeholder={annotationState === "loading" ? "正在读取 Eagle 注释" : ""}
            disabled={annotationState === "loading" || annotationState === "unavailable"}
            onChange={(event) => updateBodyText(event.target.value)}
          />
          {annotationState === "saving" && <span className="card-body-saving">保存到 Eagle</span>}
          <button type="button" className="card-copy-body-button" disabled={!bodyText} onClick={copyFullBody}>
            <Copy size={13} />复制全文
          </button>
        </div>
        <div className={`card-quick-actions ${referenceMode ? "reference-card-actions" : ""}`}>
          <label className="card-category-control">
            <Tags size={14} />
            <span className="sr-only">分类</span>
            <select value={categoryValue(item)} onChange={(event) => onCategoryChange?.(item.id, event.target.value)}>
              <option value="">未分类</option>
              {categories.map((category) => <option value={category} key={category}>{category}</option>)}
            </select>
          </label>
          <button type="button" className="card-source-button" onClick={copyOriginalLink}><Copy size={15} />复制原链接</button>
          {!referenceMode && (
            <button type="button" className="card-create-button" onClick={() => onCreate(item)}><Sparkles size={15} />创作</button>
          )}
        </div>
      </div>
    </article>
  );
}
