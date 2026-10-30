import assert from "node:assert/strict";
import { test } from "node:test";
import { LspClient } from "./lsp-client.ts";

test("correlates responses to requests by id", async () => {
  const sent: any[] = [];
  const c = new LspClient(async (m) => void sent.push(JSON.parse(m)));
  const a = c.request("a", {});
  const b = c.request("b", {});
  await new Promise((r) => setTimeout(r, 0));
  c.receive(JSON.stringify({ id: sent[1].id, result: "B" }));
  c.receive(JSON.stringify({ id: sent[0].id, result: "A" }));
  assert.equal(await a, "A");
  assert.equal(await b, "B");
});

test("rejects on error responses", async () => {
  const sent: any[] = [];
  const c = new LspClient(async (m) => void sent.push(JSON.parse(m)));
  const p = c.request("x", {});
  await new Promise((r) => setTimeout(r, 0));
  c.receive(JSON.stringify({ id: sent[0].id, error: { message: "boom" } }));
  await assert.rejects(p, /boom/);
});

test("sends stay in order even when the transport is slow", async () => {
  const order: string[] = [];
  const c = new LspClient(async (m) => {
    const msg = JSON.parse(m);
    if (msg.method === "first") await new Promise((r) => setTimeout(r, 20));
    order.push(msg.method);
  });
  c.notify("first", {});
  c.notify("second", {});
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(order, ["first", "second"]);
});

test("routes notifications and acks server requests", async () => {
  const sent: any[] = [];
  const c = new LspClient(async (m) => void sent.push(JSON.parse(m)));
  const seen: string[] = [];
  c.onNotification = (method) => void seen.push(method);
  c.receive(JSON.stringify({ method: "textDocument/publishDiagnostics", params: {} }));
  c.receive(JSON.stringify({ id: 7, method: "window/workDoneProgress/create", params: {} }));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(seen, ["textDocument/publishDiagnostics"]);
  assert.deepEqual(sent[0], { jsonrpc: "2.0", id: 7, result: null });
});
