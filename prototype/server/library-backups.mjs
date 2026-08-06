import fs from "node:fs/promises";
import path from "node:path";

const BACKUP_LIMIT = 24;

function safeLabel(value) {
  return String(value || "write").replace(/[^a-z0-9_-]/gi, "-").slice(0, 40) || "write";
}

async function atomicWrite(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, value, { encoding: "utf8", flag: "wx" });
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function createLibraryIndexBackup(libraryDir, indexText, options = {}) {
  const backupDir = path.join(path.resolve(libraryDir), "metadata", "index-backups");
  await fs.mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `library.json.${stamp}.${safeLabel(options.label)}.bak`);
  await atomicWrite(backupPath, indexText.endsWith("\n") ? indexText : `${indexText}\n`);
  const entries = (await fs.readdir(backupDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.startsWith("library.json.") && entry.name.endsWith(".bak"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  await Promise.all(entries.slice(BACKUP_LIMIT).map((entry) => fs.rm(path.join(backupDir, entry), { force: true })));
  return backupPath;
}

async function backupCandidates(libraryDir) {
  const root = path.resolve(libraryDir);
  const candidates = [];
  for (const directory of [root, path.join(root, "metadata", "index-backups")]) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("library.json") || !entry.name.endsWith(".bak")) continue;
      candidates.push(path.join(directory, entry.name));
    }
  }
  return candidates;
}

export async function purgeLibraryBackupsContaining(libraryDir, fingerprints = []) {
  const needles = Array.from(new Set(fingerprints.map((value) => String(value || "").trim()).filter(Boolean)));
  if (!needles.length) return [];
  const removed = [];
  for (const filePath of await backupCandidates(libraryDir)) {
    const text = await fs.readFile(filePath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (!needles.some((needle) => text.includes(needle))) continue;
    await fs.rm(filePath, { force: false });
    removed.push(filePath);
  }
  return removed;
}

export async function findSensitiveMetadataFiles(libraryDir, fingerprints = []) {
  const root = path.resolve(libraryDir);
  const metadataRoot = path.join(root, "metadata");
  const needles = Array.from(new Set(fingerprints.map((value) => String(value || "").trim()).filter(Boolean)));
  const matches = [];
  if (!needles.length) return matches;

  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(target);
        continue;
      }
      if (!entry.isFile() || entry.name === "library-writer.lock.json") continue;
      const stat = await fs.stat(target).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!stat) continue;
      if (stat.size > 16 * 1024 * 1024) continue;
      const text = await fs.readFile(target, "utf8").catch(() => "");
      if (needles.some((needle) => text.includes(needle))) matches.push(target);
    }
  }

  await walk(metadataRoot);
  return matches;
}

export async function purgeSensitiveMetadataFiles(libraryDir, fingerprints = []) {
  const matches = await findSensitiveMetadataFiles(libraryDir, fingerprints);
  await Promise.all(matches.map((filePath) => fs.rm(filePath, { force: false })));
  return matches;
}
