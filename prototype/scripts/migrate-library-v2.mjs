#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import process from "node:process";
import {
  migrationDryRun,
  readLibraryForMigration,
  withContentModelV2,
  writeMigratedLibrary,
} from "../server/content-model-v2.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const libraryDir = argument("--library") || process.env.VIDEO_CONTENT_LIBRARY_ROOT || "";
const apply = process.argv.includes("--apply");
const confirm = process.argv.includes("--confirm");

if (!libraryDir) {
  console.error("用法：node prototype/scripts/migrate-library-v2.mjs --library /path/to/库.library [--apply --confirm]");
  process.exitCode = 2;
} else {
  try {
    const resolved = path.resolve(libraryDir);
    const current = await readLibraryForMigration(resolved);
    const unitRoot = path.join(resolved, "content-units");
    const entries = await fs.readdir(unitRoot, { withFileTypes: true }).catch(() => []);
    const inspected = {
      ...current,
      contentUnitDirectories: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    };
    const report = migrationDryRun(inspected);
    if (!apply) {
      console.log(JSON.stringify({ mode: "dry-run", libraryDir: resolved, ...report }, null, 2));
    } else if (!confirm) {
      console.error("写入迁移必须同时提供 --apply --confirm；本次未修改资料库。");
      process.exitCode = 2;
    } else {
      const result = await writeMigratedLibrary(resolved, withContentModelV2(current), { backup: true });
      console.log(JSON.stringify({
        mode: "applied",
        libraryDir: resolved,
        backupPath: result.backupPath,
        report,
      }, null, 2));
    }
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
