import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_TTL_MS = 45_000;
const DEFAULT_HEARTBEAT_MS = 12_000;
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const MIN_TTL_MS = 250;
const MIN_HEARTBEAT_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockError(message, details = {}) {
  const error = new Error(message);
  error.statusCode = 423;
  error.code = "LIBRARY_WRITE_LOCKED";
  Object.assign(error, details);
  return error;
}

async function readLock(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return { corrupt: true, errorCode: error.code || "LOCK_READ_FAILED" };
  }
}

async function writeExclusive(lockPath, value) {
  await fs.writeFile(lockPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

async function replaceOwnedLock(lockPath, value) {
  const temporaryPath = `${lockPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await fs.rename(temporaryPath, lockPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function createLibraryWriteLease(options = {}) {
  const ownerId = options.ownerId || randomUUID();
  const ttlMs = Math.max(MIN_TTL_MS, Number(options.ttlMs) || DEFAULT_TTL_MS);
  const heartbeatMs = Math.min(ttlMs / 2, Math.max(MIN_HEARTBEAT_MS, Number(options.heartbeatMs) || DEFAULT_HEARTBEAT_MS));
  const waitTimeoutMs = Math.max(0, Number(options.waitTimeoutMs) || DEFAULT_WAIT_TIMEOUT_MS);
  let libraryDir = "";
  let lockPath = "";
  let owned = false;
  let timer = null;
  let lastOwner = null;
  let heartbeatPromise = null;

  function publicState() {
    return {
      owned,
      mode: "read_write",
      owner: lastOwner ? {
        host: lastOwner.host || "",
        pid: Number(lastOwner.pid) || 0,
        acquiredAt: lastOwner.acquiredAt || "",
        expiresAt: lastOwner.expiresAt || "",
      } : null,
    };
  }

  function leaseRecord() {
    const now = Date.now();
    return {
      schemaVersion: 1,
      ownerId,
      host: os.hostname(),
      pid: process.pid,
      acquiredAt: lastOwner?.ownerId === ownerId ? lastOwner.acquiredAt : new Date(now).toISOString(),
      heartbeatAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
  }

  async function configure(nextLibraryDir) {
    const resolvedLibraryDir = path.resolve(nextLibraryDir);
    if (libraryDir === resolvedLibraryDir && lockPath) return publicState();
    await release();
    libraryDir = resolvedLibraryDir;
    const metadataDir = path.join(libraryDir, "metadata");
    await fs.mkdir(metadataDir, { recursive: true });
    lockPath = path.join(metadataDir, "library-writer.lock.json");
    lastOwner = await readLock(lockPath);
    owned = false;
    return publicState();
  }

  async function removeExpired(existing) {
    const expiresAt = Date.parse(existing?.expiresAt || "");
    let localOwnerGone = false;
    if (existing?.host === os.hostname() && Number.isSafeInteger(Number(existing?.pid)) && Number(existing.pid) > 1) {
      try {
        process.kill(Number(existing.pid), 0);
      } catch (error) {
        localOwnerGone = error.code === "ESRCH";
      }
    }
    if (!localOwnerGone && Number.isFinite(expiresAt) && expiresAt > Date.now()) return false;
    const stalePath = `${lockPath}.expired.${process.pid}.${Date.now()}`;
    try {
      await fs.rename(lockPath, stalePath);
      await fs.rm(stalePath, { force: true });
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return true;
      return false;
    }
  }

  async function acquire({ allowReadOnly = false } = {}) {
    if (!lockPath) throw new Error("资料库写入锁尚未配置");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const deadline = Date.now() + waitTimeoutMs;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const existing = await readLock(lockPath);
      if (existing?.ownerId === ownerId) {
        const next = leaseRecord();
        await replaceOwnedLock(lockPath, next);
        lastOwner = next;
        owned = true;
        startHeartbeat();
        return publicState();
      }
      if (existing && !(await removeExpired(existing))) {
        owned = false;
        lastOwner = existing;
        if (allowReadOnly) return publicState();
        if (Date.now() < deadline) {
          await sleep(Math.min(100, Math.max(20, ttlMs / 10)));
          continue;
        }
        throw lockError("资料库正在另一台电脑上写入，请稍后自动重试", { lockOwner: publicState().owner });
      }
      try {
        const next = leaseRecord();
        await writeExclusive(lockPath, next);
        lastOwner = next;
        owned = true;
        startHeartbeat();
        return publicState();
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    owned = false;
    lastOwner = await readLock(lockPath);
    if (allowReadOnly) return publicState();
    throw lockError("资料库写入权正在被另一台电脑使用", { lockOwner: publicState().owner });
  }

  async function heartbeat() {
    if (heartbeatPromise) return heartbeatPromise;
    const operation = (async () => {
      if (!owned || !lockPath) return publicState();
      const existing = await readLock(lockPath);
      if (existing?.ownerId !== ownerId) {
        owned = false;
        lastOwner = existing;
        stopHeartbeat();
        return publicState();
      }
      const next = leaseRecord();
      await replaceOwnedLock(lockPath, next);
      lastOwner = next;
      return publicState();
    })();
    heartbeatPromise = operation;
    try {
      return await operation;
    } finally {
      if (heartbeatPromise === operation) heartbeatPromise = null;
    }
  }

  function startHeartbeat() {
    if (timer) return;
    timer = setInterval(() => {
      void heartbeat().catch(() => {
        owned = false;
        stopHeartbeat();
      });
    }, heartbeatMs);
    timer.unref?.();
  }

  function stopHeartbeat() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  async function ensureOwned() {
    if (!owned) return acquire();
    const state = await heartbeat();
    if (!state.owned) throw lockError("资料库写入权已被其他电脑接管", { lockOwner: state.owner });
    return state;
  }

  async function release() {
    stopHeartbeat();
    if (heartbeatPromise) await heartbeatPromise.catch(() => {});
    if (!lockPath) {
      owned = false;
      lastOwner = null;
      return;
    }
    const existing = await readLock(lockPath);
    if (existing?.ownerId === ownerId) await fs.rm(lockPath, { force: true }).catch(() => {});
    owned = false;
    lastOwner = existing?.ownerId === ownerId ? null : existing;
    libraryDir = "";
    lockPath = "";
  }

  return {
    ownerId,
    configure,
    acquire,
    ensureOwned,
    heartbeat,
    release,
    state: publicState,
  };
}
