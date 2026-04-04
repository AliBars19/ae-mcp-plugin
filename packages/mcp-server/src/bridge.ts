/**
 * WebSocket Bridge — connects the MCP server to the CEP panel running inside AE.
 *
 * Sends JSON-RPC requests and resolves when the corresponding response arrives.
 * Auto-reconnects on disconnect with exponential backoff.
 */
import WebSocket from "ws";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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
  private connectPromise: Promise<void> | null = null;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private startTime = Date.now();

  constructor(port: number = 9741) {
    this.url = `ws://127.0.0.1:${port}`;
  }

  private loadSecret(): string | null {
    const secretPath = join(process.env.APPDATA || "", "Apollova", "bridge-secret.json");
    try {
      if (!existsSync(secretPath)) return null;
      const data = JSON.parse(readFileSync(secretPath, "utf-8"));
      return data?.token ?? null;
    } catch {
      return null;
    }
  }

  private async authenticate(ws: WebSocket): Promise<void> {
    if (process.env.AE_MCP_AUTH === "0") return;

    const token = this.loadSecret();
    if (!token) return; // No secret file yet — skip auth (first run)

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Authentication timeout"));
      }, 5000);

      const handler = (data: WebSocket.RawData) => {
        clearTimeout(timeout);
        ws.removeListener("message", handler);
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "auth" && msg.success) {
            resolve();
          } else {
            reject(new Error("Authentication failed"));
          }
        } catch {
          reject(new Error("Invalid auth response"));
        }
      };

      ws.on("message", handler);
      ws.send(JSON.stringify({ type: "auth", token }));
    });
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    // If already connecting, wait for the in-flight attempt
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.on("open", () => {
          this.authenticate(this.ws!)
            .then(() => {
              this.connectPromise = null;
              this.reconnectDelay = 1000;
              resolve();
            })
            .catch((err) => {
              this.connectPromise = null;
              reject(new Error(`Authentication failed: ${err.message}`));
            });
        });

        this.ws.on("message", (data: WebSocket.RawData) => {
          this.handleMessage(data.toString());
        });

        this.ws.on("close", () => {
          this.connectPromise = null;
          this.rejectAllPending("Connection closed");
          if (!this.closed) this.scheduleReconnect();
        });

        this.ws.on("error", (err: Error) => {
          this.connectPromise = null;
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            reject(new Error(`Cannot connect to AE bridge at ${this.url}: ${err.message}`));
          }
          // Close the socket so the close handler fires for cleanup
          try { this.ws?.close(); } catch { /* already closing */ }
        });
      } catch (err) {
        this.connectPromise = null;
        reject(err);
      }
    });

    return this.connectPromise;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    // Prevent multiple overlapping reconnect timers
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
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

    // Guard against non-object parse results (e.g. JSON.parse("null"))
    if (!response || typeof response !== "object") return;

    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.error) {
      const msg = response.error.data
        ? `${response.error.message} (${JSON.stringify(response.error.data)})`
        : response.error.message;
      pending.reject(new Error(msg));
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

    // Null-safe check after connect — connection could have dropped between await and here
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to AE bridge");
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

      socket.send(message, (err) => {
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

  get uptime(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending("Bridge closing");
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
