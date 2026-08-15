import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import mobileInboxWorker, { mobileInboxWorkerTestables } from "../mobile-inbox/worker.js";
import { createMobileInboxService, mobileInboxTestables } from "../server/mobile-inbox-service.mjs";
import { syncMobileInbox } from "../vite.config.mjs";

class D1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) || null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

function createD1() {
  const database = new DatabaseSync(":memory:");
  return {
    database,
    prepare(sql) {
      return new D1Statement(database, sql);
    },
  };
}

async function workerEnvironment() {
  const d1 = createD1();
  d1.database.exec(await fs.readFile(new URL("../mobile-inbox/schema.sql", import.meta.url), "utf8"));
  return {
    env: { MOBILE_INBOX_DB: d1, OWNER_API_TOKEN: "owner-test-secret" },
    close: () => d1.database.close(),
  };
}

async function call(env, path, { method = "GET", token = "", body } = {}) {
  const response = await mobileInboxWorker.fetch(new Request(`https://mobile.test${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  return { response, data: await response.json().catch(() => ({})) };
}

async function provisionTwoDevices(env) {
  const initialized = await call(env, "/v1/workspace/initialize", {
    method: "POST",
    token: "owner-test-secret",
    body: { label: "管理员 Mac" },
  });
  assert.equal(initialized.response.status, 201);
  const adminToken = initialized.data.deviceToken;
  const activation = await call(env, "/v1/desktop/activations", {
    method: "POST",
    token: adminToken,
    body: { label: "公司 Mac", minutes: 30 },
  });
  assert.equal(activation.response.status, 201);
  const joined = await call(env, "/v1/desktop/activate", {
    method: "POST",
    body: { activationCode: activation.data.activation.code, label: "公司 Mac" },
  });
  assert.equal(joined.response.status, 201);
  return {
    adminToken,
    adminDevice: initialized.data.device,
    memberToken: joined.data.deviceToken,
    memberDevice: joined.data.device,
    activationCode: activation.data.activation.code,
  };
}

async function createMobileSubmission(env, deviceToken, url) {
  const pairing = await call(env, "/v1/pairings", {
    method: "POST",
    token: deviceToken,
    body: { label: "测试手机" },
  });
  assert.equal(pairing.response.status, 201);
  const pairingToken = new URL(pairing.data.pairing.mobileUrl).pathname.split("/").at(-1);
  const submission = await call(env, "/v1/mobile/submissions", {
    method: "POST",
    body: { pairingToken, url },
  });
  assert.equal(submission.response.status, 201);
  return { pairing: pairing.data.pairing, pairingToken, submission: submission.data.submission };
}

test("phone QR prepares a one-use standalone install without iOS focus zoom", async (t) => {
  const setup = await workerEnvironment();
  t.after(setup.close);
  const devices = await provisionTwoDevices(setup.env);
  const pairing = await call(setup.env, "/v1/pairings", {
    method: "POST",
    token: devices.adminToken,
    body: { label: "我的手机" },
  });
  assert.equal(pairing.response.status, 201);
  assert.equal(pairing.data.pairing.webAppUrl, "https://mobile.test/app");
  assert.equal(pairing.data.pairing.expiresAt.startsWith("9999-"), true);
  const pairingToken = new URL(pairing.data.pairing.mobileUrl).pathname.split("/").at(-1);

  const bootstrap = await mobileInboxWorker.fetch(new Request(pairing.data.pairing.mobileUrl), setup.env);
  const bootstrapHtml = await bootstrap.text();
  assert.equal(bootstrap.status, 200);
  assert.match(bootstrapHtml, /localStorage\.setItem\(storageKey,bootstrapToken\)/);
  assert.match(bootstrapHtml, /history\.replaceState\(\{\},'', '\/app'\)/);
  assert.match(bootstrapHtml, /不需要重复扫码/);
  assert.match(bootstrapHtml, /textarea\{[^}]*font-family:inherit;[^}]*font-size:16px;[^}]*line-height:1\.55/);
  assert.match(bootstrapHtml, /-webkit-text-size-adjust:100%/);
  assert.doesNotMatch(bootstrapHtml, /font:16px\/1\.55 inherit/);
  assert.doesNotMatch(bootstrapHtml, /maximum-scale|user-scalable=no/);
  assert.match(bootstrapHtml, /请删掉这个旧图标/);

  const manifestPath = bootstrapHtml.match(/id="app-manifest" rel="manifest" href="([^"]+)"/)?.[1];
  assert.ok(manifestPath?.startsWith("/manifest.webmanifest?ticket="));
  const installTicket = new URL(`https://mobile.test${manifestPath}`).searchParams.get("ticket");
  assert.ok(installTicket);
  const manifestResponse = await mobileInboxWorker.fetch(new Request(`https://mobile.test${manifestPath}`), setup.env);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.start_url, `/install/${installTicket}`);
  assert.equal(JSON.stringify(manifest).includes(pairingToken), false);

  // A standalone PWA starts with isolated storage. Its install page carries only
  // the short-lived ticket and exchanges it for a new credential in that context.
  const standalonePage = await mobileInboxWorker.fetch(new Request(`https://mobile.test${manifest.start_url}`), setup.env);
  const standaloneHtml = await standalonePage.text();
  assert.match(standaloneHtml, new RegExp(`const installTicket=${JSON.stringify(installTicket)}`));
  assert.match(standaloneHtml, /const bootstrapToken=""/);
  const redeemed = await call(setup.env, "/v1/mobile/install/redeem", {
    method: "POST",
    body: { installTicket },
  });
  assert.equal(redeemed.response.status, 201);
  assert.notEqual(redeemed.data.pairingToken, pairingToken);
  const reusedTicket = await call(setup.env, "/v1/mobile/install/redeem", {
    method: "POST",
    body: { installTicket },
  });
  assert.equal(reusedTicket.response.status, 401);
  assert.equal(reusedTicket.data.code, "INSTALL_TICKET_INVALID");

  const fixedApp = await mobileInboxWorker.fetch(new Request("https://mobile.test/app"), setup.env);
  assert.equal(fixedApp.status, 200);
  assert.match(await fixedApp.text(), /手机链接收集箱/);

  const submitted = await call(setup.env, "/v1/mobile/submissions", {
    method: "POST",
    body: {
      pairingToken: redeemed.data.pairingToken,
      url: "5.30 复制此链接 https://v.douyin.com/example-share/ 打开抖音查看！",
    },
  });
  assert.equal(submitted.response.status, 201);
  assert.equal(submitted.data.submission.sourceUrl, "https://v.douyin.com/example-share/");

  const mobileStatus = await call(setup.env, "/v1/mobile/status", {
    method: "POST",
    body: { pairingToken: redeemed.data.pairingToken },
  });
  assert.equal(mobileStatus.response.status, 200);
  assert.equal(mobileStatus.data.submissions.length, 1);
  assert.equal(mobileStatus.data.submissions[0].state, "pending");

  const dashboard = await call(setup.env, "/v1/desktop/dashboard", { token: devices.memberToken });
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.data.submissions.length, 1);
  assert.equal(dashboard.data.currentDevice.id, devices.memberDevice.id);
});

