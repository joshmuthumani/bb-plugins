import type { Pr } from "./server";

// "N passed" is omitted only when nothing passed but something was skipped, so a
// skip-only or skip-plus-fail summary does not lead with a misleading "0 passed".
export function checksLabel(pr: Pick<Pr, "checks" | "counts">) {
  const { pass, fail, pending, skipped } = pr.counts;
  if (pr.checks === "none") return "No checks";
  const parts: string[] = [];
  if (pass > 0 || skipped === 0) parts.push(`${pass} passed`);
  if (fail > 0) parts.push(`${fail} failed`);
  if (pending > 0) parts.push(`${pending} running`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.join(" · ");
}
