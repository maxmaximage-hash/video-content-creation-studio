import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyAuthPage,
  createAuthCaptureManager,
  isRecoverableCdpError,
  matchesDedicatedBrowserCommand,
  normalizeHttpUrl,
  normalizePlatformCaptureUrl,
  resolveCanonicalAuthRoot,
} from "../server/auth-capture.mjs";

test("canonical auth root is explicit and never falls back to the project profile", () => {
  assert.equal(resolveCanonicalAuthRoot({ env: { VIDEO_CONTENT_AUTH_ROOT: "./isolated-auth" }, homeDir: "/Users/test", platform: "darwin" }), path.resolve("isolated-auth"));
  assert.equal(resolveCanonicalAuthRoot({ env: {}, homeDir: "/Users/test", platform: "darwin" }), "/Users/test/Library/Application Support/视频内容创作中台/auth-browser");
  assert.doesNotMatch(resolveCanonicalAuthRoot({ env: {}, homeDir: "/Users/test", platform: "darwin" }), /prototype\/\.auth-browser/);
});

test("auth health distinguishes login, challenge, authenticated and unavailable states", () => {
  assert.equal(classifyAuthPage({ platform: "douyin", url: "https://www.douyin.com/", bodyText: "扫码登录", cookies: [] }).authState, "login_required");
  assert.equal(classifyAuthPage({ platform: "douyin", url: "https://www.douyin.com/", bodyText: "请完成安全验证", cookies: [{ name: "sessionid", value: "secret" }] }).authState, "challenge");
  assert.equal(classifyAuthPage({ platform: "douyin", url: "https://www.douyin.com/", bodyText: "推荐 关注", cookies: [{ name: "sessionid", value: "secret" }] }).authState, "authenticated");
  assert.equal(classifyAuthPage({ platform: "xiaohongshu", status: 503 }).authState, "platform_unavailable");
  assert.equal(classifyAuthPage({ platform: "xiaohongshu", url: "https://www.xiaohongshu.com/explore", bodyText: "发现", cookies: [] }).authState, "login_required");
  assert.equal(classifyAuthPage({ platform: "douyin", url: "chrome://newtab/", cookies: [{ name: "sessionid", value: "secret" }] }).authState, "unknown");
  assert.equal(classifyAuthPage({ platform: "douyin", url: "https://www.douyin.com/video/1", title: "抖音", bodyText: "", cookies: [{ name: "sessionid", value: "secret" }] }).authState, "unknown");
  assert.equal(classifyAuthPage({ platform: "xiaohongshu", url: "https://www.xiaohongshu.com/explore/1", title: "小红书", bodyText: "", cookies: [{ name: "web_session", value: "secret" }] }).authState, "unknown");
});

test("cookie with only newtab remains session_unverified during a non-navigating probe", async (t) => {
  const authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "capture-newtab-auth-"));
  t.after(() => fs.rm(authRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(authRoot, "douyin"));
  const page = {
    url: () => "chrome://newtab/",
    context: () => context,
  };
  const context = {
    pages: () => [page],
    cookies: async () => [{ name: "sessionid", value: "memory-only" }],
  };
  const browser = { contexts: () => [context], newContext: async () => context };
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/json/version")) return new Response(JSON.stringify({ Browser: "mock" }), { status: 200 });
    if (String(url).endsWith("/json/list")) return new Response(JSON.stringify([{ url: page.url() }]), { status: 200 });
    throw new Error("unexpected request");
  };
  const manager = createAuthCaptureManager({
    authRoot,
    fetchImpl,
    loadPlaywright: async () => ({ chromium: { connectOverCDP: async () => browser } }),
  });

  const state = (await manager.status("douyin", { probe: true })).douyin;
  assert.equal(state.authState, "unknown");
  assert.equal(state.errorCode, "AUTH_SESSION_UNVERIFIED");
});

