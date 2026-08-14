import assert from "node:assert/strict";
import test from "node:test";
import { bodyFormatChanged, formatBodyText } from "../src/pages/queue/body-format.js";

test("formatBodyText only removes explicit markdown formatting", () => {
  const source = "> **王的姿态**  \r\n\r\n\r\n保留 > 和 *普通星号*\n未闭合 **标记";
  assert.equal(formatBodyText(source), "王的姿态\n\n保留 > 和 *普通星号*\n未闭合 **标记");
  assert.equal(bodyFormatChanged(source), true);
});

test("formatBodyText is idempotent and keeps content order", () => {
  const formatted = "第一行\n\n第二行，含数字 123 和标点。";
  assert.equal(formatBodyText(formatted), formatted);
  assert.equal(bodyFormatChanged(formatted), false);
});
