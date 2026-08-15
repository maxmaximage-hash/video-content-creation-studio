import assert from "node:assert/strict";
import test from "node:test";
import { bodyFormatChanged, formatBodyText } from "../src/pages/queue/body-format.js";

test("formatBodyText only removes explicit markdown formatting", () => {
  const source = "> **王的姿态**  \r\n\r\n\r\n保留 > 和 *普通星号*\n未闭合 **标记";
  assert.equal(formatBodyText(source), "王的姿态\n保留 > 和 *普通星号*\n未闭合 **标记");
  assert.equal(bodyFormatChanged(source), true);
});

test("formatBodyText is idempotent and keeps content order", () => {
  const formatted = "第一行\n第二行，含数字 123 和标点。";
  assert.equal(formatBodyText(formatted), formatted);
  assert.equal(bodyFormatChanged(formatted), false);
});

test("formatBodyText removes Chinese punctuation spacing and blank paragraph rows", () => {
  const source = "建模一般的男生，  千万不要觉得朋友圈里有帅照， 展示面就有用了。\n\n我觉得很多兄弟对展示面最大的误解就是这个。\n\n你本身颜值不是优势， 为什么还要挤进纯颜值赛道？";
  assert.equal(
    formatBodyText(source),
    "建模一般的男生，千万不要觉得朋友圈里有帅照，展示面就有用了。\n我觉得很多兄弟对展示面最大的误解就是这个。\n你本身颜值不是优势，为什么还要挤进纯颜值赛道？",
  );
});
