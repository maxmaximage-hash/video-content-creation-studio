#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function git(args, fallback = "unknown") {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || fallback;
  } catch {
    return fallback;
  }
}

const status = git(["status", "--porcelain"], "");
console.log(`Version: ${packageJson.version}`);
console.log(`Branch: ${git(["branch", "--show-current"], "detached")}`);
console.log(`Commit: ${git(["rev-parse", "HEAD"])}`);
console.log(`Worktree: ${status ? "dirty" : "clean"}`);
