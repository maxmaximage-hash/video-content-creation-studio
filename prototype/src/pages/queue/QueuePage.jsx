import { useEffect, useMemo, useRef, useState } from "react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Copy,
  FolderOpen,
  GripVertical,
  ImagePlus,
  Menu,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import {
  CONTENT_ACCOUNT_VARIANTS,
  projectAccountCopy,
  projectAccountCovers,
  updateProjectAccountCopy,
} from "./content-variants.js";
import {
  coverSource,
  isCreationComplete,
  PROJECT_MEDIA_SLOTS,
  projectCoverCandidates,
  projectFinishedVideos,
  projectMediaSlotKey,
  projectMediaSlotProjection,
  projectOriginalMediaItems,
} from "../creation/project-model.js";
import {
  canStartNativeFileDrag,
  fetchProjectAssetStates,
  libraryRelativePath,
  startNativeFileDrag,
} from "../../services/project-media.js";
import { eagleMediaSource } from "../../services/eagle-media.js";
import "./queue.css";

const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/x-m4v,video/webm,.mp4,.mov,.m4v,.webm";

function QueueIconButton({ label, children, className = "", onClick, disabled = false, ...props }) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
}

function QueueHeader({ completedCount, creatingContent, onCreateContent, setSidebarOpen }) {
  return (
    <header className="page-header">
      <div className="title-row">
        <QueueIconButton label="打开导航" className="mobile-menu" onClick={() => setSidebarOpen(true)}>
          <Menu size={20} />
        </QueueIconButton>
        <div>
          <span className="eyebrow">03 / 内容沉淀</span>
          <h1>内容库</h1>
          <p>一个选题同时维护博主号与 IP 号两版内容，序号代表当前整理优先级。</p>
        </div>
      </div>
      <div className="header-actions queue-header-actions">
        <button type="button" className="primary-button queue-create-button" onClick={onCreateContent} disabled={creatingContent}>
          {creatingContent ? <RefreshCw size={16} className="spin" /> : <Plus size={16} />}
          {creatingContent ? "正在新建" : "新建内容"}
        </button>
        <span className="status-pill tone-green">{completedCount} 个创作已完成</span>
      </div>
    </header>
  );
}

function QueueCopyButton({ value, notify }) {
  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      notify("已复制到剪贴板");
    } catch {
      notify("已模拟复制");
    }
  };
  return <QueueIconButton label="复制" onClick={copy} disabled={!value}><Copy size={15} /></QueueIconButton>;
}

