import assert from "node:assert/strict";
import { test } from "node:test";
import { bindingBlocked, blocker, summarize } from "./server.ts";

const run = (name: string, conclusion: string) => ({
  __typename: "CheckRun",
  name,
  status: "COMPLETED",
  conclusion,
});

test("AC1: SKIPPED is its own state; SUCCESS and NEUTRAL stay passed", () => {
  const r = summarize([run("a", "SKIPPED"), run("b", "SUCCESS"), run("c", "NEUTRAL")]);
  assert.deepEqual(
    r.list.map((c) => c.state),
    ["skipped", "pass", "pass"],
  );
  assert.deepEqual(r.counts, { pass: 2, fail: 0, pending: 0, skipped: 1 });
});

test("AC1: other mappings are unchanged", () => {
  const r = summarize([
    { name: "gated", status: "WAITING" },
    { name: "needs-human", status: "COMPLETED", conclusion: "ACTION_REQUIRED" },
    { name: "running", status: "IN_PROGRESS" },
    { __typename: "StatusContext", context: "legacy", state: "PENDING" },
    run("broken", "FAILURE"),
  ]);
  assert.deepEqual(
    r.list.map((c) => c.state),
    ["action", "action", "pending", "pending", "fail"],
  );
  assert.deepEqual(r.counts, { pass: 0, fail: 1, pending: 4, skipped: 0 });
});

test("AC2: PR #41 fixture (4 success, 2 skipped, 1 failing)", () => {
  const r = summarize([
    run("CI / build", "SUCCESS"),
    run("CI / test", "SUCCESS"),
    run("CI / lint", "SUCCESS"),
    run("CI / PR review (PR-Agent)", "SKIPPED"),
    run("Independent Review / PR-Agent (external)", "SKIPPED"),
    run("Docs", "SUCCESS"),
    run("Binding approval", "FAILURE"),
  ]);
  assert.deepEqual(r.counts, { pass: 4, fail: 1, pending: 0, skipped: 2 });
  assert.equal(r.checks, "fail");
  assert.deepEqual(r.failing, ["Binding approval"]);
  assert.deepEqual(
    r.list.filter((c) => c.state === "skipped").map((c) => c.name),
    ["CI / PR review (PR-Agent)", "Independent Review / PR-Agent (external)"],
  );
});

test("AC3: aggregates", () => {
  assert.equal(summarize([]).checks, "none");
  assert.equal(summarize([run("a", "SUCCESS"), run("b", "SKIPPED")]).checks, "pass");
  assert.equal(summarize([run("a", "SKIPPED"), run("b", "SKIPPED")]).checks, "skipped");
  assert.equal(summarize([run("a", "SKIPPED"), { name: "b", status: "IN_PROGRESS" }]).checks, "pending");
  assert.equal(summarize([run("a", "SKIPPED"), run("b", "FAILURE")]).checks, "fail");
});

test("AC4: blocker is unchanged for every aggregate", () => {
  const ok = { draft: false, mergeable: "MERGEABLE" };
  assert.equal(blocker({ ...ok, checks: "skipped" }), null);
  assert.equal(blocker({ ...ok, checks: "pass" }), null);
  assert.equal(blocker({ ...ok, checks: "none" }), null);
  assert.equal(blocker({ ...ok, checks: "fail" }), "Checks failing");
  assert.equal(blocker({ ...ok, checks: "pending" }), "Checks still running");
  assert.equal(blocker({ draft: true, mergeable: "MERGEABLE", checks: "skipped" }), "Draft PR");
  assert.equal(blocker({ draft: true, mergeable: "MERGEABLE", checks: "pass" }), "Draft PR");
  assert.equal(blocker({ ...ok, mergeable: "CONFLICTING", checks: "skipped" }), "Merge conflicts");
  assert.equal(
    blocker({ ...ok, mergeable: "UNKNOWN", checks: "skipped" }),
    "GitHub is still computing mergeability",
  );
});

test("AC4: a skipped Binding approval does not set bindingBlocked", () => {
  assert.equal(bindingBlocked(summarize([run("Binding approval", "SKIPPED")]).list), false);
  assert.equal(bindingBlocked(summarize([run("Binding approval", "SUCCESS")]).list), false);
  assert.equal(bindingBlocked(summarize([run("Binding approval", "FAILURE")]).list), true);
  assert.equal(bindingBlocked(summarize([{ name: "Binding approval", status: "IN_PROGRESS" }]).list), true);
  assert.equal(bindingBlocked(summarize([run("Other", "FAILURE")]).list), false);
});
