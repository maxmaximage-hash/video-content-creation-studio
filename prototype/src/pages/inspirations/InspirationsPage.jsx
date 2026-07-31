import { useEffect, useRef, useState } from "react";
import {
  Inbox,
  Link2,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  ShieldCheck,
  Tags,
} from "lucide-react";
import { InspirationCard } from "../../features/inspirations/InspirationCard.jsx";
import {
  applyExtraction,
} from "../../features/inspirations/inspiration-model.js";
import "./inspirations.css";

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

function effectiveCaptureState(item) {
  return item?.refreshState && item.refreshState !== "success"
    ? item.refreshState
    : item?.parseState;
}

function LinkCapture({ categories, onAdd }) {
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (category && !categories.includes(category)) setCategory("");
  }, [categories, category]);

  const addLink = async () => {
    if (!url.trim()) return;
    setAdding(true);
    try {
      const ok = await onAdd(url, category);
      if (ok !== false) setUrl("");
    } finally {
      setAdding(false);
    }
  };

  return (
    <section className="link-capture real-capture" aria-label="添加真实灵感链接">
      <div className="capture-icon"><Link2 size={20} /></div>
      <input
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && addLink()}
        placeholder="粘贴真实抖音、小红书、B站、视频号、YouTube 或 Instagram 链接"
        aria-label="真实内容链接"
      />
      <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="入库分类">
        <option value="">未分类</option>
        {categories.map((item) => <option value={item} key={item}>{item}</option>)}
      </select>
      <button type="button" className="primary-button" onClick={addLink} disabled={!url.trim() || adding}>
        {adding ? <RefreshCw size={16} className="spin" /> : <Plus size={16} />}
        {adding ? "扒取中" : "添加灵感"}
      </button>
    </section>
  );
}

