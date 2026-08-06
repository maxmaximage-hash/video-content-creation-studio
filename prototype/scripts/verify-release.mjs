#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(root);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const changelog = fs.readFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "utf8");
const expectedTag = `v${packageJson.version}`;
const suppliedTag = process.argv[2] || process.env.GITHUB_REF_NAME || "";
const failures = [];

function git(args, fallback = "") {
  try {
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

if (!/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
  failures.push(`package version must be stable semver, received ${packageJson.version}`);
}
if (packageLock.version !== packageJson.version || packageLock.packages?.[""]?.version !== packageJson.version) {
  failures.push("package.json and package-lock.json versions do not match");
}
if (suppliedTag && suppliedTag !== expectedTag) {
  failures.push(`release tag ${suppliedTag} does not match ${expectedTag}`);
}
if (!new RegExp(`^## ${packageJson.version} - \\d{4}-\\d{2}-\\d{2}$`, "m").test(changelog)) {
  failures.push(`CHANGELOG.md is missing a dated ${packageJson.version} section`);
}
if (git(["status", "--porcelain"])) {
  failures.push("worktree changes are still uncommitted");
}

if (failures.length) {
  console.error("Release check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Release metadata verified: ${expectedTag} (${git(["rev-parse", "--short=10", "HEAD"], "unknown")})`);
