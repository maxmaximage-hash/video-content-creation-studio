import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  APP_BUNDLE_ID,
  APP_INSTALL_NAME,
  APP_PRODUCT_NAME,
  LEGACY_APP_INSTALL_NAMES,
  LEGACY_USER_DATA_NAME,
} from "../desktop/app-identity.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("桌面应用身份与安装路径保持一致", () => {
  assert.equal(packageJson.productName, APP_PRODUCT_NAME);
  assert.equal(packageJson.build.productName, APP_PRODUCT_NAME);
  assert.equal(packageJson.build.appId, APP_BUNDLE_ID);
  assert.equal(APP_INSTALL_NAME, "Video Hub.app");
  assert.deepEqual(LEGACY_APP_INSTALL_NAMES, ["视频内容创作中台.app"]);
  assert.equal(LEGACY_USER_DATA_NAME, "视频内容创作中台");
});
