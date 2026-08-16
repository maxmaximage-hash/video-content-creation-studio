import { useEffect, useMemo, useRef, useState } from "react";
import { InspirationCard } from "./features/inspirations/InspirationCard.jsx";
import {
  collectReferencedInspirationIds,
  formatDuration,
  platformTone,
} from "./features/inspirations/inspiration-model.js";
import { CreationPage } from "./pages/creation/CreationPage.jsx";
import { InspirationsPage } from "./pages/inspirations/InspirationsPage.jsx";
import { QueuePage } from "./pages/queue/QueuePage.jsx";
import { ArchivePage } from "./pages/archive/ArchivePage.jsx";
import { MobileInboxPage } from "./pages/mobile-inbox/MobileInboxPage.jsx";
import { projectPrimaryCopy } from "./pages/queue/content-variants.js";
import {
  clearProjectContent,
  coverSource,
  makeOriginalProject,
  mergeUploadedMedia,
  primaryProjectCover,
  projectCoverCandidates,
  projectMediaAssets,
  projectMediaSlotKey,
  projectMediaSlotLabel,
  projectMediaSlotProjection,
  queueProject,
} from "./pages/creation/project-model.js";
import {
  deleteProjectMediaFile,
  libraryRelativePath,
  revealProjectTarget,
  uploadProjectCoverFile,
  uploadProjectMediaFile,
} from "./services/project-media.js";
import { eagleMediaSource } from "./services/eagle-media.js";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FolderOpen,
  Inbox,
  Lightbulb,
  Menu,
  Pause,
  PencilLine,
  Play,
  Plus,
  Tags,
  Smartphone,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

const defaultCategories = [];
const legacyPresetCategories = new Set(["情感", "展示面", "认知", "教程"]);
const appVersionLabel = `V${String(__APP_VERSION__).split(".").slice(0, 2).join(".")}`;
const appBuildLabel = `${appVersionLabel} · ${__APP_COMMIT__}${__APP_DIRTY__ ? " · 未提交" : ""}`;

const navItems = [
  { id: "inspirations", label: "灵感库", icon: Lightbulb },
  { id: "mobile-inbox", label: "手机收集", icon: Smartphone },
  { id: "creation", label: "编辑", icon: PencilLine },
  { id: "queue", label: "创作台", icon: Inbox },
  { id: "archive", label: "归档库", icon: FolderOpen },
];

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

function optimisticContentId() {
  const seconds = Math.floor(Date.now() / 1000);
  const random = globalThis.crypto?.getRandomValues
    ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000
    : Math.floor(Math.random() * 1_000_000);
  return `C${seconds}${String(random).padStart(6, "0")}`;
}

function categoryValue(item) {
  const value = item?.category || "";
  if (legacyPresetCategories.has(value) && !item?.categoryAssignedByUser) return "";
  return value;
}

function categoryLabel(item) {
  return categoryValue(item) || "未分类";
}

function ResilientImage({ src, alt = "", onLoad, onMissing, ...props }) {
  const [retryCount, setRetryCount] = useState(0);
  const retryTimerRef = useRef(null);
  const isLocalLibraryAsset = String(src || "").startsWith("/library-assets/");
  const retrySrc = retryCount && isLocalLibraryAsset
    ? `${src}${src.includes("?") ? "&" : "?"}assetRetry=${retryCount}`
    : src;

  useEffect(() => {
    setRetryCount(0);
    return () => clearTimeout(retryTimerRef.current);
  }, [src]);

  const retryOnError = () => {
    if (!isLocalLibraryAsset || retryCount >= 2) {
      onMissing?.();
      return;
    }
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = setTimeout(
      () => setRetryCount((current) => current + 1),
      Math.min(600 * (2 ** retryCount), 4000),
    );
  };

  return <img {...props} src={retrySrc} alt={alt} data-asset-retry={retryCount} onError={retryOnError} onLoad={onLoad} />;
}

