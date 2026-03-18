import type { CmuxSocket } from '../cmuxSocket.js';
import type { AgentSession, SessionState } from '../types.js';
import { toTaskExecutorAgent } from '../types.js';
import type { ExfClient } from '../exfClient.js';

type StateChangeHandler = (session: AgentSession, prev: SessionState) => void;

const STATE_DISPLAY: Record<
  SessionState,
  { icon: string; color: string; label: string }
> = {
  starting: { icon: 'hourglass', color: '#8E8E93', label: 'Starting...' },
  running: { icon: 'bolt.fill', color: '#34C759', label: 'Running' },
  waiting_input: { icon: 'bell.fill', color: '#007AFF', label: 'Needs Input' },
  review_ready: {
    icon: 'checkmark.circle.fill',
    color: '#8E8E93',
    label: 'Review Ready',
  },
  failed: {
    icon: 'exclamationmark.triangle.fill',
    color: '#FF3B30',
    label: 'Failed',
  },
  stopped: { icon: 'stop.circle.fill', color: '#8E8E93', label: 'Stopped' },
};

const VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
  starting: ['running', 'failed', 'stopped'],
  running: ['waiting_input', 'review_ready', 'failed', 'stopped'],
  waiting_input: ['running', 'failed', 'stopped'],
  review_ready: ['running', 'stopped'],
  failed: ['starting', 'stopped'],
  stopped: [],
};

export class AgentManager {
  private sessions = new Map<string, AgentSession>();
  private handlers: StateChangeHandler[] = [];

  constructor(
    private cmux: CmuxSocket,
    private exfClient: ExfClient
  ) {}

  register(session: AgentSession): void {
    this.sessions.set(session.workspaceId, session);
    this.updateSidebar(session);

    // Set executorAgent on task using the correct backend enum value
    if (session.taskId) {
      this.exfClient
        .updateTask(session.taskId, {
          executorAgent: toTaskExecutorAgent(session.agentType),
        })
        .catch(() => {});
    }
  }

  async transition(
    workspaceId: string,
    newState: SessionState,
    error?: string
  ): Promise<void> {
    const session = this.sessions.get(workspaceId);
    if (!session) return;

    const valid = VALID_TRANSITIONS[session.state];
    if (!valid.includes(newState)) return;

    const prev = session.state;
    session.state = newState;
    session.lastStateChange = new Date().toISOString();
    if (error) session.error = error;

    await this.updateSidebar(session);

    // State-specific side effects
    if (newState === 'waiting_input') {
      await this.cmux
        .notificationCreate(
          `${session.agentType} needs input`,
          session.taskId
            ? `Task: ${session.workspaceId}`
            : undefined
        )
        .catch(() => {});
    }

    if (newState === 'review_ready') {
      await this.cmux
        .notificationCreate(`${session.agentType} finished — review ready`)
        .catch(() => {});
    }

    if (newState === 'failed' && session.taskId) {
      await this.exfClient
        .updateTask(session.taskId, {
          phase: 'blocked',
          blockedReason: error || 'Agent failed',
        })
        .catch(() => {});
    }

    for (const handler of this.handlers) {
      handler(session, prev);
    }
  }

  onStateChange(handler: StateChangeHandler): void {
    this.handlers.push(handler);
  }

  getSession(workspaceId: string): AgentSession | undefined {
    return this.sessions.get(workspaceId);
  }

  getAllSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  getActiveSessions(): AgentSession[] {
    return this.getAllSessions().filter(
      (s) => s.state !== 'stopped' && s.state !== 'failed'
    );
  }

  removeSession(workspaceId: string): void {
    this.sessions.delete(workspaceId);
  }

  private async updateSidebar(session: AgentSession): Promise<void> {
    const display = STATE_DISPLAY[session.state];
    // v1 set_status command with correct args
    await this.cmux
      .setStatus('agent', display.label, {
        icon: display.icon,
        color: display.color,
        workspaceId: session.workspaceId,
      })
      .catch(() => {});
  }
}
