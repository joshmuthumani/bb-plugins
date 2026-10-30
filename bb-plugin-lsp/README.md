# bb-plugin-lsp

A BB plugin that adds LSP-backed editing (TypeScript/JavaScript) to BB.

- `app.tsx` — registers a `fileOpener` ("Editor with LSP") for ts/tsx/js/jsx/mjs/cjs.
- `editor.tsx` — Monaco editor; hover, completion, and diagnostics via `lsp-client.ts`.
- `lsp-client.ts` — minimal JSON-RPC client (request/response correlation, ordered sends).
- `server.ts` — RPC: `file_read`/`file_write` (via `bb.sdk.files`) and `lsp_start`/`lsp_send`/`lsp_stop`.
  Server messages reach the editor on realtime channel `lsp:<sessionId>`.
- `host.ts`, `contract.ts`, `lsp-process.ts` — host entry that spawns
  `typescript-language-server` and frames LSP messages.
- `PLUGIN_OVERVIEW.md` — store listing text.

## Setup

Needs `typescript-language-server` on `PATH` and a JavaScript TypeScript 5.x/6.x
(TypeScript 7 has no `tsserver.js`). Point the plugin at it when the workspace has none:

```sh
npm i -g typescript@5 typescript-language-server
bb plugin config lsp set tsserverPath /opt/homebrew/lib/node_modules/typescript/lib
```

## Development

```sh
npm install
npm test
bb plugin build
bb plugin install . --yes
```

`dist/` is committed because git installs load prebuilt artifacts.

## Limits

TypeScript/JavaScript only; full-document sync; hover, completion, and diagnostics only
(no go-to-definition, rename, or code actions yet). Monaco's editor worker runs on the main thread.