test("profile existence and CDP availability are not treated as authenticated", async (t) => {
  const authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "capture-auth-"));
  t.after(() => fs.rm(authRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(authRoot, "douyin"));
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/json/version")) return new Response(JSON.stringify({ Browser: "mock" }), { status: 200 });
    if (String(url).endsWith("/json/list")) return new Response(JSON.stringify([{ url: "https://www.douyin.com/video/1?token=secret" }]), { status: 200 });
    throw new Error("unexpected request");
  };
  const manager = createAuthCaptureManager({ authRoot, fetchImpl, spawnImpl: () => { throw new Error("must not spawn"); } });
  const state = (await manager.status("douyin")).douyin;
  assert.equal(state.hasProfile, true);
  assert.equal(state.browserState, "online");
  assert.equal(state.authState, "unknown");
  assert.deepEqual(state.activeUrls, ["https://www.douyin.com/video/1"]);
  assert.doesNotMatch(JSON.stringify(state), /secret|cookie|sessionid/i);
});

test("opaque browser targets never appear as null active URLs", async (t) => {
  const authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "capture-opaque-tabs-auth-"));
  t.after(() => fs.rm(authRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(authRoot, "douyin"));
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/json/version")) return new Response(JSON.stringify({ Browser: "mock" }), { status: 200 });
    if (String(url).endsWith("/json/list")) {
      return new Response(JSON.stringify([
        { url: "chrome://newtab/" },
        { url: "chrome-untrusted://new-tab-page/one-google-bar" },
        { url: "about:blank" },
        { type: "worker", url: "blob:https://www.douyin.com/worker" },
        { type: "service_worker", url: "https://www.douyin.com/sw.js" },
        { type: "page", url: "https://www.douyin.comhttps//broken" },
      ]), { status: 200 });
    }
    throw new Error("unexpected request");
  };
  const manager = createAuthCaptureManager({ authRoot, fetchImpl });
  const state = (await manager.status("douyin")).douyin;
  assert.deepEqual(state.activeUrls, []);
  assert.equal(state.authState, "unknown");
});

test("background challenge iframe target does not override a normal platform page", async (t) => {
  const authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "capture-background-frame-auth-"));
  t.after(() => fs.rm(authRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(authRoot, "douyin"));
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/json/version")) return new Response(JSON.stringify({ Browser: "mock" }), { status: 200 });
    if (String(url).endsWith("/json/list")) {
      return new Response(JSON.stringify([
        { type: "page", url: "https://www.douyin.com/video/7617795110478627401" },
        { type: "iframe", url: "https://lf-rc1.yhgfb-cn-static.com/obj/rc-verifycenter/rmc-nocaptcha/1.0.0.44/index.html" },
      ]), { status: 200 });
    }
    throw new Error("unexpected request");
  };
  const manager = createAuthCaptureManager({ authRoot, fetchImpl });
  const state = (await manager.status("douyin")).douyin;
  assert.equal(state.authState, "unknown");
  assert.equal(state.errorCode, "AUTH_NOT_CHECKED");
  assert.deepEqual(state.activeUrls, ["https://www.douyin.com/video/7617795110478627401"]);
});

function createBrowserFixture() {
  const page = {
    url: () => "https://www.douyin.com/video/1",
    title: async () => "抖音",
    locator: () => ({ innerText: async () => "推荐 关注" }),
    frames: () => [page],
    mainFrame: () => page,
    context: () => context,
    goto: async () => ({ status: () => 200 }),
    bringToFront: async () => {},
    isClosed: () => false,
  };
  const context = {
    pages: () => [page],
    cookies: async () => [{ name: "sessionid", value: "memory-only" }],
    newPage: async () => page,
  };
  const browser = {
    contexts: () => [context],
    newContext: async () => context,
    close: async () => {},
  };
  return { browser };
}