test("expired install tickets fall back to the unpaired app and cannot be redeemed", async (t) => {
  const setup = await workerEnvironment();
  t.after(setup.close);
  const devices = await provisionTwoDevices(setup.env);
  const pairing = await call(setup.env, "/v1/pairings", {
    method: "POST",
    token: devices.adminToken,
    body: { label: "过期测试手机" },
  });
  const pairingToken = new URL(pairing.data.pairing.mobileUrl).pathname.split("/").at(-1);
  const created = await call(setup.env, "/v1/mobile/install-ticket", {
    method: "POST",
    body: { pairingToken },
  });
  const manifestUrl = new URL(created.data.install.manifestUrl);
  const installTicket = manifestUrl.searchParams.get("ticket");
  setup.env.MOBILE_INBOX_DB.database.prepare(
    "UPDATE mobile_install_tickets SET expires_at = ? WHERE ticket_hash = ?",
  ).run("2000-01-01T00:00:00.000Z", await mobileInboxWorkerTestables.hash(installTicket));

  const manifestResponse = await mobileInboxWorker.fetch(new Request(manifestUrl), setup.env);
  assert.equal((await manifestResponse.json()).start_url, "/app");
  const rejected = await call(setup.env, "/v1/mobile/install/redeem", {
    method: "POST",
    body: { installTicket },
  });
  assert.equal(rejected.response.status, 401);
  assert.equal(rejected.data.code, "INSTALL_TICKET_INVALID");
});

