// bb-plugin-pr-tracker — backend. Lists open PRs with their Actions status and
// merges them as the Claude Code GitHub App bot. Reads use the `gh` login;
// only the merge mints a bot token (see ~/.claude/rules/shipping-gates.md).
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const run = promisify(execFile);

const checkState = z.enum(["pass", "fail", "pending", "skipped", "none"]);
const checkItem = z.object({
  name: z.string(),
  state: z.enum(["pass", "fail", "pending", "action", "skipped"]),
  url: z.string().nullable(),
});
const prSchema = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  author: z.string(),
  url: z.string(),
  branch: z.string(),
  draft: z.boolean(),
  mergeable: z.string(),
  review: z.string(),
  checks: checkState,
  counts: z.object({
    pass: z.number(),
    fail: z.number(),
    pending: z.number(),
    skipped: z.number(),
  }),
  failing: z.array(z.string()),
  mergeBlocker: z.string().nullable(),
  list: z.array(checkItem),
  needsYou: z.array(z.string()),
  // What the user can do to unblock the PR (see pr_approve). null = nothing.
  action: z.enum(["approve", "approve_rerun", "rerun"]).nullable(),
});
export type Pr = z.infer<typeof prSchema>;

export const rpcContract = defineRpcContract({
  prs_list: {
    input: z.null(),
    output: z.object({
      prs: z.array(prSchema),
      errors: z.array(z.string()),
      repos: z.array(z.string()),
    }),
  },
  pr_merge: {
    input: z.object({
      repo: z.string(),
      number: z.number().int().positive(),
    }),
    output: z.object({ merged: z.boolean() }),
  },
  pr_approve: {
    input: z.object({
      repo: z.string(),
      number: z.number().int().positive(),
    }),
    output: z.object({ approved: z.boolean(), rerun: z.boolean() }),
  },
});

const REPO = /^[\w.-]+\/[\w.-]+$/;
// Workflow whose re-run recomputes the "Binding approval" check once Josh has
// approved the current head (see Brain decisions, 2026-10-09).
const REVIEW_WORKFLOW = "Independent Review";
const BINDING_CHECK = /binding approval/i;
// The daemon's PATH may lack Homebrew; gh lives there.
const PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;

type RawCheck = {
  __typename?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  name?: string;
  context?: string;
  detailsUrl?: string;
  targetUrl?: string;
  checkSuite?: { createdAt?: string; workflowRun?: { workflow?: { id?: string } | null } | null } | null;
};

// Fold CheckRun and StatusContext entries into pass/fail/pending/skipped counts.
// "action" = a gated run waiting on a human (environment approval, first-time
// contributor); it counts as pending, never as a failure.
export function summarize(rollup: RawCheck[]) {
  const counts = { pass: 0, fail: 0, pending: 0, skipped: 0 };
  const failing: string[] = [];
  const list: z.infer<typeof checkItem>[] = [];
  for (const c of rollup) {
    const workflow = c.checkSuite?.workflowRun?.workflow?.id;
    const createdAt = c.checkSuite?.createdAt;
    if (workflow && c.name && createdAt && rollup.some((other) =>
      other.name === c.name && other.checkSuite?.workflowRun?.workflow?.id === workflow &&
      !!other.checkSuite.createdAt && Date.parse(other.checkSuite.createdAt) > Date.parse(createdAt)
    )) continue;
    const name = c.name ?? c.context ?? "check";
    const url = c.detailsUrl || c.targetUrl || null;
    const outcome = c.conclusion ?? c.state ?? "";
    let state: z.infer<typeof checkItem>["state"];
    if (c.status === "WAITING" || outcome === "ACTION_REQUIRED") state = "action";
    else if (c.status && c.status !== "COMPLETED") state = "pending";
    else if (["SUCCESS", "NEUTRAL"].includes(outcome)) state = "pass";
    else if (outcome === "SKIPPED") state = "skipped";
    else if (["PENDING", "EXPECTED", ""].includes(outcome)) state = "pending";
    else state = "fail";
    if (state === "pass") counts.pass++;
    else if (state === "skipped") counts.skipped++;
    else if (state === "fail") {
      counts.fail++;
      failing.push(name);
    } else counts.pending++;
    list.push({ name, state, url });
  }
  // Mixed pass + skipped stays "pass" (GitHub reports a skipped job as success);
  // only an all-skipped rollup gets its own aggregate, since nothing ran.
  let checks: Pr["checks"];
  if (rollup.length === 0) checks = "none";
  else if (counts.fail > 0) checks = "fail";
  else if (counts.pending > 0) checks = "pending";
  else if (counts.pass > 0) checks = "pass";
  else checks = "skipped";
  return { counts, failing, checks, list };
}