function createCdpFixture({ initialTabs, connectImpl }) {
  let online = true;
  let tabs = initialTabs;
  const calls = { spawns: 0, stops: 0, connects: 0, spawnArgs: [] };
  const fetchImpl = async (url) => {
    if (!online) throw new Error("offline");
    if (String(url).endsWith("/json/version")) return new Response(JSON.stringify({ Browser: "mock" }), { status: 200 });
    if (String(url).endsWith("/json/list")) return new Response(JSON.stringify(tabs), { status: 200 });
    throw new Error("unexpected request");
  };
  const chromium = {
    executablePath: () => "/mock/chromium",
    connectOverCDP: async () => {
      calls.connects += 1;
      return connectImpl(calls.connects);
    },
  };
  return {
    calls,
    fetchImpl,
    loadPlaywright: async () => ({ chromium }),
    spawnImpl: (_executable, args) => {
      calls.spawns += 1;
      calls.spawnArgs.push(args);
      online = true;
      tabs = [{ url: "https://www.douyin.com/?login=1" }];
      return { pid: 9001, unref() {}, kill() { online = false; } };
    },
    terminateDedicatedProcess: async () => {
      calls.stops += 1;
      online = false;
      tabs = [];
    },
  };
}

test("stale CDP with no pages relaunches once with the same canonical profile", async (t) => {
  const authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "capture-stale-auth-"));
  t.after(() => fs.rm(authRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(authRoot, "douyin"));
  const browser = createBrowserFixture();
  const cdp = createCdpFixture({
    initialTabs: [],
    connectImpl: async () => browser.browser,
  });
  const manager = createAuthCaptureManager({
    authRoot,
    ...cdp,
    sleep: async () => {},
  });

  const result = await manager.open({ platform: "douyin" });
  assert.equal(result.authState, "authenticated");
  assert.equal(cdp.calls.stops, 1);
  assert.equal(cdp.calls.spawns, 1);
  assert.equal(cdp.calls.connects, 1);
  assert.ok(cdp.calls.spawnArgs[0].includes(`--user-data-dir=${path.join(authRoot, "douyin")}`));
});

test("recoverable CDP connection failure triggers one relaunch and reconnect", async (t) => {
  const authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "capture-connect-auth-"));
  t.after(() => fs.rm(authRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(authRoot, "douyin"));
  const browser = createBrowserFixture();
  const cdp = createCdpFixture({
    initialTabs: [{ url: "https://www.douyin.com/video/1" }],
    connectImpl: async (attempt) => {
      if (attempt === 1) throw new Error("Protocol error (Browser.setDownloadBehavior): Browser context management is not supported");
      return browser.browser;
    },
  });
  const manager = createAuthCaptureManager({
    authRoot,
    ...cdp,
    sleep: async () => {},
  });

  const result = await manager.open({ platform: "douyin" });
  assert.equal(result.authState, "authenticated");
  assert.equal(cdp.calls.stops, 1);
  assert.equal(cdp.calls.spawns, 1);
  assert.equal(cdp.calls.connects, 2);
});

test("CDP recovery is bounded to one relaunch per operation", async (t) => {
  const authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "capture-bounded-auth-"));
  t.after(() => fs.rm(authRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(authRoot, "douyin"));
  const cdp = createCdpFixture({
    initialTabs: [{ url: "https://www.douyin.com/video/1" }],
    connectImpl: async () => {
      throw new Error("Protocol error (Browser.setDownloadBehavior): Browser context management is not supported");
    },
  });
  const manager = createAuthCaptureManager({
    authRoot,
    ...cdp,
    sleep: async () => {},
  });

  await assert.rejects(manager.open({ platform: "douyin" }), /context management is not supported/);
  assert.equal(cdp.calls.stops, 1);
  assert.equal(cdp.calls.spawns, 1);
  assert.equal(cdp.calls.connects, 2);
});

test("stale process matching requires both the dedicated port and canonical profile", () => {
  const expected = {
    port: 9331,
    userDataDir: "/tmp/auth-browser/douyin",
  };
  assert.equal(matchesDedicatedBrowserCommand(
    "/mock/chromium --remote-debugging-port=9331 --user-data-dir=/tmp/auth-browser/douyin",
    expected,
  ), true);
  assert.equal(matchesDedicatedBrowserCommand(
    "/mock/chromium --remote-debugging-port=9331 --user-data-dir=/Users/test/Chrome",
    expected,
  ), false);
  assert.equal(isRecoverableCdpError(new Error("Protocol error (Browser.setDownloadBehavior): Browser context management is not supported")), true);
  assert.equal(isRecoverableCdpError(new Error("invalid profile")), false);
});

