import assert from "node:assert/strict";
import { test } from "node:test";
import { checksLabel } from "./checks-label.ts";
import { summarize } from "./server.ts";

// [pass, fail, running, skipped] -> label, as in plan amendment A2.
const cases: Array<[[number, number, number, number], string]> = [
  [[4, 1, 0, 2], "4 passed · 1 failed · 2 skipped"],
  [[3, 0, 0, 2], "3 passed · 2 skipped"],
  [[0, 0, 0, 2], "2 skipped"],
  [[0, 1, 0, 1], "1 failed · 1 skipped"],
  [[0, 0, 1, 2], "1 running · 2 skipped"],
  [[0, 1, 0, 0], "0 passed · 1 failed"],
  [[0, 0, 2, 0], "0 passed · 2 running"],
  [[2, 0, 0, 0], "2 passed"],
];

for (const [[pass, fail, pending, skipped], label] of cases) {
  test(`checksLabel ${pass}/${fail}/${pending}/${skipped} -> ${label}`, () => {
    const rollup = [
      ...Array(pass).fill({ status: "COMPLETED", conclusion: "SUCCESS" }),
      ...Array(fail).fill({ status: "COMPLETED", conclusion: "FAILURE" }),
      ...Array(pending).fill({ status: "IN_PROGRESS" }),
      ...Array(skipped).fill({ status: "COMPLETED", conclusion: "SKIPPED" }),
    ];
    const { checks, counts } = summarize(rollup);
    assert.equal(checksLabel({ checks, counts }), label);
  });
}

test("checksLabel: no checks", () => {
  const { checks, counts } = summarize([]);
  assert.equal(checksLabel({ checks, counts }), "No checks");
});
