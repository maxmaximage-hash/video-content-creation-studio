import { useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  FileVideo2,
  FolderOpen,
  Image as ImageIcon,
  Menu,
  MoreHorizontal,
  Tags,
} from "lucide-react";
import {
  coverSource,
  projectCoverCandidates,
  projectMediaAssets,
  projectMediaSlotProjection,
} from "../creation/project-model.js";
import {
  fetchProjectAssetStates,
  libraryRelativePath,
} from "../../services/project-media.js";
import "./archive.css";

const CONTENT_ID_PATTERN = /^[IC]\d{6,}$/;
const ASSET_STATES = new Set(["available", "offline", "missing", "not_added"]);

function normalizedMediaRole(role = "") {
  return ({
    final: "finished_video",
    refined: "finished_video",
    refined_video: "finished_video",
    finished: "finished_video",
  })[role] || role;
}

function encodedLibraryAssetPath(relativePath = "") {
  return `/library-assets/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

function normalizedVideo(asset, index) {
  const relativePath = libraryRelativePath(asset);
  return {
    ...asset,
    id: asset?.id || `finished-video-${index + 1}`,
    role: "finished_video",
    order: Number(asset?.order) || Number(asset?.version) || index + 1,
    relativePath,
    src: asset?.src || asset?.localPath || (relativePath ? encodedLibraryAssetPath(relativePath) : ""),
  };
}

export function canonicalReferenceContentIds(item = {}) {
  const candidates = [
    ...(Array.isArray(item.relationships?.referenceContentIds)
      ? item.relationships.referenceContentIds
      : []),
    ...(Array.isArray(item.references) ? item.references : []),
  ];
  return Array.from(new Set(candidates
    .map((reference) => (typeof reference === "string" ? reference : reference?.id))
    .map((id) => String(id || "").trim())
    .filter((id) => CONTENT_ID_PATTERN.test(id))));
}

export function archiveFinishedVideos(item = {}) {
  const projection = projectMediaSlotProjection(item);
  const selected = [
    ...projection.slots
      .filter((slot) => slot.role === "finished_video" && slot.asset)
      .map((slot) => ({ ...slot.asset, legacyAccountRole: slot.legacy })),
    ...projection.legacyOverflow.filter((asset) => asset.role === "finished_video"),
  ];
  const seen = new Set();
  return selected
    .map(normalizedVideo)
    .filter((video) => {
      const key = video.id || video.relativePath || video.src;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.order - right.order);
}

function archiveMediaAssets(project) {
  const current = Array.isArray(project?.mediaAssets)
    ? project.mediaAssets
    : projectMediaAssets(project);
  const nonFinished = current.filter((asset) => normalizedMediaRole(asset?.role) !== "finished_video");
  return [...nonFinished, ...archiveFinishedVideos(project)];
}

export function createArchiveSnapshot(project, publishedAt) {
  const finishedVideos = archiveFinishedVideos(project);
  const referenceContentIds = canonicalReferenceContentIds(project);
  const primaryCover = projectCoverCandidates(project)[0] || null;
  const coverFallback = primaryCover || project;
  const snapshotCovers = projectCoverCandidates(project).map((item) => ({
    id: item.id,
    src: coverSource(item),
    relativePath: item.relativePath || "",
    name: item.name || "",
    coverKind: item.coverKind,
  }));

  return {
    id: project.id,
    platform: coverFallback.platform
      || (typeof project.references?.[0] === "object" ? project.references[0]?.platform : "")
      || "本地创作",
    title: project.title || "未命名创作",
    body: project.body || "尚未填写正文",
    coverUrl: coverFallback.coverUrl || "",
    coverLocalPath: coverSource(coverFallback),
    videoUrl: coverFallback.videoUrl || "",
    videoPreviewUrl: coverFallback.videoPreviewUrl || "",
    videoLocalPath: finishedVideos[0]?.src || coverFallback.videoLocalPath || "",
    unitSchemaVersion: 1,
    origin: project.origin || "original",
    mediaAssets: archiveMediaAssets(project),
    creationStatus: project.creationStatus || "in_progress",
    completedAt: project.completedAt || null,
    workflow: {
      ...(project.workflow || {}),
      stage: "published",
      creationStatus: project.creationStatus || "in_progress",
      completedAt: project.completedAt || null,
    },
    source: project.source || {
      platform: "",
      originalUrl: "",
      accountName: "",
      publishedAt: "",
    },
    metricsSnapshots: project.metricsSnapshots || [],
    covers: snapshotCovers,
    publishedAt,
    matched: false,
    path: null,
    relationships: {
      ...(project.relationships || {}),
      referenceContentIds,
    },
    references: referenceContentIds,
    referenceCount: referenceContentIds.length,
    category: project.category,
    categoryAssignedByUser: project.categoryAssignedByUser,
  };
}

function stateLabel(state) {
  return ({
    available: "可用",
    offline: "离线",
    missing: "文件缺失",
    not_added: "未上传",
  })[state] || "离线";
}

function stateForVideo(video, states, key) {
  const explicitState = video?.assetState || video?.availability || video?.state;
  if (ASSET_STATES.has(explicitState)) return explicitState;
  if (!video) return "not_added";
  if (!libraryRelativePath(video)) return video.src ? "available" : "not_added";
  return states[key]?.state || "offline";
}

function isRevealableFinishedVideo(projectId, video) {
  const relativePath = libraryRelativePath(video);
  if (!relativePath || !CONTENT_ID_PATTERN.test(String(projectId || ""))) return false;
  const unitRoot = `content-units/${projectId}`;
  return (
    relativePath.startsWith(`${unitRoot}/media/finished-video/`)
    || relativePath.startsWith(`${unitRoot}/media/refined-video/`)
    || relativePath.startsWith(`${unitRoot}/final/`)
    || relativePath.startsWith(`assets/projects/${projectId}/`)
  );
}

function videoStateKey(item, video, index) {
  return `archive:${item.id}:finished:${video.id || index + 1}`;
}

function ArchiveIconButton({ label, children, className = "", onClick, disabled = false }) {
  return (
    <button
      type="button"
      className={`archive-icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function ArchiveCopyButton({ label, value, successMessage, notify }) {
  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      notify(successMessage);
    } catch {
      notify("复制失败，请重试");
    }
  };
  return (
    <button type="button" className="archive-copy-button" onClick={copy} disabled={!value}>
      <Copy size={14} />
      {label}
    </button>
  );
}