test("revoking the parent phone pairing invalidates pending install tickets and issued PWA credentials", async (t) => {
  const setup = await workerEnvironment();
  t.after(setup.close);
  const devices = await provisionTwoDevices(setup.env);
  const pairing = await call(setup.env, "/v1/pairings", {
    method: "POST",
    token: devices.adminToken,
    body: { label: "撤销测试手机" },
  });
  const pairingToken = new URL(pairing.data.pairing.mobileUrl).pathname.split("/").at(-1);
  const firstTicket = await call(setup.env, "/v1/mobile/install-ticket", {
    method: "POST",
    body: { pairingToken },
  });
  const firstValue = new URL(firstTicket.data.install.manifestUrl).searchParams.get("ticket");
  const redeemed = await call(setup.env, "/v1/mobile/install/redeem", {
    method: "POST",
    body: { installTicket: firstValue },
  });
  assert.equal(redeemed.response.status, 201);
  const pendingTicket = await call(setup.env, "/v1/mobile/install-ticket", {
    method: "POST",
    body: { pairingToken },
  });
  const pendingValue = new URL(pendingTicket.data.install.manifestUrl).searchParams.get("ticket");

  await call(setup.env, `/v1/pairings/${pairing.data.pairing.id}/revoke`, {
    method: "POST",
    token: devices.adminToken,
    body: {},
  });
  const rejectedCredential = await call(setup.env, "/v1/mobile/status", {
    method: "POST",
    body: { pairingToken: redeemed.data.pairingToken },
  });
  assert.equal(rejectedCredential.response.status, 401);
  const rejectedTicket = await call(setup.env, "/v1/mobile/install/redeem", {
    method: "POST",
    body: { installTicket: pendingValue },
  });
  assert.equal(rejectedTicket.response.status, 401);
  assert.equal(rejectedTicket.data.code, "INSTALL_TICKET_INVALID");
});

test("multi-device workspace claims each mobile link only once and activation codes are one-use", async (t) => {
  const setup = await workerEnvironment();
  t.after(setup.close);
  const devices = await provisionTwoDevices(setup.env);

  const reused = await call(setup.env, "/v1/desktop/activate", {
    method: "POST",
    body: { activationCode: devices.activationCode, label: "重复电脑" },
  });
  assert.equal(reused.response.status, 401);
  assert.equal(reused.data.code, "ACTIVATION_INVALID");

  await createMobileSubmission(setup.env, devices.adminToken, "https://www.xiaohongshu.com/explore/abc123?source=share");
  const [adminClaim, memberClaim] = await Promise.all([
    call(setup.env, "/v1/desktop/claim", { method: "POST", token: devices.adminToken, body: { limit: 5 } }),
    call(setup.env, "/v1/desktop/claim", { method: "POST", token: devices.memberToken, body: { limit: 5 } }),
  ]);
  const claimed = [...adminClaim.data.tasks, ...memberClaim.data.tasks];
  assert.equal(claimed.length, 1);
  assert.equal(new Set(claimed.map((item) => item.id)).size, 1);
});