test("cookie scopes reject local, relative and sanitized URLs while accepting protocol-relative media", () => {
  assert.equal(normalizeHttpUrl("/library-assets/content-units/I000014/media/images/01.jpg"), "");
  assert.equal(normalizeHttpUrl("images/01.jpg"), "");
  assert.equal(normalizeHttpUrl("https://cdn.test/a.jpg?token=[redacted]"), "");
  assert.equal(normalizeHttpUrl("https://cdn.test/a..."), "");
  assert.equal(normalizeHttpUrl("//sns-webpic-qc.xhscdn.com/a.jpg", { allowProtocolRelative: true }), "https://sns-webpic-qc.xhscdn.com/a.jpg");
});

test("Xiaohongshu discovery links normalize to explore for the logged browser", () => {
  const source = "https://www.xiaohongshu.com/discovery/item/6a0000000000000013000001?source=webshare&xsec_source=pc_share";
  assert.equal(
    normalizePlatformCaptureUrl(source, "xiaohongshu"),
    "https://www.xiaohongshu.com/explore/6a0000000000000013000001?source=webshare&xsec_source=pc_share",
  );
  assert.equal(normalizePlatformCaptureUrl(source, "douyin"), source);
});

test("authenticated headers never pass an invalid media URL to browserContext.cookies", async (t) => {
  const authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "capture-cookie-url-auth-"));
  t.after(() => fs.rm(authRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(authRoot, "xiaohongshu"));
  const cookieCalls = [];
  const page = {
    url: () => "https://www.xiaohongshu.com/explore",
    evaluate: async () => "fixture-agent",
  };
  const context = {
    pages: () => [page],
    cookies: async (urls) => {
      cookieCalls.push(urls);
      if (urls.some((url) => !/^https?:\/\//.test(url))) throw new Error("browserContext.cookies: Invalid URL");
      return [{ name: "web_session", value: "memory-only" }];
    },
  };
  const browser = { contexts: () => [context], newContext: async () => context };
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/json/version")) return new Response(JSON.stringify({ Browser: "mock" }), { status: 200 });
    if (String(url).endsWith("/json/list")) return new Response(JSON.stringify([{ url: page.url() }]), { status: 200 });
    throw new Error("unexpected request");
  };
  const manager = createAuthCaptureManager({
    authRoot,
    fetchImpl,
    loadPlaywright: async () => ({ chromium: { connectOverCDP: async () => browser } }),
  });

  const localHeaders = await manager.authenticatedHeaders(
    "xiaohongshu",
    "/library-assets/content-units/I000014/media/images/01.jpg",
    "https://www.xiaohongshu.com/discovery/item/6a0000000000000013000001?source=webshare",
  );
  assert.deepEqual(cookieCalls[0], ["https://www.xiaohongshu.com/"]);
  assert.equal(localHeaders.referer, "https://www.xiaohongshu.com/explore/6a0000000000000013000001?source=webshare");

  await manager.authenticatedHeaders("xiaohongshu", "//sns-webpic-qc.xhscdn.com/a.jpg");
  assert.deepEqual(cookieCalls[1], [
    "https://www.xiaohongshu.com/",
    "https://sns-webpic-qc.xhscdn.com/a.jpg",
  ]);
});

