import * as http from 'node:http';

import type { CmuxSocket } from '../cmuxSocket.js';
import type { ExfClient } from '../exfClient.js';
import type { AgentManager } from './agentManager.js';
import type { WorkspaceManager } from './workspaceManager.js';
import type { DaemonConfig } from '../types.js';

export class SidebarUpdater {
  private fastTimer: ReturnType<typeof setInterval> | null = null;
  private slowTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private cmux: CmuxSocket,
    private exfClient: ExfClient,
    private agentManager: AgentManager,
    private workspaceManager: WorkspaceManager,
    private config: DaemonConfig
  ) {}

  start(): void {
    // Fast loop: dev server health checks (every pollIntervalMs)
    this.fastTimer = setInterval(
      () => this.updateLocal(),
      this.config.pollIntervalMs
    );

    // Slow loop: fetch from ExecuFunction (every 60s)
    this.slowTimer = setInterval(() => this.updateRemote(), 60000);

    // Initial run
    this.updateLocal();
    this.updateRemote();
  }

  stop(): void {
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.slowTimer) clearInterval(this.slowTimer);
  }

  private async updateLocal(): Promise<void> {
    const devWorkspaces = this.workspaceManager.getDevServerWorkspaces();
    for (const ws of devWorkspaces) {
      const port = ws.title.includes('Backend') ? 8080 : 3000;
      const healthy = await this.checkPort(port);
      const icon = healthy ? 'network' : 'network.slash';
      const color = healthy ? '#34C759' : '#FF3B30';
      const label = healthy ? `Port ${port} OK` : `Port ${port} down`;

      // v1 set_status with --tab for workspace targeting
      await this.cmux
        .setStatus('server', label, { icon, color, workspaceId: ws.id })
        .catch(() => {});
    }
  }

  private async updateRemote(): Promise<void> {
    try {
      // Fetch active tasks — check for externally-completed tasks
      const taskResult = await this.exfClient.listTasks({
        status: 'in_progress',
        limit: 10,
      });

      if (taskResult.data?.tasks) {
        const agentSessions = this.agentManager.getAllSessions();

        for (const session of agentSessions) {
          if (!session.taskId) continue;

          const task = taskResult.data.tasks.find(
            (t) => (t as { id: string }).id === session.taskId
          );

          if (!task) {
            await this.cmux
              .notificationCreate(
                'Task completed externally',
                `Task for ${session.agentType} was completed outside this session`
              )
              .catch(() => {});
          }
        }
      }

      // Fetch today's calendar → show next event in agent workspaces
      const today = new Date().toISOString().split('T')[0];
      const tomorrow = new Date(Date.now() + 86400000)
        .toISOString()
        .split('T')[0];

      const calResult = await this.exfClient.listCalendarEvents({
        startDate: today,
        endDate: tomorrow,
        limit: 5,
      });

      if (calResult.data?.events && calResult.data.events.length > 0) {
        const nextEvent = calResult.data.events[0] as { title: string };
        const agentWorkspaces = this.workspaceManager.getAgentWorkspaces();

        for (const ws of agentWorkspaces) {
          await this.cmux
            .setStatus('calendar', `Next: ${nextEvent.title}`, {
              icon: 'calendar',
              color: '#FF9500',
              workspaceId: ws.id,
            })
            .catch(() => {});
        }
      }
    } catch {
      // Non-critical — silently skip
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
