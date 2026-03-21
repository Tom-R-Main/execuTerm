import type { ExecuTermSocket } from '../execuTermSocket.js';
import type {
  AgentSession,
  CheckpointStatus,
  NotificationPreferences,
  SavedResumableSession,
  SessionState,
} from '../types.js';
import { toTaskExecutorAgent } from '../types.js';
import type { ExfClient } from '../exfClient.js';
import { readDaemonConfig, DEFAULT_NOTIFICATION_PREFS } from '../config.js';
import type { WorkspaceManager } from './workspaceManager.js';

type StateChangeHandler = (session: AgentSession, prev: SessionState) => void;

/** Shell prompt patterns that indicate an agent CLI has exited back to shell */
const SHELL_PROMPT_PATTERNS = /[$%❯#>]\s*$/;
const RESUME_ID_PATTERN = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const CODEX_RESUME_PATTERN = /codex resume ([0-9a-f-]{36})/i;

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
  private exitPollerTimer: ReturnType<typeof setInterval> | null = null;
  private launchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private bootstrapTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private cmux: ExecuTermSocket,
    private exfClient: ExfClient,
    private workspaceManager: WorkspaceManager,
    private launchFailureTimeoutMs = 20000
  ) {}

  register(session: AgentSession): void {
    const workspace = this.workspaceManager.getWorkspace(session.workspaceId);
    if (workspace?.surfaceId && !session.surfaceId) {
      session.surfaceId = workspace.surfaceId;
    }
    if (workspace?.resumeId && !session.resumeId) {
      session.resumeId = workspace.resumeId;
    }
    if (workspace?.resumeCommand && !session.resumeCommand) {
      session.resumeCommand = workspace.resumeCommand;
    }
    if (workspace?.resumeCapability && !session.resumeCapability) {
      session.resumeCapability = workspace.resumeCapability;
    }
    this.sessions.set(session.workspaceId, session);
    this.updateSidebar(session);
    this.scheduleLaunchTimeout(session);
    this.scheduleBootstrapReady(session);

    // Set executorAgent on task using the correct backend enum value
    if (session.taskId) {
      this.exfClient
        .updateTask(session.taskId, {
          executorAgent: toTaskExecutorAgent(session.agentType),
        })
        .catch(() => {});
    }
  }

  async stop(workspaceId: string): Promise<void> {
    const session = this.sessions.get(workspaceId);
    if (!session) {
      throw new Error('Session not found');
    }

    let surfaceId = session.surfaceId;
    if (!surfaceId) {
      const surfaces = await this.cmux.surfaceList(workspaceId);
      surfaceId = surfaces.surfaces[0]?.id;
      if (surfaceId) {
        session.surfaceId = surfaceId;
      }
    }

    if (surfaceId) {
      await this.cmux.surfaceSendText('\u0003', surfaceId);
    }

    await this.transition(workspaceId, 'stopped');
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
    if (newState !== 'starting') {
      this.clearLaunchTimeout(workspaceId);
      this.clearBootstrapReady(workspaceId);
    }

    await this.updateSidebar(session);

    // State-specific side effects (gated on notification preferences)
    const prefs = this.getNotificationPrefs();

    if (newState === 'waiting_input' && prefs.onNeedsInput) {
      await this.cmux
        .notificationCreate(
          `${session.agentType} needs input`,
          session.taskId
            ? `Task: ${session.workspaceId}`
            : undefined
        )
        .catch(() => {});
    }

    if (newState === 'review_ready' && prefs.onFinished) {
      await this.cmux
        .notificationCreate(`${session.agentType} finished — review ready`)
        .catch(() => {});
    }

    if (newState === 'failed') {
      if (prefs.onFailed) {
        await this.cmux
          .notificationCreate(`${session.agentType} failed`, error || undefined)
          .catch(() => {});
      }
      if (session.taskId) {
        await this.exfClient
          .updateTask(session.taskId, {
            phase: 'blocked',
            blockedReason: error || 'Agent failed',
          })
          .catch(() => {});
      }
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
      (s) =>
        s.state === 'starting' ||
        s.state === 'running' ||
        s.state === 'waiting_input'
    );
  }

  getHistorySessions(limit = 6): AgentSession[] {
    return this.getAllSessions()
      .filter(
        (s) => {
          const checkpointStatus =
            this.workspaceManager.getWorkspace(s.workspaceId)?.checkpointStatus;
          if (checkpointStatus === 'saved') {
            return false;
          }
          return (
            s.state === 'review_ready' ||
            s.state === 'failed' ||
            s.state === 'stopped'
          );
        }
      )
      .sort(
        (a, b) =>
          new Date(b.lastStateChange).getTime() -
          new Date(a.lastStateChange).getTime()
      )
      .slice(0, limit);
  }

  removeSession(workspaceId: string): void {
    this.clearLaunchTimeout(workspaceId);
    this.clearBootstrapReady(workspaceId);
    this.sessions.delete(workspaceId);
  }

  getSavedSessions(): SavedResumableSession[] {
    return this.workspaceManager.listSavedResumableSessions();
  }

  async checkpointSession(workspaceId: string): Promise<SavedResumableSession | null> {
    const session = this.sessions.get(workspaceId);
    const workspace = this.workspaceManager.getWorkspace(workspaceId);
    if (!session || !workspace || workspace.kind !== 'agent') {
      return null;
    }

    const capability = workspace.resumeCapability || session.resumeCapability || 'none';
    if (capability === 'none') {
      this.workspaceManager.updateWorkspace(workspaceId, {
        checkpointStatus: 'failed',
      });
      return null;
    }

    this.workspaceManager.updateWorkspace(workspaceId, {
      checkpointStatus: 'pending',
    });

    try {
      const surfaceId = await this.ensureSurfaceId(session);
      if (surfaceId) {
        await this.cmux.surfaceSendText('\u0003', surfaceId);
      }
      await this.delay(900);

      let resumeId = workspace.resumeId || session.resumeId;
      let resumeCommand = workspace.resumeCommand || session.resumeCommand;

      if (capability === 'codex' && (!resumeId || !resumeCommand)) {
        const parsed = await this.captureCodexResume(workspaceId, surfaceId);
        if (parsed) {
          resumeId = parsed.resumeId;
          resumeCommand = parsed.resumeCommand;
        }
      }

      if (!resumeId || !resumeCommand || !RESUME_ID_PATTERN.test(resumeId)) {
        this.workspaceManager.updateWorkspace(workspaceId, {
          checkpointStatus: 'failed',
        });
        return null;
      }

      const checkpointedAt = new Date().toISOString();
      const saved: SavedResumableSession = {
        id: `${workspaceId}:${resumeId}`,
        workspaceId,
        title: workspace.title,
        cwd: workspace.cwd,
        agentType: session.agentType,
        taskId: workspace.taskId,
        projectId: workspace.projectId,
        resumeId,
        resumeCommand,
        resumeCapability: capability,
        checkpointStatus: 'saved',
        checkpointedAt,
        attachedContextItems: workspace.attachedContextItems || [],
      };

      this.workspaceManager.updateWorkspace(workspaceId, {
        resumeId,
        resumeCommand,
        checkpointStatus: 'saved',
        checkpointedAt,
        state: 'stopped',
      });
      session.resumeId = resumeId;
      session.resumeCommand = resumeCommand;
      session.resumeCapability = capability;
      await this.transition(workspaceId, 'stopped');
      this.workspaceManager.saveResumableSession(saved);
      return saved;
    } catch {
      this.workspaceManager.updateWorkspace(workspaceId, {
        checkpointStatus: 'failed',
      });
      return null;
    }
  }

  async checkpointActiveSessionsOnShutdown(): Promise<SavedResumableSession[]> {
    const checkpointable = this.getActiveSessions().filter((session) => {
      const workspace = this.workspaceManager.getWorkspace(session.workspaceId);
      return workspace?.kind === 'agent';
    });
    const saved: SavedResumableSession[] = [];
    for (const session of checkpointable) {
      const result = await Promise.race([
        this.checkpointSession(session.workspaceId),
        this.delay(2500).then(() => null),
      ]);
      if (result) {
        saved.push(result);
      }
    }
    return saved;
  }

  async restoreSavedSession(savedSessionId: string): Promise<string> {
    const saved = this.workspaceManager.getSavedResumableSession(savedSessionId);
    if (!saved) {
      throw new Error('Saved session not found');
    }

    const startupCommand =
      saved.resumeCapability === 'claude'
        ? `EXECUTERM_MANAGED_AGENT=1 ${saved.resumeCommand}`
        : saved.resumeCommand;

    const workspaceId = await this.workspaceManager.createFromTemplate(
      saved.agentType,
      {
        taskId: saved.taskId,
        projectId: saved.projectId,
        title: saved.title,
        cwd: saved.cwd,
        startupCommandOverride: startupCommand,
        resumeId: saved.resumeId,
        resumeCommand: saved.resumeCommand,
        checkpointStatus: 'idle',
        attachedContextItems: saved.attachedContextItems || [],
      }
    );

    this.register({
      workspaceId,
      taskId: saved.taskId,
      agentType: saved.agentType,
      state: 'starting',
      startedAt: new Date().toISOString(),
      lastStateChange: new Date().toISOString(),
      resumeId: saved.resumeId,
      resumeCommand: saved.resumeCommand,
      resumeCapability: saved.resumeCapability,
    });

    this.workspaceManager.removeSavedResumableSession(savedSessionId);
    return workspaceId;
  }

  /**
   * Poll cmux workspaces every 5s to detect agent exits.
   * - If workspace is gone from execuTerm → transition to 'stopped'
   * - If surface title matches shell prompt patterns → 'review_ready' (agent exited to shell)
   */
  startExitPoller(workspaceManager: WorkspaceManager): void {
    if (this.exitPollerTimer) return;

    this.exitPollerTimer = setInterval(() => {
      this.pollForExits(workspaceManager).catch(() => {});
    }, 5000);
  }

  stopExitPoller(): void {
    if (this.exitPollerTimer) {
      clearInterval(this.exitPollerTimer);
      this.exitPollerTimer = null;
    }
  }

  private async pollForExits(workspaceManager: WorkspaceManager): Promise<void> {
    const activeSessions = this.getActiveSessions();
    if (activeSessions.length === 0) return;

    // Get current cmux workspaces
    let cmuxIds: Set<string>;
    try {
      const result = await this.cmux.workspaceList();
      cmuxIds = new Set(result.workspaces.map((w) => w.id));
    } catch {
      return; // Can't reach cmux, skip this cycle
    }

    for (const session of activeSessions) {
      if (!cmuxIds.has(session.workspaceId)) {
        // Workspace gone from execuTerm → stopped
        await this.transition(session.workspaceId, 'stopped');
        continue;
      }

      // Only check shell prompt for sessions that are already running
      if (session.state !== 'running' && session.state !== 'waiting_input') continue;

      try {
        const surfaces = await this.cmux.surfaceList(session.workspaceId);
        const surface = surfaces.surfaces[0];
        if (surface && SHELL_PROMPT_PATTERNS.test(surface.title)) {
          await this.transition(session.workspaceId, 'review_ready');
        }
      } catch {
        // Surface query failed, skip
      }
    }

    // Also reconcile workspace manager state
    await workspaceManager.reconcile().catch(() => {});
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

  private scheduleLaunchTimeout(session: AgentSession): void {
    this.clearLaunchTimeout(session.workspaceId);
    if (session.state !== 'starting' || session.agentType !== 'claude-code') {
      return;
    }

    const timer = setTimeout(() => {
      const current = this.sessions.get(session.workspaceId);
      if (!current || current.state !== 'starting') return;
      void this.failStartupSession(
        session.workspaceId,
        'Agent did not become ready before the launch timeout elapsed'
      );
    }, this.launchFailureTimeoutMs);
    timer.unref?.();
    this.launchTimers.set(session.workspaceId, timer);
  }

  private clearLaunchTimeout(workspaceId: string): void {
    const timer = this.launchTimers.get(workspaceId);
    if (timer) {
      clearTimeout(timer);
      this.launchTimers.delete(workspaceId);
    }
  }

  private scheduleBootstrapReady(session: AgentSession): void {
    this.clearBootstrapReady(session.workspaceId);
    if (session.state !== 'starting') {
      return;
    }

    const timer = setInterval(() => {
      const current = this.sessions.get(session.workspaceId);
      if (!current || current.state !== 'starting') {
        this.clearBootstrapReady(session.workspaceId);
        return;
      }
      void this.promoteIfReady(session.workspaceId);
    }, session.agentType === 'claude-code' ? 1000 : 1500);
    timer.unref?.();
    this.bootstrapTimers.set(session.workspaceId, timer);
  }

  private clearBootstrapReady(workspaceId: string): void {
    const timer = this.bootstrapTimers.get(workspaceId);
    if (timer) {
      clearInterval(timer);
      this.bootstrapTimers.delete(workspaceId);
    }
  }

  private getNotificationPrefs(): NotificationPreferences {
    try {
      const config = readDaemonConfig();
      return config.notifications || DEFAULT_NOTIFICATION_PREFS;
    } catch {
      return DEFAULT_NOTIFICATION_PREFS;
    }
  }

  private async promoteIfReady(workspaceId: string): Promise<void> {
    const current = this.sessions.get(workspaceId);
    if (!current || current.state !== 'starting') return;

    try {
      const surfaceResult = await this.cmux.surfaceList(workspaceId);
      const surface = surfaceResult.surfaces[0];
      if (surface?.id && !current.surfaceId) {
        current.surfaceId = surface.id;
        this.workspaceManager.updateWorkspace(workspaceId, {
          surfaceId: surface.id,
        });
      }
      const title = (surface?.title || '').trim().toLowerCase();

      if (current.agentType === 'codex') {
        await this.maybeCaptureCodexResume(workspaceId, surface.id);
        if (title && title !== 'terminal') {
          await this.transition(workspaceId, 'running');
          return;
        }
      } else if (current.agentType === 'claude-code') {
        if (title.includes('claude')) {
          await this.transition(workspaceId, 'running');
          return;
        }
      }
    } catch {
      // Fall through to best-effort state update below.
    }

    if (current.agentType !== 'claude-code') {
      await this.transition(workspaceId, 'running');
    }
  }

  private async failStartupSession(
    workspaceId: string,
    baseMessage: string
  ): Promise<void> {
    let error = baseMessage;
    try {
      const surfaceResult = await this.cmux.surfaceList(workspaceId);
      const surface = surfaceResult.surfaces[0];
      if (surface?.id) {
        const session = this.sessions.get(workspaceId);
        if (session && !session.surfaceId) {
          session.surfaceId = surface.id;
        }
      }
      const title = surface?.title?.trim();
      if (title) {
        error = `${baseMessage} (last surface: ${title})`;
      }
    } catch {
      // Best effort only.
    }
    await this.transition(workspaceId, 'failed', error);
  }

  private async ensureSurfaceId(session: AgentSession): Promise<string | undefined> {
    if (session.surfaceId) return session.surfaceId;
    const surfaces = await this.cmux.surfaceList(session.workspaceId);
    const surfaceId = surfaces.surfaces[0]?.id;
    if (surfaceId) {
      session.surfaceId = surfaceId;
      this.workspaceManager.updateWorkspace(session.workspaceId, {
        surfaceId,
      });
    }
    return surfaceId;
  }

  private async maybeCaptureCodexResume(
    workspaceId: string,
    surfaceId?: string
  ): Promise<void> {
    const workspace = this.workspaceManager.getWorkspace(workspaceId);
    if (!workspace || workspace.agentType !== 'codex' || workspace.resumeId) {
      return;
    }
    const parsed = await this.captureCodexResume(workspaceId, surfaceId);
    if (!parsed) return;
    this.workspaceManager.updateWorkspace(workspaceId, {
      resumeId: parsed.resumeId,
      resumeCommand: parsed.resumeCommand,
      resumeCapability: 'codex',
    });
    const session = this.sessions.get(workspaceId);
    if (session) {
      session.resumeId = parsed.resumeId;
      session.resumeCommand = parsed.resumeCommand;
      session.resumeCapability = 'codex';
    }
  }

  private async captureCodexResume(
    workspaceId: string,
    surfaceId?: string
  ): Promise<{ resumeId: string; resumeCommand: string } | null> {
    try {
      const text = await this.cmux.surfaceReadText({
        workspaceId,
        surfaceId,
        scrollback: true,
        lines: 220,
      });
      const match = text.match(CODEX_RESUME_PATTERN);
      if (!match?.[1]) return null;
      return {
        resumeId: match[1].toLowerCase(),
        resumeCommand: `codex resume ${match[1].toLowerCase()}`,
      };
    } catch {
      return null;
    }
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
