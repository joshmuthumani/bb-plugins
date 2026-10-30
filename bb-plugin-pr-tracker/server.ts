// bb-plugin-pr-tracker — backend. Lists open PRs with their Actions status and
// merges them as the Claude Code GitHub App bot. Reads use the `gh` login;
// only the merge mints a bot token (see ~/.claude/rules/shipping-gates.md).
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const run = promisify(execFile);

const checkState = z.enum(["pass", "fail", "pending", "none"]);
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
  counts: z.object({ pass: z.number(), fail: z.number(), pending: z.number() }),
  failing: z.array(z.string()),
  mergeBlocker: z.string().nullable(),
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
});

const REPO = /^[\w.-]+\/[\w.-]+$/;
// The daemon's PATH may lack Homebrew; gh lives there.
const PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;

type RawCheck = {
  __typename?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  name?: string;
  context?: string;
};

// Fold CheckRun and StatusContext entries into pass/fail/pending counts.
function summarize(rollup: RawCheck[]) {
  const counts = { pass: 0, fail: 0, pending: 0 };
  const failing: string[] = [];
  for (const c of rollup) {
    const label = c.name ?? c.context ?? "check";
    const outcome = c.conclusion ?? c.state ?? "";
    if (c.status && c.status !== "COMPLETED") counts.pending++;
    else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(outcome)) counts.pass++;
    else if (["PENDING", "EXPECTED", ""].includes(outcome)) counts.pending++;
    else {
      counts.fail++;
      failing.push(label);
    }
  }
  const checks: Pr["checks"] =
    rollup.length === 0
      ? "none"
      : counts.fail > 0
        ? "fail"
        : counts.pending > 0
          ? "pending"
          : "pass";
  return { counts, failing, checks };
}

function blocker(p: {
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

  async function fetchPrs(repo: string): Promise<Pr[]> {
    const out = await gh([
      "pr", "list", "-R", repo, "--state", "open", "--limit", "30",
      "--json",
      "number,title,author,url,headRefName,isDraft,mergeable,reviewDecision,statusCheckRollup",
    ]);
    const rows = JSON.parse(out) as Array<{
      number: number;
      title: string;
      author: { login: string };
      url: string;
      headRefName: string;
      isDraft: boolean;
      mergeable: string;
      reviewDecision: string;
      statusCheckRollup: RawCheck[] | null;
    }>;
    return rows.map((r) => {
      const { counts, failing, checks } = summarize(r.statusCheckRollup ?? []);
      return {
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
        mergeBlocker: blocker({ draft: r.isDraft, mergeable: r.mergeable, checks }),
      };
    });
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

      await gh(["pr", "merge", String(number), "-R", canonical, "--squash"], {
        GH_TOKEN: token,
      });
      bb.log.info(`merged ${canonical}#${number}`);
      return { merged: true };
    },
  });
}
