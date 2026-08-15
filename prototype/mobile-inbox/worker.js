const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store",
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function error(message, status = 400, code = "MOBILE_INBOX_ERROR") {
  return json({ error: message, code }, status);
}

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function token() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function hash(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function bearerToken(request) {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
}

function firstHttpUrl(value) {
  const match = String(value || "").match(/https?:\/\/[^\s<>"']+/i);
  return match?.[0]?.replace(/[\uff0c\u3002\uff01\uff1f\u3001\uff1b\uff1a)\]}>]+$/u, "") || "";
}

function canonicalSourceKey(rawUrl) {
  const url = new URL(rawUrl);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|share_|xsec_|source$|spm$)/i.test(key)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

async function ownerAuthorized(request, env) {
  const provided = bearerToken(request);
  if (!env.OWNER_API_TOKEN || !provided) return false;
  return await hash(provided) === await hash(env.OWNER_API_TOKEN);
}

async function deviceForRequest(request, env, { touch = true } = {}) {
  const provided = bearerToken(request);
  if (!provided) return null;
  const device = await env.MOBILE_INBOX_DB.prepare(
    "SELECT id, label, role, created_at AS createdAt, last_seen_at AS lastSeenAt FROM desktop_devices WHERE token_hash = ? AND revoked_at IS NULL",
  ).bind(await hash(provided)).first();
  if (device && touch) {
    const seenAt = now();
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await env.MOBILE_INBOX_DB.prepare("UPDATE desktop_devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)")
      .bind(seenAt, device.id, staleBefore).run();
    device.lastSeenAt = seenAt;
  }
  return device || null;
}

async function requireDevice(request, env, { admin = false } = {}) {
  const device = await deviceForRequest(request, env);
  if (!device) return { response: error("此电脑未获授权或已被撤销", 401, "DEVICE_UNAUTHORIZED") };
  if (admin && device.role !== "admin") {
    return { response: error("只有工作区管理员可以执行此操作", 403, "ADMIN_REQUIRED") };
  }
  return { device };
}

async function pairingForToken(env, pairingToken) {
  if (!pairingToken) return null;
  const tokenHash = await hash(pairingToken);
  const row = await env.MOBILE_INBOX_DB.prepare(
    "SELECT * FROM mobile_pairings WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
  ).bind(tokenHash, now()).first();
  if (row) return row;
  const credentialRow = await env.MOBILE_INBOX_DB.prepare(
    "SELECT p.* FROM mobile_pairing_credentials c JOIN mobile_pairings p ON p.id = c.pairing_id WHERE c.token_hash = ? AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > ?)",
  ).bind(tokenHash, now()).first();
  return credentialRow || null;
}

