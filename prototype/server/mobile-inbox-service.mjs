import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = "com.yinli.video-hub.mobile-inbox";
const ENDPOINT_ACCOUNT = "worker-endpoint";
const DEVICE_TOKEN_ACCOUNT = "device-token";
const DEVICE_ID_ACCOUNT = "device-id";
const DEVICE_LABEL_ACCOUNT = "device-label";
const DEVICE_ROLE_ACCOUNT = "device-role";
const OWNER_TOKEN_ACCOUNT = "owner-api-token";
const MOBILE_PAIRING_ID_ACCOUNT = "mobile-pairing-id";
const MOBILE_BOOTSTRAP_URL_ACCOUNT = "mobile-bootstrap-url";
const MOBILE_WEB_APP_URL_ACCOUNT = "mobile-web-app-url";

async function keychainRead(account) {
  if (process.platform !== "darwin") return "";
  const result = await execFileAsync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], {
    encoding: "utf8",
  }).catch(() => ({ stdout: "" }));
  return String(result.stdout || "").trim();
}

async function keychainWrite(account, value) {
  if (process.platform !== "darwin") throw new Error("当前系统不支持 macOS 钥匙串");
  if (!value) {
    await execFileAsync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account]).catch(() => {});
    return;
  }
  await execFileAsync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value]);
}

function normalizeEndpoint(value) {
  const endpoint = String(value || "").trim().replace(/\/+$/, "");
  if (!endpoint) return "";
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("手机收集箱地址必须使用 HTTPS");
  return url.origin;
}

function publicError(error) {
  const message = String(error?.message || "手机链接收集箱请求失败");
  const clean = message.replace(/Bearer\s+[^\s]+/gi, "Bearer [已隐藏]");
  const next = new Error(clean);
  next.code = error?.code || "MOBILE_INBOX_REQUEST_FAILED";
  return next;
}

