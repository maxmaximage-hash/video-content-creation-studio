import { useCallback, useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Copy, Laptop, Link2, Plus, RefreshCw, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import "./mobile-inbox.css";

const STATE_LABELS = {
  pending: "待接收",
  processing: "正在处理",
  success: "已入库",
  waiting_login: "需要登录",
  waiting_verification: "需要验证",
  failed: "失败",
};

function taskState(task) {
  return STATE_LABELS[task.state] || task.state || "待接收";
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || "手机链接收集箱请求失败");
  }
  return result;
}

export function MobileInboxPage({ storage, libraryWritable, onApplyLibrary, notify }) {
  const [status, setStatus] = useState({ configured: false, connected: false, submissions: [], pairings: [], devices: [] });
  const [pairing, setPairing] = useState(null);
  const [pairingQr, setPairingQr] = useState(null);
  const [activation, setActivation] = useState(null);
  const [busy, setBusy] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [ownerToken, setOwnerToken] = useState("");
  const [activationCode, setActivationCode] = useState("");
  const [computerLabel, setComputerLabel] = useState("");

  const refresh = useCallback(async () => {
    const result = await api("/api/mobile-inbox/status");
    setStatus(result);
    setEndpoint((current) => current || result.endpoint || "");
    const activePairings = result.pairings?.filter((item) => !item.revokedAt) || [];
    const remote = result.mobilePairing
      ? activePairings.find((item) => item.id === result.mobilePairing.id)
      : activePairings[0];
    setPairing(remote ? { ...remote, ...(remote.id === result.mobilePairing?.id ? result.mobilePairing : {}) } : null);
    return result;
  }, []);

  useEffect(() => {
    void refresh().catch((error) => notify(error.message));
  }, [refresh, notify]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh().catch(() => {});
    }, 4000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const setup = async (mode) => {
    setBusy(true);
    try {
      const body = mode === "initialize"
        ? { endpoint, ownerToken, label: computerLabel || "管理员电脑" }
        : { endpoint, activationCode, label: computerLabel || "工作电脑" };
      await api(`/api/mobile-inbox/setup/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      setOwnerToken("");
      setActivationCode("");
      await refresh();
      notify(mode === "initialize" ? "工作区已初始化，此电脑是管理员电脑" : "此电脑已加入手机收集工作区");
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  };

  const sync = useCallback(async ({ quiet = false } = {}) => {
    if (!status.connected || !libraryWritable || busy) return null;
    setBusy(true);
    try {
      const result = await api("/api/mobile-inbox/sync", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-library-session-id": storage?.sessionId || "",
        },
        body: JSON.stringify({ limit: 5 }),
      });
      if (result.library) onApplyLibrary?.(result.library);
      await refresh();
      if (!quiet && result.outcomes?.length) notify(`已处理 ${result.outcomes.length} 条手机链接`);
      return result;
    } catch (error) {
      if (!quiet) notify(error.message);
      return null;
    } finally {
      setBusy(false);
    }
  }, [busy, libraryWritable, notify, onApplyLibrary, refresh, status.connected, storage?.sessionId]);

  const createPairing = async ({ additional = false } = {}) => {
    setBusy(true);
    try {
      const activeCount = status.pairings?.filter((item) => !item.revokedAt).length || 0;
      const result = await api("/api/mobile-inbox/pairings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: additional && activeCount ? `我的手机 ${activeCount + 1}` : "我的手机" }),
      });
      setPairing(result.pairing);
      setPairingQr({ ...result.pairing, mode: "new" });
      await refresh();
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  };

  const createPairingHandoff = async () => {
    if (!pairing?.id) {
      await createPairing();
      return;
    }
    setBusy(true);
    try {
      const result = await api(`/api/mobile-inbox/pairings/${encodeURIComponent(pairing.id)}/handoff`, { method: "POST" });
      setPairingQr({ ...result.handoff, id: pairing.id, mode: "entry" });
      notify("已生成同一台手机的新入口，二维码 10 分钟内有效");
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  };

  const createActivation = async () => {
    setBusy(true);
    try {
      const result = await api("/api/mobile-inbox/devices/activation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "新工作电脑", minutes: 30 }),
      });
      setActivation(result.activation);
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (kind, id) => {
    setBusy(true);
    try {
      await api(`/api/mobile-inbox/${kind}/${encodeURIComponent(id)}/revoke`, { method: "POST" });
      if (kind === "pairings" && pairing?.id === id) setPairing(null);
      if (kind === "pairings" && pairingQr?.id === id) setPairingQr(null);
      await refresh();
      notify(kind === "pairings" ? "已撤销这台手机的提交权限" : "已撤销这台电脑的工作区权限");
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  };

  const retry = async (id) => {
    setBusy(true);
    try {
      await api(`/api/mobile-inbox/submissions/${encodeURIComponent(id)}/retry`, { method: "POST" });
      await sync();
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  };

  const copy = (value, message) => {
    navigator.clipboard.writeText(value).then(() => notify(message)).catch(() => notify("复制失败"));
  };

  const activePairings = useMemo(() => status.pairings?.filter((item) => !item.revokedAt) || [], [status.pairings]);
  const groups = useMemo(() => ({
    pending: status.submissions?.filter((item) => item.state === "pending") || [],
    processing: status.submissions?.filter((item) => item.state === "processing") || [],
    attention: status.submissions?.filter((item) => ["waiting_login", "waiting_verification", "failed"].includes(item.state)) || [],
    complete: status.submissions?.filter((item) => item.state === "success") || [],
  }), [status.submissions]);

  const needsSetup = !status.configured || status.errorCode === "DEVICE_UNAUTHORIZED";
  const isAdmin = status.device?.role === "admin";

  return (
    <main className="page-shell mobile-inbox-page">
      <header className="page-header">
        <div className="title-row">
          <Smartphone size={24} />
          <div><span className="eyebrow">05 / 跨网络收集</span><h1>手机链接收集箱</h1><p>所有获授权电脑共享一个收集箱；手机只提交链接，电脑写入同一个灵感库。</p></div>
        </div>
        <button type="button" className="quiet-button" disabled={!status.connected || busy || !libraryWritable} onClick={() => void sync()}><RefreshCw size={15} className={busy ? "spin" : ""} />立即同步</button>
      </header>

      {needsSetup ? (
        <section className="mobile-setup-panel">
          <div className="mobile-setup-heading"><ShieldCheck size={26} /><div><strong>授权这台电脑</strong><p>首台电脑只初始化一次；其他电脑使用管理员生成的一次性入组码。</p></div></div>
          <label>Cloudflare 收集箱地址<input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://你的-worker.workers.dev" /></label>
          <label>这台电脑名称<input value={computerLabel} onChange={(event) => setComputerLabel(event.target.value)} placeholder="例如：公司 Mac" /></label>
          <div className="mobile-setup-options">
            <div><strong>首台管理员电脑</strong><input type="password" autoComplete="off" value={ownerToken} onChange={(event) => setOwnerToken(event.target.value)} placeholder="管理员初始化令牌" /><button type="button" className="primary-button" disabled={busy || !endpoint || !ownerToken} onClick={() => setup("initialize")}>初始化工作区</button></div>
            <div><strong>加入已有工作区</strong><input type="password" autoComplete="off" value={activationCode} onChange={(event) => setActivationCode(event.target.value)} placeholder="一次性电脑入组码" /><button type="button" className="primary-button" disabled={busy || !endpoint || !activationCode} onClick={() => setup("join")}>授权此电脑</button></div>
          </div>
        </section>
      ) : !status.connected ? (
        <section className="mobile-inbox-empty"><ShieldCheck size={28} /><strong>暂时无法连接手机收集箱</strong><p>{status.error || "请检查网络后重试。云端待处理链接不会因此丢失。"}</p><button type="button" className="quiet-button" onClick={() => void refresh()}>重新连接</button></section>
      ) : (
        <>
          <section className="mobile-inbox-pair">
            <div>
              <span className="eyebrow">手机 WEB APP</span>
              <h2>一台手机，多种入口，共用同一份收集箱</h2>
              <p>微信、Safari 和主屏幕 App 会作为同一台手机的不同入口，不再重复创建手机授权。主屏幕旧图标若提示未连接，只需重新生成一次入口。</p>
              <div className="mobile-pairing-actions">
                <button type="button" className="primary-button" disabled={busy} onClick={() => void createPairingHandoff()}><Link2 size={15} />{pairing ? "连接这台手机的另一个入口" : "连接我的手机"}</button>
                {pairing && <button type="button" className="quiet-button" disabled={busy} onClick={() => void createPairing({ additional: true })}><Plus size={15} />添加另一台手机</button>}
              </div>
              {pairing?.webAppUrl && <div className="mobile-web-app-address"><span>固定工作台地址</span><code>{pairing.webAppUrl}</code><button type="button" className="quiet-button" onClick={() => copy(pairing.webAppUrl, "已复制手机 Web App 地址")}><Copy size={14} />复制地址</button></div>}
              {activePairings.length > 0 && <div className="mobile-phone-list">{activePairings.map((item) => <div key={item.id} className={item.id === pairing?.id ? "current" : ""}><Smartphone size={15} /><span><strong>{item.label}</strong><small>{Number(item.credentialCount || 0) + 1} 个入口{item.lastSeenAt ? " · 最近使用 " + new Date(item.lastSeenAt).toLocaleString("zh-CN") : ""}</small></span>{item.id === pairing?.id && <em>当前</em>}<button type="button" disabled={busy} onClick={() => revoke("pairings", item.id)} aria-label={"撤销" + item.label}><Trash2 size={13} /></button></div>)}</div>}
            </div>
            {pairingQr ? <div className="mobile-qr"><QRCodeSVG value={pairingQr.mobileUrl} size={164} bgColor="#ffffff" fgColor="#20231f" /><strong>{pairingQr.mode === "entry" ? "连接同一台手机的新入口" : "连接新的手机"}</strong><small>{pairingQr.mode === "entry" ? "用当前手机扫码；添加到主屏幕后从新图标打开一次" : "仅在另一台物理手机上扫码"}</small></div> : <div className="mobile-qr mobile-qr-placeholder"><Smartphone size={34} /><strong>{pairing ? "点击左侧按钮生成入口二维码" : "先连接第一台手机"}</strong><small>二维码只包含短期连接凭据</small></div>}
          </section>

          <section className="mobile-device-panel">
            <header><div><span className="eyebrow">授权电脑</span><h2>{status.device?.label || "此电脑"}</h2><p>每台电脑使用独立凭据。撤销后，该电脑立即不能领取链接或生成手机二维码。</p></div>{isAdmin && <button type="button" className="quiet-button" disabled={busy} onClick={createActivation}><Plus size={15} />添加电脑</button>}</header>
            {activation && <div className="mobile-activation"><QRCodeSVG value={activation.code} size={112} /><div><strong>一次性电脑入组码</strong><code>{activation.code}</code><small>30 分钟内有效，使用一次后立即失效。</small></div><button type="button" className="quiet-button" onClick={() => copy(activation.code, "已复制电脑入组码")}><Copy size={14} />复制</button></div>}
            <div className="mobile-device-list">{status.devices?.map((device) => <div key={device.id}><Laptop size={16} /><span><strong>{device.label}</strong><small>{device.role === "admin" ? "管理员" : device.revokedAt ? "已撤销" : "已授权"}</small></span>{isAdmin && device.id !== status.device?.id && !device.revokedAt && <button type="button" onClick={() => revoke("devices", device.id)} disabled={busy}>撤销</button>}</div>)}</div>
          </section>

          <section className="mobile-inbox-grid">
            {[["待接收", groups.pending], ["处理中", groups.processing], ["需要人工处理", groups.attention], ["已完成", groups.complete]].map(([label, items]) => <div className="mobile-inbox-column" key={label}><header><strong>{label}</strong><span>{items.length}</span></header>{items.length ? items.map((task) => <article key={task.id}><span className={`mobile-task-state ${task.state}`}>{taskState(task)}</span><p>{task.sourceUrl}</p><small>{task.errorMessage || task.createdAt}</small>{["waiting_login", "waiting_verification", "failed"].includes(task.state) && <button type="button" onClick={() => retry(task.id)} disabled={busy}>重新领取</button>}</article>) : <p className="mobile-inbox-none">暂无链接</p>}</div>)}
          </section>
        </>
      )}
    </main>
  );
}