function AuthPanel({ authStatus, onOpenAuth }) {
  const platforms = [
    { id: "douyin", label: "抖音" },
    { id: "xiaohongshu", label: "小红书" },
  ];

  return (
    <section className="auth-panel" aria-label="平台登录">
      <div className="auth-panel-copy">
        <ShieldCheck size={17} />
        <span>专用采集浏览器</span>
        <small>扫码登录后，重扒会优先使用该会话</small>
      </div>
      <div className="auth-actions">
        {platforms.map((platform) => {
          const state = authStatus?.[platform.id];
          const authenticated = state?.authState === "authenticated";
          const statusLabel = !state
            ? "正在检查"
            : authenticated
              ? "已登录"
              : state.authState === "challenge"
                ? `请在${platform.label}专用窗口完成验证`
                : state.authState === "platform_unavailable"
                  ? "平台暂不可用"
                  : state.authState === "unknown"
                    ? "会话尚未验证"
                  : state.browserState === "offline" && state.hasProfile
                    ? "浏览器未打开"
                    : "未登录";
          return (
            <button
              type="button"
              className={`quiet-button auth-button ${authenticated ? "active" : ""} ${state?.needsUserAction ? "needs-action" : ""}`}
              onClick={() => onOpenAuth(platform.id)}
              key={platform.id}
            >
              <QrCode size={15} />
              <span>{platform.label}<small>{statusLabel}</small></span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function EmptyState({ title, description, action, filtered = false }) {
  return (
    <section className={`empty-state ${filtered ? "inspiration-filter-empty" : ""}`}>
      <div className="empty-icon"><Inbox size={22} /></div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </section>
  );
}

export function InspirationsPage({
  items,
  setItems,
  categories,
  linkedInspirationIds,
  openCategoryManager,
  onCreate,
  notify,
  setSidebarOpen,
  storage,
  authStatus,
  onOpenAuth,
  onRefreshAuth,
  onDelete,
  onIngest,
  onPatch,
  deletingIds = new Set(),
  onApplyLibrary,
  categoryValue,
  renderPageHeader,
  renderMediaPreview,
}) {
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState("全部平台");
  const [category, setCategory] = useState("全部分类");
  const autoResumedIds = useRef(new Set());
  const retryTimers = useRef(new Map());
  const autoRetryKeys = useRef(new Set());
  const mediaRecoveryIds = useRef(new Set());
  const patchTimers = useRef(new Map());
  const patchVersions = useRef(new Map());
  const onApplyLibraryRef = useRef(onApplyLibrary);
  onApplyLibraryRef.current = onApplyLibrary;

  const platforms = [
    "全部平台",
    "已关联",
    ...Array.from(new Set(items.map((item) => item.platform)))
      .filter((item) => item && !["全部平台", "已关联"].includes(item)),
  ];
  const filtered = items.filter((item) => {
    const matchesSearch = `${item.title}${item.body}${item.author}${item.originalUrl}`.toLowerCase().includes(search.toLowerCase());
    const matchesPlatform = platform === "全部平台"
      || (platform === "已关联" ? linkedInspirationIds.has(item.id) : item.platform === platform);
    const matchesCategory = category === "全部分类"
      || (category === "未分类" ? !categoryValue(item) : categoryValue(item) === category);
    return matchesSearch && matchesPlatform && matchesCategory;
  });

  const categoryCounts = Object.fromEntries(categories.map((item) => [item, items.filter((card) => categoryValue(card) === item).length]));
  const uncategorizedCount = items.filter((item) => !categoryValue(item)).length;

  const updateCard = (id, patch, { persist = false, delay = 0 } = {}) => {
    setItems((current) => current.map((card) => (
      card.id === id ? { ...card, ...patch, updatedAt: formatNow() } : card
    )));
    if (!persist || !onPatch) return;
    const version = (patchVersions.current.get(id) || 0) + 1;
    patchVersions.current.set(id, version);
    window.clearTimeout(patchTimers.current.get(id));
    const commit = async () => {
      try {
        const card = items.find((candidate) => candidate.id === id);
        await onPatch(id, patch, card?.generation);
      } catch (error) {
        notify(`修改未保存：${error.message}`);
      }
    };
    if (delay) patchTimers.current.set(id, window.setTimeout(commit, delay));
    else void commit();
  };

  const extractCard = async (item, { automatic = false, repairMissingOnly = false } = {}) => {
    if (!automatic) autoResumedIds.current.delete(item.id);
    const attempt = Math.max(1, (Number(item.attempt) || 0) + 1);
    const stageTimers = [];
    const scheduleStage = (delay, parseStage, parseProgress) => {
      stageTimers.push(setTimeout(() => {
        updateCard(item.id, { parseState: "extracting", parseStatus: "正在扒取公开信息", parseStage, parseProgress });
      }, delay));
    };
    updateCard(item.id, {
      parseState: "extracting",
      refreshState: "extracting",
      parseStatus: repairMissingOnly ? "正在修复本地图片" : "正在扒取公开信息",
      parseStage: repairMissingOnly ? "正在核对原笔记" : "正在展开链接",
      parseProgress: 12,
      parseEvidence: ["开始解析链接"],
    });
    scheduleStage(1200, "正在读取公开页面", 34);
    scheduleStage(3200, "正在调用专用浏览器", 58);
    scheduleStage(8500, "正在整理封面与视频信息", 82);
    try {
      const response = await fetch("/api/extract", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-library-session-id": storage?.sessionId || "",
        },
        body: JSON.stringify({
          id: item.id,
          url: item.originalUrl,
          repairMissingOnly,
          generation: item.generation,
          attempt,
        }),
      });
      const extraction = await response.json();
      if (!response.ok) throw new Error(extraction.error || "采集服务暂时不可用");
      if (extraction.library) {
        onApplyLibrary?.(extraction.library);
      } else {
        setItems((current) => current.map((card) => (
          card.id === item.id ? applyExtraction(card, extraction) : card
        )));
      }
      if (extraction.discarded || extraction.parseState === "discarded") return;
      if (["waiting_login", "waiting_verification"].includes(extraction.parseState)) {
        notify(extraction.parseState === "waiting_verification" ? "请在专用浏览器完成验证" : "需要登录，完成后将自动继续");
      } else if (extraction.parseState === "retry_wait") {
        notify("平台暂时不可用，已安排自动续跑");
      } else if (extraction.parseState === "partial") {
        notify("已保存可用素材，部分信息仍未获取");
      } else if (extraction.error || ["blocked", "failed", "unsupported"].includes(extraction.parseState)) {
        notify("扒取失败，可在卡片上查看状态并重试");
      } else {
        notify("已完成采集");
      }
    } catch (error) {
      const retryAfterMs = Math.min(300000, 15000 * Math.max(1, attempt));
      const nextRetryAt = new Date(Date.now() + retryAfterMs).toISOString();
      updateCard(item.id, {
        parseState: item.acquisitionState === "acquired" ? item.parseState : "retry_wait",
        refreshState: "retry_wait",
        refreshStatus: "本地采集服务暂时中断，稍后自动继续",
        refreshStage: "等待自动重试",
        refreshEvidence: [error.message],
        captureState: "retry_wait",
        errorCode: "NETWORK_TRANSIENT",
        retryable: true,
        attempt,
        retryAfterMs,
        nextRetryAt,
      }, { persist: true });
      notify("采集服务暂时中断，已保留内容并安排自动续跑");
    } finally {
      stageTimers.forEach(clearTimeout);
      const platformKey = item.platform === "抖音"
        ? "douyin"
        : item.platform === "小红书" ? "xiaohongshu" : "";
      if (platformKey) void onRefreshAuth?.(false, platformKey);
    }
  };

  useEffect(() => {
    const waitingPlatforms = new Set(items
      .filter((item) => ["waiting_login", "waiting_verification"].includes(effectiveCaptureState(item)))
      .map((item) => item.platform === "抖音" ? "douyin" : item.platform === "小红书" ? "xiaohongshu" : "")
      .filter(Boolean));
    const shouldPoll = [...waitingPlatforms].some((key) => authStatus?.[key]?.authState !== "authenticated");
    if (!shouldPoll) return undefined;
    const timer = window.setInterval(() => {
      waitingPlatforms.forEach((key) => {
        if (authStatus?.[key]?.authState !== "authenticated") onRefreshAuth?.(true, key);
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [items, authStatus, onRefreshAuth]);

  useEffect(() => {
    items.forEach((item) => {
      if (!["waiting_login", "waiting_verification"].includes(effectiveCaptureState(item))) return;
      const key = item.platform === "抖音" ? "douyin" : item.platform === "小红书" ? "xiaohongshu" : "";
      if (!key || authStatus?.[key]?.authState !== "authenticated" || autoResumedIds.current.has(item.id)) return;
      autoResumedIds.current.add(item.id);
      extractCard(item, { automatic: true });
    });
  }, [items, authStatus]);

  useEffect(() => {
    const activeKeys = new Set();
    items.forEach((item) => {
      const state = effectiveCaptureState(item);
      if (state !== "retry_wait" || item.retryable === false || !/^I\d{6,}$/.test(String(item.id || ""))) return;
      const key = [
        storage?.sessionId || "",
        item.id,
        Number(item.generation) || 1,
        Number(item.attempt) || 0,
        item.nextRetryAt || "",
      ].join(":");
      activeKeys.add(key);
      if (retryTimers.current.has(key) || autoRetryKeys.current.has(key)) return;
      const dueAt = Date.parse(item.nextRetryAt || "");
      const delay = Number.isFinite(dueAt)
        ? Math.max(0, dueAt - Date.now())
        : Math.max(1000, Number(item.retryAfterMs) || 5000);
      const timer = window.setTimeout(() => {
        retryTimers.current.delete(key);
        if (autoRetryKeys.current.has(key)) return;
        autoRetryKeys.current.add(key);
        void extractCard(item, { automatic: true });
      }, Math.min(delay, 2147483647));
      retryTimers.current.set(key, timer);
    });
    for (const [key, timer] of retryTimers.current) {
      if (activeKeys.has(key)) continue;
      window.clearTimeout(timer);
      retryTimers.current.delete(key);
    }
  }, [items, storage?.sessionId]);

  useEffect(() => () => {
    for (const timer of retryTimers.current.values()) window.clearTimeout(timer);
    retryTimers.current.clear();
  }, []);

  useEffect(() => {
    if (!storage?.sessionId) return undefined;
    const candidates = items.filter((item) => {
      if (!/^I\d{6,}$/.test(String(item?.id || "")) || item.platform !== "小红书") return false;
      const hasLocalImages = [
        ...(Array.isArray(item.images) ? item.images : []),
        ...(Array.isArray(item.mediaAssets) ? item.mediaAssets.filter((asset) => asset?.role === "content_image") : []),
      ].some((image) => image?.localPath || image?.relativePath || String(image?.src || "").startsWith("/library-assets/"));
      const interrupted = item.parseState === "extracting"
        || item.parseState === "failed"
        || item.parseStatus === "正在扒取公开信息"
        || String(item.parseStatus || "").includes("中断");
      return interrupted && !hasLocalImages && !mediaRecoveryIds.current.has(item.id);
    });
    if (!candidates.length) return undefined;
    candidates.forEach((item) => mediaRecoveryIds.current.add(item.id));
    void (async () => {
      for (const item of candidates) {
        try {
          const response = await fetch(`/api/inspirations/recover-media?id=${encodeURIComponent(item.id)}`, {
            method: "POST",
            headers: { "x-library-session-id": storage.sessionId },
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "本地素材恢复失败");
          if (result.recovered > 0 && result.library) onApplyLibraryRef.current?.(result.library);
        } catch {
          // Offline or inaccessible libraries keep their references unchanged.
        }
      }
    })();
    return undefined;
  }, [items, storage?.sessionId]);

  const addLink = async (url, nextCategory) => {
    if (!/https?:\/\/\S+/i.test(url) || /^(?:undefined|null)$/i.test(url.trim())) {
      notify("没有识别到有效内容链接");
      return false;
    }
    try {
      const result = await onIngest(url, nextCategory);
      if (result.existing) {
        setSearch("");
        setPlatform("全部平台");
        setCategory("全部分类");
        notify(`这条内容已存在：${result.item.id}`);
        window.requestAnimationFrame(() => {
          document.querySelector(`[data-inspiration-id="${result.item.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
        return true;
      }
      notify(`已写入 ${result.item.id}，开始扒取`);
      await extractCard(result.item);
      return true;
    } catch (error) {
      notify(`添加失败：${error.message}`);
      return false;
    }
  };

  const removeCard = async (item) => {
    if (deletingIds.has(item.id)) return;
    const originalIndex = items.findIndex((candidate) => candidate.id === item.id);
    setItems((current) => current.filter((candidate) => candidate.id !== item.id));
    const deleted = await onDelete(item.id);
    if (deleted) return;
    setItems((current) => {
      if (current.some((candidate) => candidate.id === item.id)) return current;
      const next = [...current];
      next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, item);
      return next;
    });
  };

  return (
    <div className="page-shell inspirations-page">
      {renderPageHeader({
        eyebrow: "01 / 灵感采集",
        title: "灵感库",
        description: storage ? `当前库：${storage.libraryDir}` : "正在连接本地资料库",
        setSidebarOpen,
      })}

      <LinkCapture categories={categories} onAdd={addLink} />
      <AuthPanel authStatus={authStatus} onOpenAuth={onOpenAuth} />

      <div className="toolbar-row inspiration-toolbar">
        <div className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、正文、作者或链接" /></div>
        <div className="segmented-control" aria-label="平台筛选">
          {platforms.map((item) => (
            <button
              key={item}
              type="button"
              className={platform === item ? "active" : ""}
              aria-pressed={platform === item}
              onClick={() => setPlatform(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <span className="result-count">{filtered.length} 条灵感</span>
      </div>

      <div className="category-strip" aria-label="分类筛选">
        <button type="button" className={category === "全部分类" ? "active" : ""} aria-pressed={category === "全部分类"} onClick={() => setCategory("全部分类")}>全部分类 <small>{items.length}</small></button>
        <button type="button" className={category === "未分类" ? "active" : ""} aria-pressed={category === "未分类"} onClick={() => setCategory("未分类")}>未分类 <small>{uncategorizedCount}</small></button>
        {categories.map((item) => (
          <button type="button" className={category === item ? "active" : ""} aria-pressed={category === item} onClick={() => setCategory(item)} key={item}>{item} <small>{categoryCounts[item] || 0}</small></button>
        ))}
        <button type="button" className="category-add-button" onClick={openCategoryManager}><Plus size={14} />新增分类</button>
      </div>

      {filtered.length ? (
        <section className="inspiration-grid" aria-label="灵感卡片">
          {filtered.map((item) => (
            <InspirationCard
              item={item}
              categories={categories}
              isLinked={linkedInspirationIds.has(item.id)}
              categoryValue={categoryValue}
              renderMediaPreview={renderMediaPreview}
              onCategoryChange={(id, value) => updateCard(id, { category: value, categoryAssignedByUser: true }, { persist: true })}
              onBodyChange={(id, value) => updateCard(id, { body: value }, { persist: true, delay: 450 })}
              onExtract={extractCard}
              onRepairMissing={(card) => extractCard(card, { repairMissingOnly: true })}
              onOpenAuth={onOpenAuth}
              onRemove={() => removeCard(item)}
              onCreate={onCreate}
              notify={notify}
              key={item.id}
            />
          ))}
        </section>
      ) : items.length ? (
        <EmptyState
          filtered
          title="没有匹配的灵感"
          description="调整平台、搜索或分类筛选后再试。"
        />
      ) : (
        <EmptyState
          title="灵感库已清空"
          description="从现在开始，这里只显示你真实添加的内容链接。"
          action={<button type="button" className="quiet-button" onClick={openCategoryManager}><Tags size={16} />管理分类</button>}
        />
      )}
    </div>
  );
}
