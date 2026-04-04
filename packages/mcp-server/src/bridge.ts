/**
 * WebSocket Bridge — connects the MCP server to the CEP panel running inside AE.
 *
 * Sends JSON-RPC requests and resolves when the corresponding response arrives.
 * Auto-reconnects on disconnect with exponential backoff.
 */
import WebSocket from "ws";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class Bridge {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestId = 0;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private url: string;
  private connecting = false;
  private closed = false;

  constructor(port: number = 9741) {
    this.url = `ws://127.0.0.1:${port}`;
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return;

    this.connecting = true;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.on("open", () => {
          this.connecting = false;
          this.reconnectDelay = 1000;
          resolve();
        });

        this.ws.on("message", (data: WebSocket.RawData) => {
          this.handleMessage(data.toString());
        });

        this.ws.on("close", () => {
          this.connecting = false;
          this.rejectAllPending("Connection closed");
          if (!this.closed) this.scheduleReconnect();
        });

        this.ws.on("error", (err: Error) => {
          this.connecting = false;
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            reject(new Error(`Cannot connect to AE bridge at ${this.url}: ${err.message}`));
          }
        });
      } catch (err) {
        this.connecting = false;
        reject(err);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    setTimeout(() => {
      this.connect().catch(() => {
        // Silently retry — scheduleReconnect will be called again on close
      });
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private handleMessage(raw: string): void {
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(raw);
    } catch {
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  async send(method: string, params: Record<string, unknown> = {}, timeout = 30000): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

    const id = String(++this.requestId);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out after ${timeout}ms: ${method}`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });

      const message = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });

      this.ws!.send(message, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`Failed to send: ${err.message}`));
        }
      });
    });
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.closed = true;
    this.rejectAllPending("Bridge closing");
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