test("revoked desktop devices receive 401 and their active claims return to the shared queue", async (t) => {
  const setup = await workerEnvironment();
  t.after(setup.close);
  const devices = await provisionTwoDevices(setup.env);
  await createMobileSubmission(setup.env, devices.memberToken, "https://www.douyin.com/video/1234567890");
  const claimed = await call(setup.env, "/v1/desktop/claim", {
    method: "POST",
    token: devices.memberToken,
    body: { limit: 1 },
  });
  assert.equal(claimed.data.tasks.length, 1);

  const revoked = await call(setup.env, `/v1/desktop/devices/${devices.memberDevice.id}/revoke`, {
    method: "POST",
    token: devices.adminToken,
    body: {},
  });
  assert.equal(revoked.response.status, 200);
  const rejectedClaim = await call(setup.env, "/v1/desktop/claim", {
    method: "POST",
    token: devices.memberToken,
    body: { limit: 1 },
  });
  assert.equal(rejectedClaim.response.status, 401);
  assert.equal(rejectedClaim.data.code, "DEVICE_UNAUTHORIZED");
  const rejectedPairing = await call(setup.env, "/v1/pairings", {
    method: "POST",
    token: devices.memberToken,
    body: { label: "不应创建" },
  });
  assert.equal(rejectedPairing.response.status, 401);

  const reclaimed = await call(setup.env, "/v1/desktop/claim", {
    method: "POST",
    token: devices.adminToken,
    body: { limit: 1 },
  });
  assert.equal(reclaimed.data.tasks.length, 1);
  assert.equal(reclaimed.data.tasks[0].id, claimed.data.tasks[0].id);
});

test("revoked mobile pairing cannot submit while prior tasks and attention states remain visible", async (t) => {
  const setup = await workerEnvironment();
  t.after(setup.close);
  const devices = await provisionTwoDevices(setup.env);
  const mobile = await createMobileSubmission(setup.env, devices.adminToken, "https://www.douyin.com/video/99887766");
  const claimed = await call(setup.env, "/v1/desktop/claim", {
    method: "POST",
    token: devices.memberToken,
    body: { limit: 1 },
  });
  const waiting = await call(setup.env, "/v1/desktop/complete", {
    method: "POST",
    token: devices.memberToken,
    body: { id: claimed.data.tasks[0].id, state: "waiting_verification", contentId: "I000321", errorCode: "AUTH_CHALLENGE" },
  });
  assert.equal(waiting.data.state, "waiting_verification");

  await call(setup.env, `/v1/pairings/${mobile.pairing.id}/revoke`, {
    method: "POST",
    token: devices.adminToken,
    body: {},
  });
  const rejected = await call(setup.env, "/v1/mobile/submissions", {
    method: "POST",
    body: { pairingToken: mobile.pairingToken, url: "https://www.douyin.com/video/new-one" },
  });
  assert.equal(rejected.response.status, 401);
  assert.equal(rejected.data.code, "PAIRING_INVALID");

  const status = await call(setup.env, "/v1/desktop/submissions", { token: devices.adminToken });
  assert.equal(status.data.submissions[0].state, "waiting_verification");
  assert.equal(status.data.submissions[0].contentId, "I000321");
});