test("auth health prefers an authenticated Xiaohongshu page over stale challenge and login tabs", async (t) => {
  const authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "capture-health-pages-auth-"));
  t.after(() => fs.rm(authRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(authRoot, "xiaohongshu"));
  const makePage = ({ url, bodyText, cookies }) => {
    const page = {
      url: () => url,
      title: async () => "小红书",
      locator: () => ({ innerText: async () => bodyText }),
      frames: () => [page],
      mainFrame: () => page,
      context: () => context,
    };
    page.cookies = cookies;
    return page;
  };
  const pages = [
    makePage({ url: "https://www.xiaohongshu.com/explore?login=1", bodyText: "扫码登录", cookies: [] }),
    makePage({ url: "https://www.xiaohongshu.com/website-login/captcha", bodyText: "请完成安全验证", cookies: [{ name: "web_session", value: "memory-only" }] }),
    makePage({ url: "https://www.xiaohongshu.com/explore", bodyText: "发现 关注 我的", cookies: [{ name: "web_session", value: "memory-only" }] }),
  ];
  const context = {
    pages: () => pages,
    cookies: async () => [],
  };
  for (const page of pages) {
    page.context = () => ({
      cookies: async () => page.cookies,
    });
  }
  const browser = { contexts: () => [context], newContext: async () => context };
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/json/version")) return new Response(JSON.stringify({ Browser: "mock" }), { status: 200 });
    if (String(url).endsWith("/json/list")) return new Response(JSON.stringify(pages.map((page) => ({ url: page.url() }))), { status: 200 });
    throw new Error("unexpected request");
  };
  const manager = createAuthCaptureManager({
    authRoot,
    fetchImpl,
    loadPlaywright: async () => ({ chromium: { connectOverCDP: async () => browser } }),
  });

  const state = (await manager.status("xiaohongshu", { probe: true })).xiaohongshu;
  assert.equal(state.authState, "authenticated");
  assert.equal(state.needsUserAction, false);
});

function createCapturePageFixture({
  initialUrl = "https://www.douyin.com/video/1",
  gotoImpl = async () => ({ status: () => 200 }),
  bodyText = "推荐 关注 作品",
  frame = null,
} = {}) {
  let currentUrl = initialUrl;
  let frontCount = 0;
  let closed = false;
  const page = {
    url: () => currentUrl,
    title: async () => "抖音",
    locator: () => ({ innerText: async () => bodyText }),
    frames: () => frame ? [page, frame] : [page],
    mainFrame: () => page,
    context: () => context,
    goto: async (url) => {
      const response = await gotoImpl(url, (nextUrl) => { currentUrl = nextUrl; });
      if (response?.finalUrl) currentUrl = response.finalUrl;
      return response;
    },
    waitForTimeout: async () => {},
    content: async () => "<html><body>fixture</body></html>",
    evaluate: async () => [],
    on: () => {},
    off: () => {},
    bringToFront: async () => { frontCount += 1; },
    isClosed: () => closed,
    close: async () => { closed = true; },
    frontCount: () => frontCount,
  };
  const context = {
    pages: () => pages,
    cookies: async () => [{ name: "sessionid", value: "memory-only" }],
    newPage: async () => {
      const created = createCapturePageFixture().page;
      pages.push(created);
      return created;
    },
  };
  const pages = [page];
  return { page, context, pages };
}

async function captureManagerFixture(t, { pages, context }) {
  const authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "capture-operation-auth-"));
  t.after(() => fs.rm(authRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(authRoot, "douyin"));
  const browser = { contexts: () => [context], newContext: async () => context };
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/json/version")) return new Response(JSON.stringify({ Browser: "mock" }), { status: 200 });
    if (String(url).endsWith("/json/list")) return new Response(JSON.stringify(pages.map((page) => ({ url: page.url() }))), { status: 200 });
    throw new Error("unexpected request");
  };
  return createAuthCaptureManager({
    authRoot,
    fetchImpl,
    loadPlaywright: async () => ({ chromium: { connectOverCDP: async () => browser } }),
  });
}

test("capture navigation recovers from one Target closed error with one replacement page", async (t) => {
  let firstAttempts = 0;
  let replacementCount = 0;
  const first = createCapturePageFixture({
    gotoImpl: async () => {
      firstAttempts += 1;
      throw new Error("Target page, context or browser has been closed");
    },
  });
  const replacement = createCapturePageFixture();
  first.context.newPage = async () => {
    replacementCount += 1;
    first.pages.push(replacement.page);
    return replacement.page;
  };
  const manager = await captureManagerFixture(t, first);

  const result = await manager.capturePage("https://www.douyin.com/video/123", "douyin");
  assert.equal(result.authState, "authenticated");
  assert.equal(result.recoveryCount, 1);
  assert.equal(firstAttempts, 1);
  assert.equal(replacementCount, 1);
});

