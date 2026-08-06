import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  PLATFORM_ADAPTERS,
  platformAdapter,
  platformChallengeFromUrl,
  platformKeyFromValue,
} from "./platforms/index.mjs";
import { sanitizeDiagnostic } from "./extraction-quality.mjs";
import {
  canonicalProfileWorkUrl,
  normalizeProfileEntries,
  profileContainerSelector,
} from "./profile-scanner.mjs";

const execFileAsync = promisify(execFile);

export const AUTH_PLATFORMS = PLATFORM_ADAPTERS;

const RECOVERABLE_CDP_PATTERN = /Browser\.setDownloadBehavior|context management is not supported|ECONNRESET|ECONNREFUSED|Connection closed|browser has been closed|Target page.*closed|Target closed|Protocol error|net::ERR_ABORTED|Navigation interrupted/i;

export function isRecoverableCdpError(error) {
  return RECOVERABLE_CDP_PATTERN.test(String(error?.message || error || ""));
}

export function matchesDedicatedBrowserCommand(command, { port, userDataDir }) {
  const text = String(command || "");
  return text.includes(`--remote-debugging-port=${port}`)
    && text.includes(`--user-data-dir=${userDataDir}`);
}

export function authPlatformKey(value) {
  return platformKeyFromValue(value);
}

export function resolveCanonicalAuthRoot({
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) {
  if (env.VIDEO_CONTENT_AUTH_ROOT) return path.resolve(env.VIDEO_CONTENT_AUTH_ROOT);
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "视频内容创作中台", "auth-browser");
  }
  return path.join(homeDir, ".video-content-creation-studio", "auth-browser");
}

function safeUrl(value = "") {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return "";
  const parsed = new URL(normalized);
  return `${parsed.origin}${parsed.pathname}`;
}

