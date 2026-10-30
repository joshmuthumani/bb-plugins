// Spawns typescript-language-server and speaks LSP's Content-Length framing,
// so callers deal only in whole JSON-RPC message strings.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ponytail: needs typescript-language-server on PATH or in the workspace's
// node_modules; bundling it is impossible (tsserver is read from disk).
const BIN = "typescript-language-server";
const resolveBin = (rootPath: string) => {
  const local = join(rootPath, "node_modules", ".bin", BIN);
  return existsSync(local) ? local : BIN;
};

// Needs a JavaScript TypeScript (5.x/6.x) lib dir containing tsserver.js;
// TypeScript 7 (native, e.g. Homebrew) has none. Workspace copy wins.
const TS_LIBS = [
  "/opt/homebrew/lib/node_modules/typescript/lib",
  "/usr/local/lib/node_modules/typescript/lib",
];
const pickTsLib = (rootPath: string, configured?: string) =>
  existsSync(join(rootPath, "node_modules", "typescript", "lib", "tsserver.js"))
    ? undefined
    : [configured, ...TS_LIBS].find((p) => p && existsSync(join(p, "tsserver.js")));

export interface LspProcess {
  send(message: string): boolean;
  stop(): void;
}

export function startLsp(
  rootPath: string,
  tsserverPath: string | undefined,
  onMessage: (message: string) => void,
  onExit: () => void,
): LspProcess {
  const child: ChildProcess = spawn(resolveBin(rootPath), ["--stdio"], {
    cwd: rootPath,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const tsLib = pickTsLib(rootPath, tsserverPath);
  // Inject tsserver.path into the client's initialize request.
  const withTsserver = (message: string) => {
    if (!tsLib || !message.includes('"initialize"')) return message;
    const msg = JSON.parse(message);
    if (msg.method !== "initialize") return message;
    msg.params.initializationOptions = {
      ...msg.params.initializationOptions,
      tsserver: { path: tsLib, ...msg.params.initializationOptions?.tsserver },
    };
    return JSON.stringify(msg);
  };
  let buffer = Buffer.alloc(0);
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const match = /Content-Length: *(\d+)/i.exec(
        buffer.subarray(0, headerEnd).toString("ascii"),
      );
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const start = headerEnd + 4;
      const end = start + Number(match[1]);
      if (buffer.length < end) return;
      onMessage(buffer.subarray(start, end).toString("utf8"));
      buffer = buffer.subarray(end);
    }
  });
  child.on("exit", onExit);
  child.on("error", onExit); // e.g. ENOENT: binary not installed
  return {
    send(message) {
      if (!child.stdin?.writable) return false;
      const body = Buffer.from(withTsserver(message), "utf8");
      child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      child.stdin.write(body);
      return true;
    },
    stop() {
      child.kill();
    },
  };
}
