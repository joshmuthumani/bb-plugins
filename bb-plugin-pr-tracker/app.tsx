// bb-plugin-pr-tracker — frontend. A right-panel tab listing open PRs with
// their Actions status and a Merge button.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { Pr, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const POLL_MS = 60_000;

const dot: Record<Pr["checks"], string> = {
  pass: "bg-green-500",
  fail: "bg-destructive",
  pending: "bg-yellow-500 animate-pulse",
  none: "bg-muted-foreground/40",
};

function checksLabel(pr: Pr) {
  const { pass, fail, pending } = pr.counts;
  if (pr.checks === "none") return "No checks";
  const parts = [`${pass} passed`];
  if (fail > 0) parts.push(`${fail} failed`);
  if (pending > 0) parts.push(`${pending} running`);
  return parts.join(" · ");
}

function PrRow({ pr, onChanged }: { pr: Pr; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const merge = async () => {
    setBusy(true);
    setError(null);
    try {
      await rpc.call("pr_merge", { repo: pr.repo, number: pr.number });
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setArmed(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="space-y-1.5 px-3 py-2.5 text-sm">
      <div className="flex items-start gap-2">
        <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", dot[pr.checks])} />
        <div className="min-w-0 flex-1">
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="block truncate font-medium hover:underline"
            title={pr.title}
          >
            {pr.title}
          </a>
          <p className="truncate text-xs text-muted-foreground">
            #{pr.number} · {pr.author} · {pr.branch}
          </p>
          <p className="text-xs text-muted-foreground">{checksLabel(pr)}</p>
          {pr.failing.length > 0 ? (
            <p className="truncate text-xs text-destructive" title={pr.failing.join(", ")}>
              {pr.failing.join(", ")}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-2 pl-4">
        {armed ? (
          <>
            <Button size="sm" disabled={busy} onClick={merge}>
              {busy ? "Merging…" : "Confirm squash merge"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setArmed(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <span title={pr.mergeBlocker ?? "Squash and merge as the bot"}>
            <Button
              size="sm"
              variant="outline"
              disabled={pr.mergeBlocker !== null}
              onClick={() => setArmed(true)}
            >
              <Icon name="GitMerge" className="size-3.5" />
              Merge
            </Button>
          </span>
        )}
        {pr.mergeBlocker !== null ? (
          <span className="text-xs text-muted-foreground">{pr.mergeBlocker}</span>
        ) : null}
      </div>
      {error === null ? null : (
        <p role="alert" className="pl-4 text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

function PrPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<{
    prs: Pr[];
    errors: string[];
    repos: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    rpc.call("prs_list").then(
      (result) => {
        setData(result);
        setError(null);
      },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);

  useEffect(() => {
    refetch();
    const timer = setInterval(refetch, POLL_MS);
    return () => clearInterval(timer);
  }, [refetch]);

  const byRepo = new Map<string, Pr[]>();
  for (const pr of data?.prs ?? []) {
    byRepo.set(pr.repo, [...(byRepo.get(pr.repo) ?? []), pr]);
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {data === null ? "Loading…" : `${data.prs.length} open`}
        </span>
        <Button size="icon" variant="ghost" className="size-7" aria-label="Refresh" onClick={refetch}>
          <Icon name="RefreshCw" className="size-4" />
        </Button>
      </div>
      {error === null ? null : (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {data?.errors.map((e) => (
        <p key={e} role="alert" className="px-3 py-2 text-xs text-destructive">
          {e}
        </p>
      ))}
      {data !== null && data.repos.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">
          No repositories set. Run{" "}
          <code>bb plugin config pr-tracker</code> and set <code>repos</code> to{" "}
          <code>owner/repo,owner/repo</code>.
        </p>
      ) : null}
      {[...byRepo].map(([repo, prs]) => (
        <section key={repo}>
          <h3 className="bg-muted/40 px-3 py-1.5 text-xs font-semibold">{repo}</h3>
          <ul className="divide-y divide-border">
            {prs.map((pr) => (
              <PrRow key={pr.number} pr={pr} onChanged={refetch} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "prs",
    title: "Pull requests",
    icon: "GitPullRequest",
    component: PrPanel,
    layout: "flush",
  });
});
