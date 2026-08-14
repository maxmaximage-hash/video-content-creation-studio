import { useEffect, useRef, useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CheckCircle2,
  Copy,
  FileVideo2,
  FolderOpen,
  Inbox,
  Menu,
  Plus,
  RefreshCw,
  Search,
  Tags,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import {
  coverSource,
  hasProjectContent,
  isCreationComplete,
  PROJECT_MEDIA_SLOTS,
  projectCoverCandidates,
  projectMediaSlotKey,
  projectMediaSlotProjection,
} from "./project-model.js";
import {
  CONTENT_ACCOUNT_VARIANTS,
  projectAccountCopy,
  projectAccountCovers,
  updateProjectAccountCopy,
} from "../queue/content-variants.js";
import { eagleMediaSource } from "../../services/eagle-media.js";
import "./creation.css";

const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/x-m4v,video/webm,.mp4,.mov,.m4v,.webm";

function CreationIconButton({ label, children, className = "", onClick, disabled = false }) {
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

function CreationHeader({ eyebrow, description, actions, setSidebarOpen }) {
  return (
    <header className="page-header">
      <div className="title-row">
        <CreationIconButton label="打开导航" className="mobile-menu" onClick={() => setSidebarOpen(true)}>
          <Menu size={20} />
        </CreationIconButton>
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h1>编辑</h1>
          <p>{description}</p>
        </div>
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}

function CreationModal({ title, description, children, onClose }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal creation-action-modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <CreationIconButton label="关闭" onClick={onClose}><X size={18} /></CreationIconButton>
        </div>
        {children}
      </section>
    </div>
  );
}

function CreationCopyButton({ value, notify }) {
  const copy = async () => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    notify("已复制");
  };
  return <CreationIconButton label="复制" onClick={copy} disabled={!value}><Copy size={15} /></CreationIconButton>;
}

function CreationImage({ src, alt = "", ...props }) {
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
    if (!isLocalLibraryAsset || retryCount >= 6) return;
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = setTimeout(
      () => setRetryCount((current) => current + 1),
      Math.min(600 * (2 ** retryCount), 4000),
    );
  };

  return <img {...props} src={retrySrc} alt={alt} data-asset-retry={retryCount} onError={retryOnError} />;
}

function ProjectMediaSlot({
  role,
  title,
  description,
  media,
  legacy = false,
  uploading,
  progress,
  onChoose,
  onDropFile,
  onRemove,
  onReveal,
}) {
  const [fileDragActive, setFileDragActive] = useState(false);
  const dropDepthRef = useRef(0);
  const mediaSrc = media?.src || eagleMediaSource(media);
  const nativeDraggable = Boolean(media?.relativePath && window.videoContentDesktop?.startFileDrag);
  const startNativeFileDrag = (event) => {
    if (!nativeDraggable) return;
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("text/plain", media.name || "");
    window.videoContentDesktop.startFileDrag(media.relativePath);
  };
  const bytes = Number(media?.size);
  const size = !Number.isFinite(bytes) || bytes <= 0
    ? ""
    : bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : bytes < 1024 * 1024 * 1024
        ? `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
        : `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  const hasDraggedFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
  const completeDrop = (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dropDepthRef.current = 0;
    setFileDragActive(false);
    const file = Array.from(event.dataTransfer.files || []).find((item) => (
      String(item.type || "").startsWith("video/")
      || /\.(?:mp4|mov|m4v|webm)$/i.test(item.name || "")
    ));
    if (file && !uploading) onDropFile?.(file);
  };
  return (
    <div
      className={`project-media-slot ${mediaSrc ? "has-media" : ""} ${fileDragActive ? "is-file-dragging" : ""}`}
      data-no-sort
      onDragEnter={(event) => {
        if (!hasDraggedFiles(event)) return;
        event.preventDefault();
        dropDepthRef.current += 1;
        setFileDragActive(true);
      }}
      onDragOver={(event) => {
        if (!hasDraggedFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!hasDraggedFiles(event)) return;
        event.preventDefault();
        dropDepthRef.current = Math.max(0, dropDepthRef.current - 1);
        if (!dropDepthRef.current) setFileDragActive(false);
      }}
      onDrop={completeDrop}
    >
      <div className="project-media-slot-heading">
        <span className="project-media-slot-icon">{role === "source_video" ? <Video size={18} /> : <FileVideo2 size={18} />}</span>
        <div><strong>{title}</strong><small>{legacy ? "历史素材 · 账号未标注" : description}</small></div>
      </div>
      {mediaSrc ? (
        <>
          <video
            key={mediaSrc}
            src={mediaSrc}
            controls
            preload="metadata"
            playsInline
            draggable={nativeDraggable}
            title={nativeDraggable ? "拖到剪映" : ""}
            onDragStart={startNativeFileDrag}
          />
          <div className="project-media-file">
            <div><strong title={media.name}>{media.name}</strong><span>{size}</span></div>
            {media?.relativePath && <button type="button" className="quiet-button" onClick={onReveal}><FolderOpen size={14} />访达</button>}
            {onChoose && <button type="button" className="quiet-button" onClick={onChoose}><RefreshCw size={14} />替换</button>}
            <CreationIconButton label={`永久删除${title}`} onClick={onRemove}><X size={15} /></CreationIconButton>
          </div>
        </>
      ) : (
        <button type="button" className="project-media-upload" onClick={onChoose} disabled={uploading}>
          <Upload size={22} />
          <span>{fileDragActive ? "松手上传" : `上传${title}`}</span>
        </button>
      )}
      {fileDragActive && <span className="project-media-drop-hint">松手上传到此位置</span>}
      {uploading && (
        <div className="project-media-progress" aria-live="polite">
          <RefreshCw size={18} className="spin" />
          <strong>上传中 {progress}%</strong>
          <span><i style={{ width: `${progress}%` }} /></span>
        </div>
      )}
    </div>
  );
}

