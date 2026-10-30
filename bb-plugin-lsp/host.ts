import { randomUUID } from "node:crypto";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals } from "./contract.js";
import { startLsp, type LspProcess } from "./lsp-process.js";

const sessions = new Map<string, LspProcess>();

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    start: async ({ rootPath, tsserverPath }, context) => {
      const sessionId = randomUUID();
      const lsp = startLsp(
        rootPath,
        tsserverPath,
        (message) =>
          void context.experimental_emitSignal("message", {
            sessionId,
            message,
          }),
        () => {
          sessions.delete(sessionId);
          void context.experimental_emitSignal("exit", { sessionId });
        },
      );
      sessions.set(sessionId, lsp);
      return { sessionId };
    },
    send: async ({ sessionId, message }) => ({
      ok: sessions.get(sessionId)?.send(message) ?? false,
    }),
    stop: async ({ sessionId }) => {
      sessions.get(sessionId)?.stop();
      return { ok: sessions.delete(sessionId) };
    },
  },
  dispose: async () => {
    for (const lsp of sessions.values()) lsp.stop();
    sessions.clear();
  },
});
