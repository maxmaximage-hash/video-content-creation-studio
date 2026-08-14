import assert from "node:assert/strict";
import test from "node:test";
import {
  assignCoverAccountRole,
  projectAccountCopy,
  projectAccountCovers,
  projectPrimaryCopy,
  updateProjectAccountCopy,
} from "../src/pages/queue/content-variants.js";

test("legacy copy remains the blogger version while IP copy starts independently", () => {
  const project = { title: "旧标题", body: "旧正文" };
  assert.deepEqual(projectAccountCopy(project, "blogger"), { title: "旧标题", body: "旧正文" });
  assert.deepEqual(projectAccountCopy(project, "ip"), { title: "", body: "" });
});

test("account copy updates independently and blogger stays backward compatible", () => {
  const project = updateProjectAccountCopy({ title: "旧标题", body: "旧正文" }, "ip", { title: "IP 标题" });
  assert.equal(project.title, "旧标题");
  assert.equal(project.accountVariants.ip.title, "IP 标题");

  const updated = updateProjectAccountCopy(project, "blogger", { body: "博主正文" });
  assert.equal(updated.body, "博主正文");
  assert.equal(updated.accountVariants.blogger.body, "博主正文");
});

test("archive copy falls back to the first populated account version", () => {
  const project = {
    title: "",
    body: "",
    accountVariants: {
      blogger: { title: "", body: "" },
      ip: { title: "IP 标题", body: "IP 正文" },
    },
  };
  assert.deepEqual(projectPrimaryCopy(project), { title: "IP 标题", body: "IP 正文" });
});

test("unlabelled legacy covers belong to blogger and labelled covers stay isolated", () => {
  const covers = [
    { id: "legacy", src: "/legacy.png" },
    { id: "blogger", src: "/blogger.png", accountRole: "blogger" },
    assignCoverAccountRole({ id: "ip", src: "/ip.png" }, "ip"),
  ];
  assert.deepEqual(projectAccountCovers({}, "blogger", covers).map((cover) => cover.id), ["legacy", "blogger"]);
  assert.deepEqual(projectAccountCovers({}, "ip", covers).map((cover) => cover.id), ["ip"]);
});
