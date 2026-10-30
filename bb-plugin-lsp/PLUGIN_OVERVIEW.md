Open TypeScript and JavaScript files in a Monaco editor with real language
intelligence: hover types, completions, and live error markers.

## What you get

- An **Editor with LSP** option in "Open with" for `.ts`, `.tsx`, `.js`,
  `.jsx`, `.mjs`, and `.cjs` files.
- Hover, completion, and diagnostics from `typescript-language-server`.
- Save with Cmd/Ctrl+S; the save is refused if the file changed on disk.

## Requirements

`typescript-language-server` on your `PATH` (or in the workspace's
`node_modules/.bin`), plus a JavaScript TypeScript (5.x or 6.x). TypeScript 7
(native, e.g. Homebrew's `typescript`) has no `tsserver.js` and does not work.
If the workspace has no `typescript`, set the **TypeScript lib folder**
setting, for example `/opt/homebrew/lib/node_modules/typescript/lib`.
