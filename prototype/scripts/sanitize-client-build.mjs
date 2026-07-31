#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const privateQaOutput = path.join(root, "dist", "client", "qa");

await fs.rm(privateQaOutput, { recursive: true, force: true });
console.log("Sanitized client build: removed local QA artifacts");