function QueueTitleEditor({ value, onChange, ariaLabel = "内容标题", placeholder = "输入标题" }) {
  const inputRef = useRef(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const fitHeight = () => {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    };
    let lastWidth = input.getBoundingClientRect().width;
    fitHeight();
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width || 0;
      if (Math.abs(width - lastWidth) < 1) return;
      lastWidth = width;
      fitHeight();
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [value]);

  return (
    <textarea
      ref={inputRef}
      className="queue-title-editor"
      rows={1}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function QueueImage({ src, alt = "", ...props }) {
  const [retryCount, setRetryCount] = useState(0);
  const timerRef = useRef(null);
  const localAsset = String(src || "").startsWith("/library-assets/");
  const retrySrc = retryCount && localAsset ? `${src}${src.includes("?") ? "&" : "?"}assetRetry=${retryCount}` : src;

  useEffect(() => {
    setRetryCount(0);
    return () => clearTimeout(timerRef.current);
  }, [src]);

  const retry = () => {
    if (!localAsset || retryCount >= 6) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(
      () => setRetryCount((current) => current + 1),
      Math.min(600 * (2 ** retryCount), 4000),
    );
  };

  return <img {...props} src={retrySrc} alt={alt} draggable={false} onError={retry} />;
}

function CoverPreviewModal({ cover, onClose }) {
  useEffect(() => {
    if (!cover) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [cover, onClose]);

  if (!cover) return null;
  return (
    <div className="queue-cover-lightbox" role="presentation" onMouseDown={onClose}>
      <button type="button" className="lightbox-close" aria-label="关闭封面预览" title="关闭封面预览" onClick={onClose}>
        <X size={24} strokeWidth={2.1} />
      </button>
      <div className="queue-cover-lightbox-stage" role="dialog" aria-modal="true" aria-label="封面预览" onMouseDown={(event) => event.stopPropagation()}>
        <QueueImage src={cover.src} alt={cover.alt} />
      </div>
    </div>
  );
}

function stateLabel(state) {
  return ({
    available: "可用",
    offline: "离线",
    missing: "文件缺失",
    not_added: "未上传",
  })[state] || "可用";
}

function stateForAsset(asset, states, key) {
  const relativePath = libraryRelativePath(asset);
  if (!asset) return "not_added";
  if (!relativePath) return asset.src ? "available" : "not_added";
  return states[key]?.state || "offline";
}

function isContextMenuKey(event) {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

function QueueCoverItem({
  cover,
  index,
  projectId,
  sessionId,
  state,
  actionLabel,
  onActivate,
  onOpenMenu,
  onRemove,
}) {
  const relativePath = libraryRelativePath(cover);
  const nativeDraggable = state === "available" && canStartNativeFileDrag(cover);
  const menuTarget = {
    projectId,
    relativePath,
    scope: "cover",
    label: `封面 ${index + 1}`,
    state,
  };

  return (
    <figure
      className="queue-cover-item"
      data-cover-id={cover.id}
      data-testid={`queue-cover-item-${cover.id}`}
      data-no-sort
      role="button"
      tabIndex={0}
      aria-label={actionLabel || `预览封面 ${index + 1}`}
      draggable={nativeDraggable}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => onActivate(cover)}
      onDragStart={(event) => startNativeFileDrag(event, {
        projectId,
        asset: cover,
        scope: "cover",
        sessionId,
      })}
      onContextMenu={(event) => {
        if (!relativePath) return;
        event.preventDefault();
        event.stopPropagation();
        onOpenMenu(event, true, menuTarget);
      }}
      onKeyDown={(event) => {
        if (isContextMenuKey(event) && relativePath) {
          onOpenMenu(event, false, menuTarget);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate(cover);
        }
      }}
    >
      <QueueImage src={cover.src} alt={cover.alt} />
      <button
        type="button"
        className="queue-cover-remove"
        aria-label={`删除封面 ${index + 1}`}
        title="删除封面"
        onClick={(event) => {
          event.stopPropagation();
          onRemove(cover);
        }}
      >
        <X size={16} strokeWidth={2.2} />
      </button>
      {state !== "available" && <span className={`queue-asset-state state-${state}`}>{stateLabel(state)}</span>}
    </figure>
  );
}

function CoverStack({
  project,
  accountRole,
  accountLabel,
  coverItems,
  expanded,
  states,
  sessionId,
  onToggle,
  onAdd,
  onPreview,
  onOpenMenu,
  onRemove,
  onDrop,
  uploading,
}) {
  const [fileDragActive, setFileDragActive] = useState(false);
  const dropDepthRef = useRef(0);
  const covers = (coverItems || projectCoverCandidates(project)).map((item, index) => ({
    ...item,
    id: item.id || `${project.id}-${index}`,
    src: coverSource(item),
    alt: item.alt || `${item.title || project.title || project.id} 封面`,
  }));
  return (
    <div
      className={`queue-cover-gallery ${expanded ? "queue-cover-gallery-expanded" : ""} ${fileDragActive ? "is-file-dragging" : ""}`}
      data-testid={accountRole === "blogger"
        ? `${expanded ? "expanded" : "collapsed"}-covers-${project.id}`
        : `${expanded ? "expanded" : "collapsed"}-covers-${project.id}-${accountRole}`}
      data-cover-count={covers.length}
      aria-label={`${accountLabel}封面图片区域`}
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
        event.preventDefault();
        dropDepthRef.current += 1;
        setFileDragActive(true);
      }}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer?.items || []).some((item) => item.kind === "file")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={(event) => {
        if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
        event.preventDefault();
        dropDepthRef.current = Math.max(0, dropDepthRef.current - 1);
        if (!dropDepthRef.current) setFileDragActive(false);
      }}
      onDrop={(event) => {
        const files = Array.from(event.dataTransfer?.files || []).filter((file) => file.type.startsWith("image/"));
        if (!files.length) return;
        event.preventDefault();
        event.stopPropagation();
        dropDepthRef.current = 0;
        setFileDragActive(false);
        onDrop(files);
      }}
    >
      <div
        className="expanded-cover-strip"
        onClick={(event) => {
          if (event.target === event.currentTarget) onToggle();
        }}
      >
        {!expanded && !covers.length && (
          <button type="button" className="queue-cover-empty" onClick={onAdd} disabled={uploading}>
            {uploading ? <RefreshCw size={20} className="spin" /> : <ImagePlus size={22} />}
            <span>添加封面</span>
          </button>
        )}
        {(expanded ? covers : covers.slice(0, 3)).map((cover, index) => (
          <QueueCoverItem
            cover={cover}
            index={index}
            projectId={project.id}
            sessionId={sessionId}
            state={stateForAsset(cover, states, `cover:${cover.id}`)}
            actionLabel={expanded ? `预览封面 ${index + 1}` : `展开封面 ${covers.length} 张`}
            onActivate={expanded ? onPreview : onToggle}
            onOpenMenu={onOpenMenu}
            onRemove={onRemove}
            key={cover.id}
          />
        ))}
        {expanded && (
          <button type="button" className="queue-cover-add" aria-label="添加封面" title="添加封面" data-testid={`add-cover-${project.id}`} disabled={uploading} onClick={onAdd}>
            {uploading ? <RefreshCw size={20} className="spin" /> : <Plus size={22} />}
          </button>
        )}
      </div>
      <div className="queue-cover-gallery-header" data-no-sort>
        <span>{covers.length ? `${covers.length} 张封面` : "添加封面"}</span>
      </div>
    </div>
  );
}

