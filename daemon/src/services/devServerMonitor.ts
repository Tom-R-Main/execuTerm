import * as http from 'node:http';

import type { CmuxSocket } from '../cmuxSocket.js';
import type { WorkspaceManager } from './workspaceManager.js';

interface PortCheck {
  workspaceId: string;
  port: number;
  label: string;
  lastHealthy: boolean | null;
}

export class DevServerMonitor {
  private checks: PortCheck[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private cmux: CmuxSocket,
    private workspaceManager: WorkspaceManager
  ) {}

  start(intervalMs = 5000): void {
    this.refreshChecks();
    this.timer = setInterval(() => this.runChecks(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private refreshChecks(): void {
    const devWorkspaces = this.workspaceManager.getDevServerWorkspaces();
    this.checks = devWorkspaces.map((ws) => {
      const port = ws.title.includes('Backend') ? 8080 : 3000;
      return {
        workspaceId: ws.id,
        port,
        label: ws.title,
        lastHealthy: null,
      };
    });
  }

  private async runChecks(): Promise<void> {
    this.refreshChecks();

    for (const check of this.checks) {
      const healthy = await this.checkPort(check.port);

      if (healthy !== check.lastHealthy) {
        const wasNull = check.lastHealthy === null;
        check.lastHealthy = healthy;

        const icon = healthy ? 'network' : 'network.slash';
        const color = healthy ? '#34C759' : '#FF3B30';
        const status = healthy
          ? `Port ${check.port} OK`
          : `Port ${check.port} down`;

        // v1 set_status with --tab
        await this.cmux
          .setStatus('server', status, {
            icon,
            color,
            workspaceId: check.workspaceId,
          })
          .catch(() => {});

        // Notify on transitions to unhealthy (not on initial check)
        if (!healthy && !wasNull) {
          await this.cmux
            .notificationCreate(
              `${check.label} is down`,
              `Port ${check.port} is not responding`
            )
            .catch(() => {});
        }
      }
    }
  }

  private checkPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/', method: 'HEAD', timeout: 2000 },
        () => resolve(true)
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }
}