function formatFileSize(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function normalizeProject(project) {
  if (!project || typeof project !== "object") return project;
  return {
    ...project,
    unitSchemaVersion: Number(project.unitSchemaVersion || project.contentUnitVersion) || 0,
    origin: project.origin || "original",
    creationStatus: project.creationStatus || "in_progress",
    completedAt: project.completedAt || null,
    workflow: {
      stage: project.workflow?.stage || "creating",
      creationStatus: project.workflow?.creationStatus || project.creationStatus || "in_progress",
      completedAt: project.workflow?.completedAt || project.completedAt || null,
    },
    mediaAssets: projectMediaAssets(project),
  };
}

function normalizeLibrary(data = {}) {
  const storedCategories = Array.isArray(data.categories) ? data.categories : [];
  const hasUserDefinedCategories = Array.isArray(data.userDefinedCategories);
  const v2RelationsByContentId = new Map();
  for (const relation of (Array.isArray(data.contentRelations) ? data.contentRelations : [])) {
    if (!relation?.fromContentId || !relation?.toContentId) continue;
    const relations = v2RelationsByContentId.get(relation.fromContentId) || [];
    relations.push(relation.toContentId);
    v2RelationsByContentId.set(relation.fromContentId, relations);
  }
  const v2MetricsByContentId = new Map();
  for (const snapshot of (Array.isArray(data.metricsSnapshots) ? data.metricsSnapshots : [])) {
    if (!snapshot?.contentId) continue;
    const snapshots = v2MetricsByContentId.get(snapshot.contentId) || [];
    snapshots.push(snapshot);
    v2MetricsByContentId.set(snapshot.contentId, snapshots);
  }
  const normalizeItem = (item) => {
    if (!item || typeof item !== "object") return item;
    const contentId = String(item.id || "");
    const v2References = Array.from(new Set(v2RelationsByContentId.get(contentId) || []));
    const v2Metrics = v2MetricsByContentId.get(contentId) || [];
    const enrichedItem = {
      ...item,
      ...(v2Metrics.length && !(Array.isArray(item.metricsSnapshots) && item.metricsSnapshots.length) ? { metricsSnapshots: v2Metrics } : {}),
      ...(v2References.length
        ? {
            relationships: {
              ...(item.relationships || {}),
              referenceContentIds: v2References,
            },
          }
        : {}),
    };
    if (enrichedItem.parseState === "extracting" || enrichedItem.parseStatus === "正在扒取公开信息") {
      const hasLocalMedia = [
        ...(Array.isArray(enrichedItem.images) ? enrichedItem.images : []),
        ...(Array.isArray(enrichedItem.mediaAssets) ? enrichedItem.mediaAssets : []),
      ].some((asset) => (
        asset?.localPath
        || asset?.relativePath
        || asset?.eagleItemId
        || String(asset?.src || "").startsWith("/library-assets/")
      )) || String(enrichedItem.videoLocalPath || "").startsWith("/library-assets/")
        || Boolean(enrichedItem.eagleItemId);
      return {
        ...enrichedItem,
        acquisitionState: hasLocalMedia ? "acquired" : (enrichedItem.acquisitionState || "pending"),
        parseState: hasLocalMedia ? "success" : "failed",
        parseStatus: hasLocalMedia ? (enrichedItem.parseStatusBeforeRefresh || "已获得本地素材") : "上次扒取中断，请点重扒",
        parseStage: hasLocalMedia ? "本地素材可用" : "上次扒取已中断",
        parseProgress: hasLocalMedia ? 100 : 0,
        refreshState: "failed",
        refreshStatus: hasLocalMedia ? "上次刷新失败，本地素材可用" : "上次扒取中断，请点重扒",
        parseEvidence: enrichedItem.parseEvidence?.length ? enrichedItem.parseEvidence : ["页面或服务重载导致扒取中断"],
      };
    }
    return enrichedItem;
  };
  return {
    categories: hasUserDefinedCategories
      ? data.userDefinedCategories
      : storedCategories.filter((category) => !legacyPresetCategories.has(category)),
    legacyCategories: storedCategories.filter((category) => legacyPresetCategories.has(category)),
    hasUserDefinedCategories,
    inspirations: Array.isArray(data.inspirations) ? data.inspirations.map(normalizeItem) : [],
    projects: Array.isArray(data.projects) ? data.projects.map(normalizeProject) : [],
    archive: Array.isArray(data.archive) ? data.archive.map(normalizeProject) : [],
    activeProject: data.activeProject ? normalizeProject(data.activeProject) : null,
    storage: data.storage || null,
    revision: Number(data.revision) || 1,
  };
}

function librarySavePayload({ legacyCategories = [], categories = [], hasUserDefinedCategories = false, inspirationItems = [], projects = [], archiveItems = [], activeProject = null }) {
  const storedCategories = Array.from(new Set([...legacyCategories, ...categories]));
  return {
    categories: storedCategories,
    ...(hasUserDefinedCategories ? { userDefinedCategories: categories } : {}),
    projects,
    archive: archiveItems,
    activeProject,
  };
}

function stableLibrarySnapshot(payload) {
  return JSON.stringify(payload);
}

function sameStructuredValue(previous, next) {
  if (Object.is(previous, next)) return true;
  try {
    return JSON.stringify(previous) === JSON.stringify(next);
  } catch {
    return false;
  }
}

function savedLibraryPayload(snapshot) {
  try {
    const value = JSON.parse(snapshot || "");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function collectProjectPatchOperations(previous, next, path = [], operations = []) {
  if (sameStructuredValue(previous, next)) return operations;
  const previousObject = previous && typeof previous === "object";
  const nextObject = next && typeof next === "object";
  if (!previousObject || !nextObject || Array.isArray(previous) || Array.isArray(next)) {
    operations.push({ path, value: next });
    return operations;
  }
  const fields = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const field of fields) {
    if (field === "id") continue;
    const nextPath = [...path, field];
    if (!Object.hasOwn(next, field)) {
      operations.push({ path: nextPath, remove: true });
    } else if (!Object.hasOwn(previous, field)) {
      operations.push({ path: nextPath, value: next[field] });
    } else {
      collectProjectPatchOperations(previous[field], next[field], nextPath, operations);
    }
  }
  return operations;
}

function dirtyProjectPatches(snapshot, projects, activeProject, removedProjectId) {
  const saved = savedLibraryPayload(snapshot);
  if (!saved) return [];
  const baseline = new Map([
    ...(saved.projects || []),
    ...(saved.activeProject ? [saved.activeProject] : []),
  ].filter((project) => project?.id).map((project) => [project.id, project]));
  const current = new Map([
    ...projects,
    ...(activeProject ? [activeProject] : []),
  ].filter((project) => project?.id).map((project) => [project.id, project]));
  return [...current.entries()]
    .filter(([projectId]) => projectId !== removedProjectId && baseline.has(projectId))
    .map(([projectId, project]) => ({
      projectId,
      operations: collectProjectPatchOperations(baseline.get(projectId), project),
    }))
    .filter((patch) => patch.operations.length);
}

function IconButton({ label, children, className = "", onClick, disabled = false }) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function StatusPill({ tone = "neutral", children }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

function Modal({ title, description, children, onClose, wide = false }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton label="关闭" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        {children}
      </section>
    </div>
  );
}

function CategoryManagerModal({ categories, counts, onAdd, onClose, notify }) {
  const [name, setName] = useState("");

  const submit = () => {
    const nextName = name.trim();
    if (!nextName) return;
    if (categories.includes(nextName)) {
      notify("这个分类已经存在");
      return;
    }
    onAdd(nextName);
    setName("");
    notify(`已新增分类「${nextName}」`);
  };

  return (
    <Modal title="分类管理" description="单层分类会贯穿灵感、创作台与归档库。" onClose={onClose}>
      <div className="category-manager">
        <div className="category-create-row">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submit()}
            placeholder="输入新分类名称"
            aria-label="新分类名称"
          />
          <button type="button" className="primary-button" disabled={!name.trim()} onClick={submit}>
            <Plus size={16} />新增
          </button>
        </div>
        <div className="category-manager-list">
          {!categories.length && <p>还没有分类。输入名称后，分类会贯穿全部内容阶段。</p>}
          {categories.map((category) => (
            <div key={category}>
              <span><Tags size={15} />{category}</span>
              <strong>{counts[category] || 0} 条内容</strong>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function LibraryActionModal({ action, storage, busy, onClose, onConfirm }) {
  const currentName = storage?.libraryName?.replace(/\.library$/i, "") || "";
  const [name, setName] = useState(currentName);
  const isRename = action === "rename";
  return (
    <Modal
      title={isRename ? "重命名资料库" : "关闭资料库"}
      description={isRename
        ? "只修改当前 .library 文件夹名称，库内内容和媒体不会移动到其他位置。"
        : "关闭只会解除当前资料库，不会删除任何内容或本地媒体。"}
      onClose={busy ? undefined : onClose}
    >
      <div className="library-action-body">
        {isRename ? (
          <label>
            <span>资料库名称</span>
            <input
              value={name}
              autoFocus
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && name.trim() && onConfirm({ name: name.trim() })}
            />
            <small>.library 会自动补全</small>
          </label>
        ) : (
          <div className="library-close-summary">
            <FolderOpen size={20} />
            <div><strong>{storage?.libraryName}</strong><span>{storage?.libraryDir}</span></div>
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="quiet-button" disabled={busy} onClick={onClose}>取消</button>
        <button
          type="button"
          className={isRename ? "primary-button" : "delete-queue-button"}
          disabled={busy || (isRename && !name.trim())}
          onClick={() => onConfirm(isRename ? { name: name.trim() } : {})}
        >
          {busy ? "处理中…" : isRename ? "确认重命名" : "关闭资料库"}
        </button>
      </div>
    </Modal>
  );
}

function ClosedLibraryWorkspace({ busy, onAction }) {
  return (
    <main className="closed-library-workspace">
      <div className="closed-library-icon"><FolderOpen size={30} /></div>
      <h1>没有打开资料库</h1>
      <p>新建一个独立资料库，或打开已有的 `.library` 继续工作。</p>
      <div>
        <button type="button" className="primary-button" disabled={busy} onClick={() => onAction("new")}><Plus size={16} />新建资料库</button>
        <button type="button" className="quiet-button" disabled={busy} onClick={() => onAction("open")}><FolderOpen size={16} />打开资料库</button>
      </div>
    </main>
  );
}

function AppSidebar({ page, setPage, queueCount, archiveCount, open, setOpen, storage, saveState, libraryBusy, onLibraryAction }) {
  const [libraryMenuOpen, setLibraryMenuOpen] = useState(false);
  const chooseAction = (action) => {
    setLibraryMenuOpen(false);
    onLibraryAction(action);
  };
  return (
    <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
      <div className="brand-row">
        <div className="brand-mark"><img src="/app-icon.png" alt="" /></div>
        <div className="brand-copy">
          <strong>Video Hub</strong>
          <span>{appVersionLabel}</span>
        </div>
        <IconButton label="收起导航" className="mobile-close" onClick={() => setOpen(false)}>
          <X size={18} />
        </IconButton>
      </div>

      <nav className="main-nav" aria-label="主导航">
        {navItems.map((item) => {
          const Icon = item.icon;
          const count = item.id === "queue" ? queueCount : item.id === "archive" ? archiveCount : null;
          return (
            <button
              type="button"
              key={item.id}
              aria-label={item.label}
              className={page === item.id ? "active" : ""}
              onClick={() => {
                setPage(item.id);
                setOpen(false);
              }}
            >
              <Icon size={18} />
              <span>{item.label}</span>
              {count !== null && <small>{count}</small>}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-bottom">
        <div className="library-switcher-wrap">
          <button
            type="button"
            className="nas-mini-status library-switcher"
            aria-expanded={libraryMenuOpen}
            disabled={libraryBusy}
            onClick={() => setLibraryMenuOpen((current) => !current)}
          >
          <span className={`online-dot ${saveState === "error" ? "offline" : ""}`} />
          <div>
              <strong>{storage?.libraryName || (saveState === "loading" ? "正在载入资料库" : "未打开资料库")}</strong>
              <span>{saveState === "saving" ? "正在保存…" : saveState === "error" ? "库写入异常" : storage?.libraryDir || "新建或打开资料库"}</span>
          </div>
            <ChevronDown size={14} />
          </button>
          {libraryMenuOpen && (
            <div className="library-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => chooseAction("new")}><Plus size={15} />新建资料库</button>
              <button type="button" role="menuitem" onClick={() => chooseAction("open")}><FolderOpen size={15} />打开资料库</button>
              <span />
              <button type="button" role="menuitem" disabled={!storage} onClick={() => chooseAction("rename")}><PencilLine size={15} />重命名资料库</button>
              <button type="button" role="menuitem" disabled={!storage} onClick={() => chooseAction("close")}><X size={15} />关闭资料库</button>
            </div>
          )}
        </div>
        <span
          className={`prototype-label build-label${__APP_DIRTY__ ? " is-dirty" : ""}`}
          title={`Video Hub ${appBuildLabel}`}
        >
          {appBuildLabel}
        </span>
      </div>
    </aside>
  );
}

function PageHeader({ eyebrow, title, description, actions, setSidebarOpen }) {
  return (
    <header className="page-header">
      <div className="title-row">
        <IconButton label="打开导航" className="mobile-menu" onClick={() => setSidebarOpen(true)}>
          <Menu size={20} />
        </IconButton>
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}

function CoverPlaceholder({ item, compact = false }) {
  const label = item.platform || item.category || "内容";
  return (
    <div className={`cover-placeholder ${compact ? "compact" : ""} tone-${platformTone[label] || "neutral"}`}>
      <span>{label}</span>
    </div>
  );
}

function MediaPreview({ item, compact = false }) {
  const videoRef = useRef(null);
  const manualPausedRef = useRef(false);
  const hoverTimerRef = useRef(null);
  const userMutedRef = useRef(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [videoReady, setVideoReady] = useState(false);
  const [mediaError, setMediaError] = useState("");
  const coverSrc = coverSource(item);
  const eagleSrc = eagleMediaSource(item);
  const videoSrc = eagleSrc || item.videoLocalPath || item.videoPreviewUrl || (item.videoUrl ? `/library-proxy/media?url=${encodeURIComponent(item.videoUrl)}` : "");
  const progress = mediaDuration > 0 ? Math.min(100, Math.max(0, (currentTime / mediaDuration) * 100)) : 0;

  useEffect(() => {
    setVideoReady(false);
    setMediaError("");
    return () => clearTimeout(hoverTimerRef.current);
  }, [videoSrc]);

  const play = async () => {
    const video = videoRef.current;
    if (!video) return;
    clearTimeout(hoverTimerRef.current);
    document.querySelectorAll(".media-preview video").forEach((other) => {
      if (other !== video && !other.paused) other.pause();
    });
    try {
      await video.play();
    } catch {
      setIsPlaying(false);
    }
  };
  const pause = () => {
    if (!videoRef.current) return;
    videoRef.current.pause();
  };
  const resetPreview = () => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    setIsPlaying(false);
    setVideoReady(false);
    try {
      video.currentTime = 0;
      setCurrentTime(0);
    } catch {}
  };
  const togglePlay = () => {
    if (!videoRef.current) return;
    clearTimeout(hoverTimerRef.current);
    if (!isPlaying) {
      manualPausedRef.current = false;
      void play();
    } else {
      manualPausedRef.current = true;
      pause();
    }
  };
  const toggleMuted = () => {
    setIsMuted((current) => {
      const next = !current;
      userMutedRef.current = next;
      if (videoRef.current) videoRef.current.muted = next;
      return next;
    });
  };
  const setSpeed = (rate) => {
    const nextRate = playbackRate === rate ? 1 : rate;
    setPlaybackRate(nextRate);
    if (videoRef.current) videoRef.current.playbackRate = nextRate;
  };
  const updateDuration = () => {
    const video = videoRef.current;
    if (!video) return;
    if (Number.isFinite(video.duration) && video.duration > 0) setMediaDuration(video.duration);
    video.playbackRate = playbackRate;
    if (!userMutedRef.current) video.volume = 1;
  };
  const updateTime = () => {
    if (isScrubbing || !videoRef.current) return;
    setCurrentTime(videoRef.current.currentTime || 0);
  };
  const scrubTo = (value) => {
    const next = Number(value);
    setCurrentTime(next);
    if (videoRef.current && Number.isFinite(next)) videoRef.current.currentTime = next;
  };

  if (compact) {
    if (coverSrc) return <ResilientImage src={coverSrc} alt="" onMissing={item.onMediaMissing} onLoad={item.onMediaLoaded} />;
    return <CoverPlaceholder item={item} compact />;
  }

  if (!coverSrc && !videoSrc) return <CoverPlaceholder item={item} />;

  return (
    <div
      className={`media-preview ${videoReady ? "video-ready" : ""}`}
      onMouseLeave={() => {
        clearTimeout(hoverTimerRef.current);
        manualPausedRef.current = false;
        resetPreview();
      }}
    >
      {coverSrc ? <ResilientImage src={coverSrc} alt="" onMissing={item.onMediaMissing} onLoad={item.onMediaLoaded} /> : <CoverPlaceholder item={item} />}
      {videoSrc && (
        <>
          <video
            ref={videoRef}
            src={videoSrc}
            muted={isMuted}
            loop
            playsInline
            preload="none"
            poster={videoReady ? undefined : coverSrc || undefined}
            onLoadedMetadata={updateDuration}
            onLoadedData={updateDuration}
            onDurationChange={updateDuration}
            onCanPlay={updateDuration}
            onTimeUpdate={updateTime}
            onSeeked={() => {
              setVideoReady(true);
              updateTime();
            }}
            onPlaying={() => {
              setIsPlaying(true);
              setVideoReady(true);
            }}
            onPause={() => setIsPlaying(false)}
            onError={() => {
              setIsPlaying(false);
              setMediaError(eagleSrc ? "Eagle 文件不可用/重新关联" : "视频文件不可用");
            }}
          />
          {mediaError && (
            <div className="media-error-state" role="status">
              <strong>{mediaError}</strong>
              <small>{eagleSrc ? "请确认 Eagle 已启动且素材未被移动或删除" : "请修复素材后重试"}</small>
            </div>
          )}
          <div
            className="media-hover-surface"
            aria-hidden="true"
            onMouseEnter={() => {
              clearTimeout(hoverTimerRef.current);
              hoverTimerRef.current = setTimeout(() => {
                if (!manualPausedRef.current && videoRef.current) {
                  videoRef.current.muted = userMutedRef.current;
                  if (!userMutedRef.current) videoRef.current.volume = 1;
                  setIsMuted(userMutedRef.current);
                  void play();
                }
              }, 180);
            }}
          />
          <div className="media-speed-control" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            {[2, 3].map((rate) => (
              <button
                type="button"
                className={playbackRate === rate ? "active" : ""}
                onClick={() => setSpeed(rate)}
                aria-pressed={playbackRate === rate}
                aria-label={`${rate} 倍速播放`}
                key={rate}
              >
                {rate}x
              </button>
            ))}
          </div>
          <div className="media-scrubber" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
            <button type="button" className="media-control-button" onPointerDown={() => clearTimeout(hoverTimerRef.current)} onClick={togglePlay} aria-label={isPlaying ? "暂停预览" : "播放预览"}>
              {isPlaying ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
            </button>
            <input
              type="range"
              aria-label="拖动视频进度"
              min="0"
              max={mediaDuration || 0}
              step="0.1"
              value={mediaDuration ? Math.min(currentTime, mediaDuration) : 0}
              onPointerDown={() => setIsScrubbing(true)}
              onPointerUp={() => {
                setIsScrubbing(false);
                if (!manualPausedRef.current) play();
              }}
              onPointerCancel={() => setIsScrubbing(false)}
              onChange={(event) => scrubTo(event.target.value)}
              style={{ "--progress": `${progress}%` }}
            />
            <span>{formatDuration(currentTime)} / {formatDuration(mediaDuration || item.duration)}</span>
            <button type="button" className="media-control-button" onClick={toggleMuted} aria-label={isMuted ? "打开声音" : "关闭声音"}>
              {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function CreationChoiceModal({ item, projects, onClose, onNew, onAdd, notify }) {
  const [mode, setMode] = useState("choice");
  return (
    <Modal title="把灵感带入创作" description={item.title} onClose={onClose}>
      {mode === "choice" ? (
        <div className="choice-list">
          <button type="button" onClick={() => onNew(item)}><span className="choice-icon coral"><Plus size={20} /></span><div><strong>开始新的创作</strong><p>生成新的永久内容 ID，并自动关联这条灵感。</p></div><ChevronRight size={18} /></button>
          <button type="button" onClick={() => setMode("existing")} disabled={!projects.length}><span className="choice-icon blue"><Inbox size={20} /></span><div><strong>加入已有创作</strong><p>从创作台中选择一个选题继续整理。</p></div><ChevronRight size={18} /></button>
        </div>
      ) : (
        <div className="existing-list">
          <button type="button" className="back-link" onClick={() => setMode("choice")}><ChevronDown size={16} />返回选择</button>
          {projects.map((project) => (
            <button type="button" key={project.id} onClick={() => { onAdd(project, item); notify(`已加入 ${project.id}`); onClose(); }}>
              <MediaPreview item={primaryProjectCover(project) || project} compact /><div><small>{project.id}</small><strong>{project.title || "未命名创作"}</strong></div><Plus size={18} />
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function App() {
  const [page, setPage] = useState("inspirations");
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const [storage, setStorage] = useState(null);
  const [saveState, setSaveState] = useState("loading");
  const [inspirationItems, setInspirationItems] = useState([]);
  const [categories, setCategories] = useState(defaultCategories);
  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState(null);
  const [editingProjectId, setEditingProjectId] = useState(null);
  const [editingAccountRole, setEditingAccountRole] = useState("blogger");
  const [mediaUploads, setMediaUploads] = useState({});
  const [archiveItems, setArchiveItems] = useState([]);
  const [choiceItem, setChoiceItem] = useState(null);
  const [toast, setToast] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [authStatus, setAuthStatus] = useState({});
  const [libraryWritable, setLibraryWritable] = useState(false);
  const [libraryAction, setLibraryAction] = useState(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryRevision, setLibraryRevision] = useState(1);
  const [deletingInspirationIds, setDeletingInspirationIds] = useState(() => new Set());
  const [deletingProjectIds, setDeletingProjectIds] = useState(() => new Set());
  const [creatingContentIds, setCreatingContentIds] = useState(() => new Set());
  const [movingProjectIds, setMovingProjectIds] = useState(() => new Set());
  const legacyCategoriesRef = useRef([]);
  const userCategoriesStoredRef = useRef(false);
  const lastSavedSnapshotRef = useRef("");
  const projectRevisionRef = useRef(new Map());
  const abandonedProjectIdsRef = useRef(new Set());
  const latestMediaUploadTaskRef = useRef(new Map());
  const creatingProjectRef = useRef(false);
  const libraryRevisionRef = useRef(1);
  const saveInFlightRef = useRef(null);
  const autosaveTimerRef = useRef(null);
  const deletingInspirationIdsRef = useRef(new Set());
  const deletingProjectIdsRef = useRef(new Set());
  const creatingContentIdsRef = useRef(new Set());
  const movingProjectIdsRef = useRef(new Set());
  const mobileInboxSyncInFlightRef = useRef(false);
  const projectIndexMutationQueueRef = useRef(Promise.resolve());
  const inspirationItemsRef = useRef(inspirationItems);
  const pendingReferencePatchesRef = useRef(new Map());
  const referencePatchTimersRef = useRef(new Map());
  const activeProjectRef = useRef(activeProject);
  const projectsRef = useRef(projects);
  const archiveItemsRef = useRef(archiveItems);
  const linkedInspirationIds = useMemo(() => collectReferencedInspirationIds({
    activeProject,
    projects,
    archiveItems,
  }), [activeProject, projects, archiveItems]);
  activeProjectRef.current = activeProject;
  projectsRef.current = projects;
  archiveItemsRef.current = archiveItems;
  inspirationItemsRef.current = inspirationItems;
  libraryRevisionRef.current = libraryRevision;
  deletingInspirationIdsRef.current = deletingInspirationIds;
  deletingProjectIdsRef.current = deletingProjectIds;
  creatingContentIdsRef.current = creatingContentIds;
  movingProjectIdsRef.current = movingProjectIds;
  const editingProject = editingProjectId
    ? projects.find((project) => project.id === editingProjectId) || null
    : null;
  const creationProject = editingProject || activeProject;

  const applyLibraryData = (data) => {
    if (data.libraryOpen === false) {
      legacyCategoriesRef.current = [];
      userCategoriesStoredRef.current = false;
      setCategories([]);
      setInspirationItems([]);
      setProjects([]);
      setArchiveItems([]);
      setActiveProject(null);
      setEditingProjectId(null);
      setEditingAccountRole("blogger");
      setMediaUploads({});
      projectRevisionRef.current = new Map();
      abandonedProjectIdsRef.current = new Set();
      latestMediaUploadTaskRef.current = new Map();
      setStorage(null);
      libraryRevisionRef.current = Number(data.revision) || libraryRevisionRef.current;
      setLibraryRevision(libraryRevisionRef.current);
      setDeletingInspirationIds(new Set());
      deletingProjectIdsRef.current = new Set();
      setDeletingProjectIds(new Set());
      creatingContentIdsRef.current = new Set();
      setCreatingContentIds(new Set());
      setMovingProjectIds(new Set());
      lastSavedSnapshotRef.current = "";
      setLibraryLoaded(true);
      setLibraryWritable(false);
      setSaveState("closed");
      setPage("inspirations");
      return;
    }
    const library = normalizeLibrary(data);
    const activeWasQueued = library.activeProject?.workflow?.stage === "ready_to_publish";
    const duplicateIndex = library.activeProject
      ? library.projects.findIndex((project) => project.id === library.activeProject.id)
      : -1;
    const visibleProjects = activeWasQueued
      ? library.projects.filter((project) => project.id !== library.activeProject.id)
      : [...library.projects];
    if (activeWasQueued) {
      visibleProjects.splice(
        duplicateIndex >= 0 ? Math.min(duplicateIndex, visibleProjects.length) : 0,
        0,
        library.activeProject,
      );
    }
    const nextActiveProject = activeWasQueued ? null : library.activeProject;
    legacyCategoriesRef.current = library.legacyCategories;
    userCategoriesStoredRef.current = library.hasUserDefinedCategories;
    setCategories(library.categories);
    setInspirationItems(library.inspirations);
    setProjects(visibleProjects);
    setArchiveItems(library.archive);
    setActiveProject(nextActiveProject);
    setEditingProjectId(null);
    setEditingAccountRole("blogger");
    setMediaUploads({});
    projectRevisionRef.current = new Map();
    abandonedProjectIdsRef.current = new Set();
    latestMediaUploadTaskRef.current = new Map();
    setStorage(library.storage);
    libraryRevisionRef.current = library.revision;
    setLibraryRevision(library.revision);
    setDeletingInspirationIds(new Set());
    deletingProjectIdsRef.current = new Set();
    setDeletingProjectIds(new Set());
    creatingContentIdsRef.current = new Set();
    setCreatingContentIds(new Set());
    setMovingProjectIds(new Set());
    lastSavedSnapshotRef.current = stableLibrarySnapshot(librarySavePayload({
      legacyCategories: library.legacyCategories,
      categories: library.categories,
      hasUserDefinedCategories: library.hasUserDefinedCategories,
      inspirationItems: library.inspirations,
      projects: visibleProjects,
      archiveItems: library.archive,
      activeProject: nextActiveProject,
    }));
    setLibraryLoaded(true);
    const writable = library.storage?.mode !== "read_only";
    setLibraryWritable(writable);
    setSaveState(writable ? "saved" : "readonly");
  };

  const refreshAuthStatus = async (probe = false, platform = "") => {
    try {
      const params = new URLSearchParams();
      if (probe) params.set("probe", "1");
      if (platform) params.set("platform", platform);
      const response = await fetch(`/api/auth/status${params.size ? `?${params}` : ""}`);
      const nextStatus = await response.json();
      setAuthStatus((current) => platform ? { ...current, ...nextStatus } : nextStatus);
      return nextStatus;
    } catch {
      return {};
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetch("/api/library")
      .then((response) => {
        if (!response.ok) throw new Error("library api failed");
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        applyLibraryData(data);
        refreshAuthStatus(true);
      })
      .catch(() => {
        if (cancelled) return;
        setLibraryLoaded(true);
        setLibraryWritable(false);
        setSaveState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    for (const timer of referencePatchTimersRef.current.values()) window.clearTimeout(timer);
    referencePatchTimersRef.current.clear();
    pendingReferencePatchesRef.current.clear();
  }, []);

  useEffect(() => {
    if (!libraryLoaded || !libraryWritable || !storage?.sessionId) return undefined;
    let cancelled = false;
    const syncMobileInbox = async () => {
      if (cancelled || mobileInboxSyncInFlightRef.current) return;
      mobileInboxSyncInFlightRef.current = true;
      try {
        const statusResponse = await fetch("/api/mobile-inbox/status");
        const mobileStatus = await statusResponse.json();
        if (!statusResponse.ok || !mobileStatus.connected || cancelled) return;
        const response = await fetch("/api/mobile-inbox/sync", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-library-session-id": storage.sessionId,
          },
          body: JSON.stringify({ limit: 5 }),
        });
        const result = await response.json();
        if (!response.ok || !result.library || cancelled) return;
        const library = normalizeLibrary(result.library);
        setInspirationItems(library.inspirations);
        if (library.storage) setStorage(library.storage);
        if (library.revision) {
          libraryRevisionRef.current = library.revision;
          setLibraryRevision(library.revision);
        }
      } catch {
        // Offline computers and NAS mounts are expected to recover later. D1 keeps
        // pending links until a writable, authorized desktop can claim them.
      } finally {
        mobileInboxSyncInFlightRef.current = false;
      }
    };
    void syncMobileInbox();
    const timer = window.setInterval(syncMobileInbox, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [libraryLoaded, libraryWritable, storage?.sessionId]);

  useEffect(() => {
    if (!libraryLoaded || !libraryWritable) return undefined;
    if (deletingInspirationIds.size || deletingProjectIds.size || creatingContentIds.size || movingProjectIds.size) {
      setSaveState("saving");
      return undefined;
    }
    const payload = librarySavePayload({
      legacyCategories: legacyCategoriesRef.current,
      categories,
      hasUserDefinedCategories: userCategoriesStoredRef.current,
      inspirationItems,
      projects,
      archiveItems,
      activeProject,
    });
    const snapshot = stableLibrarySnapshot(payload);
    if (snapshot === lastSavedSnapshotRef.current) {
      setSaveState("saved");
      return undefined;
    }
    setSaveState("saving");
    autosaveTimerRef.current = window.setTimeout(() => {
      if (deletingInspirationIdsRef.current.size || deletingProjectIdsRef.current.size || creatingContentIdsRef.current.size || movingProjectIdsRef.current.size || saveInFlightRef.current) return;
      const requestRevision = libraryRevisionRef.current;
      const request = fetch("/api/library", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-library-session-id": storage?.sessionId || "",
          "x-library-revision": String(requestRevision),
        },
        body: JSON.stringify(payload),
      })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) {
            const error = new Error(data.error || "save failed");
            error.status = response.status;
            error.data = data;
            throw error;
          }
          return data;
        })
        .then((data) => {
          if (data.storage) setStorage(data.storage);
          if (data.revision) {
            libraryRevisionRef.current = data.revision;
            setLibraryRevision(data.revision);
          }
          lastSavedSnapshotRef.current = snapshot;
          setSaveState("saved");
        })
        .catch((error) => {
          if (error.status === 409) {
            setSaveState("error");
            notify("检测到资料库版本冲突，当前页面内容已保留，请重试保存");
            return;
          }
          setSaveState("error");
        })
        .finally(() => {
          if (saveInFlightRef.current === request) saveInFlightRef.current = null;
        });
      saveInFlightRef.current = request;
    }, 360);
    return () => window.clearTimeout(autosaveTimerRef.current);
  }, [libraryLoaded, libraryWritable, categories, inspirationItems, projects, archiveItems, activeProject, storage?.sessionId, libraryRevision, deletingInspirationIds, deletingProjectIds, creatingContentIds, movingProjectIds]);

  const openAuth = async (platform) => {
    notify("正在打开专用登录窗口");
    try {
      const response = await fetch("/api/auth/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform }),
      });
      const result = await response.json();
      await refreshAuthStatus(true, platform);
      notify(result.error || result.status || "登录窗口已打开");
      return result;
    } catch (error) {
      notify(`登录窗口打开失败：${error.message}`);
      return null;
    }
  };

  const hardDeleteContent = async (id) => {
    window.clearTimeout(autosaveTimerRef.current);
    try {
      const response = await fetch(`/api/content/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: {
          "x-library-session-id": storage?.sessionId || "",
          "x-library-revision": String(libraryRevisionRef.current),
        },
      });
      const result = await response.json();
      if (!response.ok || result.error) {
        const error = new Error(result.error || "删除失败");
        error.status = response.status;
        error.data = result;
        throw error;
      }
      if (result.library) applyLibraryData(result.library);
      return result;
    } catch (error) {
      if ([409, 423].includes(error.status) && error.data?.library) applyLibraryData(error.data.library);
      notify(`删除失败：${error.message}`);
      return null;
    }
  };

  const deleteInspiration = async (id) => {
    if (deletingInspirationIdsRef.current.has(id)) return false;
    window.clearTimeout(autosaveTimerRef.current);
    const nextDeletingIds = new Set(deletingInspirationIdsRef.current);
    nextDeletingIds.add(id);
    deletingInspirationIdsRef.current = nextDeletingIds;
    setDeletingInspirationIds(nextDeletingIds);
    try {
      return Boolean(await hardDeleteContent(id));
    } finally {
      setDeletingInspirationIds((current) => {
        const next = new Set(current);
        next.delete(id);
        deletingInspirationIdsRef.current = next;
        return next;
      });
    }
  };

  const ingestInspiration = async (rawText, category) => {
    const response = await fetch("/api/inspirations/ingest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-library-session-id": storage?.sessionId || "",
      },
      body: JSON.stringify({ rawText, category }),
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || "添加灵感失败");
    if (result.library) applyLibraryData(result.library);
    return result;
  };

  const patchInspiration = async (id, patch, generation) => {
    const response = await fetch(`/api/inspirations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-library-session-id": storage?.sessionId || "",
      },
      body: JSON.stringify({ patch, generation }),
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || "灵感更新失败");
    if (result.library?.revision) {
      libraryRevisionRef.current = result.library.revision;
      setLibraryRevision(result.library.revision);
    }
    return result;
  };

  const notify = (message) => {
    setToast(message);
    window.clearTimeout(window.__demoToastTimer);
    window.__demoToastTimer = window.setTimeout(() => setToast(""), 2300);
  };

  const currentLibraryPayload = () => librarySavePayload({
    legacyCategories: legacyCategoriesRef.current,
    categories,
    hasUserDefinedCategories: userCategoriesStoredRef.current,
    inspirationItems,
    projects,
    archiveItems,
    activeProject,
  });

  const persistCurrentLibrary = async () => {
    window.clearTimeout(autosaveTimerRef.current);
    if (saveInFlightRef.current) await saveInFlightRef.current;
    const payload = currentLibraryPayload();
    const snapshot = stableLibrarySnapshot(payload);
    if (snapshot === lastSavedSnapshotRef.current) return { payload, snapshot };
    setSaveState("saving");
    const response = await fetch("/api/library", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-library-session-id": storage?.sessionId || "",
        "x-library-revision": String(libraryRevisionRef.current),
      },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok || result.error) {
      const error = new Error(result.error || "保存失败");
      error.status = response.status;
      error.data = result;
      setSaveState("error");
      throw error;
    }
    if (result.storage) setStorage(result.storage);
    if (result.revision) {
      libraryRevisionRef.current = result.revision;
      setLibraryRevision(result.revision);
    }
    lastSavedSnapshotRef.current = snapshot;
    setSaveState("saved");
    return { payload, snapshot };
  };

  const executeLibraryAction = async (action, extra = {}) => {
    if (libraryBusy) return;
    const previousStorage = storage;
    setLibraryBusy(true);
    setLibraryWritable(false);
    try {
      if (previousStorage) {
        const payload = currentLibraryPayload();
        const saveResponse = await fetch("/api/library", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-library-session-id": previousStorage.sessionId || "",
            "x-library-revision": String(libraryRevisionRef.current),
          },
          body: JSON.stringify(payload),
        });
        const saved = await saveResponse.json();
        if (!saveResponse.ok) throw new Error(saved.error || "切换前保存失败");
        if (saved.revision) {
          libraryRevisionRef.current = saved.revision;
          setLibraryRevision(saved.revision);
        }
        lastSavedSnapshotRef.current = stableLibrarySnapshot(payload);
      }
      const response = await fetch("/api/library/manage", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-library-session-id": previousStorage?.sessionId || "",
        },
        body: JSON.stringify({ action, ...extra }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "资料库操作失败");
      if (result.cancelled) {
        setLibraryWritable(Boolean(previousStorage));
        setSaveState(previousStorage ? "saved" : "closed");
        return;
      }
      applyLibraryData(result);
      setLibraryAction(null);
      notify(action === "new" ? "新资料库已创建并打开" : action === "open" ? "资料库已打开" : action === "rename" ? "资料库已重命名" : "资料库已关闭");
    } catch (error) {
      setLibraryWritable(Boolean(previousStorage));
      setSaveState(previousStorage ? "saved" : "closed");
      notify(error.message);
    } finally {
      setLibraryBusy(false);
    }
  };

  const requestLibraryAction = (action) => {
    if (libraryBusy) return;
    if ((action === "rename" || action === "close") && storage) {
      setLibraryAction(action);
      return;
    }
    executeLibraryAction(action);
  };

  useEffect(() => {
    const handleCommand = (event) => requestLibraryAction(event.detail?.action);
    window.addEventListener("library-command", handleCommand);
    return () => window.removeEventListener("library-command", handleCommand);
  });

  const allocateProjectId = async () => {
    const response = await fetch("/api/content-ids", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-library-session-id": storage?.sessionId || "",
        "x-library-revision": String(libraryRevisionRef.current),
      },
      body: JSON.stringify({ prefix: "C" }),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 409 && result.library) applyLibraryData(result.library);
      throw new Error(result.error || "无法分配新的内容 ID");
    }
    if (result.revision) {
      libraryRevisionRef.current = result.revision;
      setLibraryRevision(result.revision);
    }
    return result.contentId;
  };

  const createProject = async ({ reference = null, replaceProjectId = "" } = {}) => {
    if (creatingProjectRef.current) {
      notify("正在创建新画板，请稍候");
      return null;
    }
    creatingProjectRef.current = true;
    try {
      if (replaceProjectId) {
        abandonedProjectIdsRef.current.add(replaceProjectId);
        projectRevisionRef.current.set(replaceProjectId, (projectRevisionRef.current.get(replaceProjectId) || 0) + 1);
        const deleted = await hardDeleteContent(replaceProjectId);
        if (!deleted) return null;
      }
      const id = await allocateProjectId();
      if (replaceProjectId) {
        setMediaUploads((current) => {
          const next = { ...current };
          delete next[replaceProjectId];
          return next;
        });
        setProjects((current) => current.filter((project) => project.id !== replaceProjectId));
      }
      const project = makeOriginalProject({
        id,
        reference,
        createdAt: formatNow(),
      });
      activeProjectRef.current = project;
      setActiveProject(project);
      setEditingProjectId(null);
      setEditingAccountRole("blogger");
      setPage("creation");
      return project;
    } catch (error) {
      notify(error.message);
      return null;
    } finally {
      creatingProjectRef.current = false;
    }
  };

  const createNew = async (inspiration) => {
    // Remove the source modal before the async ID request can reveal the creation page.
    // Otherwise its backdrop can briefly intercept the first click on the new page.
    setChoiceItem(null);
    const project = await createProject({
      reference: inspiration,
      replaceProjectId: activeProjectRef.current?.id || "",
    });
    if (!project) return;
    notify(`已新建 ${project.id}，并关联灵感`);
  };

  const createBlank = async () => {
    const project = await createProject({
      replaceProjectId: activeProjectRef.current?.id || "",
    });
    if (project) notify(`已新建 ${project.id}`);
  };

  const createContentIndex = () => {
    const project = queueProject(makeOriginalProject({ id: optimisticContentId(), createdAt: formatNow() }));
    const nextCreatingIds = new Set(creatingContentIdsRef.current);
    nextCreatingIds.add(project.id);
    creatingContentIdsRef.current = nextCreatingIds;
    setCreatingContentIds(nextCreatingIds);
    window.clearTimeout(autosaveTimerRef.current);
    projectsRef.current = [project, ...projectsRef.current];
    setProjects(projectsRef.current);
    setSaveState("saving");

    const finishCreate = () => {
      const next = new Set(creatingContentIdsRef.current);
      next.delete(project.id);
      creatingContentIdsRef.current = next;
      setCreatingContentIds(next);
    };
    const commitCreate = async () => {
      try {
        const response = await fetch("/api/projects/index", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-library-session-id": storage?.sessionId || "",
            "x-library-revision": String(libraryRevisionRef.current),
          },
          body: JSON.stringify({ project }),
        });
        const result = await response.json();
        if (!response.ok || result.error || result.createdProject?.id !== project.id) throw new Error(result.error || "新建内容失败");
        if (result.storage) setStorage(result.storage);
        if (result.revision) {
          libraryRevisionRef.current = result.revision;
          setLibraryRevision(result.revision);
        }
        const savedPayload = savedLibraryPayload(lastSavedSnapshotRef.current);
        if (savedPayload) {
          lastSavedSnapshotRef.current = stableLibrarySnapshot({
            ...savedPayload,
            projects: [result.createdProject, ...(savedPayload.projects || []).filter((item) => item.id !== project.id)],
          });
        }
        setSaveState("saved");
        notify(`已新建 ${project.id}，可以直接填写内容`);
      } catch (error) {
        projectsRef.current = projectsRef.current.filter((item) => item.id !== project.id);
        setProjects(projectsRef.current);
        notify(`新建失败，已撤回内容：${error.message || "新建内容失败"}`);
      } finally {
        finishCreate();
      }
    };
    const queued = projectIndexMutationQueueRef.current.then(commitCreate, commitCreate);
    projectIndexMutationQueueRef.current = queued.catch(() => {});
    return project;
  };

  const addToExisting = (project, inspiration) => {
    setProjects((current) => current.map((item) => item.id === project.id && !item.references.some((ref) => ref.id === inspiration.id) ? { ...item, references: [...item.references, inspiration], modified: "刚刚" } : item));
  };

  const updateProjectById = (projectId, updater) => {
    if (activeProjectRef.current?.id === projectId) {
      activeProjectRef.current = updater(activeProjectRef.current);
      setActiveProject(activeProjectRef.current);
    }
    projectsRef.current = projectsRef.current.map((project) => project.id === projectId ? updater(project) : project);
    setProjects(projectsRef.current);
  };

  const queueActive = (projectId, navigate = true) => {
    const wasEditing = editingProjectId === projectId;
    const project = activeProjectRef.current?.id === projectId
      ? activeProjectRef.current
      : projectsRef.current.find((item) => item.id === projectId);
    if (!project) return null;
    const queuedProject = queueProject(project);
    setProjects((current) => {
      const existingIndex = current.findIndex((item) => item.id === queuedProject.id);
      if (existingIndex < 0) return [queuedProject, ...current];
      return current.map((item, index) => index === existingIndex ? queuedProject : item);
    });
    if (activeProjectRef.current?.id === queuedProject.id) activeProjectRef.current = null;
    setActiveProject((current) => current?.id === queuedProject.id ? null : current);
    setEditingProjectId((current) => current === queuedProject.id ? null : current);
    if (wasEditing) setEditingAccountRole("blogger");
    if (navigate) setPage("queue");
    notify(wasEditing ? "编辑已同步到创作台" : "已保存到创作台");
    return queuedProject;
  };

  const queueAndCreate = async (projectId) => {
    if (creatingProjectRef.current) return;
    creatingProjectRef.current = true;
    try {
      const id = await allocateProjectId();
      const project = activeProjectRef.current?.id === projectId
        ? activeProjectRef.current
        : projectsRef.current.find((item) => item.id === projectId);
      if (!project) throw new Error("当前草稿已经变化，请重试");
      const queuedProject = queueProject(project);
      setProjects((current) => {
        const existingIndex = current.findIndex((item) => item.id === queuedProject.id);
        if (existingIndex < 0) return [queuedProject, ...current];
        return current.map((item, index) => index === existingIndex ? queuedProject : item);
      });
      const nextProject = makeOriginalProject({ id, createdAt: formatNow() });
      activeProjectRef.current = nextProject;
      setActiveProject(nextProject);
      setEditingProjectId(null);
      setEditingAccountRole("blogger");
      setPage("creation");
      notify("当前创作已保存到创作台，并打开了新画板");
    } catch (error) {
      notify(error.message);
    } finally {
      creatingProjectRef.current = false;
    }
  };

  const clearActiveProject = async (projectId) => {
    projectRevisionRef.current.set(projectId, (projectRevisionRef.current.get(projectId) || 0) + 1);
    setMediaUploads((current) => {
      const next = { ...current };
      delete next[projectId];
      return next;
    });
    const project = await createProject({ replaceProjectId: projectId });
    if (project) notify("原草稿及其真实文件已彻底删除，已打开新画板");
  };

  const discardAndCreate = async (projectId) => {
    const project = await createProject({ replaceProjectId: projectId });
    if (project) notify("当前草稿及其真实文件已彻底删除，已打开新画板");
  };

  const uploadProjectCovers = async (projectId, files, accountRole = "blogger") => {
    const revision = projectRevisionRef.current.get(projectId) || 0;
    let successCount = 0;
    let failureCount = 0;
    for (const file of files) {
      try {
        const cover = await uploadProjectCoverFile({
          file,
          projectId,
          accountRole,
          sessionId: storage?.sessionId || "",
        });
        if (abandonedProjectIdsRef.current.has(projectId) || (projectRevisionRef.current.get(projectId) || 0) !== revision) return;
        updateProjectById(projectId, (current) => ({
          ...current,
          covers: [...(current.covers || []), { ...cover, accountRole }],
          modified: "刚刚",
        }));
        successCount += 1;
      } catch (error) {
        failureCount += 1;
        notify(`${file.name}：${error.message || "封面上传失败"}`);
      }
    }
    if (successCount) notify(`已导入 Eagle 并添加 ${successCount} 张封面`);
    if (failureCount) notify(`${failureCount} 张封面导入失败，可单独重试`);
  };

  const updateUploadTask = (projectId, uploadKey, taskId, updater) => {
    setMediaUploads((current) => {
      const projectUploads = current[projectId] || {};
      const task = projectUploads[uploadKey];
      if (!task || task.taskId !== taskId) return current;
      const nextTask = updater(task);
      const nextProjectUploads = { ...projectUploads };
      if (nextTask) nextProjectUploads[uploadKey] = nextTask;
      else delete nextProjectUploads[uploadKey];
      const next = { ...current };
      if (Object.keys(nextProjectUploads).length) next[projectId] = nextProjectUploads;
      else delete next[projectId];
      return next;
    });
  };

  const uploadProjectMedia = async (projectId, role, accountRole, file, replacementId = "") => {
    if (!file) return;
    if (!/\.(?:mp4|mov|m4v|webm)$/i.test(file.name)) {
      notify("只支持 MP4、MOV、M4V 或 WebM 视频");
      return;
    }
    const uploadKey = projectMediaSlotKey(role, accountRole);
    if (!uploadKey) {
      notify("视频上传位置无效");
      return;
    }
    const taskId = `${projectId}-${uploadKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const revision = projectRevisionRef.current.get(projectId) || 0;
    latestMediaUploadTaskRef.current.set(`${projectId}:${uploadKey}`, taskId);
    setMediaUploads((current) => ({
      ...current,
      [projectId]: {
        ...(current[projectId] || {}),
        [uploadKey]: {
          taskId,
          projectId,
          role,
          accountRole,
          replacementId,
          fileName: file.name,
          progress: 0,
        },
      },
    }));
    try {
      const media = await uploadProjectMediaFile({
        file,
        projectId,
        role,
        accountRole,
        uploadId: taskId,
        sessionId: storage?.sessionId || "",
        onProgress: (progress) => updateUploadTask(projectId, uploadKey, taskId, (current) => ({ ...current, progress })),
      });
      if (abandonedProjectIdsRef.current.has(projectId) || (projectRevisionRef.current.get(projectId) || 0) !== revision) return;
      if (latestMediaUploadTaskRef.current.get(`${projectId}:${uploadKey}`) !== taskId) return;
      updateProjectById(projectId, (current) => mergeUploadedMedia(current, {
        role,
        accountRole,
        media,
        replacementId,
      }));
      notify(`${projectMediaSlotLabel(role, accountRole)}已保存到资料库`);
    } catch (error) {
      if (latestMediaUploadTaskRef.current.get(`${projectId}:${uploadKey}`) !== taskId) return;
      notify(error.message || "视频上传失败");
    } finally {
      if (latestMediaUploadTaskRef.current.get(`${projectId}:${uploadKey}`) === taskId) {
        latestMediaUploadTaskRef.current.delete(`${projectId}:${uploadKey}`);
      }
      updateUploadTask(projectId, uploadKey, taskId, () => null);
    }
  };

  const removeProjectMedia = async (
    projectId,
    role,
    accountRole,
    mediaId = "",
    options = {},
  ) => {
    const project = activeProjectRef.current?.id === projectId
      ? activeProjectRef.current
      : projectsRef.current.find((item) => item.id === projectId);
    const projection = projectMediaSlotProjection(project);
    const slot = projection.slots.find((item) => (
      item.role === role
      && item.accountRole === accountRole
      && (!mediaId || item.asset?.id === mediaId)
    ));
    const media = slot?.asset || projection.legacyOverflow.find((item) => (
      item.role === role && (!mediaId || item.id === mediaId)
    ));
    const relativePath = libraryRelativePath(media);
    const eagleItemId = String(media?.eagleItemId || "");
    const label = projectMediaSlotLabel(role, accountRole);
    if (!project || !media || (!relativePath && !eagleItemId)) {
      notify(`找不到要删除的${label}`);
      return false;
    }
    const confirmed = window.confirm(eagleItemId
      ? `确定从内容中移除这条${label}吗？\n\n只会解除软件索引，Eagle 原文件不会被删除。`
      : `永久删除这条${label}？\n\n文件会从当前 .library 中彻底删除，无法恢复。`);
    if (!confirmed) return false;
    try {
      const result = await deleteProjectMediaFile({
        projectId,
        role,
        accountRole,
        mediaId: media.id || mediaId,
        relativePath,
        eagleItemId,
        legacyAccountRole: Boolean(options.legacyAccountRole || media.legacyAccountRole),
        sessionId: storage?.sessionId || "",
      });
      if (result.library) applyLibraryData(result.library);
      notify(eagleItemId ? `已解除${label}的软件索引，Eagle 文件未受影响` : `已从资料库永久删除${label}`);
      return true;
    } catch (error) {
      notify(error.message || `${label}删除失败`);
      return false;
    }
  };

  const revealProjectAsset = async (projectId, target = {}) => {
    try {
      await revealProjectTarget({
        projectId,
        relativePath: target.relativePath || "",
        scope: target.scope || "project",
        sessionId: storage?.sessionId || "",
      });
    } catch (error) {
      notify(error.message);
    }
  };

  const revealProjectMedia = async (projectId, media) => revealProjectAsset(projectId, {
    relativePath: libraryRelativePath(media),
    scope: media?.role === "source_video" ? "source_video" : "finished_video",
  });

  const updateProjectReference = (projectId, inspirationId, patch) => {
    const updatedAt = formatNow();
    updateProjectById(projectId, (current) => ({
      ...current,
      references: current.references.map((item) => item.id === inspirationId ? { ...item, ...patch, updatedAt } : item),
      modified: "刚刚",
    }));
    setInspirationItems((current) => current.map((item) => item.id === inspirationId ? { ...item, ...patch, updatedAt } : item));

    const pending = pendingReferencePatchesRef.current.get(inspirationId) || {};
    pendingReferencePatchesRef.current.set(inspirationId, { ...pending, ...patch });
    window.clearTimeout(referencePatchTimersRef.current.get(inspirationId));
    referencePatchTimersRef.current.set(inspirationId, window.setTimeout(async () => {
      const committedPatch = pendingReferencePatchesRef.current.get(inspirationId);
      pendingReferencePatchesRef.current.delete(inspirationId);
      referencePatchTimersRef.current.delete(inspirationId);
      if (!committedPatch) return;
      const source = inspirationItemsRef.current.find((item) => item.id === inspirationId);
      try {
        await patchInspiration(inspirationId, committedPatch, source?.generation);
      } catch (error) {
        notify(`修改未保存：${error.message}`);
      }
    }, 450));
  };

  const editProject = (project, accountRole = "blogger") => {
    setEditingProjectId(project.id);
    setEditingAccountRole(accountRole);
    setPage("creation");
  };

  const deleteQueuedProject = (projectId) => {
    if (deletingProjectIdsRef.current.has(projectId)) return Promise.resolve(false);
    const removedProject = projectsRef.current.find((project) => project.id === projectId);
    if (!removedProject) return Promise.resolve(false);
    const removedIndex = projectsRef.current.findIndex((project) => project.id === projectId);
    const removedActiveProject = activeProjectRef.current?.id === projectId ? activeProjectRef.current : null;
    const nextDeletingIds = new Set(deletingProjectIdsRef.current);
    nextDeletingIds.add(projectId);
    deletingProjectIdsRef.current = nextDeletingIds;
    setDeletingProjectIds(nextDeletingIds);
    window.clearTimeout(autosaveTimerRef.current);

    projectsRef.current = projectsRef.current.filter((project) => project.id !== projectId);
    setProjects(projectsRef.current);
    if (removedActiveProject) {
      activeProjectRef.current = null;
      setActiveProject(null);
    }
    setEditingProjectId((current) => current === projectId ? null : current);

    const finishDelete = () => {
      const next = new Set(deletingProjectIdsRef.current);
      next.delete(projectId);
      deletingProjectIdsRef.current = next;
      setDeletingProjectIds(next);
    };
    const commitDelete = async () => {
      try {
        const localPayload = librarySavePayload({
          legacyCategories: legacyCategoriesRef.current,
          categories,
          hasUserDefinedCategories: userCategoriesStoredRef.current,
          inspirationItems: inspirationItemsRef.current,
          projects: projectsRef.current,
          archiveItems,
          activeProject: activeProjectRef.current,
        });
        const projectPatches = dirtyProjectPatches(
          lastSavedSnapshotRef.current,
          localPayload.projects,
          localPayload.activeProject,
          projectId,
        );
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/index`, {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
            "x-library-session-id": storage?.sessionId || "",
            "x-library-revision": String(libraryRevisionRef.current),
          },
          body: JSON.stringify({ projectPatches }),
        });
        const result = await response.json();
        if (!response.ok || result.error) throw new Error(result.error || "删除索引失败");
        const reconciledById = new Map((result.reconciledProjects || []).map((project) => [project.id, project]));
        projectsRef.current = projectsRef.current.map((project) => reconciledById.get(project.id) || project);
        setProjects(projectsRef.current);
        if (activeProjectRef.current) {
          activeProjectRef.current = reconciledById.get(activeProjectRef.current.id) || activeProjectRef.current;
          setActiveProject(activeProjectRef.current);
        }
        if (result.storage) setStorage(result.storage);
        if (result.revision) {
          libraryRevisionRef.current = result.revision;
          setLibraryRevision(result.revision);
        }
        const savedPayload = savedLibraryPayload(lastSavedSnapshotRef.current);
        if (savedPayload) {
          lastSavedSnapshotRef.current = stableLibrarySnapshot({
            ...savedPayload,
            projects: (savedPayload.projects || [])
              .filter((project) => project.id !== projectId)
              .map((project) => reconciledById.get(project.id) || project),
            activeProject: reconciledById.get(savedPayload.activeProject?.id) || activeProjectRef.current,
          });
        }
        setSaveState("saved");
        notify("已删除软件索引，Eagle 文件未受影响");
        return true;
      } catch (error) {
        projectsRef.current = [...projectsRef.current];
        projectsRef.current.splice(Math.min(removedIndex, projectsRef.current.length), 0, removedProject);
        setProjects(projectsRef.current);
        if (removedActiveProject) {
          activeProjectRef.current = removedActiveProject;
          setActiveProject(removedActiveProject);
        }
        notify(`删除失败，已恢复内容：${error.message || "删除索引失败"}`);
        return false;
      } finally {
        finishDelete();
      }
    };
    const queued = projectIndexMutationQueueRef.current.then(commitDelete, commitDelete);
    projectIndexMutationQueueRef.current = queued.catch(() => {});
    return queued;
  };

  const moveProjectToState = (projectId, destination) => {
    const sourceIsArchive = destination === "projects";
    const source = sourceIsArchive ? archiveItemsRef.current : projectsRef.current;
    const project = source.find((item) => item.id === projectId);
    if (!project || movingProjectIdsRef.current.has(projectId)) return Promise.resolve(false);
    const sourceIndex = source.findIndex((item) => item.id === projectId);
    const nextMoving = new Set(movingProjectIdsRef.current);
    nextMoving.add(projectId);
    movingProjectIdsRef.current = nextMoving;
    setMovingProjectIds(nextMoving);
    window.clearTimeout(autosaveTimerRef.current);

    const primaryCopy = projectPrimaryCopy(project);
    const movedProject = destination === "archive"
      ? {
          ...project,
          ...primaryCopy,
          creationStatus: "completed",
          completedAt: project.completedAt || new Date().toISOString(),
          workflow: { ...(project.workflow || {}), stage: "archived", creationStatus: "completed", completedAt: project.completedAt || new Date().toISOString() },
        }
      : {
          ...project,
          creationStatus: "in_progress",
          completedAt: null,
          workflow: { ...(project.workflow || {}), stage: "creating", creationStatus: "in_progress", completedAt: null },
        };
    if (destination === "archive") {
      projectsRef.current = projectsRef.current.filter((item) => item.id !== projectId);
      archiveItemsRef.current = [movedProject, ...archiveItemsRef.current.filter((item) => item.id !== projectId)];
    } else {
      archiveItemsRef.current = archiveItemsRef.current.filter((item) => item.id !== projectId);
      projectsRef.current = [movedProject, ...projectsRef.current.filter((item) => item.id !== projectId)];
    }
    setProjects(projectsRef.current);
    setArchiveItems(archiveItemsRef.current);

    const finish = () => {
      const next = new Set(movingProjectIdsRef.current);
      next.delete(projectId);
      movingProjectIdsRef.current = next;
      setMovingProjectIds(next);
    };
    const commit = async () => {
      try {
        const endpoint = destination === "archive" ? "archive" : "restore";
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/${endpoint}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-library-session-id": storage?.sessionId || "",
            "x-library-revision": String(libraryRevisionRef.current),
          },
          body: JSON.stringify({ project: movedProject }),
        });
        const result = await response.json();
        if (!response.ok || result.error || (!result.project && !result.alreadyMoved)) throw new Error(result.error || "更新内容状态失败");
        const committed = result.project || movedProject;
        if (destination === "archive") {
          archiveItemsRef.current = archiveItemsRef.current.map((item) => item.id === projectId ? committed : item);
          setArchiveItems(archiveItemsRef.current);
        } else {
          projectsRef.current = projectsRef.current.map((item) => item.id === projectId ? committed : item);
          setProjects(projectsRef.current);
        }
        if (result.storage) setStorage(result.storage);
        if (result.revision) {
          libraryRevisionRef.current = result.revision;
          setLibraryRevision(result.revision);
        }
        const savedPayload = savedLibraryPayload(lastSavedSnapshotRef.current);
        if (savedPayload) {
          lastSavedSnapshotRef.current = stableLibrarySnapshot({
            ...savedPayload,
            projects: projectsRef.current,
            archive: archiveItemsRef.current,
          });
        }
        setSaveState("saved");
        notify(destination === "archive" ? "已完成，内容已移入归档库" : "已恢复到创作台");
        return true;
      } catch (error) {
        if (sourceIsArchive) {
          projectsRef.current = projectsRef.current.filter((item) => item.id !== projectId);
          archiveItemsRef.current = [...archiveItemsRef.current];
          archiveItemsRef.current.splice(Math.min(sourceIndex, archiveItemsRef.current.length), 0, project);
        } else {
          archiveItemsRef.current = archiveItemsRef.current.filter((item) => item.id !== projectId);
          projectsRef.current = [...projectsRef.current];
          projectsRef.current.splice(Math.min(sourceIndex, projectsRef.current.length), 0, project);
        }
        setProjects(projectsRef.current);
        setArchiveItems(archiveItemsRef.current);
        notify(`状态更新失败，已恢复原内容：${error.message || "请重试"}`);
        return false;
      } finally {
        finish();
      }
    };
    const queued = projectIndexMutationQueueRef.current.then(commit, commit);
    projectIndexMutationQueueRef.current = queued.catch(() => {});
    return queued;
  };

  const deleteArchivedProject = (projectId) => {
    if (deletingProjectIdsRef.current.has(projectId)) return Promise.resolve(false);
    const project = archiveItemsRef.current.find((item) => item.id === projectId);
    if (!project) return Promise.resolve(false);
    const index = archiveItemsRef.current.findIndex((item) => item.id === projectId);
    const nextDeleting = new Set(deletingProjectIdsRef.current);
    nextDeleting.add(projectId);
    deletingProjectIdsRef.current = nextDeleting;
    setDeletingProjectIds(nextDeleting);
    archiveItemsRef.current = archiveItemsRef.current.filter((item) => item.id !== projectId);
    setArchiveItems(archiveItemsRef.current);
    const finish = () => {
      const next = new Set(deletingProjectIdsRef.current);
      next.delete(projectId);
      deletingProjectIdsRef.current = next;
      setDeletingProjectIds(next);
    };
    const commit = async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/index`, {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
            "x-library-session-id": storage?.sessionId || "",
            "x-library-revision": String(libraryRevisionRef.current),
          },
          body: JSON.stringify({ projectPatches: [] }),
        });
        const result = await response.json();
        if (!response.ok || result.error) throw new Error(result.error || "删除索引失败");
        if (result.storage) setStorage(result.storage);
        if (result.revision) {
          libraryRevisionRef.current = result.revision;
          setLibraryRevision(result.revision);
        }
        const savedPayload = savedLibraryPayload(lastSavedSnapshotRef.current);
        if (savedPayload) lastSavedSnapshotRef.current = stableLibrarySnapshot({ ...savedPayload, archive: archiveItemsRef.current });
        setSaveState("saved");
        notify("已删除软件索引，Eagle 文件未受影响");
        return true;
      } catch (error) {
        archiveItemsRef.current = [...archiveItemsRef.current];
        archiveItemsRef.current.splice(Math.min(index, archiveItemsRef.current.length), 0, project);
        setArchiveItems(archiveItemsRef.current);
        notify(`删除失败，已恢复内容：${error.message || "删除索引失败"}`);
        return false;
      } finally {
        finish();
      }
    };
    const queued = projectIndexMutationQueueRef.current.then(commit, commit);
    projectIndexMutationQueueRef.current = queued.catch(() => {});
    return queued;
  };

  let main;
  if (!libraryLoaded) {
    main = (
      <div className="empty-state" role="status" aria-live="polite">
        <div className="empty-icon"><FolderOpen size={20} /></div>
        <h2>正在打开资料库</h2>
      </div>
    );
  } else if (!storage) {
    main = <ClosedLibraryWorkspace busy={libraryBusy} onAction={requestLibraryAction} />;
  } else if (page === "mobile-inbox") {
    main = (
      <MobileInboxPage
        storage={storage}
        libraryWritable={libraryWritable}
        onApplyLibrary={applyLibraryData}
        notify={notify}
      />
    );
  } else if (page === "creation") {
    main = (
      <CreationPage
        activeProject={creationProject}
        accountRole={editingAccountRole}
        editingExisting={Boolean(editingProject)}
        onAccountRoleChange={setEditingAccountRole}
        inspirationItems={inspirationItems}
        categories={categories}
        notify={notify}
        onQueue={queueActive}
        setSidebarOpen={setSidebarOpen}
        onCreateBlank={createBlank}
        mediaUploads={mediaUploads}
        categoryValue={categoryValue}
        renderReferenceCard={(item, handlers) => (
          <InspirationCard
            item={item}
            categories={categories}
            referenceMode
            onCategoryChange={handlers.onCategoryChange}
            onBodyChange={handlers.onBodyChange}
            onDetach={handlers.onDetach}
            notify={notify}
            sessionId={storage?.sessionId || ""}
            categoryValue={categoryValue}
            renderMediaPreview={(media) => <MediaPreview item={media} />}
            key={item.id}
          />
        )}
        onUpdateProject={updateProjectById}
        onUpdateReference={updateProjectReference}
        onUploadCovers={uploadProjectCovers}
        onUploadMedia={uploadProjectMedia}
        onRemoveMedia={removeProjectMedia}
        onRevealMedia={revealProjectMedia}
        onClearProject={clearActiveProject}
        onDiscardAndCreate={discardAndCreate}
        onQueueAndCreate={queueAndCreate}
      />
    );
  } else if (page === "queue") {
    main = (
      <QueuePage
        projects={projects}
        inspirations={inspirationItems}
        setProjects={setProjects}
        categories={categories}
        mediaUploads={mediaUploads}
        notify={notify}
        onCreateContent={createContentIndex}
        onEdit={editProject}
        onDeleteProject={deleteQueuedProject}
        onCompleteProject={(projectId) => moveProjectToState(projectId, "archive")}
        onUpdateProject={updateProjectById}
        onUploadCovers={uploadProjectCovers}
        onUploadMedia={uploadProjectMedia}
        onRemoveMedia={removeProjectMedia}
        onRevealTarget={revealProjectAsset}
        setSidebarOpen={setSidebarOpen}
        storage={storage}
      />
    );
  } else if (page === "archive") {
    main = (
      <ArchivePage
        archiveItems={archiveItems}
        categories={categories}
        categoryValue={categoryValue}
        openCategoryManager={() => setCategoryManagerOpen(true)}
        notify={notify}
        onRevealTarget={revealProjectAsset}
        onRestoreProject={(projectId) => moveProjectToState(projectId, "projects")}
        onDeleteProject={deleteArchivedProject}
        setSidebarOpen={setSidebarOpen}
        storage={storage}
      />
    );
  } else {
    main = (
      <InspirationsPage
        items={inspirationItems}
        setItems={setInspirationItems}
        categories={categories}
        linkedInspirationIds={linkedInspirationIds}
        openCategoryManager={() => setCategoryManagerOpen(true)}
        onCreate={setChoiceItem}
        notify={notify}
        setSidebarOpen={setSidebarOpen}
        storage={storage}
        authStatus={authStatus}
        onOpenAuth={openAuth}
        onRefreshAuth={refreshAuthStatus}
        onDelete={deleteInspiration}
        onIngest={ingestInspiration}
        onPatch={patchInspiration}
        deletingIds={deletingInspirationIds}
        onApplyLibrary={applyLibraryData}
        categoryValue={categoryValue}
        renderPageHeader={(props) => <PageHeader {...props} />}
        renderMediaPreview={(item) => <MediaPreview item={item} />}
      />
    );
  }

  const categoryCounts = Object.fromEntries(categories.map((category) => [
    category,
    inspirationItems.filter((item) => categoryValue(item) === category).length + projects.filter((item) => categoryValue(item) === category).length,
  ]));

  return (
    <div className="app-frame">
      <AppSidebar page={page} setPage={setPage} queueCount={projects.length} archiveCount={archiveItems.length} open={sidebarOpen} setOpen={setSidebarOpen} storage={storage} saveState={saveState} libraryBusy={libraryBusy} onLibraryAction={requestLibraryAction} />
      {sidebarOpen && <button type="button" className="sidebar-scrim" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}
      <div className="app-content">{main}</div>
      {choiceItem && <CreationChoiceModal item={choiceItem} projects={projects} onClose={() => setChoiceItem(null)} onNew={createNew} onAdd={addToExisting} notify={notify} />}
      {categoryManagerOpen && <CategoryManagerModal categories={categories} counts={categoryCounts} onAdd={(category) => {
        userCategoriesStoredRef.current = true;
        setCategories((current) => [...current, category]);
      }} onClose={() => setCategoryManagerOpen(false)} notify={notify} />}
      {libraryAction && <LibraryActionModal action={libraryAction} storage={storage} busy={libraryBusy} onClose={() => setLibraryAction(null)} onConfirm={(extra) => executeLibraryAction(libraryAction, extra)} />}
      {toast && <div className="toast" role="status"><CheckCircle2 size={17} />{toast}</div>}
    </div>
  );
}