function QueueMediaCard({
  projectId,
  label,
  displayLabel = label,
  media,
  scope,
  state,
  sessionId,
  onOpenMenu,
  onChoose,
  onDropFiles,
  onRemove,
  legacy = false,
  uploading,
  progress,
}) {
  const videoRef = useRef(null);
  const hoverTimerRef = useRef(null);
  const hoverPreviewRef = useRef(false);
  const dropDepthRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [aspectRatio, setAspectRatio] = useState(16 / 9);
  const [fileDragActive, setFileDragActive] = useState(false);
  const relativePath = libraryRelativePath(media);
  const mediaSrc = media?.src || eagleMediaSource(media);
  const available = state === "available";
  const nativeDraggable = available && canStartNativeFileDrag(media);
  const menuTarget = { projectId, relativePath, scope, label, state };
  const orientation = aspectRatio < 0.9
    ? "is-portrait"
    : aspectRatio > 1.2 ? "is-landscape" : "is-square";

  useEffect(() => () => clearTimeout(hoverTimerRef.current), []);

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video || !available) return;
    hoverPreviewRef.current = false;
    if (video.paused) {
      video.muted = false;
      await video.play().catch(() => {});
      setPlaying(!video.paused);
    } else {
      video.pause();
      setPlaying(false);
    }
  };

  const startHoverPreview = () => {
    if (!available || playing) return;
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(async () => {
      const video = videoRef.current;
      if (!video || !video.paused) return;
      hoverPreviewRef.current = true;
      video.muted = true;
      await video.play().catch(() => {});
    }, 280);
  };

  const stopHoverPreview = () => {
    clearTimeout(hoverTimerRef.current);
    const video = videoRef.current;
    if (!video || !hoverPreviewRef.current) return;
    video.pause();
    video.currentTime = 0;
    hoverPreviewRef.current = false;
  };

  const hasDraggedFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
  const handleFileDragEnter = (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dropDepthRef.current += 1;
    setFileDragActive(true);
  };
  const handleFileDragOver = (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    if (!fileDragActive) setFileDragActive(true);
  };
  const handleFileDragLeave = (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dropDepthRef.current = Math.max(0, dropDepthRef.current - 1);
    if (!dropDepthRef.current) setFileDragActive(false);
  };
  const handleFileDrop = (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dropDepthRef.current = 0;
    setFileDragActive(false);
    if (!uploading) onDropFiles?.(Array.from(event.dataTransfer.files || []));
  };

  if (!media) {
    return (
      <button
        type="button"
        className={`queue-media-card queue-media-upload-card ${fileDragActive ? "is-file-dragging" : ""}`}
        data-no-sort
        aria-busy={uploading}
        onClick={() => {
          if (!uploading) onChoose?.();
        }}
        onDragEnter={handleFileDragEnter}
        onDragOver={handleFileDragOver}
        onDragLeave={handleFileDragLeave}
        onDrop={handleFileDrop}
      >
        {scope === "source_video" ? <Video size={20} /> : <Upload size={20} />}
        <strong>{displayLabel}</strong>
        <small>{uploading ? `上传中 ${progress}%` : fileDragActive ? "松手上传" : "点击或拖入视频"}</small>
        {fileDragActive && <span className="queue-media-drop-hint">松手添加视频</span>}
        {uploading && <span className="queue-upload-progress"><i style={{ width: `${progress}%` }} /></span>}
      </button>
    );
  }

  return (
    <article
      className={`queue-media-card state-${state} ${orientation} ${playing ? "is-playing" : ""} ${fileDragActive ? "is-file-dragging" : ""}`}
      style={{ "--queue-media-aspect": aspectRatio }}
      data-no-sort
      role="button"
      tabIndex={available ? 0 : -1}
      aria-label={`${playing ? "暂停" : "播放"}${label}`}
      draggable={nativeDraggable}
      onPointerEnter={startHoverPreview}
      onPointerLeave={stopHoverPreview}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={togglePlayback}
      onDragStart={(event) => startNativeFileDrag(event, {
        projectId,
        asset: media,
        scope,
        sessionId,
      })}
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
      onContextMenu={(event) => {
        if (!relativePath) return;
        event.preventDefault();
        event.stopPropagation();
        onOpenMenu(event, true, menuTarget);
      }}
      onKeyDown={(event) => {
        if (isContextMenuKey(event) && relativePath) {
          onOpenMenu(event, false, menuTarget);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          togglePlayback();
        }
      }}
    >
      <div className="queue-media-viewport">
        {available && mediaSrc ? (
          <video
            ref={videoRef}
            src={mediaSrc}
            preload="metadata"
            playsInline
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (video.videoWidth > 0 && video.videoHeight > 0) {
                setAspectRatio(video.videoWidth / video.videoHeight);
              }
            }}
            onPlay={() => {
              if (!hoverPreviewRef.current) setPlaying(true);
            }}
            onPause={() => {
              if (!hoverPreviewRef.current) setPlaying(false);
            }}
            onEnded={() => setPlaying(false)}
          />
        ) : (
          <span className="queue-media-state-placeholder">{stateLabel(state)}</span>
        )}
        {available && <span className="queue-media-play-indicator" aria-hidden="true">
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
        </span>}
      </div>
      <button
        type="button"
        className="queue-media-remove"
        aria-label={`永久删除${label}`}
        title={`永久删除${label}`}
        onClick={(event) => {
          event.stopPropagation();
          onRemove?.();
        }}
      >
        <X size={16} strokeWidth={2.2} />
      </button>
      {fileDragActive && <span className="queue-media-drop-hint">松手添加视频</span>}
      <div className="queue-media-info">
        <strong>{displayLabel}</strong>
        <small title={media.name}>{media.name || "未命名视频"}</small>
        <span>{legacy ? "账号未标注" : stateLabel(state)}</span>
      </div>
      {uploading && (
        <div className="queue-media-upload-overlay">
          <RefreshCw size={17} className="spin" />
          <strong>{progress}%</strong>
        </div>
      )}
    </article>
  );
}