function ArchiveImage({ src, alt = "" }) {
  const [retryCount, setRetryCount] = useState(0);
  const retryTimerRef = useRef(null);
  const localAsset = String(src || "").startsWith("/library-assets/");
  const retrySrc = retryCount && localAsset
    ? `${src}${src.includes("?") ? "&" : "?"}assetRetry=${retryCount}`
    : src;

  useEffect(() => {
    setRetryCount(0);
    return () => clearTimeout(retryTimerRef.current);
  }, [src]);

  const retry = () => {
    if (!localAsset || retryCount >= 6) return;
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = setTimeout(
      () => setRetryCount((current) => current + 1),
      Math.min(600 * (2 ** retryCount), 4000),
    );
  };

  return <img src={retrySrc} alt={alt} draggable={false} onError={retry} data-asset-retry={retryCount} />;
}

function ArchiveVideoCard({
  item,
  video,
  index,
  state,
  onOpenMenu,
}) {
  const label = video.legacyAccountRole || !video.accountRole
    ? `成品视频 · 账号未标注 ${index + 1}`
    : `成品视频 · ${video.accountRole === "ip" ? "IP 号" : "博主号"}`;
  const source = video.src || (video.relativePath ? encodedLibraryAssetPath(video.relativePath) : "");
  const revealable = isRevealableFinishedVideo(item.id, video) && state === "available";
  const menuTarget = {
    projectId: item.id,
    relativePath: libraryRelativePath(video),
    scope: "finished_video",
    state,
    revealable,
    label,
  };

  return (
    <figure
      className={`archive-video state-${state}`}
      data-video-order={video.order}
      onContextMenu={(event) => onOpenMenu(event, true, menuTarget)}
    >
      {source ? (
        <video
          src={source}
          controls
          preload="auto"
          playsInline
          aria-label={`${label}：${video.name || "未命名视频"}`}
          onLoadedData={(event) => {
            if (event.currentTarget.currentTime === 0) event.currentTarget.currentTime = 0.001;
          }}
        />
      ) : (
        <div className="archive-video-unavailable"><FileVideo2 size={28} /></div>
      )}
      <span className={`archive-asset-state state-${state}`}>{stateLabel(state)}</span>
      <ArchiveIconButton
        label={`更多操作：${label}`}
        className="archive-video-menu-button"
        onClick={(event) => onOpenMenu(event, false, menuTarget)}
      >
        <MoreHorizontal size={17} />
      </ArchiveIconButton>
      <figcaption>
        <strong>{label}</strong>
        <span>{video.name || "未命名视频"}</span>
      </figcaption>
      {!revealable && (
        <span className="archive-reveal-note">
          {isRevealableFinishedVideo(item.id, video) ? stateLabel(state) : "无托管路径"}
        </span>
      )}
    </figure>
  );
}

