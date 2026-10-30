// bb-plugin-lsp frontend: a Monaco file editor with TypeScript language
// intelligence (hover, completion, diagnostics) from a host-side LSP.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { LspEditor } from "./editor";

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "lsp-editor",
    title: "Editor with LSP",
    extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs"],
    component: LspEditor,
  });
});