export function normalizeHttpUrl(value, { allowProtocolRelative = false } = {}) {
  const text = String(value || "").trim();
  if (!text || /\[redacted\]|…|\.\.\./i.test(text)) return "";
  const candidate = allowProtocolRelative && text.startsWith("//") ? `https:${text}` : text;
  try {
    const parsed = new URL(candidate);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

export function normalizePlatformCaptureUrl(value, key) {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return "";
  return platformAdapter(key).normalizeCaptureUrl(normalized);
}

export function classifyAuthPage({
  platform,
  url = "",
  title = "",
  bodyText = "",
  cookies = [],
  status = 200,
} = {}) {
  const config = AUTH_PLATFORMS[platform];
  const visible = `${url}\n${title}\n${String(bodyText).slice(0, 5000)}`;
  const lastCheckedAt = new Date().toISOString();
  if (!config) {
    return { authState: "unknown", needsUserAction: false, errorCode: "AUTH_PLATFORM_UNKNOWN", lastCheckedAt };
  }
  if (config.challengeTextPattern.test(visible) || config.challengeUrlPattern.test(url)) {
    return { authState: "challenge", needsUserAction: true, errorCode: "AUTH_CHALLENGE", lastCheckedAt };
  }
  if (status >= 500 || status === 0) {
    return { authState: "platform_unavailable", needsUserAction: false, errorCode: "PLATFORM_UNAVAILABLE", lastCheckedAt };
  }
  const authenticatedCookie = cookies.some((cookie) => config.authenticatedCookies.test(String(cookie?.name || "")) && cookie?.value);
  let platformPageVisible = false;
  try {
    platformPageVisible = config.matchesHost(new URL(url).hostname)
      && config.authenticatedPagePattern.test(visible);
  } catch {}
  if (authenticatedCookie && platformPageVisible && !config.loginPattern.test(visible)) {
    return { authState: "authenticated", needsUserAction: false, errorCode: "", lastCheckedAt };
  }
  if (/login|passport/i.test(url) || config.loginPattern.test(visible) || (platformPageVisible && !authenticatedCookie)) {
    return { authState: "login_required", needsUserAction: true, errorCode: "AUTH_LOGIN_REQUIRED", lastCheckedAt };
  }
  return { authState: "unknown", needsUserAction: false, errorCode: "AUTH_SESSION_UNVERIFIED", lastCheckedAt };
}

export function createAuthCaptureManager(options = {}) {
  const platforms = options.platforms || AUTH_PLATFORMS;
  const authRoot = options.authRoot || resolveCanonicalAuthRoot(options.rootOptions);
  const fsApi = options.fsApi || fs;
  const fetchImpl = options.fetchImpl || fetch;
  const spawnImpl = options.spawnImpl || spawn;
  const execFileImpl = options.execFileImpl || execFileAsync;
  const killImpl = options.killImpl || process.kill.bind(process);
  const loadPlaywright = options.loadPlaywright || (() => import("playwright"));
  const now = options.now || (() => new Date());
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const sessions = new Map();
  const opening = new Map();
  const recovering = new Map();

  function platformConfig(key) {
    const config = platforms[key];
    if (!config) throw new Error("不支持的平台登录");
    return config;
  }

  function profilePath(key) {
    platformConfig(key);
    const target = path.resolve(authRoot, key);
    if (path.dirname(target) !== path.resolve(authRoot)) throw new Error("登录资料目录无效");
    return target;
  }

  // A platform's default CDP port is only trusted after this process launched it
  // or its listener can be matched to the canonical profile.  A different Chrome
  // instance can legitimately occupy the fixed port; never terminate that process.
  function sessionPort(key, session = sessions.get(key)) {
    const candidate = Number(session?.port);
    return Number.isInteger(candidate) && candidate > 0 ? candidate : platformConfig(key).port;
  }

  async function hasProfile(key) {
    try {
      return (await fsApi.stat(profilePath(key))).isDirectory();
    } catch {
      return false;
    }
  }

  async function cdpJson(port, endpoint) {
    const response = await fetchImpl(`http://127.0.0.1:${port}${endpoint}`);
    if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
    return response.json();
  }

  async function cdpOnline(key, port = sessionPort(key)) {
    try {
      await cdpJson(port, "/json/version");
      return true;
    } catch {
      return false;
    }
  }

  async function activeUrls(key, port = sessionPort(key)) {
    try {
      const tabs = await cdpJson(port, "/json/list");
      const config = platformConfig(key);
      return tabs
        .filter((tab) => !tab?.type || tab.type === "page")
        .map((tab) => safeUrl(tab.url))
        .filter((url) => {
          if (!url) return false;
          try {
            return config.matchesHost(new URL(url).hostname)
              || config.challengeUrlPattern.test(url);
          } catch {
            return false;
          }
        });
    } catch {
      return [];
    }
  }

  async function activeChallengeHealth(key, port = sessionPort(key)) {
    let targets = [];
    try {
      targets = await cdpJson(port, "/json/list");
    } catch {
      return null;
    }
    const hasTopLevelChallenge = targets.some((target) => (
      (!target?.type || target.type === "page")
      && platformChallengeFromUrl(safeUrl(target?.url), platforms) === key
    ));
    if (!hasTopLevelChallenge) return null;
    return {
      authState: "challenge",
      needsUserAction: true,
      errorCode: "AUTH_CHALLENGE",
      lastCheckedAt: now().toISOString(),
    };
  }

  async function cdpUsable(key, port = sessionPort(key)) {
    try {
      await cdpJson(port, "/json/version");
      const tabs = await cdpJson(port, "/json/list");
      return Array.isArray(tabs) && tabs.length > 0;
    } catch {
      return false;
    }
  }

  async function waitForCdp(key, timeoutMs = 12000, { usable = true, port = sessionPort(key) } = {}) {
    const started = Date.now();
    let lastError;
    while (Date.now() - started < timeoutMs) {
      try {
        const version = await cdpJson(port, "/json/version");
        if (!usable) return version;
        const tabs = await cdpJson(port, "/json/list");
        if (Array.isArray(tabs) && tabs.length > 0) return version;
        lastError = new Error("专用采集浏览器没有可用页面");
      } catch (error) {
        lastError = error;
      }
      await sleep(300);
    }
    throw lastError || new Error("专用采集浏览器未启动");
  }

  async function waitForCdpOffline(key, timeoutMs = 5000, port = sessionPort(key)) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!await cdpOnline(key, port)) return;
      await sleep(150);
    }
    throw new Error("专用采集浏览器旧会话未能停止");
  }

  async function listeningPids(port) {
    const result = await execFileImpl("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-t",
    ]).catch(() => ({ stdout: "" }));
    return String(result?.stdout || "")
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 1);
  }

  async function dedicatedListenerOwnedByProfile(key, port) {
    if (options.assumeDedicatedCdp) return true;
    const pids = await listeningPids(port);
    if (!pids.length) return false;
    for (const pid of pids) {
      const detail = await execFileImpl("ps", ["-p", String(pid), "-o", "command="]).catch(() => ({ stdout: "" }));
      if (matchesDedicatedBrowserCommand(detail?.stdout, { port, userDataDir: profilePath(key) })) return true;
    }
    return false;
  }

  async function availableFallbackPort(key) {
    const config = platformConfig(key);
    for (let offset = 100; offset < 300; offset += 1) {
      const port = config.port + offset;
      if (!(await listeningPids(port)).length) return port;
    }
    throw new Error("没有可用的专用采集浏览器端口，请关闭多余的浏览器窗口后重试");
  }

  async function stopDedicatedProcess(key, session) {
    const config = platformConfig(key);
    const port = sessionPort(key, session);
    if (options.terminateDedicatedProcess) {
      await options.terminateDedicatedProcess({
        key,
        port,
        userDataDir: profilePath(key),
        session,
      });
      await waitForCdpOffline(key, 5000, port);
      return;
    }

    if (session?.process?.pid) {
      session.process.kill?.("SIGTERM");
      await waitForCdpOffline(key, 5000, port);
      return;
    }

    const pids = await listeningPids(port);
    let stopped = false;
    for (const pid of pids) {
      const detail = await execFileImpl("ps", ["-p", String(pid), "-o", "command="]).catch(() => ({ stdout: "" }));
      if (!matchesDedicatedBrowserCommand(detail?.stdout, {
        port,
        userDataDir: profilePath(key),
      })) continue;
      killImpl(pid, "SIGTERM");
      stopped = true;
    }
    if (!stopped) throw new Error("检测到无法确认归属的浏览器端口，未执行重启");
    await waitForCdpOffline(key, 5000, port);
  }

  async function launchProcess(key, { port = platformConfig(key).port } = {}) {
    const config = platformConfig(key);
    const { chromium } = await loadPlaywright();
    const userDataDir = profilePath(key);
    await fsApi.mkdir(userDataDir, { recursive: true });
    const child = spawnImpl(chromium.executablePath(), [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,900",
      "--new-window",
      config.loginUrl,
    ], { detached: true, stdio: "ignore" });
    child.unref?.();
    await waitForCdp(key, 12000, { port });
    const session = { port, process: child, openedAt: now().toISOString() };
    sessions.set(key, session);
    return session;
  }

  async function restartDedicatedProcess(key) {
    if (recovering.has(key)) return recovering.get(key);
    const task = (async () => {
      const previous = sessions.get(key);
      sessions.delete(key);
      await previous?.browser?.close?.().catch(() => {});
      const port = sessionPort(key, previous);
      if (await cdpOnline(key, port)) {
        try {
          await stopDedicatedProcess(key, previous);
        } catch (error) {
          if (!/无法确认归属的浏览器端口/.test(String(error?.message || error))) throw error;
          return launchProcess(key, { port: await availableFallbackPort(key) });
        }
      }
      return launchProcess(key, { port });
    })().finally(() => recovering.delete(key));
    recovering.set(key, task);
    return task;
  }

  async function ensureProcess(key) {
    const config = platformConfig(key);
    const existing = sessions.get(key);
    if (existing && await cdpUsable(key, existing.port)) return { session: existing, recovered: false };
    sessions.delete(key);
    if (await cdpUsable(key, config.port) && await dedicatedListenerOwnedByProfile(key, config.port)) {
      const session = { port: config.port, process: null, openedAt: now().toISOString() };
      sessions.set(key, session);
      return { session, recovered: false };
    }
    if (await cdpOnline(key, config.port)) {
      if (await dedicatedListenerOwnedByProfile(key, config.port)) {
        return { session: await restartDedicatedProcess(key), recovered: true };
      }
      return { session: await launchProcess(key, { port: await availableFallbackPort(key) }), recovered: true };
    }
    return { session: await launchProcess(key), recovered: false };
  }

  async function contextFor(key, { start = false } = {}) {
    if (!start && !await cdpUsable(key)) return null;
    let recovered = false;
    let session;
    if (start) {
      ({ session, recovered } = await ensureProcess(key));
    } else {
      session = sessions.get(key) || { port: platformConfig(key).port, process: null, openedAt: "" };
    }
    sessions.set(key, session);
    if (session.context) return session.context;
    const connect = async () => {
      const { chromium } = await loadPlaywright();
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${session.port}`);
      const context = browser.contexts()[0] || await browser.newContext({ locale: "zh-CN" });
      session.browser = browser;
      session.context = context;
      return context;
    };
    try {
      return await connect();
    } catch (error) {
      if (!start || recovered || !isRecoverableCdpError(error)) throw error;
      session = await restartDedicatedProcess(key);
      sessions.set(key, session);
      return connect();
    }
  }

  function pageMatchesPlatform(key, page) {
    try {
      const pageHost = new URL(page.url()).hostname;
      return platformConfig(key).matchesHost(pageHost);
    } catch {
      return false;
    }
  }

  function pageMatchesChallenge(key, page) {
    return platformConfig(key).challengeUrlPattern.test(String(page?.url?.() || ""));
  }

  async function visibleChallengeFrame(config, frame) {
    const frameUrl = String(frame?.url?.() || "");
    const body = frame.locator("body");
    const frameText = await body.innerText({ timeout: 1200 }).catch(() => "");
    if (!config.challengeUrlPattern.test(frameUrl) && !config.challengeTextPattern.test(frameText)) {
      return { visible: false, preloaded: false };
    }
    const isVisible = await Promise.resolve(body.isVisible?.({ timeout: 800 })).catch(() => false);
    const box = await Promise.resolve(body.boundingBox?.({ timeout: 800 })).catch(() => null);
    const controls = frame.locator("button,input,[role=button],[tabindex]");
    const interactiveCount = await Promise.resolve(controls.count?.()).catch(() => 0);
    const hasMeaningfulSize = Boolean(box && box.width >= 80 && box.height >= 40);
    return {
      visible: isVisible && hasMeaningfulSize && (interactiveCount > 0 || config.challengeTextPattern.test(frameText)),
      preloaded: true,
    };
  }

  async function inspectPage(key, page, responseStatus = 200) {
    const config = platformConfig(key);
    const url = page.url();
    const title = await page.title().catch(() => "");
    const bodyText = await page.locator("body").innerText({ timeout: 8000 }).catch(() => "");
    let visibleFrameChallenge = false;
    let hiddenChallengeFrames = 0;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const challenge = await visibleChallengeFrame(config, frame);
      if (challenge.visible) visibleFrameChallenge = true;
      else if (challenge.preloaded) hiddenChallengeFrames += 1;
    }
    const cookies = await page.context().cookies(config.referer).catch(() => []);
    const classified = classifyAuthPage({
        platform: key,
        url,
        title,
        bodyText,
        cookies,
        status: responseStatus,
      });
    const health = visibleFrameChallenge
      ? {
          authState: "challenge",
          needsUserAction: true,
          errorCode: "AUTH_CHALLENGE",
          lastCheckedAt: now().toISOString(),
        }
      : classified;
    return {
      ...health,
      url: safeUrl(url),
      title: String(title).slice(0, 120),
      bodyText,
      hiddenChallengeFrames,
    };
  }

  async function probe(key) {
    const config = platformConfig(key);
    if (!await hasProfile(key)) {
      return { authState: "login_required", needsUserAction: true, errorCode: "AUTH_PROFILE_MISSING", lastCheckedAt: now().toISOString() };
    }
    if (!await cdpOnline(key)) {
      return { authState: "unknown", needsUserAction: false, errorCode: "AUTH_BROWSER_OFFLINE", lastCheckedAt: now().toISOString() };
    }
    try {
      const context = await contextFor(key);
      if (!context) {
        return { authState: "unknown", needsUserAction: false, errorCode: "AUTH_BROWSER_OFFLINE", lastCheckedAt: now().toISOString() };
      }
      const capturePage = sessions.get(key)?.capturePage;
      if (capturePage && !capturePage.isClosed() && (pageMatchesPlatform(key, capturePage) || pageMatchesChallenge(key, capturePage))) {
        const captureHealth = await inspectPage(key, capturePage);
        if (captureHealth.authState === "challenge") {
          sessions.get(key).lastHealth = captureHealth;
          return captureHealth;
        }
      }
      const pages = context.pages().filter((page) => (
        pageMatchesPlatform(key, page) || pageMatchesChallenge(key, page)
      ));
      let health;
      if (!pages.length) {
        health = {
          authState: "unknown",
          needsUserAction: false,
          errorCode: "AUTH_SESSION_UNVERIFIED",
          lastCheckedAt: now().toISOString(),
        };
      } else {
        const states = [];
        for (const page of pages) states.push(await inspectPage(key, page));
        health = states.find((item) => item.authState === "authenticated")
          || states.find((item) => item.authState === "challenge")
          || states.find((item) => item.authState === "login_required")
          || states[0];
      }
      sessions.get(key).lastHealth = health;
      return health;
    } catch (error) {
      const challenge = await activeChallengeHealth(key);
      if (challenge) {
        if (sessions.get(key)) sessions.get(key).lastHealth = challenge;
        return challenge;
      }
      return { authState: "platform_unavailable", needsUserAction: false, errorCode: "AUTH_HEALTH_FAILED", lastCheckedAt: now().toISOString(), error: error.message };
    }
  }

  async function status(key = "", { probe: shouldProbe = false } = {}) {
    const keys = key ? [key] : Object.keys(platforms);
    const result = {};
    for (const item of keys) {
      const config = platformConfig(item);
      const profile = await hasProfile(item);
      const online = await cdpOnline(item);
      let health = sessions.get(item)?.lastHealth || {
        authState: profile ? "unknown" : "login_required",
        needsUserAction: !profile,
        errorCode: profile ? "AUTH_NOT_CHECKED" : "AUTH_PROFILE_MISSING",
        lastCheckedAt: "",
      };
      if (shouldProbe && online) health = await probe(item);
      const activeChallenge = online ? await activeChallengeHealth(item) : null;
      if (activeChallenge && health.authState !== "authenticated") health = activeChallenge;
      result[item] = {
        label: config.label,
        hasProfile: profile,
        browserState: online ? "online" : "offline",
        authState: health.authState,
        needsUserAction: Boolean(health.needsUserAction),
        lastCheckedAt: health.lastCheckedAt || "",
        errorCode: health.errorCode || "",
        causeCode: health.causeCode || "",
        stage: health.stage || "",
        error: sanitizeDiagnostic(health.error || ""),
        finalUrl: safeUrl(health.finalUrl || health.url || ""),
        activeUrls: online ? await activeUrls(item) : [],
        openedAt: sessions.get(item)?.openedAt || "",
      };
    }
    return result;
  }

  async function open(payload = {}) {
    const key = authPlatformKey(payload.platform);
    platformConfig(key);
    if (opening.has(key)) return opening.get(key);
    const task = (async () => {
      const config = platformConfig(key);
      const context = await contextFor(key, { start: true });
      const pages = context.pages().filter((page) => (
        pageMatchesPlatform(key, page) || pageMatchesChallenge(key, page)
      ));
      const inspected = [];
      for (const page of pages) inspected.push({ page, health: await inspectPage(key, page) });
      const selected = inspected.find((item) => item.health.authState === "challenge")
        || inspected.find((item) => item.health.authState === "authenticated")
        || inspected[0];
      const page = selected?.page || await context.newPage();
      let health = selected?.health || null;
      if (!health || !["authenticated", "challenge"].includes(health.authState)) {
        await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
        health = await inspectPage(key, page);
      }
      await page.bringToFront();
      sessions.get(key).lastHealth = health;
      sessions.get(key).capturePage = page;
      return {
        platform: key,
        label: config.label,
        status: health.authState === "authenticated"
          ? `${config.label}登录会话已可用`
          : "登录窗口已打开，请完成登录或安全验证",
        ...(await status(key))[key],
      };
    })().finally(() => opening.delete(key));
    opening.set(key, task);
    return task;
  }

  async function capturePage(url, key) {
    const config = platformConfig(key);
    const requestedPlatform = authPlatformKey(url);
    if (!requestedPlatform || requestedPlatform !== key) {
      return {
        authState: "unknown",
        needsUserAction: false,
        errorCode: "AUTH_PLATFORM_MISMATCH",
        error: `采集平台不匹配：${key}`,
      };
    }
    const navigationUrl = normalizePlatformCaptureUrl(url, key);
    if (!navigationUrl) {
      return {
        authState: "unknown",
        needsUserAction: false,
        errorCode: "AUTH_URL_INVALID",
        error: "采集链接无效，请重新复制完整链接",
      };
    }
    if (!await hasProfile(key)) {
      return { authState: "login_required", needsUserAction: true, errorCode: "AUTH_PROFILE_MISSING" };
    }
    let stage = "context";
    let finalUrl = "";
    let recoveryCount = 0;
    let replacePageOnRetry = false;
    const captureAttempt = async ({ forceNewPage = false } = {}) => {
      stage = "context";
      const context = await contextFor(key, { start: true });
      if (!context) throw new Error("专用采集浏览器离线");
      const session = sessions.get(key);
      let page = forceNewPage ? null : session.capturePage;
      if (!page || page.isClosed()) {
        page = !forceNewPage
          ? context.pages().find((candidate) => pageMatchesPlatform(key, candidate) && !candidate.isClosed())
          : null;
        page ||= await context.newPage();
        session.capturePage = page;
      }
      const responseJsonCandidates = [];
      const onResponse = async (response) => {
        if (!config.responsePattern.test(response.url()) || response.status() !== 200) return;
        try {
          const text = await response.text();
          if (text.trim().startsWith("{")) responseJsonCandidates.push(JSON.parse(text));
        } catch {}
      };
      page.on("response", onResponse);
      try {
        stage = "navigation";
        const response = await page.goto(navigationUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
        finalUrl = page.url();
        stage = "page_settle";
        await page.waitForTimeout(6500);
        stage = "page_inspection";
        const health = await inspectPage(key, page, response?.status() || 200);
        sessions.get(key).lastHealth = health;
        finalUrl = page.url();
        const html = await page.content();
        const resources = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name).slice(-300)).catch(() => []);
        const rawMediaSnapshot = await page.evaluate(() => ({
          videos: Array.from(document.querySelectorAll("video")).map((item) => ({
            src: item.currentSrc || item.src || "",
            poster: item.poster || "",
            duration: Number.isFinite(item.duration) && item.duration > 0 ? Math.round(item.duration) : "",
          })).filter((item) => item.src || item.poster),
          images: Array.from(document.querySelectorAll("img")).slice(0, 300).map((item) => ({
            src: item.currentSrc || item.src || "",
            alt: item.alt || "",
          })).filter((item) => item.src),
        })).catch(() => ({ videos: [], images: [] }));
        const mediaSnapshot = {
          videos: Array.isArray(rawMediaSnapshot?.videos) ? rawMediaSnapshot.videos : [],
          images: Array.isArray(rawMediaSnapshot?.images) ? rawMediaSnapshot.images : [],
        };
        const videoDuration = mediaSnapshot.videos.find((item) => item.duration)?.duration || "";
        if (health.needsUserAction) await page.bringToFront();
        return {
          ...health,
          html,
          finalUrl,
          bodyText: health.bodyText,
          resources,
          mediaSnapshot,
          videoDuration,
          responseJsonCandidates,
          recoveryCount,
        };
      } finally {
        page.off("response", onResponse);
      }
    };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await captureAttempt({ forceNewPage: attempt > 1 && replacePageOnRetry });
      } catch (error) {
        const context = await contextFor(key).catch(() => null);
        const candidatePages = context?.pages?.().filter((page) => (
          pageMatchesPlatform(key, page) || pageMatchesChallenge(key, page)
        )) || [];
        for (const candidate of candidatePages) {
          const health = await inspectPage(key, candidate).catch(() => null);
          if (health?.authState !== "challenge") continue;
          await candidate.bringToFront().catch(() => {});
          sessions.get(key).capturePage = candidate;
          sessions.get(key).lastHealth = health;
          return { ...health, finalUrl: candidate.url(), recoveryCount };
        }
        if (attempt === 1 && isRecoverableCdpError(error)) {
          recoveryCount = 1;
          const session = sessions.get(key);
          replacePageOnRetry = /Target page.*closed|Target closed|browser has been closed/i.test(String(error?.message || error));
          if (session) {
            if (replacePageOnRetry) session.capturePage = null;
            if (/Connection closed|browser has been closed|Protocol error|ECONNRESET|ECONNREFUSED/i.test(String(error?.message || error))) {
              session.context = null;
              session.browser = null;
            }
          }
          continue;
        }
        const message = sanitizeDiagnostic(error?.message || String(error));
        const causeCode = /Target page.*closed|Target closed/i.test(message)
          ? "CDP_TARGET_CLOSED"
          : /net::ERR_ABORTED|Navigation interrupted/i.test(message)
            ? "NAVIGATION_ABORTED"
            : /Protocol error|Connection closed|ECONNRESET|ECONNREFUSED/i.test(message)
              ? "CDP_CONNECTION_FAILED"
              : "CAPTURE_OPERATION_FAILED";
        const failure = {
          authState: "unknown",
          needsUserAction: false,
          errorCode: "AUTH_CAPTURE_FAILED",
          causeCode,
          stage,
          error: message,
          finalUrl: safeUrl(finalUrl),
          recoveryCount,
          evidence: [{
            stage,
            errorCode: "AUTH_CAPTURE_FAILED",
            causeCode,
            message,
            finalUrl: safeUrl(finalUrl),
            attempt,
          }],
          lastCheckedAt: now().toISOString(),
        };
        if (sessions.get(key)) sessions.get(key).lastHealth = failure;
        return failure;
      }
    }
    throw new Error("不可达的采集恢复状态");
  }

  async function authenticatedHeaders(key, url, referer = "") {
    const context = await contextFor(key);
    if (!context) return {};
    const config = platformConfig(key);
    const mediaUrl = normalizeHttpUrl(url, { allowProtocolRelative: true });
    const cookieUrls = [...new Set([config.referer, mediaUrl].filter(Boolean))];
    const cookies = await context.cookies(cookieUrls);
    const page = context.pages()[0];
    const userAgent = page
      ? await page.evaluate(() => navigator.userAgent).catch(() => "")
      : "";
    const safeReferer = normalizePlatformCaptureUrl(referer, key)
      || normalizeHttpUrl(referer)
      || config.referer;
    return {
      ...(cookies.length ? { cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") } : {}),
      ...(userAgent ? { "user-agent": userAgent } : {}),
      referer: safeReferer,
    };
  }

  async function scanProfile(url, key, options = {}) {
    const navigationUrl = normalizePlatformCaptureUrl(url, key);
    if (!navigationUrl) throw new Error("主页链接无效");
    if (!await hasProfile(key)) {
      return { authState: "login_required", needsUserAction: true, errorCode: "AUTH_PROFILE_MISSING", candidates: [] };
    }
    const context = await contextFor(key, { start: true });
    const session = sessions.get(key);
    let page = session.profilePage;
    if (!page || page.isClosed()) {
      page = await context.newPage();
      session.profilePage = page;
    }
    const response = await page.goto(navigationUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3500);
    const health = await inspectPage(key, page, response?.status() || 200);
    if (health.needsUserAction || health.authState !== "authenticated") {
      await page.bringToFront();
      return { ...health, candidates: [], finalUrl: page.url() };
    }
    const directWorkUrl = canonicalProfileWorkUrl(key, page.url());
    if (directWorkUrl) {
      return {
        authState: "authenticated",
        needsUserAction: false,
        errorCode: "",
        finalUrl: page.url(),
        endedBy: "single_work",
        mode: "single_work",
        candidates: [{
          url: directWorkUrl,
          title: String(health.title || "").trim().slice(0, 160),
          coverUrl: "",
        }],
      };
    }
    const found = new Map();
    const maxRounds = Math.max(5, Math.min(Number(options.maxRounds) || 120, 300));
    const maxItems = Math.max(1, Math.min(Number(options.maxItems) || 5000, 20000));
    let stableRounds = 0;
    let previousHeight = 0;
    let endedBy = "limit";
    for (let round = 1; round <= maxRounds && found.size < maxItems; round += 1) {
      const selector = profileContainerSelector(key);
      const snapshot = await page.evaluate((containerSelector) => {
        const container = document.querySelector(containerSelector) || document.body;
        const anchors = Array.from(container.querySelectorAll("a[href]"));
        const entries = anchors.slice(0, 10000).map((anchor) => {
          const image = anchor.querySelector("img");
          return {
            href: anchor.href || anchor.getAttribute("href") || "",
            text: (anchor.innerText || anchor.textContent || image?.alt || "").trim(),
            coverUrl: image?.currentSrc || image?.src || "",
            profileMatch: container !== document.body,
          };
        });
        const scrolling = document.scrollingElement || document.documentElement;
        return { entries, height: scrolling.scrollHeight, top: scrolling.scrollTop, viewport: window.innerHeight };
      }, selector);
      for (const candidate of normalizeProfileEntries(key, snapshot.entries, page.url())) found.set(candidate.url, candidate);
      options.onProgress?.({ round, foundCount: found.size, scrollHeight: snapshot.height });
      const atBottom = snapshot.top + snapshot.viewport >= snapshot.height - 24;
      stableRounds = snapshot.height === previousHeight && atBottom ? stableRounds + 1 : 0;
      previousHeight = snapshot.height;
      if (stableRounds >= 4) {
        endedBy = "end";
        break;
      }
      await page.evaluate(() => window.scrollBy({ top: Math.max(window.innerHeight * 0.88, 720), behavior: "smooth" }));
      await page.waitForTimeout(Math.max(700, Math.min(Number(options.intervalMs) || 1400, 5000)));
    }
    return {
      authState: "authenticated",
      needsUserAction: false,
      errorCode: "",
      finalUrl: page.url(),
      endedBy,
      mode: "profile",
      candidates: [...found.values()],
    };
  }

  return {
    authRoot,
    hasProfile,
    open,
    probe,
    status,
    capturePage,
    authenticatedHeaders,
    scanProfile,
  };
}