function ArchiveFallback({ item }) {
  const cover = projectCoverCandidates(item)[0] || null;
  const source = coverSource(cover || item);
  return (
    <div className="archive-fallback" data-asset-state="not_added">
      {source ? <ArchiveImage src={source} alt="" /> : <ImageIcon size={30} />}
      <div>
        <span className="archive-asset-state state-not_added">未上传</span>
        <strong>未添加成品视频</strong>
        <small>发布快照已保留，可稍后补充媒体。</small>
      </div>
    </div>
  );
}

function ArchiveCard({
  item,
  categoryLabel,
  assetStates,
  notify,
  onOpenMenu,
}) {
  const videos = archiveFinishedVideos(item);
  const referenceCount = Number(item.referenceCount)
    || canonicalReferenceContentIds(item).length;
  return (
    <article className="archive-record" data-archive-id={item.id}>
      <div className="archive-record-meta">
        <div>
          <span className="archive-published-state">已发布</span>
          <span>{categoryLabel(item)}</span>
          <span>{videos.length} 条成品视频</span>
        </div>
        <time>{item.publishedAt}</time>
      </div>

      {videos.length ? (
        <div className="archive-video-grid" aria-label={`${item.title}的成品视频`}>
          {videos.map((video, index) => {
            const key = videoStateKey(item, video, index);
            return (
              <ArchiveVideoCard
                item={item}
                video={video}
                index={index}
                state={stateForVideo(video, assetStates, key)}
                onOpenMenu={onOpenMenu}
                key={`${video.id}-${video.order}-${index}`}
              />
            );
          })}
        </div>
      ) : <ArchiveFallback item={item} />}

      <div className="archive-copy">
        <div className="archive-copy-heading">
          <span>{item.id}</span>
          <span>{referenceCount} 条关联灵感</span>
        </div>
        <div className="archive-copy-field archive-title-field">
          <h2>{item.title || "未命名创作"}</h2>
          <ArchiveCopyButton
            label="复制标题"
            value={item.title || ""}
            successMessage="标题已复制"
            notify={notify}
          />
        </div>
        <div className="archive-copy-field archive-body-field">
          <p>{item.body || "尚未填写正文"}</p>
          <ArchiveCopyButton
            label="复制全文"
            value={item.body || ""}
            successMessage="全文已复制"
            notify={notify}
          />
        </div>
      </div>
    </article>
  );
}

function ArchiveContextMenu({ menu, onClose, onReveal }) {
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menu) return undefined;
    menuRef.current?.focus();
    const close = () => onClose();
    const keydown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", keydown);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  return (
    <div
      ref={menuRef}
      className="archive-context-menu"
      role="menu"
      aria-label={`${menu.target.label}操作`}
      tabIndex={-1}
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        disabled={!menu.target.revealable}
        onClick={() => {
          onReveal(menu.target);
          onClose();
        }}
      >
        <FolderOpen size={15} />
        <span>在访达中显示</span>
        {!menu.target.revealable && (
          <small>
            {isRevealableFinishedVideo(menu.target.projectId, menu.target)
              ? stateLabel(menu.target.state)
              : "无托管路径"}
          </small>
        )}
      </button>
    </div>
  );
}

function ArchiveHeader({ setSidebarOpen }) {
  return (
    <header className="page-header">
      <div className="title-row">
        <ArchiveIconButton label="打开导航" className="mobile-menu" onClick={() => setSidebarOpen(true)}>
          <Menu size={20} />
        </ArchiveIconButton>
        <div>
          <span className="eyebrow">04 / 发布归档</span>
          <h1>归档</h1>
          <p>发布快照立即保留；成品视频与后续归档匹配保持独立。</p>
        </div>
      </div>
    </header>
  );
}