async function createInstallTicket(env, pairingId, minutes = 10) {
  const installTicket = token();
  const createdAt = now();
  const expiresAt = new Date(Date.now() + Math.max(2, Math.min(30, Number(minutes) || 10)) * 60000).toISOString();
  await env.MOBILE_INBOX_DB.prepare(
    "INSERT INTO mobile_install_tickets (id, pairing_id, ticket_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(id("install"), pairingId, await hash(installTicket), createdAt, expiresAt).run();
  return { installTicket, createdAt, expiresAt };
}

async function validInstallTicket(env, installTicket) {
  if (!installTicket) return null;
  const checkedAt = now();
  return await env.MOBILE_INBOX_DB.prepare(
    "SELECT t.id, t.pairing_id AS pairingId, t.expires_at AS expiresAt FROM mobile_install_tickets t JOIN mobile_pairings p ON p.id = t.pairing_id WHERE t.ticket_hash = ? AND t.consumed_at IS NULL AND t.expires_at > ? AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > ?)",
  ).bind(await hash(installTicket), checkedAt, checkedAt).first();
}

function mobilePage({ bootstrapToken = "", installTicket = "", manifestHref = "/manifest.webmanifest" } = {}) {
  const encodedToken = JSON.stringify(bootstrapToken);
  const encodedInstallTicket = JSON.stringify(installTicket);
  const encodedManifestHref = String(manifestHref || "/manifest.webmanifest").replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f4f3ee"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="Video Hub 收集"><link id="app-manifest" rel="manifest" href="${encodedManifestHref}"><title>Video Hub · 手机链接收集箱</title><style>
  :root{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC",sans-serif;color:#20231f;background:#f4f3ee;font-synthesis:none;-webkit-text-size-adjust:100%;text-size-adjust:100%}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 15% 0,rgba(205,177,116,.2),transparent 36%),#f4f3ee;padding:env(safe-area-inset-top) 16px env(safe-area-inset-bottom)}main{width:min(100%,620px);margin:0 auto;padding:24px 0 48px}.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px}.brand{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:760}.mark{display:grid;width:34px;height:34px;place-items:center;border-radius:11px;color:#fff;background:#20231f;font-size:12px;letter-spacing:-.04em}.online{display:flex;align-items:center;gap:6px;color:#6e736b;font-size:12px}.online:before{content:"";width:7px;height:7px;border-radius:50%;background:#54a577;box-shadow:0 0 0 4px rgba(84,165,119,.12)}.hero{margin-bottom:18px}.eyebrow{color:#9b742f;font-size:11px;font-weight:750;letter-spacing:.12em}.hero h1{margin:8px 0 8px;font-size:31px;line-height:1.15;letter-spacing:-.04em}.hero p{margin:0;color:#6b7068;font-size:14px;line-height:1.65}.panel{padding:18px;border:1px solid rgba(44,48,41,.1);border-radius:20px;background:rgba(255,255,255,.9);box-shadow:0 18px 55px rgba(45,42,32,.08);backdrop-filter:blur(18px)}label{display:block;margin-bottom:10px;color:#30342e;font-size:13px;font-weight:700}textarea{width:100%;min-height:126px;padding:15px;border:1px solid #dfe1da;border-radius:14px;outline:0;color:#20231f;background:#fbfcfa;font-family:inherit;font-size:16px;line-height:1.55;resize:vertical;transition:border-color .18s,box-shadow .18s}textarea:focus{border-color:#c3a15c;box-shadow:0 0 0 4px rgba(195,161,92,.13)}button{width:100%;min-height:50px;margin-top:12px;border:0;border-radius:14px;color:#fff;background:#20231f;font-family:inherit;font-size:15px;font-weight:700;cursor:pointer;transition:transform .16s,opacity .16s}button:active{transform:scale(.985)}button:disabled{opacity:.48;cursor:default}.status{min-height:21px;margin:11px 2px 0;color:#70756d;font-size:13px;line-height:1.5}.status.ok{color:#277250}.status.bad{color:#b04135}.tip{display:flex;gap:9px;margin-top:14px;padding:12px 13px;border-radius:12px;color:#73776f;background:#f5f5f1;font-size:12px;line-height:1.55}.tip b{flex:0 0 auto;color:#9b742f}.recent{margin-top:26px}.section-title{display:flex;align-items:end;justify-content:space-between;margin-bottom:10px}.section-title h2{margin:0;font-size:17px}.section-title span{color:#858980;font-size:11px}.list{display:grid;gap:9px}.empty{padding:25px 16px;border:1px dashed #d3d5cf;border-radius:15px;color:#888c84;text-align:center;font-size:13px}.item{padding:13px 14px;border:1px solid rgba(44,48,41,.09);border-radius:14px;background:rgba(255,255,255,.72)}.item-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.platform{color:#40443e;font-size:12px;font-weight:720}.state{padding:4px 8px;border-radius:999px;color:#6d7069;background:#e9ebe6;font-size:10px;font-weight:750}.state.success{color:#277250;background:#e5f4eb}.state.processing{color:#88661f;background:#f8efd7}.state.waiting_login,.state.waiting_verification,.state.failed{color:#ad4137;background:#fbe8e5}.item p{display:-webkit-box;margin:8px 0 0;overflow:hidden;color:#6b7068;font-size:12px;line-height:1.45;-webkit-box-orient:vertical;-webkit-line-clamp:2;word-break:break-all}.privacy{margin:22px 8px 0;color:#8a8e86;font-size:11px;line-height:1.6;text-align:center}.unpaired{display:none;margin-bottom:14px;padding:12px 14px;border-radius:13px;color:#a5483f;background:#fcebe8;font-size:13px;line-height:1.55}@media (min-width:700px){main{padding-top:46px}.panel{padding:22px}.hero h1{font-size:36px}}
  </style></head><body><main><div class="topbar"><div class="brand"><span class="mark">VH</span>Video Hub</div><div class="online">云端收集箱</div></div><section class="hero"><div class="eyebrow">MOBILE INBOX</div><h1>手机链接收集箱</h1><p>在公司、家里或外面刷到内容，都可以随时粘贴到这里。链接会在电脑端 Video Hub 显示，并进入现有灵感卡片采集流程。</p></section><section class="panel"><div id="unpaired" class="unpaired">这台手机还没有配对。请先在电脑端「手机收集」页面扫一次二维码。</div><form id="form"><label for="url">抖音、小红书或其他内容链接</label><textarea id="url" inputmode="url" autocomplete="off" placeholder="可以直接粘贴整段分享文字，我们会自动识别其中的链接"></textarea><button id="submit" type="submit">收集到电脑端</button><div id="status" class="status" role="status" aria-live="polite"></div></form><div class="tip"><b>提示</b><span>第一次扫码配对后，可以把本页添加到手机主屏幕。以后直接打开这个工作台，不需要重复扫码。</span></div></section><section class="recent"><div class="section-title"><h2>最近收集</h2><span id="updated"></span></div><div id="list" class="list"><div class="empty">暂无收集记录</div></div></section><p class="privacy">云端只暂存链接和处理状态，不保存视频、Cookie、平台账号、NAS 路径或资料库内容。</p></main><script>
  const storageKey='video-hub.mobile-inbox.pairing-token';const bootstrapToken=${encodedToken};const installTicket=${encodedInstallTicket};const standalone=window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true;let pairingToken=localStorage.getItem(storageKey)||'';if(bootstrapToken){localStorage.setItem(storageKey,bootstrapToken);pairingToken=bootstrapToken;history.replaceState({},'', '/app')}const form=document.querySelector('#form'),field=document.querySelector('#url'),status=document.querySelector('#status'),button=document.querySelector('#submit'),list=document.querySelector('#list'),updated=document.querySelector('#updated'),unpaired=document.querySelector('#unpaired'),manifestLink=document.querySelector('#app-manifest'),tip=document.querySelector('.tip span');const labels={pending:'已提交',processing:'电脑处理中',success:'已进入灵感库',waiting_login:'等待电脑登录',waiting_verification:'等待电脑验证',failed:'处理失败'};function platform(url){try{const host=new URL(url).hostname;if(host.includes('douyin'))return'抖音';if(host.includes('xiaohongshu')||host.includes('xhslink'))return'小红书';if(host.includes('bilibili')||host.includes('b23.tv'))return'B站';if(host.includes('youtube')||host.includes('youtu.be'))return'YouTube';if(host.includes('instagram'))return'Instagram';return'其他平台'}catch{return'内容链接'}}async function post(path,body){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'请求失败');return data}function render(items){list.textContent='';if(!items.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='暂无收集记录';list.append(empty);return}for(const item of items){const card=document.createElement('article');card.className='item';const head=document.createElement('div');head.className='item-head';const name=document.createElement('span');name.className='platform';name.textContent=platform(item.sourceUrl);const state=document.createElement('span');state.className='state '+item.state;state.textContent=labels[item.state]||item.state;const source=document.createElement('p');source.textContent=item.sourceUrl;head.append(name,state);card.append(head,source);list.append(card)}}function showUnpaired(message=''){pairingToken='';localStorage.removeItem(storageKey);unpaired.textContent=message||(standalone?'这是之前添加的旧图标，它没有带入配对。请删掉这个旧图标，回到电脑端「手机收集」重新扫码，并在扫码打开的新页面里再添加到主屏幕一次。':'这台手机还没有配对。请先在电脑端「手机收集」页面扫一次二维码。');unpaired.style.display='block';field.disabled=true;button.disabled=true}async function redeemInstall(){if(pairingToken||!installTicket)return;const data=await post('/v1/mobile/install/redeem',{installTicket});pairingToken=data.pairingToken;localStorage.setItem(storageKey,pairingToken);history.replaceState({},'', '/app')}async function prepareInstallManifest(){if(!pairingToken||standalone)return;try{const data=await post('/v1/mobile/install-ticket',{pairingToken});if(data.install?.manifestUrl){manifestLink.href=data.install.manifestUrl;tip.textContent='已配对。现在可以把本页添加到手机主屏幕，从新图标启动仍会保持配对。'}}catch{tip.textContent='已配对，但安装凭据暂时准备失败。请保持本页打开后稍后再添加到主屏幕。'}}async function refresh(){if(!pairingToken)return;try{const data=await post('/v1/mobile/status',{pairingToken});render(data.submissions||[]);updated.textContent='刚刚更新'}catch(error){if(/\u914d\u5bf9|\u5931\u6548/.test(error.message))showUnpaired('这台手机的配对已失效。请在电脑端「手机收集」重新扫码。');updated.textContent='更新失败'}}async function initialize(){try{await redeemInstall()}catch(error){showUnpaired(error.message);return}if(!pairingToken){showUnpaired();return}field.disabled=false;button.disabled=false;void refresh();void prepareInstallManifest();setInterval(refresh,5000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh()})}void initialize();form.addEventListener('submit',async(event)=>{event.preventDefault();const value=field.value.trim();if(!value||!pairingToken)return;button.disabled=true;status.className='status';status.textContent='正在提交…';try{const data=await post('/v1/mobile/submissions',{pairingToken,url:value});status.className='status ok';status.textContent=data.duplicate?'这条链接已在收集箱中。':'已提交，电脑端会自动显示并处理。';if(!data.duplicate)field.value='';await refresh()}catch(error){status.className='status bad';status.textContent=error.message}finally{button.disabled=false}});
  </script></body></html>`;
}

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

async function initializeWorkspace(request, env) {
  if (!await ownerAuthorized(request, env)) return error("工作区初始化认证失败", 401, "OWNER_UNAUTHORIZED");
  const initializedAt = now();
  const reserved = await env.MOBILE_INBOX_DB.prepare(
    "INSERT OR IGNORE INTO workspace_state (id, initialized_at) VALUES ('default', ?)",
  ).bind(initializedAt).run();
  if (Number(reserved?.meta?.changes || 0) !== 1) {
    return error("工作区已经初始化，请使用一次性电脑入组码", 409, "WORKSPACE_ALREADY_INITIALIZED");
  }
  const body = await readBody(request);
  const deviceToken = token();
  const device = {
    id: id("device"),
    label: String(body.label || "管理员电脑").trim().slice(0, 80) || "管理员电脑",
    role: "admin",
    createdAt: initializedAt,
  };
  await env.MOBILE_INBOX_DB.prepare(
    "INSERT INTO desktop_devices (id, token_hash, label, role, created_at, last_seen_at) VALUES (?, ?, ?, 'admin', ?, ?)",
  ).bind(device.id, await hash(deviceToken), device.label, initializedAt, initializedAt).run();
  return json({ device, deviceToken }, 201);
}

async function createActivation(request, env) {
  const auth = await requireDevice(request, env, { admin: true });
  if (auth.response) return auth.response;
  const body = await readBody(request);
  const activationCode = token();
  const createdAt = now();
  const minutes = Math.max(5, Math.min(1440, Number(body.minutes) || 30));
  const activation = {
    id: id("activation"),
    label: String(body.label || "新电脑").trim().slice(0, 80) || "新电脑",
    createdAt,
    expiresAt: new Date(Date.now() + minutes * 60000).toISOString(),
  };
  await env.MOBILE_INBOX_DB.prepare(
    "INSERT INTO desktop_activation_codes (id, code_hash, label, created_at, expires_at, created_by_device_id) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(activation.id, await hash(activationCode), activation.label, createdAt, activation.expiresAt, auth.device.id).run();
  return json({ activation: { ...activation, code: activationCode } }, 201);
}

async function activateDevice(request, env) {
  const body = await readBody(request);
  const activationCode = String(body.activationCode || "").trim();
  if (!activationCode) return error("缺少一次性电脑入组码", 400, "ACTIVATION_CODE_REQUIRED");
  const codeHash = await hash(activationCode);
  const activation = await env.MOBILE_INBOX_DB.prepare(
    "SELECT id, label FROM desktop_activation_codes WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?",
  ).bind(codeHash, now()).first();
  if (!activation) return error("电脑入组码无效、已使用或已过期", 401, "ACTIVATION_INVALID");

  const deviceToken = token();
  const device = {
    id: id("device"),
    label: String(body.label || activation.label || "工作电脑").trim().slice(0, 80) || "工作电脑",
    role: "member",
    createdAt: now(),
  };
  await env.MOBILE_INBOX_DB.prepare(
    "INSERT INTO desktop_devices (id, token_hash, label, role, created_at, last_seen_at) VALUES (?, ?, ?, 'member', ?, ?)",
  ).bind(device.id, await hash(deviceToken), device.label, device.createdAt, device.createdAt).run();
  const consumed = await env.MOBILE_INBOX_DB.prepare(
    "UPDATE desktop_activation_codes SET consumed_at = ?, consumed_by_device_id = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?",
  ).bind(device.createdAt, device.id, activation.id, device.createdAt).run();
  if (Number(consumed?.meta?.changes || 0) !== 1) {
    await env.MOBILE_INBOX_DB.prepare("DELETE FROM desktop_devices WHERE id = ?").bind(device.id).run();
    return error("电脑入组码已被另一台电脑使用", 409, "ACTIVATION_ALREADY_USED");
  }
  return json({ device, deviceToken }, 201);
}

async function listDevices(request, env) {
  const auth = await requireDevice(request, env);
  if (auth.response) return auth.response;
  const results = await env.MOBILE_INBOX_DB.prepare(
    "SELECT id, label, role, created_at AS createdAt, last_seen_at AS lastSeenAt, revoked_at AS revokedAt FROM desktop_devices ORDER BY created_at ASC",
  ).all();
  return json({ currentDevice: auth.device, devices: results.results || [] });
}

async function revokeDevice(request, env, deviceId) {
  const auth = await requireDevice(request, env, { admin: true });
  if (auth.response) return auth.response;
  if (deviceId === auth.device.id) return error("不能在这里撤销当前管理员电脑", 400, "CANNOT_REVOKE_CURRENT_ADMIN");
  const revokedAt = now();
  const result = await env.MOBILE_INBOX_DB.prepare(
    "UPDATE desktop_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
  ).bind(revokedAt, deviceId).run();
  if (Number(result?.meta?.changes || 0) !== 1) return error("没有找到可撤销的电脑", 404, "DEVICE_NOT_FOUND");
  await env.MOBILE_INBOX_DB.prepare(
    "UPDATE mobile_submissions SET state='pending', claimed_by=NULL, claim_until=NULL, updated_at=? WHERE state='processing' AND claimed_by=?",
  ).bind(revokedAt, deviceId).run();
  return json({ revoked: true, id: deviceId });
}

async function createPairing(request, env) {
  const auth = await requireDevice(request, env);
  if (auth.response) return auth.response;
  const body = await readBody(request);
  const pairToken = token();
  const createdAt = now();
  // A paired phone keeps one stable Web App until the user explicitly revokes it.
  // The far-future value keeps compatibility with the existing NOT NULL schema.
  const expiresAt = "9999-12-31T23:59:59.999Z";
  const pairingId = id("pair");
  const label = String(body.label || "我的手机").trim().slice(0, 80) || "我的手机";
  await env.MOBILE_INBOX_DB.prepare(
    "INSERT INTO mobile_pairings (id, token_hash, label, created_at, expires_at, created_by_device_id) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(pairingId, await hash(pairToken), label, createdAt, expiresAt, auth.device.id).run();
  const url = new URL(request.url);
  return json({ pairing: {
    id: pairingId,
    label,
    createdAt,
    expiresAt,
    mobileUrl: `${url.origin}/p/${pairToken}`,
    webAppUrl: `${url.origin}/app`,
  } }, 201);
}

async function listPairings(request, env) {
  const auth = await requireDevice(request, env);
  if (auth.response) return auth.response;
  const results = await env.MOBILE_INBOX_DB.prepare(
    "SELECT id, label, created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt FROM mobile_pairings ORDER BY created_at DESC",
  ).all();
  return json({ pairings: results.results || [] });
}

async function revokePairing(request, env, pairingId) {
  const auth = await requireDevice(request, env);
  if (auth.response) return auth.response;
  await env.MOBILE_INBOX_DB.prepare("UPDATE mobile_pairings SET revoked_at = ? WHERE id = ?")
    .bind(now(), pairingId).run();
  return json({ revoked: true, id: pairingId });
}

async function createMobileInstallTicket(request, env) {
  const body = await readBody(request);
  const pairing = await pairingForToken(env, body?.pairingToken);
  if (!pairing) return error("此手机配对已失效，请在创作台重新配对", 401, "PAIRING_INVALID");
  const created = await createInstallTicket(env, pairing.id);
  const url = new URL(request.url);
  const encoded = encodeURIComponent(created.installTicket);
  return json({ install: {
    expiresAt: created.expiresAt,
    manifestUrl: `${url.origin}/manifest.webmanifest?ticket=${encoded}`,
  } }, 201);
}

async function redeemMobileInstallTicket(request, env) {
  const body = await readBody(request);
  const installTicket = String(body?.installTicket || "").trim();
  const ticketRow = await validInstallTicket(env, installTicket);
  if (!ticketRow) return error("这个主屏幕安装凭据已使用、已过期或配对已撤销，请在电脑端重新扫码", 401, "INSTALL_TICKET_INVALID");
  const consumedAt = now();
  const consumed = await env.MOBILE_INBOX_DB.prepare(
    "UPDATE mobile_install_tickets SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ? AND pairing_id IN (SELECT id FROM mobile_pairings WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?))",
  ).bind(consumedAt, ticketRow.id, consumedAt, consumedAt).run();
  if (Number(consumed?.meta?.changes || 0) !== 1) {
    return error("这个主屏幕安装凭据已经使用，请在电脑端重新扫码", 409, "INSTALL_TICKET_USED");
  }
  const pairingToken = token();
  const credentialId = id("credential");
  await env.MOBILE_INBOX_DB.prepare(
    "INSERT INTO mobile_pairing_credentials (id, pairing_id, token_hash, kind, created_at, last_seen_at) VALUES (?, ?, ?, 'pwa', ?, ?)",
  ).bind(credentialId, ticketRow.pairingId, await hash(pairingToken), consumedAt, consumedAt).run();
  await env.MOBILE_INBOX_DB.prepare(
    "UPDATE mobile_install_tickets SET credential_id = ? WHERE id = ?",
  ).bind(credentialId, ticketRow.id).run();
  return json({ pairingToken }, 201);
}

async function submitMobileLink(request, env) {
  const body = await readBody(request);
  const pairing = await pairingForToken(env, body?.pairingToken);
  if (!pairing) return error("此手机配对已失效，请在创作台重新配对", 401, "PAIRING_INVALID");
  let sourceUrl;
  let sourceKey;
  try {
    sourceUrl = new URL(firstHttpUrl(body.url)).toString();
    sourceKey = canonicalSourceKey(sourceUrl);
  } catch {
    return error("请输入有效的内容链接", 400, "INVALID_URL");
  }
  const existing = await env.MOBILE_INBOX_DB.prepare(
    "SELECT id, state, content_id AS contentId FROM mobile_submissions WHERE source_key = ?",
  ).bind(sourceKey).first();
  if (existing) return json({ submission: existing, duplicate: true });
  const submittedAt = now();
  const submission = { id: id("link"), sourceUrl, sourceKey, state: "pending", submittedAt };
  try {
    await env.MOBILE_INBOX_DB.prepare(
      "INSERT INTO mobile_submissions (id, pairing_id, source_key, source_url, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
    ).bind(submission.id, pairing.id, sourceKey, sourceUrl, submittedAt, submittedAt).run();
  } catch {
    const duplicate = await env.MOBILE_INBOX_DB.prepare(
      "SELECT id, state, content_id AS contentId FROM mobile_submissions WHERE source_key = ?",
    ).bind(sourceKey).first();
    if (duplicate) return json({ submission: duplicate, duplicate: true });
    throw new Error("手机链接保存失败");
  }
  return json({ submission, duplicate: false }, 201);
}

async function mobileSubmissionStatus(request, env) {
  const body = await readBody(request);
  const pairing = await pairingForToken(env, body?.pairingToken);
  if (!pairing) return error("此手机配对已失效，请在创作台重新配对", 401, "PAIRING_INVALID");
  const results = await env.MOBILE_INBOX_DB.prepare(
    "SELECT id, source_url AS sourceUrl, state, content_id AS contentId, error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt FROM mobile_submissions WHERE pairing_id = ? ORDER BY created_at DESC LIMIT 30",
  ).bind(pairing.id).all();
  return json({
    pairing: { id: pairing.id, label: pairing.label },
    submissions: results.results || [],
  });
}

async function claimSubmissions(request, env) {
  const auth = await requireDevice(request, env);
  if (auth.response) return auth.response;
  const body = await readBody(request);
  const limit = Math.max(1, Math.min(8, Number(body.limit) || 5));
  const claimStartedAt = now();
  const claimUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const candidates = await env.MOBILE_INBOX_DB.prepare(
    "SELECT id FROM mobile_submissions WHERE state = 'pending' OR (state = 'processing' AND (claim_until IS NULL OR claim_until < ?)) ORDER BY created_at ASC LIMIT ?",
  ).bind(claimStartedAt, limit * 2).all();
  const claimedIds = [];
  for (const row of candidates.results || []) {
    if (claimedIds.length >= limit) break;
    const claimed = await env.MOBILE_INBOX_DB.prepare(
      "UPDATE mobile_submissions SET state='processing', attempt=attempt+1, claimed_by=?, claim_until=?, updated_at=? WHERE id=? AND (state='pending' OR (state='processing' AND (claim_until IS NULL OR claim_until < ?)))",
    ).bind(auth.device.id, claimUntil, claimStartedAt, row.id, claimStartedAt).run();
    if (Number(claimed?.meta?.changes || 0) === 1) claimedIds.push(row.id);
  }
  const tasks = claimedIds.length
    ? await env.MOBILE_INBOX_DB.prepare(
      `SELECT id, source_url AS sourceUrl, source_key AS sourceKey, state, attempt, created_at AS createdAt FROM mobile_submissions WHERE id IN (${claimedIds.map(() => "?").join(",")}) AND claimed_by = ? ORDER BY created_at ASC`,
    ).bind(...claimedIds, auth.device.id).all()
    : { results: [] };
  return json({ tasks: tasks.results || [] });
}

async function completeSubmission(request, env) {
  const auth = await requireDevice(request, env);
  if (auth.response) return auth.response;
  const body = await readBody(request);
  const state = ["success", "waiting_login", "waiting_verification", "failed"].includes(body.state) ? body.state : "failed";
  const result = await env.MOBILE_INBOX_DB.prepare(
    "UPDATE mobile_submissions SET state=?, content_id=?, error_code=?, error_message=?, claim_until=NULL, updated_at=? WHERE id=? AND state='processing' AND claimed_by=?",
  ).bind(state, String(body.contentId || ""), String(body.errorCode || "").slice(0, 120), String(body.errorMessage || "").slice(0, 500), now(), String(body.id || ""), auth.device.id).run();
  if (Number(result?.meta?.changes || 0) !== 1) return error("此任务的领取权已失效", 409, "CLAIM_LOST");
  return json({ completed: true, id: body.id, state });
}

async function retrySubmission(request, env, submissionId) {
  const auth = await requireDevice(request, env);
  if (auth.response) return auth.response;
  await env.MOBILE_INBOX_DB.prepare(
    "UPDATE mobile_submissions SET state='pending', claimed_by=NULL, claim_until=NULL, error_code='', error_message='', updated_at=? WHERE id=?",
  ).bind(now(), submissionId).run();
  return json({ retried: true, id: submissionId });
}

async function inboxStatus(request, env) {
  const auth = await requireDevice(request, env);
  if (auth.response) return auth.response;
  const results = await env.MOBILE_INBOX_DB.prepare(
    "SELECT id, source_url AS sourceUrl, state, attempt, content_id AS contentId, error_code AS errorCode, error_message AS errorMessage, created_at AS createdAt, updated_at AS updatedAt FROM mobile_submissions ORDER BY created_at DESC LIMIT 100",
  ).all();
  return json({ currentDevice: auth.device, submissions: results.results || [] });
}

async function desktopDashboard(request, env) {
  const auth = await requireDevice(request, env);
  if (auth.response) return auth.response;
  const [submissions, pairings, devices] = await Promise.all([
    env.MOBILE_INBOX_DB.prepare(
      "SELECT id, source_url AS sourceUrl, state, attempt, content_id AS contentId, error_code AS errorCode, error_message AS errorMessage, created_at AS createdAt, updated_at AS updatedAt FROM mobile_submissions ORDER BY created_at DESC LIMIT 100",
    ).all(),
    env.MOBILE_INBOX_DB.prepare(
      "SELECT id, label, created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt FROM mobile_pairings ORDER BY created_at DESC",
    ).all(),
    env.MOBILE_INBOX_DB.prepare(
      "SELECT id, label, role, created_at AS createdAt, last_seen_at AS lastSeenAt, revoked_at AS revokedAt FROM desktop_devices ORDER BY created_at ASC",
    ).all(),
  ]);
  return json({
    currentDevice: auth.device,
    submissions: submissions.results || [],
    pairings: pairings.results || [],
    devices: devices.results || [],
  });
}

async function manifest(request, env) {
  const origin = new URL(request.url).origin;
  const installTicket = new URL(request.url).searchParams.get("ticket") || "";
  const ticketRow = await validInstallTicket(env, installTicket);
  const startUrl = ticketRow ? `/install/${encodeURIComponent(installTicket)}` : "/app";
  return new Response(JSON.stringify({
    id: `${origin}/app`,
    name: "Video Hub 手机链接收集箱",
    short_name: "Video Hub 收集",
    description: "随时把抖音、小红书等链接提交到电脑端 Video Hub。",
    start_url: startUrl,
    scope: "/",
    display: "standalone",
    background_color: "#f4f3ee",
    theme_color: "#f4f3ee",
  }), {
    headers: {
      ...JSON_HEADERS,
      "content-type": "application/manifest+json; charset=utf-8",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });
      if (request.method === "GET" && url.pathname === "/manifest.webmanifest") return manifest(request, env);
      if (request.method === "GET" && ["/", "/app"].includes(url.pathname)) {
        return new Response(mobilePage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      if (request.method === "GET" && url.pathname.startsWith("/p/")) {
        const pairToken = url.pathname.slice(3);
        const pairing = await pairingForToken(env, pairToken);
        if (!pairing) return new Response("配对已失效，请在创作台重新生成二维码。", { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
        const created = await createInstallTicket(env, pairing.id);
        return new Response(mobilePage({
          bootstrapToken: pairToken,
          manifestHref: `/manifest.webmanifest?ticket=${encodeURIComponent(created.installTicket)}`,
        }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      if (request.method === "GET" && url.pathname.startsWith("/install/")) {
        const installTicket = decodeURIComponent(url.pathname.slice("/install/".length));
        return new Response(mobilePage({ installTicket }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      if (request.method === "POST" && url.pathname === "/v1/workspace/initialize") return initializeWorkspace(request, env);
      if (request.method === "POST" && url.pathname === "/v1/desktop/activations") return createActivation(request, env);
      if (request.method === "POST" && url.pathname === "/v1/desktop/activate") return activateDevice(request, env);
      if (request.method === "GET" && url.pathname === "/v1/desktop/devices") return listDevices(request, env);
      if (request.method === "POST" && url.pathname.match(/^\/v1\/desktop\/devices\/[^/]+\/revoke$/)) return revokeDevice(request, env, decodeURIComponent(url.pathname.split("/")[4]));
      if (request.method === "POST" && url.pathname === "/v1/pairings") return createPairing(request, env);
      if (request.method === "GET" && url.pathname === "/v1/pairings") return listPairings(request, env);
      if (request.method === "POST" && url.pathname.match(/^\/v1\/pairings\/[^/]+\/revoke$/)) return revokePairing(request, env, decodeURIComponent(url.pathname.split("/")[3]));
      if (request.method === "POST" && url.pathname === "/v1/mobile/install-ticket") return createMobileInstallTicket(request, env);
      if (request.method === "POST" && url.pathname === "/v1/mobile/install/redeem") return redeemMobileInstallTicket(request, env);
      if (request.method === "POST" && url.pathname === "/v1/mobile/submissions") return submitMobileLink(request, env);
      if (request.method === "POST" && url.pathname === "/v1/mobile/status") return mobileSubmissionStatus(request, env);
      if (request.method === "GET" && url.pathname === "/v1/desktop/dashboard") return desktopDashboard(request, env);
      if (request.method === "POST" && url.pathname === "/v1/desktop/claim") return claimSubmissions(request, env);
      if (request.method === "POST" && url.pathname === "/v1/desktop/complete") return completeSubmission(request, env);
      if (request.method === "POST" && url.pathname.match(/^\/v1\/desktop\/submissions\/[^/]+\/retry$/)) return retrySubmission(request, env, decodeURIComponent(url.pathname.split("/")[4]));
      if (request.method === "GET" && url.pathname === "/v1/desktop/submissions") return inboxStatus(request, env);
      return error("找不到接口", 404, "NOT_FOUND");
    } catch (caught) {
      console.error("[mobile-inbox]", caught?.message || caught);
      return error("手机链接收集箱暂时不可用", 500, "MOBILE_INBOX_INTERNAL_ERROR");
    }
  },
};

export const mobileInboxWorkerTestables = {
  canonicalSourceKey,
  hash,
};
