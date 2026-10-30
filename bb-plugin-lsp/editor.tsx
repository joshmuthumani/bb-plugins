import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { LspClient } from "./lsp-client";

const LANGS = ["typescript", "javascript"];
const clients = new Map<string, LspClient>(); // model uri → client
let providersRegistered = false;

const lspPos = (p: monaco.Position) => ({ line: p.lineNumber - 1, character: p.column - 1 });
const docOf = (m: monaco.editor.ITextModel) => ({ uri: m.uri.toString() });
const md = (v: any): string =>
  typeof v === "string" ? v : Array.isArray(v) ? v.map(md).join("\n\n") : v?.value ?? "";

function registerProviders() {
  if (providersRegistered) return;
  providersRegistered = true;
  for (const lang of LANGS) {
    monaco.languages.registerHoverProvider(lang, {
      async provideHover(model, position) {
        const c = clients.get(model.uri.toString());
        const r = await c?.request("textDocument/hover", { textDocument: docOf(model), position: lspPos(position) });
        if (!r?.contents) return null;
        return { contents: [{ value: md(r.contents) }] };
      },
    });
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: [".", '"', "'", "/", "<"],
      async provideCompletionItems(model, position) {
        const c = clients.get(model.uri.toString());
        const r = await c?.request("textDocument/completion", { textDocument: docOf(model), position: lspPos(position) });
        const items: any[] = Array.isArray(r) ? r : r?.items ?? [];
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        return {
          suggestions: items.map((i) => ({
            label: i.label,
            kind: monaco.languages.CompletionItemKind.Property,
            insertText: i.insertText ?? i.label,
            detail: i.detail,
            sortText: i.sortText,
            range,
          })),
        };
      },
    });
  }
}

const SEVERITY = [0, monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint];

export function LspEditor({ path, source }: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const host = useRef<HTMLDivElement>(null);
  const clientRef = useRef<LspClient | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState("loading…");

  useRealtime(`lsp:${sessionId ?? "none"}`, (payload) => {
    if (typeof payload === "string") clientRef.current?.receive(payload);
    else setStatus("language server exited");
  });

  useEffect(() => {
    if (source.kind === "thread-storage") return void setStatus("unsupported source");
    const ref = { kind: source.kind, environmentId: source.environmentId, path, ...(source.experimental_hostId ? { hostId: source.experimental_hostId } : {}) };
    let disposed = false;
    let session: string | null = null;
    let editor: monaco.editor.IStandaloneCodeEditor | undefined;
    let model: monaco.editor.ITextModel | undefined;

    (async () => {
      const file = await rpc.call("file_read", ref);
      const started = await rpc.call("lsp_start", { hostId: file.hostId, rootPath: file.rootPath });
      if (disposed) return void rpc.call("lsp_stop", { hostId: file.hostId, sessionId: started.sessionId });
      session = started.sessionId;
      const lang = /\.(jsx?|mjs|cjs)$/.test(path) ? "javascript" : "typescript";
      const uri = monaco.Uri.file(file.absPath);
      model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(file.content, lang, uri);
      const client = new LspClient((message) => rpc.call("lsp_send", { hostId: file.hostId, sessionId: session!, message }));
      client.onNotification = (method, params) => {
        if (method === "textDocument/publishDiagnostics" && params.uri === uri.toString()) {
          monaco.editor.setModelMarkers(model!, "lsp", params.diagnostics.map((d: any) => ({
            severity: SEVERITY[d.severity ?? 1],
            message: d.message,
            startLineNumber: d.range.start.line + 1,
            startColumn: d.range.start.character + 1,
            endLineNumber: d.range.end.line + 1,
            endColumn: d.range.end.character + 1,
          })));
        }
      };
      clientRef.current = client;
      clients.set(uri.toString(), client);
      setSessionId(session); // subscribes to the realtime channel before initialize
      await new Promise((r) => setTimeout(r, 50));
      await client.request("initialize", {
        processId: null,
        rootUri: monaco.Uri.file(file.rootPath).toString(),
        capabilities: { textDocument: { hover: {}, completion: {}, publishDiagnostics: {} } },
      });
      client.notify("initialized", {});
      client.notify("textDocument/didOpen", {
        textDocument: { uri: uri.toString(), languageId: lang, version: 1, text: model.getValue() },
      });

      registerProviders();
      editor = monaco.editor.create(host.current!, { model, automaticLayout: true, theme: "vs-dark", minimap: { enabled: false } });
      let sha = file.sha256;
      model.onDidChangeContent(() =>
        client.notify("textDocument/didChange", {
          textDocument: { uri: uri.toString(), version: model!.getVersionId() },
          contentChanges: [{ text: model!.getValue() }], // full sync; valid under incremental too
        }),
      );
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
        const r = await rpc.call("file_write", { ...ref, content: model!.getValue(), expectedSha256: sha });
        if (r.outcome === "written" && r.sha256) sha = r.sha256;
        setStatus(r.outcome === "written" ? "saved" : "conflict: file changed on disk");
      });
      setStatus("ready");
    })().catch((e) => setStatus(`error: ${e instanceof Error ? e.message : String(e)}`));

    return () => {
      disposed = true;
      if (model) {
        clients.delete(model.uri.toString());
        monaco.editor.setModelMarkers(model, "lsp", []);
      }
      editor?.dispose();
      model?.dispose();
      clientRef.current = null;
      if (session) void rpc.call("lsp_stop", { sessionId: session }).catch(() => {});
    };
  }, [path, source.kind, source.environmentId, source.experimental_hostId, rpc]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div ref={host} style={{ flex: 1, minHeight: 0 }} />
      <div style={{ fontSize: 11, padding: "2px 8px", opacity: 0.7 }}>LSP: {status}</div>
    </div>
  );
}
