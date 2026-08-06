import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const prototypeRoot = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PLAYWRIGHT_PORT || 4174);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.mjs",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: prototypeRoot,
    env: {
      VIDEO_CONTENT_LIBRARY_ROOT: path.join(prototypeRoot, ".qa-library"),
      VIDEO_CONTENT_AUTH_ROOT: path.join(prototypeRoot, ".qa-auth-browser"),
      VIDEO_STUDIO_QA_MODE: "1",
    },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120000,
  },
});