function SortableCreationCover({ cover, index, onKeyboardMove, onRemove, onPreview }) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: cover.id });
  const { onKeyDown: activateWithKeyboard, ...otherListeners } = listeners || {};
  return (
    <div
      ref={setNodeRef}
      className={`cover-option ${isDragging ? "cover-dragging" : ""}`}
      data-cover-id={cover.id}
      data-testid={`creation-cover-${cover.id}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="cover-select-button"
        aria-label={`放大封面 ${index + 1}`}
        title="拖动排序，点击查看大图"
        onClick={(event) => {
          if (isDragging) {
            event.preventDefault();
            return;
          }
          onPreview(cover, index);
        }}
        onKeyDown={(event) => {
          activateWithKeyboard?.(event);
          const direction = {
            ArrowDown: 1,
            ArrowRight: 1,
            ArrowUp: -1,
            ArrowLeft: -1,
          }[event.code];
          if (!isDragging || !direction) return;
          event.preventDefault();
          event.stopPropagation();
          onKeyboardMove(cover.id, direction);
        }}
        {...attributes}
        {...otherListeners}
      >
        <CreationImage src={coverSource(cover)} alt="" draggable={false} />
      </button>
      <CreationIconButton label={`移除封面 ${cover.name || cover.id}`} className="cover-remove-button" onClick={() => onRemove(cover.id)}>
        <X size={15} />
      </CreationIconButton>
    </div>
  );
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
        <CreationImage src={cover.src} alt={cover.alt} />
      </div>
    </div>
  );
}

function InspirationPickerModal({ inspirations, selectedIds, categories, categoryValue, onPick, onClose }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("全部分类");
  const available = inspirations.filter((item) => !selectedIds.has(item.id));
  const categoryLabel = (item) => categoryValue(item) || "未分类";
  const pickerCategories = [...categories, ...available
    .map((item) => categoryValue(item))
    .filter((item, index, values) => item && !categories.includes(item) && values.indexOf(item) === index)];
  const categoryCounts = available.reduce((counts, item) => {
    const label = categoryLabel(item);
    counts[label] = (counts[label] || 0) + 1;
    return counts;
  }, {});
  const filtered = available.filter((item) => (
    (category === "全部分类" || categoryLabel(item) === category)
    && `${item.title}${item.body}${item.author}${item.originalUrl}`.toLowerCase().includes(search.toLowerCase())
  ));

  return (
    <CreationModal title="添加灵感参考" description="从当前灵感库选择一条加入这个创作。" onClose={onClose}>
      <div className="inspiration-picker">
        <div className="search-box inspiration-picker-search">
          <Search size={16} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、正文、作者或链接" autoFocus />
        </div>
        <div className="category-strip inspiration-picker-categories" aria-label="灵感参考分类筛选">
          <button type="button" className={category === "全部分类" ? "active" : ""} onClick={() => setCategory("全部分类")}>全部分类 <small>{available.length}</small></button>
          <button type="button" className={category === "未分类" ? "active" : ""} onClick={() => setCategory("未分类")}>未分类 <small>{categoryCounts["未分类"] || 0}</small></button>
          {pickerCategories.map((item) => (
            <button type="button" className={category === item ? "active" : ""} onClick={() => setCategory(item)} key={item}>{item} <small>{categoryCounts[item] || 0}</small></button>
          ))}
        </div>
        {filtered.length ? (
          <div className="inspiration-picker-list">
            {filtered.map((item) => (
              <button type="button" className="inspiration-picker-item" key={item.id} onClick={() => onPick(item)}>
                {coverSource(item) ? <CreationImage src={coverSource(item)} alt="" /> : <span className="creation-picker-placeholder" />}
                <div>
                  <strong>{item.title || item.body || "未命名灵感"}</strong>
                  <span>{[item.platform, item.author ? `@${item.author.replace(/^@/, "")}` : "", categoryLabel(item)].filter(Boolean).join(" · ")}</span>
                </div>
                <Plus size={18} />
              </button>
            ))}
          </div>
        ) : (
          <p className="muted-line picker-empty">{available.length ? "没有匹配的灵感。" : "灵感库里没有可添加的新灵感。"}</p>
        )}
      </div>
    </CreationModal>
  );
}

function ClearProjectModal({ onClose, onConfirm }) {
  return (
    <CreationModal
      title="清空当前画板？"
      description="这会彻底删除当前草稿、文字、封面、原素材、成品视频及资料库中的对应文件，无法恢复。"
      onClose={onClose}
    >
      <div className="creation-dialog-summary">
        <Trash2 size={20} />
        <p>当前 content-id 不会保留；删除完成后会创建一个全新空画板。</p>
      </div>
      <div className="modal-footer">
        <button type="button" className="quiet-button" onClick={onClose}>取消</button>
        <button type="button" className="delete-queue-button" onClick={onConfirm}><Trash2 size={16} />确认清空</button>
      </div>
    </CreationModal>
  );
}

function NewProjectModal({ onClose, onDiscard, onQueue }) {
  return (
    <CreationModal
      title="新建创作"
      description="当前画板已有内容。先处理这份草稿，再打开全新的空画板。"
      onClose={onClose}
    >
      <div className="creation-new-actions">
        <button type="button" className="creation-choice-danger" onClick={onDiscard}>
          <span><Trash2 size={18} /></span>
          <div><strong>删除 / 放弃当前草稿</strong><p>彻底删除这个 content-id 及其全部真实文件，然后打开新画板。</p></div>
        </button>
        <button type="button" onClick={onQueue}>
          <span><Inbox size={18} /></span>
          <div><strong>保存到创作台</strong><p>完整保留当前标题、正文、分类、封面、参考和视频素材。</p></div>
        </button>
      </div>
      <div className="modal-footer">
        <button type="button" className="quiet-button" onClick={onClose}>取消</button>
      </div>
    </CreationModal>
  );
}

export function CreationPage({
  activeProject,
  accountRole = "blogger",
  editingExisting = false,
  onAccountRoleChange,
  inspirationItems,
  categories,
  notify,
  setSidebarOpen,
  mediaUploads,
  categoryValue,
  renderReferenceCard,
  onCreateBlank,
  onUpdateProject,
  onUpdateReference,
  onUploadCovers,
  onUploadMedia,
  onRemoveMedia,
  onRevealMedia,
  onClearProject,
  onDiscardAndCreate,
  onQueueAndCreate,
  onQueue,
}) {
  const project = activeProject;
  const coverInputRef = useRef(null);
  const mediaInputRef = useRef(null);
  const selectedMediaSlotRef = useRef(null);
  const coverDragDepthRef = useRef(0);
  const keyboardReorderHandledRef = useRef(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [coverDragActive, setCoverDragActive] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewCover, setPreviewCover] = useState(null);
  const [dialog, setDialog] = useState("");
  const coverSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (!project) {
    return (
      <div className="page-shell">
        <CreationHeader
          eyebrow="02 / 正在创作"
          description="可以从灵感库开始，也可以直接创建一个空白内容。"
          setSidebarOpen={setSidebarOpen}
        />
        <div className="empty-state">
          <div className="empty-icon"><Plus size={20} /></div>
          <h2>还没有正在编辑的内容</h2>
          <p>可以从灵感库开始，也可以直接创建一个空白内容。</p>
          <button type="button" className="primary-button" onClick={onCreateBlank}><Plus size={16} />新建空白创作</button>
        </div>
      </div>
    );
  }

  const projectUploads = mediaUploads[project.id] || {};
  const selectedAccount = CONTENT_ACCOUNT_VARIANTS.find((item) => item.id === accountRole)
    || CONTENT_ACCOUNT_VARIANTS[0];
  const selectedAccountRole = selectedAccount.id;
  const accountCopy = projectAccountCopy(project, selectedAccountRole);
  const coverCandidates = projectAccountCovers(
    project,
    selectedAccountRole,
    projectCoverCandidates(project),
  );
  const mediaProjection = projectMediaSlotProjection(project);
  const accountMediaSlots = mediaProjection.slots.filter((slot) => slot.accountRole === selectedAccountRole);
  const accountLegacyMedia = mediaProjection.legacyOverflow.filter((media) => (
    media.accountRole === selectedAccountRole
    || (selectedAccountRole === "blogger" && media.legacyAccountRole)
  ));
  const creationComplete = isCreationComplete(project);
  const selectedReferenceIds = new Set(project.references?.map((item) => item.id) || []);
  const hasContent = hasProjectContent(project, projectUploads);
  const accountMaterialCount = [
    accountCopy.title.trim(),
    accountCopy.body.trim(),
    coverCandidates.length,
    ...accountMediaSlots.map((slot) => slot.asset),
  ].filter(Boolean).length;
  const update = (field, value) => onUpdateProject(project.id, (current) => (
    updateProjectAccountCopy(current, selectedAccountRole, { [field]: value })
  ));

  const uploadCoverFiles = async (fileList) => {
    const files = Array.from(fileList || []).filter((file) => (
      ["image/jpeg", "image/png", "image/webp"].includes(file.type)
      || /\.(?:jpe?g|png|webp)$/i.test(file.name)
    ));
    if (!files.length) return;
    setUploadingCover(true);
    try {
      await onUploadCovers(project.id, files, selectedAccountRole);
    } finally {
      setUploadingCover(false);
    }
  };
  const hasDraggedFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
  const completeCoverDrop = (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    coverDragDepthRef.current = 0;
    setCoverDragActive(false);
    uploadCoverFiles(event.dataTransfer.files);
  };
  const reorderCovers = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    onUpdateProject(project.id, (current) => {
      const allCovers = projectCoverCandidates(current);
      const currentCovers = projectAccountCovers(current, selectedAccountRole, allCovers);
      const oldIndex = currentCovers.findIndex((cover) => cover.id === active.id);
      const newIndex = currentCovers.findIndex((cover) => cover.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return current;
      const reordered = [...currentCovers];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);
      const selectedIds = new Set(currentCovers.map((cover) => cover.id));
      let replacementIndex = 0;
      const covers = allCovers.map((cover) => (
        selectedIds.has(cover.id) ? reordered[replacementIndex++] : cover
      ));
      return { ...current, covers, modified: "刚刚" };
    });
  };
  const reorderCoverWithKeyboard = (coverId, direction) => {
    keyboardReorderHandledRef.current = true;
    onUpdateProject(project.id, (current) => {
      const allCovers = projectCoverCandidates(current);
      const currentCovers = projectAccountCovers(current, selectedAccountRole, allCovers);
      const oldIndex = currentCovers.findIndex((cover) => cover.id === coverId);
      const newIndex = Math.max(0, Math.min(currentCovers.length - 1, oldIndex + direction));
      if (oldIndex < 0 || oldIndex === newIndex) return current;
      const reordered = [...currentCovers];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);
      const selectedIds = new Set(currentCovers.map((cover) => cover.id));
      let replacementIndex = 0;
      const covers = allCovers.map((cover) => (
        selectedIds.has(cover.id) ? reordered[replacementIndex++] : cover
      ));
      return { ...current, covers, modified: "刚刚" };
    });
  };
  const removeCover = (id) => {
    onUpdateProject(project.id, (current) => ({
      ...current,
      covers: (current.covers || []).filter((item, index) => {
        const itemId = typeof item === "string" ? `${current.id}-upload-${index}` : item.id;
        return itemId !== id;
      }),
      modified: "刚刚",
    }));
    setPreviewCover((current) => current?.id === id ? null : current);
    notify("已从当前创作移除封面，源文件仍保留在资料库");
  };
  const setCreationStatus = (status) => {
    onUpdateProject(project.id, (current) => ({
      ...current,
      unitSchemaVersion: 1,
      creationStatus: status,
      completedAt: status === "completed" ? current.completedAt || new Date().toISOString() : null,
      workflow: {
        ...(current.workflow || {}),
        stage: "creating",
        creationStatus: status,
        completedAt: status === "completed" ? current.completedAt || new Date().toISOString() : null,
      },
      modified: "刚刚",
    }));
  };
  const chooseProjectMedia = (slot) => {
    selectedMediaSlotRef.current = slot;
    mediaInputRef.current?.click();
  };
  const uploadToMediaSlot = async (slot, file) => {
    if (!slot || !file) return;
    await onUploadMedia(
      project.id,
      slot.role,
      slot.accountRole,
      file,
      slot.asset?.id || "",
    );
  };
  const selectProjectMedia = async (event) => {
    const file = Array.from(event.target.files || [])[0];
    const slot = selectedMediaSlotRef.current;
    selectedMediaSlotRef.current = null;
    event.target.value = "";
    await uploadToMediaSlot(slot, file);
  };

  return (
    <div className="page-shell creation-shell">
      <CreationHeader
        eyebrow={`02 / ${selectedAccount.label}编辑`}
        description={editingExisting
          ? `正在编辑 ${project.id} 的${selectedAccount.label}内容，完成后同步回创作台。`
          : "封面、文案、原始拍摄素材和成品视频都保存到当前资料库。"}
        setSidebarOpen={setSidebarOpen}
        actions={(
          <div className="creation-header-actions">
            {!editingExisting && <button type="button" className="quiet-button creation-clear-button" disabled={!hasContent} onClick={() => hasContent ? setDialog("clear") : onClearProject(project.id)}><Trash2 size={15} />清空全部</button>}
            {!editingExisting && <button type="button" className="quiet-button creation-new-button" onClick={() => hasContent ? setDialog("new") : onCreateBlank()}><Plus size={15} />新建创作</button>}
            <div className="segmented-control creation-account-control" aria-label="编辑账号">
              {CONTENT_ACCOUNT_VARIANTS.map((variant) => (
                <button
                  type="button"
                  className={selectedAccountRole === variant.id ? "active" : ""}
                  aria-pressed={selectedAccountRole === variant.id}
                  onClick={() => onAccountRoleChange(variant.id)}
                  key={variant.id}
                >
                  {variant.label}
                </button>
              ))}
            </div>
            <span className="creation-material-count"><CheckCircle2 size={15} />资料 {accountMaterialCount}/5</span>
            <label className="creation-category-control">
              <Tags size={15} />
              <select
                aria-label="创作分类"
                value={categoryValue(project)}
                onChange={(event) => onUpdateProject(project.id, (current) => ({ ...current, category: event.target.value, categoryAssignedByUser: true, modified: "刚刚" }))}
              >
                <option value="">未分类</option>
                {categories.map((category) => <option value={category} key={category}>{category}</option>)}
              </select>
            </label>
            {!editingExisting && <div className="segmented-control creation-status-control" aria-label="创作状态">
              <button type="button" className={!creationComplete ? "active" : ""} aria-pressed={!creationComplete} onClick={() => setCreationStatus("in_progress")}>正在创作</button>
              <button type="button" className={creationComplete ? "active completed" : ""} aria-pressed={creationComplete} onClick={() => setCreationStatus("completed")}>创作已完成</button>
            </div>}
            <button type="button" className="primary-button" onClick={() => onQueue(project.id)}><Inbox size={16} />{editingExisting ? "完成编辑" : "保存到创作台"}</button>
          </div>
        )}
      />

      <div className="creation-layout">
        <main className="editor-column">
          <section className="editor-section">
            <div className="section-heading"><div><span>封面</span><small>{coverCandidates.length ? `${coverCandidates.length} 张 · 拖动排序 · 点击查看大图` : "支持上传多张封面"}</small></div></div>
            <div
              className={`cover-editor-grid cover-editor-strip ${coverDragActive ? "is-file-dragging" : ""}`}
              aria-label="封面图片区域"
              onDragEnter={(event) => {
                if (!hasDraggedFiles(event)) return;
                event.preventDefault();
                coverDragDepthRef.current += 1;
                setCoverDragActive(true);
              }}
              onDragOver={(event) => {
                if (!hasDraggedFiles(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={(event) => {
                if (!hasDraggedFiles(event)) return;
                event.preventDefault();
                coverDragDepthRef.current = Math.max(0, coverDragDepthRef.current - 1);
                if (!coverDragDepthRef.current) setCoverDragActive(false);
              }}
              onDrop={completeCoverDrop}
            >
              <DndContext
                sensors={coverSensors}
                collisionDetection={closestCenter}
                measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
                onDragStart={() => {
                  keyboardReorderHandledRef.current = false;
                }}
                onDragCancel={() => {
                  keyboardReorderHandledRef.current = false;
                }}
                onDragEnd={(event) => {
                  if (!keyboardReorderHandledRef.current) reorderCovers(event);
                  keyboardReorderHandledRef.current = false;
                }}
              >
                <SortableContext items={coverCandidates.map((cover) => cover.id)} strategy={rectSortingStrategy}>
                  {coverCandidates.map((cover, index) => (
                    <SortableCreationCover
                      cover={cover}
                      index={index}
                      onKeyboardMove={reorderCoverWithKeyboard}
                      onRemove={removeCover}
                      onPreview={(item, itemIndex) => setPreviewCover({ ...item, src: coverSource(item), alt: `封面 ${itemIndex + 1}` })}
                      key={cover.id}
                    />
                  ))}
                </SortableContext>
              </DndContext>
              <input ref={coverInputRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple aria-label="选择本地封面图片" onChange={(event) => {
                const files = Array.from(event.target.files || []);
                event.target.value = "";
                uploadCoverFiles(files);
              }} />
              <button type="button" className="upload-cover" aria-label={uploadingCover ? "正在添加封面" : "添加封面"} title="添加封面" disabled={uploadingCover} onClick={() => coverInputRef.current?.click()}>
                {uploadingCover ? <RefreshCw size={24} className="spin" /> : <Plus size={30} />}
              </button>
            </div>
          </section>

          <section className="editor-section">
            <div className="section-heading"><div><span>标题</span><small>{selectedAccount.label}内容</small></div><CreationCopyButton value={accountCopy.title} notify={notify} /></div>
            <input className="title-input" aria-label={`${selectedAccount.label}编辑标题`} value={accountCopy.title} onChange={(event) => update("title", event.target.value)} placeholder={`输入${selectedAccount.label}视频标题`} />
          </section>

          <section className="editor-section body-section">
            <div className="section-heading"><div><span>正文</span><small>{accountCopy.body.length} 字</small></div><CreationCopyButton value={accountCopy.body} notify={notify} /></div>
            <textarea aria-label={`${selectedAccount.label}编辑正文`} value={accountCopy.body} onChange={(event) => update("body", event.target.value)} placeholder={`写下${selectedAccount.label}视频正文、口播文案或内容说明`} />
          </section>

          <section className="editor-section project-media-section">
            <div className="section-heading"><div><span>视频素材</span><small>按内容 ID 保存到项目目录</small></div></div>
            <input ref={mediaInputRef} className="sr-only" type="file" accept={VIDEO_ACCEPT} aria-label="选择创作视频素材" onChange={selectProjectMedia} />
            <div className="project-media-grid">
              {accountMediaSlots.map((slot) => {
                const upload = projectUploads[projectMediaSlotKey(slot.role, slot.accountRole)];
                return (
                  <ProjectMediaSlot
                    role={slot.role}
                    title={slot.label}
                    description={slot.role === "source_video" ? "拍摄完成后上传" : "剪辑完成后上传"}
                    media={slot.asset}
                    legacy={slot.legacy}
                    uploading={Boolean(upload)}
                    progress={upload?.progress || 0}
                    onChoose={() => chooseProjectMedia(slot)}
                    onDropFile={(file) => uploadToMediaSlot(slot, file)}
                    onRemove={() => onRemoveMedia(
                      project.id,
                      slot.role,
                      slot.accountRole,
                      slot.asset?.id || "",
                      { legacyAccountRole: slot.legacy },
                    )}
                    onReveal={() => onRevealMedia(project.id, slot.asset)}
                    key={slot.key}
                  />
                );
              })}
            </div>
            {accountLegacyMedia.length > 0 && (
              <div className="project-media-legacy" aria-label="历史未归位视频">
                {accountLegacyMedia.map((media, index) => (
                  <ProjectMediaSlot
                    role={media.role}
                    title={media.slotConflict ? "历史视频 · 槽位冲突" : "历史视频 · 账号未标注"}
                    description="保留旧数据，不会自动迁移"
                    media={media}
                    legacy={media.legacyAccountRole}
                    uploading={false}
                    progress={0}
                    onRemove={() => onRemoveMedia(
                      project.id,
                      media.role,
                      media.accountRole || PROJECT_MEDIA_SLOTS.find((slot) => slot.role === media.role)?.accountRole,
                      media.id || "",
                      { legacyAccountRole: media.legacyAccountRole },
                    )}
                    onReveal={() => onRevealMedia(project.id, media)}
                    key={media.id || media.relativePath || index}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="editor-section references-section">
            <div className="section-heading">
              <div><span>灵感参考</span><small>{project.references.length} 条关联灵感</small></div>
              <button type="button" className="quiet-button add-reference-button" onClick={() => setPickerOpen(true)}><Plus size={15} />添加灵感</button>
            </div>
            <div className="creation-reference-grid">
              {project.references.length
                ? project.references.map((item) => renderReferenceCard(item, {
                    onCategoryChange: (id, value) => onUpdateReference(project.id, id, { category: value, categoryAssignedByUser: true }),
                    onBodyChange: (id, value) => onUpdateReference(project.id, id, value && typeof value === "object" ? value : { body: value }),
                    onDetach: (id) => onUpdateProject(project.id, (current) => ({ ...current, references: current.references.filter((reference) => reference.id !== id), modified: "刚刚" })),
                  }))
                : <p className="muted-line">这个内容还没有关联灵感。</p>}
            </div>
          </section>
        </main>
      </div>

      {pickerOpen && <InspirationPickerModal inspirations={inspirationItems} selectedIds={selectedReferenceIds} categories={categories} categoryValue={categoryValue} onPick={(inspiration) => {
        onUpdateProject(project.id, (current) => current.references.some((item) => item.id === inspiration.id) ? current : ({ ...current, references: [...current.references, inspiration], modified: "刚刚" }));
        setPickerOpen(false);
        notify("已添加灵感参考");
      }} onClose={() => setPickerOpen(false)} />}
      {previewCover && <CoverPreviewModal cover={previewCover} onClose={() => setPreviewCover(null)} />}
      {dialog === "clear" && <ClearProjectModal onClose={() => setDialog("")} onConfirm={() => {
        setDialog("");
        onClearProject(project.id);
      }} />}
      {dialog === "new" && <NewProjectModal onClose={() => setDialog("")} onDiscard={() => {
        setDialog("");
        onDiscardAndCreate(project.id);
      }} onQueue={() => {
        setDialog("");
        onQueueAndCreate(project.id);
      }} />}
    </div>
  );
}
