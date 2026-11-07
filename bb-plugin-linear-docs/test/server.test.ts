// Unit tests for the `bb linear-docs` CLI. These run the plugin factory against
// a fake bb API. The Linear API is replaced by a fetch stub, so no test
// reaches the network.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../server.ts";

type RunResult = { exitCode: number; stdout?: string; stderr?: string };
type CliSpec = { name: string; run: (argv: string[]) => Promise<RunResult> };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function loadCli(
  settings: Record<string, string | undefined> = {},
): Promise<CliSpec> {
  let captured: CliSpec | undefined;
  const fakeBb = {
    log: { info() {}, warn() {}, error() {} },
    settings: { define: () => ({ get: async () => settings }) },
    cli: {
      register(spec: CliSpec) {
        captured = spec;
      },
    },
    onDispose() {},
  };
  await plugin(fakeBb as never);
  assert.ok(captured, "plugin should register the linear-docs CLI");
  return captured;
}

function stubFetch(
  respond: () => Response,
): { bodies: Array<{ query: string; variables: { input: Record<string, unknown> } }> } {
  const seen: { bodies: Array<{ query: string; variables: { input: Record<string, unknown> } }> } = {
    bodies: [],
  };
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen.bodies.push(JSON.parse(String(init?.body)));
    return respond();
  }) as typeof fetch;
  return seen;
}

const okDoc = () =>
  new Response(
    JSON.stringify({
      data: {
        documentCreate: {
          success: true,
          document: { id: "d1", title: "Plan", url: "https://linear.app/x/document/plan" },
        },
      },
    }),
    { status: 200 },
  );

test("help prints usage with exit 0", async () => {
  const cli = await loadCli();
  const result = await cli.run(["help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /bb linear-docs create/);
});

test("unknown command fails", async () => {
  const cli = await loadCli();
  assert.equal((await cli.run(["delete", "x"])).exitCode, 1);
});

test("create rejects an empty title", async () => {
  const cli = await loadCli();
  const result = await cli.run(["create", "   "]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /Title must be/);
});

test("title limit counts characters, not UTF-16 units", async () => {
  const cli = await loadCli({ apiKey: "k", teamId: "T1" });
  const emoji = "😀".repeat(200); // 200 characters, 400 UTF-16 units
  const seen = stubFetch(okDoc);
  const result = await cli.run(["create", emoji]);
  assert.equal(result.exitCode, 0);
  assert.equal(seen.bodies.length, 1);
});

test("a title over 200 characters fails", async () => {
  const cli = await loadCli();
  const result = await cli.run(["create", "a".repeat(201)]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /Title must be/);
});

test("an unknown flag fails instead of being dropped", async () => {
  const cli = await loadCli({ apiKey: "k", teamId: "T1" });
  const result = await cli.run(["create", "Plan", "--body", "x.md"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /Unknown flag --body/);
});

test("a flag with no value fails before any API call", async () => {
  const cli = await loadCli();
  const result = await cli.run(["create", "Title", "--team"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /Missing value for --team/);
});

test("an empty --team value does not clear the default team", async () => {
  const cli = await loadCli({ apiKey: "k", teamId: "T1" });
  const seen = stubFetch(okDoc);
  const result = await cli.run(["create", "Plan", "--team="]);
  assert.equal(result.exitCode, 1); // empty value is rejected as missing
  assert.equal(seen.bodies.length, 0);
});

test("create without a key fails with the setup hint", async () => {
  const cli = await loadCli({ teamId: "T1" });
  const result = await cli.run(["create", "Title"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /No Linear API key set/);
});

test("create without team or project and no defaults fails", async () => {
  const cli = await loadCli({ apiKey: "k" });
  const result = await cli.run(["create", "Title"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /Pass --team or --project/);
});

test("success sends the documentCreate input and prints the URL", async () => {
  const cli = await loadCli({ apiKey: "k", teamId: "T1" });
  const seen = stubFetch(okDoc);
  const result = await cli.run(["create", "Plan", "--project=P9"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /https:\/\/linear\.app\/x\/document\/plan/);
  const input = seen.bodies[0].variables.input;
  assert.equal(input.title, "Plan");
  assert.equal(input.teamId, "T1");
  assert.equal(input.projectId, "P9");
  assert.equal(input.content, "");
});

test("--body-file content is sent as the document body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linear-docs-test-"));
  try {
    const file = join(dir, "body.md");
    await writeFile(file, "# Hello\n");
    const cli = await loadCli({ apiKey: "k", teamId: "T1" });
    const seen = stubFetch(okDoc);
    const result = await cli.run(["create", "Plan", "--body-file", file]);
    assert.equal(result.exitCode, 0);
    assert.equal(seen.bodies[0].variables.input.content, "# Hello\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing --body-file returns exit 1 with a message, not a throw", async () => {
  const cli = await loadCli({ apiKey: "k", teamId: "T1" });
  const result = await cli.run(["create", "Plan", "--body-file", "/nonexistent/x.md"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /ENOENT/);
});

test("a non-2xx Linear response includes Linear's error body", async () => {
  const cli = await loadCli({ apiKey: "k", teamId: "T1" });
  stubFetch(
    () =>
      new Response('{"errors":[{"message":"Team not found"}]}', { status: 400 }),
  );
  const result = await cli.run(["create", "Plan"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /HTTP 400.*Team not found/);
});