export async function safeChecks(fetch: () => Promise<RawCheck[]>, onError: (cause: unknown) => void = () => {}) {
  try {
    return summarize(await fetch());
  } catch (cause) {
    onError(cause);
    return summarize([{ name: "Checks unavailable", status: "IN_PROGRESS" }]);
  }
}

export function blocker(p: {
  draft: boolean;
  mergeable: string;
  checks: Pr["checks"];
}): string | null {
  if (p.draft) return "Draft PR";
  if (p.checks === "fail") return "Checks failing";
  if (p.checks === "pending") return "Checks still running";
  if (p.mergeable === "CONFLICTING") return "Merge conflicts";
  if (p.mergeable !== "MERGEABLE") return "GitHub is still computing mergeability";
  return null;
}

// A Binding approval check that has not passed; skipped counts as passed, like GitHub.
export function bindingBlocked(list: z.infer<typeof checkItem>[]): boolean {
  return list.some(
    (c) => BINDING_CHECK.test(c.name) && c.state !== "pass" && c.state !== "skipped",
  );
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    repos: {
      type: "string",
      label: "Repositories",
      description: "Comma-separated owner/repo list to track.",
      default: "",
    },
  });
  // Canonicalize configured repos before use: when a repo is transferred to a
  // new owner, GitHub 404s /repos/<old>/installation (the endpoint gh-bot-token
  // hits), so resolve the current owner here and cache it briefly.
  const repoCache = new Map<string, { canonical: string; at: number }>();
  const REPO_CACHE_TTL = 60 * 60 * 1000; // 1 hour

  async function gh(args: string[], extraEnv: Record<string, string> = {}) {
    const { stdout } = await run("gh", args, {
      env: { ...process.env, PATH, ...extraEnv },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  }

  // Resolve "owner/repo" to its current canonical owner/repo, following GitHub's
  // transfer redirect. Falls back to the configured value so a transient lookup
  // failure surfaces as the downstream command's own error instead of dropping
  // the repo.
  async function resolveRepo(repo: string): Promise<string> {
    const cached = repoCache.get(repo);
    if (cached && Date.now() - cached.at < REPO_CACHE_TTL) return cached.canonical;
    try {
      const out = await gh([
        "repo", "view", repo, "--json", "nameWithOwner", "--jq", ".nameWithOwner",
      ]);
      const canonical = out.trim();
      if (REPO.test(canonical)) {
        repoCache.set(repo, { canonical, at: Date.now() });
        return canonical;
      }
    } catch {
      // Fall through: keep the configured value.
    }
    return repo;
  }

  const readRepos = async () => {
    const { repos } = await settings.get();
    const configured = repos
      .split(",")
      .map((r) => r.trim())
      .filter((r) => REPO.test(r));
    const resolved = await Promise.all(configured.map((r) => resolveRepo(r)));
    return [...new Set(resolved)];
  };

  let me: string | null = null;
  async function viewer(): Promise<string | null> {
    if (me) return me;
    try {
      me = (await gh(["api", "user", "--jq", ".login"])).trim();
    } catch {
      // Review-request detection is best effort.
    }
    return me;
  }

  async function checksForPr(repo: string, number: number, headOid: string): Promise<RawCheck[]> {
    const [owner, name] = repo.split("/");
    const query = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $name) { pullRequest(number: $number) {
        commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on CheckRun { name status conclusion detailsUrl checkSuite { createdAt workflowRun { workflow { id } } } }
            ... on StatusContext { context state targetUrl }
          }
        } } } } }
      } }
    }`;
    const checks: RawCheck[] = [];
    let cursor: string | null = null;
    do {
      const args = ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`];
      if (cursor) args.push("-f", `cursor=${cursor}`);
      const response = JSON.parse(await gh(args));
      const commit = response.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit;
      if (!commit || commit.oid !== headOid) throw new Error(`PR #${number} head changed while fetching checks`);
      const contexts = commit.statusCheckRollup?.contexts;
      if (!contexts) {
        if (commit.statusCheckRollup !== null || checks.length || cursor) throw new Error(`Missing check results for PR #${number}`);
        return [];
      }
      checks.push(...contexts.nodes);
      if (contexts.pageInfo.hasNextPage && !contexts.pageInfo.endCursor) throw new Error(`Missing check cursor for PR #${number}`);
      cursor = contexts.pageInfo.hasNextPage ? contexts.pageInfo.endCursor : null;
    } while (cursor);
    return checks;
  }

  async function fetchPrs(repo: string): Promise<Pr[]> {
    const [out, login] = await Promise.all([
      gh([
        "pr", "list", "-R", repo, "--state", "open", "--limit", "30",
        "--json",
        "number,title,author,url,headRefName,headRefOid,isDraft,mergeable,reviewDecision,reviewRequests,reviews",
      ]),
      viewer(),
    ]);
    const rows = JSON.parse(out) as Array<{
      number: number;
      title: string;
      author: { login: string };
      url: string;
      headRefName: string;
      headRefOid: string;
      isDraft: boolean;
      mergeable: string;
      reviewDecision: string;
      reviewRequests: Array<{ login?: string }>;
      reviews: Array<{ author: { login: string }; state: string; commit?: { oid: string } }>;
    }>;
    const prs: Pr[] = [];
    for (let i = 0; i < rows.length; i += 5) {
      const batch = rows.slice(i, i + 5);
      const results = await Promise.all(batch.map((r) => safeChecks(() => checksForPr(repo, r.number, r.headRefOid), (cause) => bb.log.warn(`Checks unavailable for ${repo}#${r.number}: ${cause instanceof Error ? cause.message : String(cause)}`))));
      for (const [index, r] of batch.entries()) {
      const { counts, failing, checks, list } = results[index];
      const needsYou = list
        .filter((c) => c.state === "action")
        .map((c) => `Approval needed: ${c.name}`);
      if (login && (r.reviewRequests ?? []).some((q) => q.login === login)) {
        needsYou.unshift("Review requested from you");
      }
      // Reviews come oldest first; a later CHANGES_REQUESTED overrides an earlier approval.
      const mine = (r.reviews ?? []).filter(
        (v) => v.author.login === login && v.commit?.oid === r.headRefOid && v.state !== "COMMENTED",
      );
      const approvedByMe = !!login && mine.at(-1)?.state === "APPROVED";
      // GitHub rejects approving your own PR, so never offer it.
      const canApprove = !!login && r.author.login !== login;
      const requested = !!login && (r.reviewRequests ?? []).some((q) => q.login === login);
      let action: Pr["action"] = null;
      if (bindingBlocked(list)) {
        if (approvedByMe) action = "rerun";
        else if (canApprove) action = "approve_rerun";
      } else if (requested && !approvedByMe && canApprove) {
        action = "approve";
      }
      prs.push({
        repo,
        number: r.number,
        title: r.title,
        author: r.author.login,
        url: r.url,
        branch: r.headRefName,
        draft: r.isDraft,
        mergeable: r.mergeable,
        review: r.reviewDecision,
        checks,
        counts,
        failing,
        list,
        needsYou,
        action,
        mergeBlocker: blocker({ draft: r.isDraft, mergeable: r.mergeable, checks }),
      });
      }
    }
    return prs;
  }

  bb.rpc.register(rpcContract, {
    prs_list: async () => {
      const repos = await readRepos();
      const prs: Pr[] = [];
      const errors: string[] = [];
      await Promise.all(
        repos.map(async (repo) => {
          try {
            prs.push(...(await fetchPrs(repo)));
          } catch (cause) {
            errors.push(`${repo}: ${cause instanceof Error ? cause.message : String(cause)}`);
          }
        }),
      );
      prs.sort((a, b) => a.repo.localeCompare(b.repo) || b.number - a.number);
      return { prs, errors, repos };
    },

    pr_merge: async ({ repo, number }) => {
      // Resolve a possibly-transferred repo to its current owner first.
      const canonical = await resolveRepo(repo);
      // Allowlist: only repos the user configured can be merged into.
      if (!(await readRepos()).includes(canonical)) {
        throw new Error(`${repo} is not a tracked repository`);
      }
      // Re-check server-side; never trust the button's enabled state.
      const pr = (await fetchPrs(canonical)).find((p) => p.number === number);
      if (pr === undefined) throw new Error(`PR #${number} is not open`);
      if (pr.mergeBlocker !== null) throw new Error(pr.mergeBlocker);

      // Token stays in this variable: never logged, never returned.
      const { stdout } = await run(
        join(homedir(), ".claude/bin/gh-bot-token"),
        [canonical],
        { env: { ...process.env, PATH }, timeout: 30_000 },
      );
      const token = stdout.trim();
      if (token === "") throw new Error("gh-bot-token returned no token");

      // Async merge API: the only one that merges stacked PRs (it also merges
      // every open downstack PR). "default" keeps merge-queue behaviour.
      const base = `repos/${canonical}/pulls/${number}/merge-async`;
      const parse = (raw: string) =>
        JSON.parse(raw) as { status: string; details: { uuid?: string; message?: string } };
      let res = parse(
        await gh(
          ["api", "-X", "PUT", base, "-f", "merge_method=squash", "-f", "merge_action=default"],
          { GH_TOKEN: token },
        ),
      );
      // shortcut: polls ~60s, then gives up; the merge may still land, refresh to check.
      for (let i = 0; i < 30 && res.status === "pending"; i++) {
        const uuid = res.details.uuid;
        if (!uuid) break;
        await sleep(2000);
        try {
          res = parse(await gh(["api", `${base}/${uuid}`], { GH_TOKEN: token }));
        } catch {
          // The merge was accepted; only reading its status failed.
          throw new Error("Merge was requested but its status could not be read; refresh to check");
        }
      }
      if (res.status === "failed") throw new Error(res.details.message ?? "Merge failed");
      if (res.status === "pending") throw new Error("Merge still pending after 60s; refresh to check");
      if (res.status !== "merged" && res.status !== "enqueued") {
        throw new Error(`Unexpected merge status: ${res.status}`);
      }
      bb.log.info(`${res.status} ${canonical}#${number}`);
      // "enqueued" means added to the merge queue, not merged yet.
      return { merged: res.status === "merged" };
    },

    // Approves as the signed-in user (the policy needs Josh's own review, not
    // the bot's), then re-runs the review workflow so the bot re-evaluates.
    pr_approve: async ({ repo, number }) => {
      const canonical = await resolveRepo(repo);
      if (!(await readRepos()).includes(canonical)) {
        throw new Error(`${repo} is not a tracked repository`);
      }
      // Re-derive from fresh state; never trust the button.
      const pr = (await fetchPrs(canonical)).find((p) => p.number === number);
      if (pr === undefined) throw new Error(`PR #${number} is not open`);
      if (pr.action === null) throw new Error("Nothing to approve on this PR");

      let approved = false;
      if (pr.action !== "rerun") {
        await gh(["pr", "review", String(number), "-R", canonical, "--approve"]);
        approved = true;
        bb.log.info(`approved ${canonical}#${number}`);
      }
      if (pr.action === "approve") return { approved, rerun: false };

      try {
        const sha = (await gh(["api", `repos/${canonical}/pulls/${number}`, "--jq", ".head.sha"])).trim();
        const runs = JSON.parse(
          await gh([
            "run", "list", "-R", canonical, "--commit", sha, "--limit", "50",
            "--json", "databaseId,workflowName",
          ]),
        ) as Array<{ databaseId: number; workflowName: string }>;
        // gh lists newest first.
        const target = runs.find((x) => x.workflowName === REVIEW_WORKFLOW);
        if (!target) throw new Error(`no "${REVIEW_WORKFLOW}" run found for this commit`);
        try {
          await gh(["run", "rerun", String(target.databaseId), "-R", canonical]);
          bb.log.info(`re-ran ${REVIEW_WORKFLOW} ${canonical}#${number}`);
        } catch (cause) {
          // The approval itself starts a fresh run; GitHub refuses to rerun one in flight.
          const msg = cause instanceof Error ? cause.message : String(cause);
          if (!/already running/i.test(msg)) throw cause;
          bb.log.info(`${REVIEW_WORKFLOW} ${canonical}#${number} already running; skipped re-run`);
        }
      } catch (cause) {
        const why = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`${approved ? "Approved, but " : ""}re-run failed: ${why}`);
      }
      return { approved, rerun: true };
    },
  });
}