test("capture recovery is bounded and preserves a sanitized AUTH_CAPTURE_FAILED diagnostic", async (t) => {
  const first = createCapturePageFixture({
    gotoImpl: async () => {
      throw new Error("Target closed token=first-secret");
    },
  });
  const replacement = createCapturePageFixture({
    gotoImpl: async () => {
      throw new Error("Target closed token=second-secret");
    },
  });
  first.context.newPage = async () => {
    first.pages.push(replacement.page);
    return replacement.page;
  };
  const manager = await captureManagerFixture(t, first);

  const result = await manager.capturePage("https://www.douyin.com/video/123", "douyin");
  assert.equal(result.errorCode, "AUTH_CAPTURE_FAILED");
  assert.equal(result.causeCode, "CDP_TARGET_CLOSED");
  assert.equal(result.stage, "navigation");
  assert.equal(result.recoveryCount, 1);
  assert.match(result.error, /Target closed/);
  assert.doesNotMatch(JSON.stringify(result), /first-secret|second-secret/);
});

test("challenge URL or frame remains open, is focused, and returns challenge", async (t) => {
  const challengeFrame = {
    url: () => "https://rmc.bytedance.com/verify",
    locator: (selector) => selector === "body"
      ? {
          innerText: async () => "请完成安全验证",
          isVisible: async () => true,
          boundingBox: async () => ({ width: 520, height: 360 }),
        }
      : { count: async () => 1 },
  };
  const fixture = createCapturePageFixture({
    frame: challengeFrame,
    gotoImpl: async (_url, setUrl) => {
      setUrl("https://www.douyin.com/video/123");
      return { status: () => 200 };
    },
  });
  const manager = await captureManagerFixture(t, fixture);

  const result = await manager.capturePage("https://www.douyin.com/video/123", "douyin");
  assert.equal(result.authState, "challenge");
  assert.equal(result.errorCode, "AUTH_CHALLENGE");
  assert.equal(fixture.page.isClosed(), false);
  assert.equal(fixture.page.frontCount(), 1);
});

test("authenticated detail page ignores a hidden preloaded risk-control iframe", async (t) => {
  const hiddenFrame = {
    url: () => "https://lf-rc1.yhgfb-cn-static.com/obj/rc-verifycenter/rmc-nocaptcha/1.0.0.44/index.html",
    locator: (selector) => selector === "body"
      ? {
          innerText: async () => "请完成安全验证",
          isVisible: async () => false,
          boundingBox: async () => ({ width: 0, height: 0 }),
        }
      : { count: async () => 1 },
  };
  const fixture = createCapturePageFixture({
    frame: hiddenFrame,
    initialUrl: "https://www.douyin.com/video/7617795110478627401",
    bodyText: "作者 标题 点赞 评论 分享 作品",
  });
  const manager = await captureManagerFixture(t, fixture);

  const result = await manager.capturePage("https://www.douyin.com/video/7617795110478627401", "douyin");
  assert.equal(result.authState, "authenticated");
  assert.equal(result.hiddenChallengeFrames, 1);
  assert.equal(fixture.page.frontCount(), 0);
});

test("active capture challenge stays challenge even when an authenticated home tab exists", async (t) => {
  const capture = createCapturePageFixture({
    gotoImpl: async (_url, setUrl) => {
      setUrl("https://rmc.bytedance.com/verify");
      return { status: () => 200 };
    },
    bodyText: "请完成安全验证",
  });
  const home = createCapturePageFixture({
    initialUrl: "https://www.douyin.com/",
    bodyText: "推荐 关注 作品",
  });
  capture.pages.push(home.page);
  const manager = await captureManagerFixture(t, capture);

  const captured = await manager.capturePage("https://www.douyin.com/video/123", "douyin");
  assert.equal(captured.authState, "challenge");
  const probed = (await manager.status("douyin", { probe: true })).douyin;
  assert.equal(probed.authState, "challenge");
  assert.equal(probed.errorCode, "AUTH_CHALLENGE");
});
