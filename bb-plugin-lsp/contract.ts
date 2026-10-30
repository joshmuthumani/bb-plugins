import {
  defineRpcContract,
  type ExperimentalHostSignals,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Host-side language-server sessions, one child process per (host, root). */
export const hostContract = defineRpcContract({
  start: {
    input: z
      .object({ rootPath: z.string().min(1), tsserverPath: z.string().optional() })
      .strict(),
    output: z.object({ sessionId: z.string() }).strict(),
  },
  send: {
    input: z
      .object({ sessionId: z.string(), message: z.string().max(5_000_000) })
      .strict(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
  stop: {
    input: z.object({ sessionId: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
});

export const hostSignals = {
  message: {
    payload: z.object({ sessionId: z.string(), message: z.string() }).strict(),
  },
  exit: {
    payload: z.object({ sessionId: z.string() }).strict(),
  },
} satisfies ExperimentalHostSignals;
