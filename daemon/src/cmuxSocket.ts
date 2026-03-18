import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

import type {
  WorkspaceListResult,
  SurfaceListResult,
  WorkspaceCreateResult,
  BrowserOpenResult,
} from './types.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RpcResponse {
  id: string;
  ok?: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/**
 * cmux socket client supporting both v2 JSON-RPC and v1 text commands.
 *
 * Protocol detection is server-side: lines starting with '{' are v2 JSON-RPC,
 * everything else is v1 text. Both share the same Unix socket.
 */
export class CmuxSocket {
  private socket: net.Socket | null = null;
  private pending = new Map<string, PendingRequest>();
  private buffer = '';
  private reconnectDelay = 2000;
  private maxReconnectDelay = 30000;
  private socketPath = '';
  private connected = false;
  private requestTimeoutMs = 10000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  async connect(socketPath?: string): Promise<void> {
    this.socketPath = socketPath || this.discoverSocketPath();

    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.socketPath, () => {
        this.connected = true;
        this.reconnectDelay = 2000;
        resolve();
      });

      this.socket.on('data', (data) => this.handleData(data));

      this.socket.on('error', (err) => {
        if (!this.connected) {
          reject(err);
        }
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.rejectAllPending(new Error('Socket closed'));
        this.scheduleReconnect();
      });
    });
  }

  /**
   * Discover the cmux socket path using the same priority as the CLI:
   * 1. CMUX_SOCKET_PATH / CMUX_SOCKET env vars
   * 2. ~/Library/Application Support/cmux/cmux.sock (stable release)
   * 3. /tmp/cmux.sock (legacy fallback)
   * 4. /tmp/cmux-debug.sock (debug build)
   */
  private discoverSocketPath(): string {
    const envPath =
      process.env.CMUX_SOCKET_PATH || process.env.CMUX_SOCKET;
    if (envPath && existsSync(envPath)) return envPath;

    const appSupportPath = join(
      homedir(),
      'Library',
      'Application Support',
      'cmux',
      'cmux.sock'
    );
    if (existsSync(appSupportPath)) return appSupportPath;

    if (existsSync('/tmp/cmux.sock')) return '/tmp/cmux.sock';
    if (existsSync('/tmp/cmux-debug.sock')) return '/tmp/cmux-debug.sock';

    // Fall back to app support path (will fail to connect with a clear error)
    return appSupportPath;
  }

  private handleData(data: Buffer): void {
    this.buffer += data.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      // v2 JSON-RPC responses start with '{'
      if (line.trim().startsWith('{')) {
        try {
          const response = JSON.parse(line) as RpcResponse;
          const pending = this.pending.get(response.id);
          if (!pending) continue;

          this.pending.delete(response.id);
          clearTimeout(pending.timer);

          if (response.ok === false || response.error) {
            pending.reject(
              new Error(
                `${response.error?.code || 'error'}: ${response.error?.message || 'Unknown error'}`
              )
            );
          } else {
            pending.resolve(response.result);
          }
        } catch {
          // Skip malformed JSON
        }
      } else {
        // v1 text response — resolve the oldest pending v1 request
        const v1Id = Array.from(this.pending.keys()).find((k) =>
          k.startsWith('v1:')
        );
        if (v1Id) {
          const pending = this.pending.get(v1Id)!;
          this.pending.delete(v1Id);
          clearTimeout(pending.timer);
          pending.resolve(line.trim());
        }
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.socketPath).catch(() => {
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 2,
          this.maxReconnectDelay
        );
        this.scheduleReconnect();
      });
    }, this.reconnectDelay);
  }

  /** Send a v2 JSON-RPC request. */
  async send<T>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected to cmux socket');
    }

    const id = randomUUID();
    const request = JSON.stringify({ id, method, params: params || {} }) + '\n';

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.socket!.write(request);
    });
  }

  /** Send a v1 text command (for set_status, clear_status, set_progress). */
  async sendV1(command: string): Promise<string> {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected to cmux socket');
    }

    const id = `v1:${randomUUID()}`;

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`v1 command timed out: ${command}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.socket!.write(command + '\n');
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(new Error('Disconnecting'));
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // =========================================================================
  // v2 JSON-RPC convenience methods
  // =========================================================================

  async workspaceCreate(opts?: {
    working_directory?: string;
    initial_command?: string;
    initial_env?: Record<string, string>;
  }): Promise<WorkspaceCreateResult> {
    return this.send('workspace.create', opts);
  }

  async workspaceList(): Promise<WorkspaceListResult> {
    return this.send('workspace.list');
  }

  async workspaceSelect(id: string): Promise<void> {
    return this.send('workspace.select', { workspace_id: id });
  }

  async workspaceRename(workspaceId: string, title: string): Promise<void> {
    return this.send('workspace.rename', { workspace_id: workspaceId, title });
  }

  async surfaceList(workspaceId?: string): Promise<SurfaceListResult> {
    return this.send(
      'surface.list',
      workspaceId ? { workspace_id: workspaceId } : {}
    );
  }

  async surfaceSendText(text: string, surfaceId?: string): Promise<void> {
    return this.send('surface.send_text', {
      text,
      ...(surfaceId ? { surface_id: surfaceId } : {}),
    });
  }

  async notificationCreate(
    title: string,
    body?: string,
    subtitle?: string
  ): Promise<void> {
    return this.send('notification.create', { title, body, subtitle });
  }

  async notificationCreateForSurface(
    surfaceId: string,
    title: string,
    body?: string
  ): Promise<void> {
    return this.send('notification.create_for_surface', {
      surface_id: surfaceId,
      title,
      body,
    });
  }

  async notificationClear(): Promise<void> {
    return this.send('notification.clear');
  }

  async browserOpenSplit(url?: string, focus?: boolean): Promise<BrowserOpenResult> {
    return this.send('browser.open_split', { url, focus });
  }

  async systemPing(): Promise<{ pong: boolean }> {
    return this.send('system.ping');
  }

  // =========================================================================
  // v1 text commands (sidebar metadata — no v2 equivalent)
  // =========================================================================

  /**
   * Set a sidebar status entry for a workspace.
   * v1: set_status <key> <value> [--icon=X] [--color=#hex] [--tab=workspaceId]
   */
  async setStatus(
    key: string,
    value: string,
    opts?: { icon?: string; color?: string; workspaceId?: string }
  ): Promise<string> {
    let cmd = `set_status ${key} ${value}`;
    if (opts?.icon) cmd += ` --icon=${opts.icon}`;
    if (opts?.color) cmd += ` --color=${opts.color}`;
    if (opts?.workspaceId) cmd += ` --tab=${opts.workspaceId}`;
    return this.sendV1(cmd);
  }

  /**
   * Clear a sidebar status entry.
   * v1: clear_status <key> [--tab=workspaceId]
   */
  async clearStatus(key: string, workspaceId?: string): Promise<string> {
    let cmd = `clear_status ${key}`;
    if (workspaceId) cmd += ` --tab=${workspaceId}`;
    return this.sendV1(cmd);
  }

  /**
   * Set progress bar for a workspace.
   * v1: set_progress <0.0-1.0> [--label=X] [--tab=workspaceId]
   */
  async setProgress(
    value: number,
    opts?: { label?: string; workspaceId?: string }
  ): Promise<string> {
    let cmd = `set_progress ${value.toFixed(2)}`;
    if (opts?.label) cmd += ` --label=${opts.label}`;
    if (opts?.workspaceId) cmd += ` --tab=${opts.workspaceId}`;
    return this.sendV1(cmd);
  }
}
