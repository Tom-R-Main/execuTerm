import * as http from 'node:http';
import type { AgentManager } from './agentManager.js';
import type { WorkspaceManager } from './workspaceManager.js';
import type { ExfClient } from '../exfClient.js';
import type { DaemonAuthState, SessionState } from '../types.js';

export class DashboardServer {
  private server: http.Server | null = null;
  private port = 0;

  constructor(
    private getAgentManager: () => AgentManager | null,
    private workspaceManager: WorkspaceManager,
    private getExfClient: () => ExfClient | null,
    private getAuthState: () => DaemonAuthState
  ) {}

  async start(preferredPort?: number): Promise<number> {
    this.server = http.createServer((req, res) =>
      this.handleRequest(req, res)
    );

    return new Promise((resolve, reject) => {
      this.server!.listen(preferredPort || 0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          resolve(this.port);
        } else {
          reject(new Error('Failed to bind dashboard server'));
        }
      });
      this.server!.on('error', reject);
    });
  }

  getPort(): number {
    return this.port;
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);

    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, port: this.port }));
      return;
    }

    if (url.pathname === '/hooks/agent' && req.method === 'POST') {
      await this.handleAgentHook(req, res);
      return;
    }

    if (url.pathname === '/dashboard' && req.method === 'GET') {
      await this.serveDashboard(res);
      return;
    }

    if (url.pathname === '/api/status' && req.method === 'GET') {
      await this.serveStatus(res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  private async handleAgentHook(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    try {
      const event = JSON.parse(body) as {
        workspaceId: string;
        state: SessionState;
        error?: string;
      };

      const agentManager = this.getAgentManager();
      if (!agentManager) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Agent manager unavailable' }));
        return;
      }

      await agentManager.transition(
        event.workspaceId,
        event.state,
        event.error
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
  }

  private async serveStatus(res: http.ServerResponse): Promise<void> {
    const sessions = this.getAgentManager()?.getAllSessions() ?? [];
    const agentWorkspaces = this.workspaceManager.getAgentWorkspaces();
    const devWorkspaces = this.workspaceManager.getDevServerWorkspaces();
    const auth = this.getAuthState();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        auth,
        agents: sessions,
        agentWorkspaces: agentWorkspaces.length,
        devServers: devWorkspaces.length,
      })
    );
  }

  private async serveDashboard(res: http.ServerResponse): Promise<void> {
    const agentManager = this.getAgentManager();
    const exfClient = this.getExfClient();
    const auth = this.getAuthState();
    const sessions = agentManager?.getAllSessions() ?? [];
    const devWorkspaces = this.workspaceManager.getDevServerWorkspaces();

    let nextEvent = '';
    if (exfClient) {
      try {
      const today = new Date().toISOString().split('T')[0];
      const tomorrow = new Date(Date.now() + 86400000)
        .toISOString()
        .split('T')[0];
      const cal = await exfClient.listCalendarEvents({
        startDate: today,
        endDate: tomorrow,
        limit: 3,
      });
      if (cal.data?.events?.[0]) {
        nextEvent = (cal.data.events[0] as { title: string }).title;
      }
      } catch {
        // Non-critical
      }
    }

    const stateColors: Record<string, string> = {
      starting: '#8E8E93',
      running: '#34C759',
      waiting_input: '#007AFF',
      review_ready: '#FF9500',
      failed: '#FF3B30',
      stopped: '#8E8E93',
    };

    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const agentRows = sessions
      .map(
        (s) => `
      <tr>
        <td>${esc(s.agentType)}</td>
        <td><span style="color:${stateColors[s.state] || '#fff'}">${esc(s.state)}</span></td>
        <td>${s.taskId ? esc(s.taskId) : '—'}</td>
        <td>${new Date(s.lastStateChange).toLocaleTimeString()}</td>
      </tr>`
      )
      .join('');

    const devRows = devWorkspaces
      .map(
        (w) => `
      <tr>
        <td>${esc(w.title)}</td>
        <td>${esc(w.state)}</td>
      </tr>`
      )
      .join('');

    const authCard = this.renderAuthCard(auth);

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>execuTerm Dashboard</title>
  <meta http-equiv="refresh" content="10">
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background: #1a1a1a; color: #e0e0e0; margin: 16px; }
    h1 { font-size: 18px; color: #fff; }
    h2 { font-size: 14px; color: #aaa; margin-top: 20px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #333; font-size: 13px; }
    th { color: #888; font-weight: 500; }
    .calendar { background: #2a2a2a; padding: 8px 12px; border-radius: 6px; margin-top: 12px; font-size: 13px; }
    .empty { color: #666; font-style: italic; }
  </style>
</head>
<body>
  <h1>execuTerm</h1>

  ${authCard}

  ${nextEvent ? `<div class="calendar">Next: ${esc(nextEvent)}</div>` : ''}

  <h2>Agents</h2>
  ${
    sessions.length > 0
      ? `<table><tr><th>Agent</th><th>State</th><th>Task</th><th>Last Update</th></tr>${agentRows}</table>`
      : '<p class="empty">No active agents</p>'
  }

  <h2>Dev Servers</h2>
  ${
    devWorkspaces.length > 0
      ? `<table><tr><th>Server</th><th>State</th></tr>${devRows}</table>`
      : '<p class="empty">No dev servers running</p>'
  }
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  private renderAuthCard(auth: DaemonAuthState): string {
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    if (auth.status === 'authenticated') {
      return auth.message
        ? `<div class="calendar">${esc(auth.message)}</div>`
        : '';
    }

    if (auth.status === 'device_flow') {
      const expires = auth.expiresAt
        ? new Date(auth.expiresAt).toLocaleTimeString()
        : 'soon';
      const verificationUrl = auth.verificationUriComplete || auth.verificationUri || '#';
      return `
  <div class="calendar">
    <strong>Sign in to ExecuFunction</strong><br>
    ${auth.message ? `${esc(auth.message)}<br>` : ''}
    Code: <strong>${esc(auth.userCode || '—')}</strong><br>
    <a href="${esc(verificationUrl)}">Open verification page</a><br>
    Expires: ${esc(expires)}
  </div>`;
    }

    if (auth.status === 'error') {
      return `
  <div class="calendar">
    <strong>ExecuFunction login error</strong><br>
    ${esc(auth.message || 'Unknown error')}
  </div>`;
    }

    return `
  <div class="calendar">
    <strong>ExecuFunction login pending</strong><br>
    ${esc(auth.message || 'Waiting to start device login...')}
  </div>`;
  }
}