test("local service stores owner and per-device credentials only in Keychain adapters", async () => {
  const keychain = new Map();
  const requests = [];
  const service = createMobileInboxService({
    keychainReadImpl: async (account) => keychain.get(account) || "",
    keychainWriteImpl: async (account, value) => keychain.set(account, value),
    fetchImpl: async (url, options) => {
      requests.push({ url, authorization: options.headers.authorization, body: options.body });
      return new Response(JSON.stringify({
        device: { id: "device_admin", label: "管理员电脑", role: "admin" },
        deviceToken: "device-secret",
      }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });
  const configured = await service.initialize({
    endpoint: "https://mobile.example.test/",
    ownerToken: "owner-secret",
    label: "管理员电脑",
  });
  assert.equal(configured.endpoint, "https://mobile.example.test");
  assert.equal(configured.device.role, "admin");
  assert.equal(keychain.get(mobileInboxTestables.accounts.OWNER_TOKEN_ACCOUNT), "owner-secret");
  assert.equal(keychain.get(mobileInboxTestables.accounts.DEVICE_TOKEN_ACCOUNT), "device-secret");
  assert.equal(requests[0].authorization, "Bearer owner-secret");
  assert.equal(JSON.stringify(configured).includes("secret"), false);
});

test("local service remembers the paired phone Web App in Keychain and clears it on revoke", async () => {
  const keychain = new Map([
    [mobileInboxTestables.accounts.ENDPOINT_ACCOUNT, "https://mobile.example.test"],
    [mobileInboxTestables.accounts.DEVICE_TOKEN_ACCOUNT, "device-secret"],
    [mobileInboxTestables.accounts.DEVICE_ID_ACCOUNT, "device_admin"],
    [mobileInboxTestables.accounts.DEVICE_LABEL_ACCOUNT, "管理员电脑"],
    [mobileInboxTestables.accounts.DEVICE_ROLE_ACCOUNT, "admin"],
  ]);
  const service = createMobileInboxService({
    keychainReadImpl: async (account) => keychain.get(account) || "",
    keychainWriteImpl: async (account, value) => {
      if (value) keychain.set(account, value);
      else keychain.delete(account);
    },
    fetchImpl: async (url) => {
      if (url.endsWith("/v1/pairings")) {
        return new Response(JSON.stringify({ pairing: {
          id: "pair_phone",
          mobileUrl: "https://mobile.example.test/p/bootstrap-secret",
          webAppUrl: "https://mobile.example.test/app",
        } }), { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ revoked: true, id: "pair_phone" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await service.createPairing({ label: "我的手机" });
  const paired = await service.status();
  assert.equal(paired.mobilePairing.webAppUrl, "https://mobile.example.test/app");
  assert.equal(keychain.get(mobileInboxTestables.accounts.MOBILE_BOOTSTRAP_URL_ACCOUNT).includes("bootstrap-secret"), true);

  await service.revokePairing("pair_phone");
  const revoked = await service.status();
  assert.equal(revoked.mobilePairing, null);
  assert.equal(keychain.has(mobileInboxTestables.accounts.MOBILE_BOOTSTRAP_URL_ACCOUNT), false);
});

test("mobile sync reuses inspiration ingestion, marks mobile source, disables transcription, and reports login states", async () => {
  const completions = [];
  const ingestions = [];
  const extractions = [];
  const tasks = [
    { id: "link_login", sourceUrl: "https://www.douyin.com/video/1", createdAt: "2026-08-15T01:00:00.000Z" },
    { id: "link_verify", sourceUrl: "https://www.xiaohongshu.com/explore/2", createdAt: "2026-08-15T01:01:00.000Z" },
  ];
  const service = {
    claim: async () => ({ tasks }),
    complete: async (payload) => completions.push(payload),
  };
  const libraryManager = {
    requireWritable: async () => ({ mode: "read_write" }),
    readLibrary: async () => ({ inspirations: [] }),
  };
  const result = await syncMobileInbox({
    service,
    libraryManager,
    authManager: {},
    sessionId: "isolated-session",
    ingest: async (payload) => {
      ingestions.push(payload);
      return {
        existing: false,
        item: { id: payload.intake.batchId === "link_login" ? "I000401" : "I000402", generation: 1, parseState: "extracting", intake: payload.intake },
      };
    },
    extract: async (payload) => {
      extractions.push(payload);
      return {
        parseState: payload.id === "I000401" ? "waiting_login" : "waiting_verification",
        errorCode: payload.id === "I000401" ? "AUTH_REQUIRED" : "AUTH_CHALLENGE",
        parseStatus: "需要人工处理",
      };
    },
  });

  assert.equal(result.outcomes.length, 2);
  assert.deepEqual(ingestions.map((item) => item.intake.channel), ["mobile", "mobile"]);
  assert.deepEqual(ingestions.map((item) => item.intake.batchId), ["link_login", "link_verify"]);
  assert.equal(extractions.every((item) => item.transcribe === false), true);
  assert.deepEqual(completions.map((item) => item.state), ["waiting_login", "waiting_verification"]);
  assert.deepEqual(completions.map((item) => item.contentId), ["I000401", "I000402"]);
});