function AccountContentColumn({
  project,
  accountRole,
  accountLabel,
  expanded,
  onToggle,
  states,
  sessionId,
  mediaProjection,
  uploads,
  notify,
  onUpdateProject,
  onAddCover,
  onDropCovers,
  onRemoveCover,
  onPreviewCover,
  onChooseMedia,
  onDropMedia,
  onRemoveMedia,
  onOpenMenu,
  uploadingCover,
}) {
  const copy = projectAccountCopy(project, accountRole);
  const covers = projectAccountCovers(project, accountRole, projectCoverCandidates(project));
  const slots = mediaProjection.slots.filter((slot) => slot.accountRole === accountRole);
  const updateCopy = (field, value) => onUpdateProject(project.id, (current) => (
    updateProjectAccountCopy(current, accountRole, { [field]: value })
  ));

  return (
    <section className={`queue-account-column ${expanded ? "is-expanded" : ""}`} data-account-role={accountRole}>
      <div className="queue-account-title-row">
        <span className="queue-account-badge">{accountLabel}</span>
        <QueueTitleEditor
          value={copy.title}
          ariaLabel={`${accountLabel}标题`}
          placeholder={`${accountLabel}标题`}
          onChange={(value) => updateCopy("title", value)}
        />
        <QueueCopyButton value={copy.title} notify={notify} />
      </div>
      <div className="queue-account-body-row">
        <textarea
          className="queue-body-editor"
          value={copy.body}
          placeholder={`${accountLabel}正文`}
          aria-label={`${accountLabel}正文`}
          onChange={(event) => updateCopy("body", event.target.value)}
        />
        <QueueCopyButton value={copy.body} notify={notify} />
      </div>
      <div className="queue-account-assets">
        <CoverStack
          project={project}
          accountRole={accountRole}
          accountLabel={accountLabel}
          coverItems={covers}
          expanded={expanded}
          states={states}
          sessionId={sessionId}
          onToggle={onToggle}
          onAdd={() => onAddCover(accountRole)}
          onPreview={onPreviewCover}
          onOpenMenu={onOpenMenu}
          onRemove={onRemoveCover}
          onDrop={(files) => onDropCovers(accountRole, files)}
          uploading={uploadingCover}
        />
        <div className="queue-account-media" aria-label={`${accountLabel}视频素材`}>
          {slots.map((slot) => {
            const upload = uploads[projectMediaSlotKey(slot.role, slot.accountRole)];
            const displayLabel = slot.role === "source_video" ? "原素材" : "成品";
            return (
              <QueueMediaCard
                projectId={project.id}
                label={slot.label}
                displayLabel={displayLabel}
                media={slot.asset}
                legacy={slot.legacy}
                scope={slot.role}
                state={slot.asset ? stateForAsset(slot.asset, states, `media:${slot.asset.id}`) : "not_added"}
                sessionId={sessionId}
                onOpenMenu={onOpenMenu}
                onChoose={() => onChooseMedia(slot.role, slot.accountRole)}
                onDropFiles={(files) => onDropMedia(slot.role, slot.accountRole, files)}
                onRemove={() => onRemoveMedia(
                  project.id,
                  slot.role,
                  slot.accountRole,
                  slot.asset?.id || "",
                  { legacyAccountRole: slot.legacy },
                )}
                uploading={Boolean(upload)}
                progress={upload?.progress || 0}
                key={slot.key}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}

function QueueCardContent({
  project,
  index,
  expandedAccount,
  onToggleAccount,
  categories,
  states,
  sessionId,
  mediaUploads,
  notify,
  onDelete,
  onUpdateProject,
  onAddCover,
  onDropCovers,
  onRemoveCover,
  onPreviewCover,
  onChooseMedia,
  onDropMedia,
  onRemoveMedia,
  onOpenMenu,
  uploadingCover,
}) {
  const completed = isCreationComplete(project);
  const mediaProjection = projectMediaSlotProjection(project);
  const uploads = mediaUploads[project.id] || {};
  const categoryOptions = project.category && !categories.includes(project.category)
    ? [project.category, ...categories]
    : categories;
  return (
    <div className="queue-card-main">
      <header className="queue-card-header">
        <strong className="queue-card-number" aria-label={`当前顺序 ${index + 1}`}>{String(index + 1).padStart(2, "0")}</strong>
        <div className="queue-card-meta">
          <span>{completed ? "已完成" : "整理中"}</span>
          <label className="queue-category-control">
            <span>分类</span>
            <select value={project.category || ""} onChange={(event) => onUpdateProject(project.id, (current) => ({
              ...current,
              category: event.target.value,
              categoryAssignedByUser: true,
              modified: "刚刚",
            }))} aria-label={`${project.title || "未命名创作"}分类`}>
              <option value="">未分类</option>
              {categoryOptions.map((category) => <option value={category} key={category}>{category}</option>)}
            </select>
          </label>
        </div>
        <button type="button" className="delete-queue-button" onClick={() => onDelete(project)}><Trash2 size={16} />删除</button>
      </header>
      <div className="queue-account-grid">
        {CONTENT_ACCOUNT_VARIANTS.map((variant) => (
          <AccountContentColumn
            key={variant.id}
            project={project}
            accountRole={variant.id}
            accountLabel={variant.label}
            expanded={expandedAccount === variant.id}
            onToggle={() => onToggleAccount(variant.id)}
            states={states}
            sessionId={sessionId}
            mediaProjection={mediaProjection}
            uploads={uploads}
            notify={notify}
            onUpdateProject={onUpdateProject}
            onAddCover={onAddCover}
            onDropCovers={onDropCovers}
            onRemoveCover={onRemoveCover}
            onPreviewCover={onPreviewCover}
            onChooseMedia={onChooseMedia}
            onDropMedia={onDropMedia}
            onRemoveMedia={onRemoveMedia}
            onOpenMenu={onOpenMenu}
            uploadingCover={uploadingCover}
          />
        ))}
      </div>
      {mediaProjection.legacyOverflow.length > 0 && (
        <div className="queue-media-legacy-grid" aria-label="历史未归位视频">
          {mediaProjection.legacyOverflow.map((media, mediaIndex) => (
            <QueueMediaCard
              projectId={project.id}
              label={media.slotConflict ? "历史视频 · 槽位冲突" : "历史视频 · 账号未标注"}
              media={media}
              legacy={media.legacyAccountRole}
              scope={media.role}
              state={stateForAsset(media, states, `media:${media.id}`)}
              sessionId={sessionId}
              onOpenMenu={onOpenMenu}
              onRemove={() => onRemoveMedia(
                project.id,
                media.role,
                media.accountRole || PROJECT_MEDIA_SLOTS.find((slot) => slot.role === media.role)?.accountRole,
                media.id || "",
                { legacyAccountRole: media.legacyAccountRole },
              )}
              key={media.id || media.relativePath || mediaIndex}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SortableQueueCard(props) {
  const { project, index, onOpenMenu } = props;
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id });

  const startCardDrag = (event) => {
    if (event.target.closest("button, a, input, select, textarea, [data-no-sort]")) return;
    listeners?.onPointerDown?.(event);
  };

  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`queue-card ${props.expandedAccount ? "queue-covers-open" : ""} ${isDragging ? "dragging" : ""}`}
      data-project-id={project.id}
      role="group"
      tabIndex={0}
      aria-label={`${project.title || "未命名创作"}，内容库项目`}
      onPointerDown={startCardDrag}
      onContextMenu={(event) => {
        if (event.target.closest("button, input, select, textarea, [data-no-sort]")) return;
        event.preventDefault();
        onOpenMenu(event, true, {
          projectId: project.id,
          relativePath: `content-units/${project.id}`,
          scope: "project",
          label: "项目目录",
          state: props.states[`project:${project.id}`]?.state || "offline",
        });
      }}
      onKeyDown={(event) => {
        if (!isContextMenuKey(event) || event.target !== event.currentTarget) return;
        onOpenMenu(event, false, {
          projectId: project.id,
          relativePath: `content-units/${project.id}`,
          scope: "project",
          label: "项目目录",
          state: props.states[`project:${project.id}`]?.state || "offline",
        });
      }}
    >
      <button
        type="button"
        className="drag-zone"
        ref={setActivatorNodeRef}
        aria-label={`拖动第 ${index + 1} 项调整顺序`}
        title="拖动排序"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={20} />
      </button>
      <QueueCardContent {...props} />
    </article>
  );
}

function QueueDragOverlay({ project, index }) {
  if (!project) return null;
  return (
    <article className="queue-card queue-card-overlay" aria-hidden="true">
      <div className="drag-zone"><GripVertical size={20} /></div>
      <div className="queue-card-main">
        <header className="queue-card-header"><strong className="queue-card-number">{String(index + 1).padStart(2, "0")}</strong></header>
        <div className="queue-account-grid">
          {CONTENT_ACCOUNT_VARIANTS.map((variant) => (
            <div className="queue-account-column" key={variant.id}>
              <div className="queue-account-title-row"><span className="queue-account-badge">{variant.label}</span><strong>{projectAccountCopy(project, variant.id).title || "未填写标题"}</strong></div>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

function QueueContextMenu({ menu, onClose, onReveal }) {
  const itemRef = useRef(null);
  useEffect(() => {
    if (!menu) return undefined;
    itemRef.current?.focus();
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
  const available = menu.target.state === "available";
  return (
    <div
      className="queue-context-menu"
      role="menu"
      aria-label={`${menu.target.label}操作`}
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        ref={itemRef}
        type="button"
        role="menuitem"
        disabled={!available}
        onClick={() => {
          onReveal(menu.target);
          onClose();
        }}
      >
        <FolderOpen size={15} />
        <span>在访达中显示</span>
        {!available && <small>{stateLabel(menu.target.state)}</small>}
      </button>
    </div>
  );
}

export function QueuePage({
  projects,
  setProjects,
  categories,
  mediaUploads,
  notify,
  onCreateContent,
  onDeleteProject,
  onUpdateProject,
  onUploadCovers,
  onUploadMedia,
  onRemoveMedia,
  onRevealTarget,
  setSidebarOpen,
  storage,
}) {
  const [expanded, setExpanded] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [creatingContent, setCreatingContent] = useState(false);
  const [newProjectId, setNewProjectId] = useState("");
  const [previewCover, setPreviewCover] = useState(null);
  const [uploadingProjectId, setUploadingProjectId] = useState(null);
  const [statusFilter, setStatusFilter] = useState("全部");
  const [assetStates, setAssetStates] = useState({});
  const [contextMenu, setContextMenu] = useState(null);
  const startingOrder = useRef([]);
  const coverInputRef = useRef(null);
  const inputCoverRoleRef = useRef("blogger");
  const mediaInputRef = useRef(null);
  const inputMediaSlotRef = useRef(null);
  const inputProjectIdRef = useRef("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    if (!newProjectId || !projects.some((project) => project.id === newProjectId)) return;
    const frame = window.requestAnimationFrame(() => {
      const input = document.querySelector(`[data-project-id="${newProjectId}"] textarea[aria-label="博主号标题"]`);
      if (!(input instanceof HTMLTextAreaElement)) return;
      input.scrollIntoView({ behavior: "smooth", block: "center" });
      input.focus({ preventScroll: true });
      input.select();
      setNewProjectId("");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [newProjectId, projects]);

  const createContent = async () => {
    if (creatingContent || !onCreateContent) return;
    setCreatingContent(true);
    try {
      const project = await onCreateContent();
      if (project?.id) {
        setStatusFilter("全部");
        setNewProjectId(project.id);
      }
    } finally {
      setCreatingContent(false);
    }
  };

  const statusSignature = useMemo(() => JSON.stringify(projects.map((project) => ({
    id: project.id,
    covers: projectCoverCandidates(project).map((cover) => libraryRelativePath(cover) || cover.eagleItemId || ""),
    media: [...projectOriginalMediaItems(project), ...projectFinishedVideos(project)].map((media) => libraryRelativePath(media) || media.eagleItemId || ""),
  }))), [projects]);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const nextStates = {};
      await Promise.all(projects.map(async (project) => {
        const assets = [
          { key: `project:${project.id}`, relativePath: `content-units/${project.id}`, scope: "project" },
          ...projectCoverCandidates(project).map((cover) => ({
            key: `cover:${cover.id}`,
            relativePath: libraryRelativePath(cover),
            eagleItemId: cover.eagleItemId || "",
            eagleFolderId: cover.eagleFolderId || "",
            scope: "cover",
          })).filter((asset) => asset.relativePath || asset.eagleItemId),
          ...[...projectOriginalMediaItems(project), ...projectFinishedVideos(project)].map((media) => ({
            key: `media:${media.id}`,
            relativePath: libraryRelativePath(media),
            eagleItemId: media.eagleItemId || "",
            eagleFolderId: media.eagleFolderId || "",
            scope: media.role === "source_video" ? "source_video" : "finished_video",
          })).filter((asset) => asset.relativePath || asset.eagleItemId),
        ];
        try {
          const result = await fetchProjectAssetStates({
            projectId: project.id,
            assets,
            sessionId: storage?.sessionId || "",
          });
          Object.assign(nextStates, result.states);
        } catch {
          for (const asset of assets) nextStates[asset.key] = { state: "offline", relativePath: asset.relativePath };
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
      x: Math.min(window.innerWidth - 210, pointerPosition ? event.clientX : rect.right - 190),
      y: Math.min(window.innerHeight - 70, pointerPosition ? event.clientY : rect.bottom + 5),
    });
  };

  const deleteProject = (project) => {
    const title = project.title || "未命名创作";
    const confirmed = window.confirm(`确定从软件中删除「${title}」吗？\n\n只会删除这条内容文档和索引，不会删除 Eagle 中的任何文件。`);
    if (!confirmed) return;
    onDeleteProject(project.id);
    setExpanded((current) => current?.startsWith(`${project.id}:`) ? null : current);
    setPreviewCover(null);
    notify("正在删除软件索引");
  };

  const chooseCovers = (projectId, accountRole) => {
    inputProjectIdRef.current = projectId;
    inputCoverRoleRef.current = accountRole;
    coverInputRef.current?.click();
  };

  const uploadCovers = async (event) => {
    const projectId = inputProjectIdRef.current;
    const accountRole = inputCoverRoleRef.current;
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!projectId || !files.length) return;
    await uploadCoverFiles(projectId, accountRole, files);
  };

  const uploadCoverFiles = async (projectId, accountRole, files) => {
    if (!projectId || !files.length) return;
    setUploadingProjectId(projectId);
    try {
      await onUploadCovers(projectId, files, accountRole);
    } finally {
      setUploadingProjectId(null);
      inputProjectIdRef.current = "";
    }
  };

  const removeCover = (projectId, cover) => {
    const confirmed = window.confirm(`确定删除「${cover.name || "这张封面"}」吗？`);
    if (!confirmed) return;
    onUpdateProject(projectId, (current) => ({
      ...current,
      removedCoverIds: [...new Set([...(current.removedCoverIds || []), cover.id])],
      modified: "刚刚",
    }));
    notify("已移除封面");
  };

  const chooseMedia = (projectId, role, accountRole) => {
    inputProjectIdRef.current = projectId;
    inputMediaSlotRef.current = { role, accountRole };
    mediaInputRef.current?.click();
  };

  const uploadMediaFiles = async (projectId, role, accountRole, fileList) => {
    const files = Array.from(fileList || []).filter((file) => (
      String(file.type || "").startsWith("video/")
      || /\.(?:mp4|mov|m4v|webm)$/i.test(file.name || "")
    ));
    if (!projectId || !files.length) {
      notify("请拖入 MP4、MOV、M4V 或 WebM 视频");
      return;
    }
    if (files.length !== Array.from(fileList || []).length) {
      notify("已忽略不是视频的文件");
    }
    if (files.length > 1) {
      notify("每个账号位置只保留一条视频，已使用第一条");
    }
    const slot = projectMediaSlotProjection(
      projects.find((project) => project.id === projectId),
    ).slots.find((item) => item.role === role && item.accountRole === accountRole);
    await onUploadMedia(projectId, role, accountRole, files[0], slot?.asset?.id || "");
  };

  const uploadMedia = async (event) => {
    const projectId = inputProjectIdRef.current;
    const slot = inputMediaSlotRef.current;
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    inputProjectIdRef.current = "";
    inputMediaSlotRef.current = null;
    if (!projectId || !slot || !files.length) return;
    await uploadMediaFiles(projectId, slot.role, slot.accountRole, files);
  };

  const reorderAcrossCenter = ({ active, over }) => {
    if (!over?.id || active.id === over.id) return;
    const activeRect = active.rect.current.translated || active.rect.current.initial;
    const overRect = over.rect;
    if (!activeRect || !overRect) return;
    const activeCenter = activeRect.top + activeRect.height / 2;
    const overCenter = overRect.top + overRect.height / 2;
    setProjects((current) => {
      const activeItem = current.find((item) => item.id === active.id);
      if (!activeItem) return current;
      const remaining = current.filter((item) => item.id !== active.id);
      const overIndex = remaining.findIndex((item) => item.id === over.id);
      if (overIndex < 0) return current;
      const insertIndex = overIndex + (activeCenter > overCenter ? 1 : 0);
      const next = [...remaining];
      next.splice(insertIndex, 0, activeItem);
      return next.every((item, index) => item.id === current[index]?.id) ? current : next;
    });
  };

  const activeProject = projects.find((project) => project.id === activeId);
  const activeIndex = activeProject ? projects.indexOf(activeProject) : 0;
  const filteredProjects = projects.filter((project) => (
    statusFilter === "全部"
    || (statusFilter === "已完成" ? isCreationComplete(project) : !isCreationComplete(project))
  ));
  const completedCount = projects.filter(isCreationComplete).length;

  return (
    <div
      className="page-shell queue-phase1"
      onPointerDownCapture={(event) => {
        if (!expanded) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest("button, a, input, select, textarea, video, [role='menu'], [role='dialog'], .queue-cover-item, .queue-media-card")) return;
        setExpanded(null);
      }}
    >
      <QueueHeader
        completedCount={completedCount}
        creatingContent={creatingContent}
        onCreateContent={createContent}
        setSidebarOpen={setSidebarOpen}
      />
      <div className="toolbar-row queue-toolbar">
        <div className="segmented-control" aria-label="创作状态筛选">
          {[
            { id: "全部", count: projects.length },
            { id: "正在创作", count: projects.length - completedCount },
            { id: "已完成", count: completedCount },
          ].map((item) => (
            <button type="button" key={item.id} className={statusFilter === item.id ? "active" : ""} onClick={() => setStatusFilter(item.id)}>{item.id} <small>{item.count}</small></button>
          ))}
        </div>
        <span className="result-count">{filteredProjects.length} 条内容索引</span>
      </div>
      <div className="queue-legend"><div><GripVertical size={16} /><span>拖动卡片调整顺序</span></div></div>

      {filteredProjects.length ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          autoScroll={{ threshold: { x: 0, y: 0.12 }, acceleration: 8, interval: 12 }}
          onDragStart={({ active }) => {
            startingOrder.current = projects.map((project) => project.id);
            setActiveId(active.id);
          }}
          onDragMove={reorderAcrossCenter}
          onDragOver={reorderAcrossCenter}
          onDragEnd={(event) => {
            reorderAcrossCenter(event);
            setActiveId(null);
            if (event.over) notify("优先级已更新");
          }}
          onDragCancel={() => {
            setProjects((current) => {
              const byId = new Map(current.map((project) => [project.id, project]));
              return startingOrder.current.map((id) => byId.get(id)).filter(Boolean);
            });
            setActiveId(null);
          }}
        >
          <SortableContext items={filteredProjects.map((project) => project.id)} strategy={verticalListSortingStrategy}>
            <section className="queue-list" aria-label="内容库项目">
              {filteredProjects.map((project) => (
                <SortableQueueCard
                  key={project.id}
                  project={project}
                  index={projects.indexOf(project)}
                  expandedAccount={expanded?.startsWith(`${project.id}:`) ? expanded.split(":")[1] : null}
                  categories={categories}
                  states={assetStates}
                  sessionId={storage?.sessionId || ""}
                  mediaUploads={mediaUploads}
                  notify={notify}
                  onToggleAccount={(accountRole) => {
                    const key = `${project.id}:${accountRole}`;
                    setExpanded((current) => current === key ? null : key);
                  }}
                  onDelete={deleteProject}
                  onUpdateProject={onUpdateProject}
                  onAddCover={(accountRole) => chooseCovers(project.id, accountRole)}
                  onDropCovers={(accountRole, files) => {
                    setExpanded(`${project.id}:${accountRole}`);
                    uploadCoverFiles(project.id, accountRole, files);
                  }}
                  onRemoveCover={(cover) => removeCover(project.id, cover)}
                  onPreviewCover={setPreviewCover}
                  onChooseMedia={(role, accountRole) => chooseMedia(project.id, role, accountRole)}
                  onDropMedia={(role, accountRole, files) => uploadMediaFiles(project.id, role, accountRole, files)}
                  onRemoveMedia={onRemoveMedia}
                  onOpenMenu={openMenu}
                  uploadingCover={uploadingProjectId === project.id}
                />
              ))}
            </section>
          </SortableContext>
          <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" }}>
            <QueueDragOverlay project={activeProject} index={activeIndex} />
          </DragOverlay>
        </DndContext>
      ) : (
        <div className="empty-state">
          <div className="empty-icon"><Plus size={20} /></div>
          <h2>{projects.length ? "这个状态下没有内容" : "内容库为空"}</h2>
          <p>{projects.length ? "切换上方状态查看其他内容。" : "从灵感卡片点“创作”，保存后会进入这里沉淀和整理。"}</p>
          {!projects.length && (
            <button type="button" className="primary-button queue-empty-create" onClick={createContent} disabled={creatingContent}>
              {creatingContent ? <RefreshCw size={16} className="spin" /> : <Plus size={16} />}
              {creatingContent ? "正在新建" : "新建第一条内容"}
            </button>
          )}
        </div>
      )}

      <input ref={coverInputRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple aria-label="选择内容库封面图片" onChange={uploadCovers} />
      <input ref={mediaInputRef} className="sr-only" type="file" accept={VIDEO_ACCEPT} aria-label="选择内容库视频素材" onChange={uploadMedia} />
      <CoverPreviewModal cover={previewCover} onClose={() => setPreviewCover(null)} />
      <QueueContextMenu
        menu={contextMenu}
        onClose={() => setContextMenu(null)}
        onReveal={(target) => onRevealTarget(target.projectId, target)}
      />
    </div>
  );
}
