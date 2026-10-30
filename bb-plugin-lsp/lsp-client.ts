// Minimal LSP client: JSON-RPC over a caller-supplied transport. Handles
// request/response correlation and routes server notifications.
type Json = Record<string, unknown>;

export class LspClient {
  private nextId = 1;
  private pending = new Map<number, (value: any, error?: Json) => void>();
  private chain: Promise<unknown> = Promise.resolve();
  onNotification: (method: string, params: any) => void = () => {};

  private transport: (message: string) => Promise<unknown>;

  constructor(transport: (message: string) => Promise<unknown>) {
    this.transport = transport;
  }

  /** Feed one raw JSON-RPC message from the server. */
  receive(raw: string) {
    const msg = JSON.parse(raw);
    if (msg.id !== undefined && msg.method === undefined) {
      this.pending.get(msg.id)?.(msg.result, msg.error);
      this.pending.delete(msg.id);
    } else if (msg.id !== undefined) {
      // Server → client request (e.g. workDoneProgress/create): ack with null.
      this.write({ jsonrpc: "2.0", id: msg.id, result: null });
    } else {
      this.onNotification(msg.method, msg.params);
    }
  }

  request<T = any>(method: string, params: Json): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (value, error) =>
        error ? reject(new Error(String(error.message))) : resolve(value),
      );
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Json) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Sends are chained so RPC round trips cannot reorder messages. */
  private write(message: Json) {
    const raw = JSON.stringify(message);
    this.chain = this.chain.then(() => this.transport(raw)).catch(() => {});
  }
}
