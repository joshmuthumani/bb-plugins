// bb-plugin-linear-docs — headless BB plugin backend.
//
// Adds `bb linear-docs create` so agents and people can create Linear documents.
// BB's bundled linear plugin has no document command, so this plugin calls
// Linear's GraphQL API (documentCreate) directly with its own API key.
import { readFile, stat } from "node:fs/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const LINEAR_API = "https://api.linear.app/graphql";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TITLE_CHARS = 200;
const MAX_BODY_BYTES = 1_000_000;
const KNOWN_FLAGS = new Set(["team", "project", "body-file"]);

const USAGE = [
  "Usage:",
  "  bb linear-docs create <title> [--body-file <path>] [--team <id>] [--project <id>] [--json]",
].join("\n");

const DOCUMENT_CREATE = `
mutation DocumentCreate($input: DocumentCreateInput!) {
  documentCreate(input: $input) {
    success
    document { id title url }
  }
}`;

interface CreatedDocument {
  id: string;
  title: string;
  url: string;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  // Secret values stay on the server. Set with:
  //   bb plugin config linear-docs set apiKey <key>
  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      label: "Linear API key",
      secret: true,
    },
    teamId: {
      type: "string",
      label: "Default Linear team id (optional)",
    },
    projectId: {
      type: "string",
      label: "Default Linear project id (optional)",
    },
  });

  async function createDocument(input: {
    title: string;
    content: string;
    teamId?: string;
    projectId?: string;
  }): Promise<CreatedDocument> {
    const current = await settings.get();
    if (!current.apiKey) {
      throw new Error(
        "No Linear API key set. Run: bb plugin config linear-docs set apiKey <key>",
      );
    }
    const response = await fetch(LINEAR_API, {
      method: "POST",
      headers: {
        Authorization: current.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: DOCUMENT_CREATE, variables: { input } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      // Linear's error body names the bad field; include it, bounded.
      throw new Error(`Linear API returned HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    const payload = JSON.parse(text) as {
      data?: { documentCreate?: { success: boolean; document: CreatedDocument | null } };
      errors?: Array<{ message: string }>;
    };
    if (payload.errors?.length) {
      throw new Error(`Linear error: ${payload.errors.map((e) => e.message).join("; ")}`);
    }
    const result = payload.data?.documentCreate;
    if (!result?.success || !result.document) {
      throw new Error("Linear did not create the document");
    }
    return result.document;
  }

  bb.cli.register({
    name: "linear-docs",
    summary: "Create Linear documents",
    commands: [
      {
        name: "create",
        summary: "Create a Linear document",
        usage:
          "bb linear-docs create <title> [--body-file <path>] [--team <id>] [--project <id>] [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const positional: string[] = [];
      const flags: Record<string, string> = {};
      for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--json") continue;
        if (arg.startsWith("--")) {
          // Accept --flag value and --flag=value. Unknown flags fail loudly
          // instead of being dropped, so a typo cannot silently change the doc.
          const eq = arg.indexOf("=");
          const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
          if (!KNOWN_FLAGS.has(name)) {
            return { exitCode: 1, stderr: `Unknown flag ${arg}\n${USAGE}` };
          }
          let value: string | undefined;
          if (eq !== -1) {
            value = arg.slice(eq + 1);
          } else {
            value = argv[i + 1];
            i++;
          }
          if (value === undefined || value === "" || value.startsWith("--")) {
            return { exitCode: 1, stderr: `Missing value for --${name}\n${USAGE}` };
          }
          flags[name] = value;
        } else {
          positional.push(arg);
        }
      }

      const [command, ...titleWords] = positional;
      if (command === undefined || command === "help") {
        return { exitCode: 0, stdout: USAGE };
      }
      if (command !== "create") {
        return { exitCode: 1, stderr: USAGE };
      }

      const title = titleWords.join(" ").trim();
      if (title === "" || [...title].length > MAX_TITLE_CHARS) {
        return {
          exitCode: 1,
          stderr: `Title must be 1 to ${MAX_TITLE_CHARS} characters.\n${USAGE}`,
        };
      }

      try {
        let content = "";
        if (flags["body-file"] !== undefined) {
          // Check size before reading, so a huge file is never loaded.
          const info = await stat(flags["body-file"]);
          if (info.size > MAX_BODY_BYTES) {
            return { exitCode: 1, stderr: `Body file exceeds ${MAX_BODY_BYTES} bytes.` };
          }
          content = await readFile(flags["body-file"], "utf8");
        }

        const current = await settings.get();
        const teamId = flags.team || current.teamId || undefined;
        const projectId = flags.project || current.projectId || undefined;
        if (!teamId && !projectId) {
          return {
            exitCode: 1,
            stderr:
              "Pass --team or --project, or set a default: bb plugin config linear-docs set teamId <id>",
          };
        }

        const doc = await createDocument({ title, content, teamId, projectId });
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify(doc) : `Created ${doc.title}\n${doc.url}`,
        };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