export function createMobileInboxService({
  fetchImpl = fetch,
  keychainReadImpl = keychainRead,
  keychainWriteImpl = keychainWrite,
} = {}) {
  let cached = null;

  async function credentials({ refresh = false } = {}) {
    if (!cached || refresh) {
      const [endpoint, token, deviceId, label, role, mobilePairingId, mobileBootstrapUrl, mobileWebAppUrl] = await Promise.all([
        keychainReadImpl(ENDPOINT_ACCOUNT),
        keychainReadImpl(DEVICE_TOKEN_ACCOUNT),
        keychainReadImpl(DEVICE_ID_ACCOUNT),
        keychainReadImpl(DEVICE_LABEL_ACCOUNT),
        keychainReadImpl(DEVICE_ROLE_ACCOUNT),
        keychainReadImpl(MOBILE_PAIRING_ID_ACCOUNT),
        keychainReadImpl(MOBILE_BOOTSTRAP_URL_ACCOUNT),
        keychainReadImpl(MOBILE_WEB_APP_URL_ACCOUNT),
      ]);
      cached = { endpoint, token, deviceId, label, role, mobilePairingId, mobileBootstrapUrl, mobileWebAppUrl };
    }
    return cached;
  }

  async function remoteRequest(endpoint, path, token, options = {}) {
    if (!endpoint || !token) {
      const missing = new Error("手机链接收集箱尚未在此电脑完成授权");
      missing.code = "MOBILE_INBOX_NOT_CONFIGURED";
      throw missing;
    }
    try {
      const response = await fetchImpl(`${endpoint}${path}`, {
        ...options,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(options.headers || {}),
        },
        signal: options.signal || AbortSignal.timeout(20000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const failure = new Error(data.error || `手机链接收集箱请求失败 (${response.status})`);
        failure.code = data.code || `HTTP_${response.status}`;
        throw failure;
      }
      return data;
    } catch (error) {
      throw publicError(error);
    }
  }

  async function request(path, options = {}) {
    const config = await credentials();
    return remoteRequest(config.endpoint, path, config.token, options);
  }

  async function saveAuthorizedDevice({ endpoint, deviceToken, device, ownerToken = "" }) {
    await Promise.all([
      keychainWriteImpl(ENDPOINT_ACCOUNT, endpoint),
      keychainWriteImpl(DEVICE_TOKEN_ACCOUNT, String(deviceToken || "")),
      keychainWriteImpl(DEVICE_ID_ACCOUNT, String(device?.id || "")),
      keychainWriteImpl(DEVICE_LABEL_ACCOUNT, String(device?.label || "")),
      keychainWriteImpl(DEVICE_ROLE_ACCOUNT, String(device?.role || "member")),
      ...(ownerToken ? [keychainWriteImpl(OWNER_TOKEN_ACCOUNT, ownerToken)] : []),
    ]);
    cached = {
      endpoint,
      token: String(deviceToken || ""),
      deviceId: String(device?.id || ""),
      label: String(device?.label || ""),
      role: String(device?.role || "member"),
      mobilePairingId: cached?.mobilePairingId || "",
      mobileBootstrapUrl: cached?.mobileBootstrapUrl || "",
      mobileWebAppUrl: cached?.mobileWebAppUrl || "",
    };
    return {
      configured: true,
      endpoint,
      device: {
        id: cached.deviceId,
        label: cached.label,
        role: cached.role,
      },
    };
  }

  return {
    async initialize({ endpoint, ownerToken, label } = {}) {
      const normalizedEndpoint = normalizeEndpoint(endpoint);
      const secret = String(ownerToken || "").trim();
      if (!secret) throw new Error("缺少工作区管理员初始化令牌");
      const result = await remoteRequest(normalizedEndpoint, "/v1/workspace/initialize", secret, {
        method: "POST",
        body: JSON.stringify({ label }),
      });
      return saveAuthorizedDevice({
        endpoint: normalizedEndpoint,
        deviceToken: result.deviceToken,
        device: result.device,
        ownerToken: secret,
      });
    },
    async join({ endpoint, activationCode, label } = {}) {
      const normalizedEndpoint = normalizeEndpoint(endpoint);
      const code = String(activationCode || "").trim();
      if (!code) throw new Error("缺少一次性电脑入组码");
      const result = await remoteRequest(normalizedEndpoint, "/v1/desktop/activate", "activation", {
        method: "POST",
        body: JSON.stringify({ activationCode: code, label }),
      });
      return saveAuthorizedDevice({
        endpoint: normalizedEndpoint,
        deviceToken: result.deviceToken,
        device: result.device,
      });
    },
    async status() {
      const config = await credentials();
      return {
        configured: Boolean(config.endpoint && config.token && config.deviceId),
        endpoint: config.endpoint || "",
        device: config.deviceId ? {
          id: config.deviceId,
          label: config.label || "此电脑",
          role: config.role || "member",
        } : null,
        mobilePairing: config.mobilePairingId && config.mobileBootstrapUrl ? {
          id: config.mobilePairingId,
          mobileUrl: config.mobileBootstrapUrl,
          webAppUrl: config.mobileWebAppUrl || `${config.endpoint}/app`,
        } : null,
      };
    },
    async createActivation({ label, minutes } = {}) {
      return request("/v1/desktop/activations", { method: "POST", body: JSON.stringify({ label, minutes }) });
    },
    async listDevices() {
      return request("/v1/desktop/devices", { method: "GET" });
    },
    async revokeDevice(id) {
      return request(`/v1/desktop/devices/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" });
    },
    async createPairing({ label, days } = {}) {
      const result = await request("/v1/pairings", { method: "POST", body: JSON.stringify({ label, days }) });
      if (result.pairing?.id && result.pairing?.mobileUrl) {
        await Promise.all([
          keychainWriteImpl(MOBILE_PAIRING_ID_ACCOUNT, result.pairing.id),
          keychainWriteImpl(MOBILE_BOOTSTRAP_URL_ACCOUNT, result.pairing.mobileUrl),
          keychainWriteImpl(MOBILE_WEB_APP_URL_ACCOUNT, result.pairing.webAppUrl || ""),
        ]);
        const config = await credentials();
        cached = {
          ...config,
          mobilePairingId: result.pairing.id,
          mobileBootstrapUrl: result.pairing.mobileUrl,
          mobileWebAppUrl: result.pairing.webAppUrl || `${config.endpoint}/app`,
        };
      }
      return result;
    },
    async listPairings() {
      return request("/v1/pairings", { method: "GET" });
    },
    async revokePairing(id) {
      const result = await request(`/v1/pairings/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" });
      const config = await credentials();
      if (config.mobilePairingId === id) {
        await Promise.all([
          keychainWriteImpl(MOBILE_PAIRING_ID_ACCOUNT, ""),
          keychainWriteImpl(MOBILE_BOOTSTRAP_URL_ACCOUNT, ""),
          keychainWriteImpl(MOBILE_WEB_APP_URL_ACCOUNT, ""),
        ]);
        cached = { ...config, mobilePairingId: "", mobileBootstrapUrl: "", mobileWebAppUrl: "" };
      }
      return result;
    },
    async dashboard() {
      return request("/v1/desktop/dashboard", { method: "GET" });
    },
    async listSubmissions() {
      return request("/v1/desktop/submissions", { method: "GET" });
    },
    async claim(limit = 5) {
      return request("/v1/desktop/claim", { method: "POST", body: JSON.stringify({ limit }) });
    },
    async complete(payload) {
      return request("/v1/desktop/complete", { method: "POST", body: JSON.stringify(payload) });
    },
    async retry(id) {
      return request(`/v1/desktop/submissions/${encodeURIComponent(id)}/retry`, { method: "POST", body: "{}" });
    },
  };
}

export const mobileInboxTestables = {
  normalizeEndpoint,
  accounts: {
    ENDPOINT_ACCOUNT,
    DEVICE_TOKEN_ACCOUNT,
    DEVICE_ID_ACCOUNT,
    DEVICE_LABEL_ACCOUNT,
    DEVICE_ROLE_ACCOUNT,
    OWNER_TOKEN_ACCOUNT,
    MOBILE_PAIRING_ID_ACCOUNT,
    MOBILE_BOOTSTRAP_URL_ACCOUNT,
    MOBILE_WEB_APP_URL_ACCOUNT,
  },
};
