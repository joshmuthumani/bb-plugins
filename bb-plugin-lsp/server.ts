// bb-plugin-lsp backend: relays LSP JSON-RPC between the editor (RPC +
// realtime) and typescript-language-server running in the host entry.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { hostContract, hostSignals } from "./contract.js";

const fileRef = z.object({
  kind: z.enum(["workspace", "host"]),
  environmentId: z.string().nullable(),
  hostId: z.string().optional(),
  path: z.string(),
});

export const rpcContract = defineRpcContract({
  file_read: {
    input: fileRef,
    output: z.object({
      content: z.string(),
      sha256: z.string(),
      absPath: z.string(),
      rootPath: z.string(),
      hostId: z.string(),
    }),
  },
  file_write: {
    input: fileRef.extend({ content: z.string(), expectedSha256: z.string() }),
    output: z.object({ outcome: z.enum(["written", "conflict"]), sha256: z.string().nullable() }),
  },
  lsp_start: {
    input: z.object({ hostId: z.string().optional(), rootPath: z.string() }),
    output: z.object({ sessionId: z.string() }),
  },
  lsp_send: {
    input: z.object({
      hostId: z.string().optional(),
      sessionId: z.string(),
      message: z.string(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  lsp_stop: {
    input: z.object({ hostId: z.string().optional(), sessionId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
});

/** Realtime channels the editor subscribes to: `lsp:<sessionId>` messages. */
export const channel = (sessionId: string) => `lsp:${sessionId}`;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    tsserverPath: {
      type: "string",
      label: "TypeScript lib folder",
      description: "Folder containing tsserver.js (TypeScript 5/6), used when the workspace has no typescript. Example: /usr/local/lib/node_modules/typescript/lib",
      default: "",
    },
  });
  const { tsserverPath } = await settings.get();
  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });
  host.experimental_onSignal("message", ({ payload }) =>
    bb.realtime.publish(channel(payload.sessionId), payload.message),
  );
  host.experimental_onSignal("exit", ({ payload }) =>
    bb.realtime.publish(channel(payload.sessionId), null),
  );

  // Omitted hostId means the server's own machine.
  const resolveHost = async (hostId?: string) => {
    const id = hostId ?? (await bb.sdk.system.config()).primaryHostId;
    if (!id) throw new Error("No local host is enrolled");
    return { hostId: id };
  };

  // Workspace paths are worktree-relative; host paths are absolute.
  const locate = async (ref: z.infer<typeof fileRef>) => {
    if (ref.kind === "workspace") {
      if (!ref.environmentId) throw new Error("Missing environment");
      const env = await bb.sdk.environments.get({ environmentId: ref.environmentId });
      if (!env.path) throw new Error("Environment has no path");
      return { hostId: env.hostId, rootPath: env.path, absPath: join(env.path, ref.path) };
    }
    if (!isAbsolute(ref.path)) throw new Error("Host path must be absolute");
    const { hostId } = await resolveHost(ref.hostId);
    return { hostId, rootPath: dirname(ref.path), absPath: ref.path };
  };

  bb.rpc.register(rpcContract, {
    file_read: async (ref) => {
      const loc = await locate(ref);
      const file = await bb.sdk.files.read({ hostId: loc.hostId, path: loc.absPath, rootPath: loc.rootPath });
      return { content: file.content, sha256: file.sha256, ...loc };
    },
    file_write: async ({ content, expectedSha256, ...ref }) => {
      const loc = await locate(ref);
      const saved = await bb.sdk.files.write({
        hostId: loc.hostId, path: loc.absPath, rootPath: loc.rootPath, content, expectedSha256,
      });
      return saved.outcome === "written"
        ? { outcome: "written" as const, sha256: saved.sha256 }
        : { outcome: "conflict" as const, sha256: saved.currentSha256 };
    },
    lsp_start: async ({ hostId, rootPath }) =>
      host.call("start", { rootPath, ...(tsserverPath ? { tsserverPath } : {}) }, await resolveHost(hostId)),
    lsp_send: async ({ hostId, sessionId, message }) =>
      host.call("send", { sessionId, message }, await resolveHost(hostId)),
    lsp_stop: async ({ hostId, sessionId }) =>
      host.call("stop", { sessionId }, await resolveHost(hostId)),
  });
}