export function ArchivePage({
  archiveItems,
  categories,
  categoryValue,
  openCategoryManager,
  notify,
  onRevealTarget,
  setSidebarOpen,
  storage,
}) {
  const [filter, setFilter] = useState("全部");
  const [category, setCategory] = useState("全部分类");
  const [assetStates, setAssetStates] = useState({});
  const [contextMenu, setContextMenu] = useState(null);

  const categoryLabel = (item) => categoryValue(item) || "未分类";
  const statusSignature = useMemo(() => JSON.stringify(archiveItems.map((item) => ({
    id: item.id,
    videos: archiveFinishedVideos(item).map((video) => ({
      id: video.id,
      order: video.order,
      relativePath: libraryRelativePath(video),
    })),
  }))), [archiveItems]);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const nextStates = {};
      await Promise.all(archiveItems.map(async (item) => {
        const assets = archiveFinishedVideos(item).map((video, index) => ({
          key: videoStateKey(item, video, index),
          relativePath: libraryRelativePath(video),
          scope: "finished_video",
        })).filter((asset) => isRevealableFinishedVideo(item.id, asset));
        if (!assets.length) return;
        try {
          const result = await fetchProjectAssetStates({
            projectId: item.id,
            assets,
            sessionId: storage?.sessionId || "",
          });
          Object.assign(nextStates, result.states);
        } catch {
          for (const asset of assets) {
            nextStates[asset.key] = {
              state: "offline",
              relativePath: asset.relativePath,
            };
          }
        }
      }));
      if (!cancelled) setAssetStates(nextStates);
    };
    check();
    return () => {
      cancelled = true;
    };
  }, [statusSignature, storage?.sessionId]);

  const openMenu = (event, pointerPosition, target) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenu({
      target,
      x: Math.max(8, Math.min(window.innerWidth - 218, pointerPosition ? event.clientX : rect.right - 198)),
      y: Math.max(8, Math.min(window.innerHeight - 76, pointerPosition ? event.clientY : rect.bottom + 5)),
    });
  };

  const filtered = archiveItems.filter((item) => {
    const videoCount = archiveFinishedVideos(item).length;
    const matchesVideo = filter === "全部"
      || (filter === "有成品" ? videoCount > 0 : videoCount === 0);
    const value = categoryValue(item);
    const matchesCategory = category === "全部分类"
      || (category === "未分类" ? !value : value === category);
    return matchesVideo && matchesCategory;
  });
  const uncategorizedCount = archiveItems.filter((item) => !categoryValue(item)).length;
  const categoryCounts = Object.fromEntries(categories.map((item) => [
    item,
    archiveItems.filter((record) => categoryValue(record) === item).length,
  ]));

  return (
    <div className="page-shell archive-phase1">
      <ArchiveHeader setSidebarOpen={setSidebarOpen} />

      <div className="toolbar-row archive-toolbar">
        <div className="segmented-control" aria-label="归档媒体筛选">
          {[
            { id: "全部", count: archiveItems.length },
            { id: "有成品", count: archiveItems.filter((item) => archiveFinishedVideos(item).length).length },
            { id: "待补成品", count: archiveItems.filter((item) => !archiveFinishedVideos(item).length).length },
          ].map((item) => (
            <button
              type="button"
              className={filter === item.id ? "active" : ""}
              onClick={() => setFilter(item.id)}
              key={item.id}
            >
              {item.id} <small>{item.count}</small>
            </button>
          ))}
        </div>
        <span className="result-count">{filtered.length} 条发布记录</span>
      </div>

      <div className="category-strip" aria-label="归档分类筛选">
        <button type="button" className={category === "全部分类" ? "active" : ""} onClick={() => setCategory("全部分类")}>全部分类 <small>{archiveItems.length}</small></button>
        <button type="button" className={category === "未分类" ? "active" : ""} onClick={() => setCategory("未分类")}>未分类 <small>{uncategorizedCount}</small></button>
        {categories.map((item) => (
          <button type="button" className={category === item ? "active" : ""} onClick={() => setCategory(item)} key={item}>{item} <small>{categoryCounts[item] || 0}</small></button>
        ))}
        <button type="button" className="category-add-button" onClick={openCategoryManager}><Tags size={14} />新增分类</button>
      </div>

      {filtered.length ? (
        <section className="archive-grid" aria-label="发布归档">
          {filtered.map((item) => (
            <ArchiveCard
              item={item}
              categoryLabel={categoryLabel}
              assetStates={assetStates}
              notify={notify}
              onOpenMenu={openMenu}
              key={item.id}
            />
          ))}
        </section>
      ) : (
        <section className="archive-empty">
          <FileVideo2 size={28} />
          <h2>归档为空</h2>
          <p>发布后的内容会立即在这里保留快照。</p>
        </section>
      )}

      <ArchiveContextMenu
        menu={contextMenu}
        onClose={() => setContextMenu(null)}
        onReveal={(target) => onRevealTarget(target.projectId, {
          relativePath: target.relativePath,
          scope: target.scope,
        })}
      />
    </div>
  );
}
