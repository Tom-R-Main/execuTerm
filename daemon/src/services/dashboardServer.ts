import * as http from 'node:http';
import type { AgentManager } from './agentManager.js';
import type { DirectoryManager } from './directoryManager.js';
import { DirectoryRequiredError } from './directoryManager.js';
import type { WorkspaceManager } from './workspaceManager.js';
import type { TaskDispatcher } from './taskDispatcher.js';
import type { ExfClient } from '../exfClient.js';
import type { ExecuTermSocket } from '../execuTermSocket.js';
import type {
  AgentType,
  AttachedContextItem,
  ContextSourceType,
  DashboardRefreshMode,
  DaemonAuthState,
  NotificationPreferences,
  SessionState,
} from '../types.js';
import {
  DEFAULT_DASHBOARD_REFRESH_INTERVAL_MS,
  DEFAULT_DASHBOARD_REFRESH_MODE,
  DEFAULT_NOTIFICATION_PREFS,
  readDaemonConfig,
  writeDaemonConfig,
} from '../config.js';

interface ContextSearchResult {
  id: string;
  sourceType: Exclude<ContextSourceType, 'file'>;
  title: string;
  excerpt: string;
  filePath?: string;
  projectId?: string;
  estimatedChars: number;
}

interface ContextPreviewSection {
  title: string;
  body: string;
}

interface ContextPreviewPayload {
  items: AttachedContextItem[];
  sections: ContextPreviewSection[];
  renderedText: string;
  estimatedChars: number;
  truncated: boolean;
}

interface DashboardSettingsPayload {
  refreshMode: DashboardRefreshMode;
  refreshIntervalMs: number;
}

export class DashboardServer {
  private server: http.Server | null = null;
  private port = 0;

  constructor(
    private getAgentManager: () => AgentManager | null,
    private directoryManager: DirectoryManager,
    private workspaceManager: WorkspaceManager,
    private getExfClient: () => ExfClient | null,
    private getAuthState: () => DaemonAuthState,
    private getTaskDispatcher: () => TaskDispatcher | null,
    private getCmux?: () => ExecuTermSocket
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

    if (url.pathname === '/api/dispatch' && req.method === 'POST') {
      await this.handleDispatch(req, res);
      return;
    }

    if (url.pathname === '/api/workspace' && req.method === 'POST') {
      await this.handleCreateWorkspace(req, res);
      return;
    }

    if (url.pathname === '/api/agent/stop' && req.method === 'POST') {
      await this.handleAgentStop(req, res);
      return;
    }

    if (url.pathname === '/api/agent/checkpoint' && req.method === 'POST') {
      await this.handleAgentCheckpoint(req, res);
      return;
    }

    if (url.pathname === '/api/directories/select' && req.method === 'POST') {
      await this.handleDirectorySelect(req, res);
      return;
    }

    if (url.pathname === '/dashboard' && req.method === 'GET') {
      await this.serveDashboard(res);
      return;
    }

    if (url.pathname === '/context' && req.method === 'GET') {
      this.serveContextPage(url, res);
      return;
    }

    if (url.pathname === '/api/context/inject' && req.method === 'POST') {
      await this.handleContextInject(req, res);
      return;
    }

    if (url.pathname === '/api/status' && req.method === 'GET') {
      await this.serveStatus(res);
      return;
    }

    if (url.pathname === '/api/resumable-sessions' && req.method === 'GET') {
      await this.serveResumableSessions(res);
      return;
    }

    if (url.pathname === '/api/resumable-sessions/restore' && req.method === 'POST') {
      await this.handleRestoreResumableSessions(req, res);
      return;
    }

    if (url.pathname === '/api/tasks' && req.method === 'GET') {
      await this.serveTasks(url, res);
      return;
    }

    if (url.pathname === '/api/tasks/create' && req.method === 'POST') {
      await this.handleCreateTask(req, res);
      return;
    }

    if (url.pathname.startsWith('/api/tasks/') && req.method === 'GET') {
      const taskId = url.pathname.replace('/api/tasks/', '');
      await this.serveTaskDetail(taskId, res);
      return;
    }

    if (url.pathname === '/api/calendar' && req.method === 'GET') {
      await this.serveCalendar(res);
      return;
    }

    if (url.pathname === '/api/agent/focus' && req.method === 'POST') {
      await this.handleAgentFocus(req, res);
      return;
    }

    if (url.pathname === '/api/notifications' && req.method === 'GET') {
      this.serveNotifications(res);
      return;
    }

    if (url.pathname === '/api/notifications' && req.method === 'POST') {
      await this.handleUpdateNotifications(req, res);
      return;
    }

    if (url.pathname === '/api/dashboard/settings' && req.method === 'GET') {
      this.serveDashboardSettings(res);
      return;
    }

    if (url.pathname === '/api/dashboard/settings' && req.method === 'POST') {
      await this.handleUpdateDashboardSettings(req, res);
      return;
    }

    if (url.pathname === '/api/projects' && req.method === 'GET') {
      await this.serveProjects(res);
      return;
    }

    if (url.pathname === '/api/search/notes' && req.method === 'GET') {
      await this.handleSearchNotes(url, res);
      return;
    }

    if (url.pathname === '/api/search/people' && req.method === 'GET') {
      await this.handleSearchPeople(url, res);
      return;
    }

    if (url.pathname === '/api/search/code-memories' && req.method === 'GET') {
      await this.handleSearchCodeMemories(url, res);
      return;
    }

    if (url.pathname === '/api/search/tasks' && req.method === 'GET') {
      await this.handleSearchTasks(url, res);
      return;
    }

    if (url.pathname === '/api/context/search' && req.method === 'GET') {
      await this.handleContextSearch(url, res);
      return;
    }

    if (url.pathname === '/api/context/attach' && req.method === 'POST') {
      await this.handleContextAttach(req, res);
      return;
    }

    if (url.pathname === '/api/context/detach' && req.method === 'POST') {
      await this.handleContextDetach(req, res);
      return;
    }

    if (url.pathname === '/api/context/send' && req.method === 'POST') {
      await this.handleContextSend(req, res);
      return;
    }

    if (
      url.pathname.startsWith('/api/context/') &&
      url.pathname.endsWith('/preview') &&
      req.method === 'GET'
    ) {
      const workspaceId = url.pathname
        .replace('/api/context/', '')
        .replace('/preview', '');
      await this.serveContextPreview(workspaceId, res);
      return;
    }

    // GET /api/context/:workspaceId
    if (url.pathname.startsWith('/api/context/') && req.method === 'GET') {
      const workspaceId = url.pathname.replace('/api/context/', '');
      if (workspaceId && workspaceId !== 'search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            items: this.workspaceManager.getAttachedContextItems(workspaceId),
          })
        );
        return;
      }
    }

    res.writeHead(404);
    res.end('Not found');
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    return body;
  }

  private async handleAgentHook(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);

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

  private async handleDispatch(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);

    try {
      const parsed = JSON.parse(body) as {
        taskId: string;
        agentType: AgentType;
        cwdOverride?: string;
      };
      const { taskId, agentType, cwdOverride } = parsed;

      if (!taskId || !agentType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'taskId and agentType are required' }));
        return;
      }

      const dispatcher = this.getTaskDispatcher();
      if (!dispatcher) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task dispatcher unavailable (not authenticated)' }));
        return;
      }

      const workspaceId = await dispatcher.dispatch(taskId, agentType, {
        cwdOverride: typeof cwdOverride === 'string' ? cwdOverride : undefined,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, workspaceId }));
    } catch (err) {
      if (err instanceof DirectoryRequiredError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: err.message,
            code: err.code,
            projectId: err.projectId,
          })
        );
        return;
      }

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : 'Dispatch failed',
        })
      );
    }
  }

  private async handleDirectorySelect(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);

    try {
      const { projectId, cwd } = JSON.parse(body || '{}') as {
        projectId?: string;
        cwd?: string;
      };

      const selectedCwd = cwd
        ? projectId
          ? this.directoryManager.setProjectDirectory(projectId, cwd)
          : this.directoryManager.setLastLaunchDirectory(cwd)
        : await this.directoryManager.chooseDirectory(projectId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          cwd: selectedCwd,
          directories: this.directoryManager.getState(),
        })
      );
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            err instanceof Error ? err.message : 'Directory selection failed',
        })
      );
    }
  }

  private async handleCreateWorkspace(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);

    try {
      const { templateId, title, cwd, prompt } = JSON.parse(body) as {
        templateId: string;
        title?: string;
        cwd?: string;
        prompt?: string;
      };

      if (!templateId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'templateId is required' }));
        return;
      }

      const resolvedCwd = this.directoryManager.resolveTaskDirectory(
        undefined,
        cwd
      );

      const workspaceId = await this.workspaceManager.createFromTemplate(
        templateId,
        { title, cwd: resolvedCwd, initialPrompt: prompt }
      );

      // Register agent session if it's an agent template
      const template = this.workspaceManager.getTemplate(templateId);
      const agentManager = this.getAgentManager();
      if (template?.kind === 'agent' && template.agentType && agentManager) {
        this.directoryManager.rememberAgentPreference(template.agentType);
        agentManager.register({
          workspaceId,
          agentType: template.agentType,
          state: 'starting',
          startedAt: new Date().toISOString(),
          lastStateChange: new Date().toISOString(),
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, workspaceId }));
    } catch (err) {
      if (err instanceof DirectoryRequiredError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: err.message,
            code: err.code,
          })
        );
        return;
      }

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : 'Workspace creation failed',
        })
      );
    }
  }

  private async handleAgentStop(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);

    try {
      const { workspaceId } = JSON.parse(body) as { workspaceId: string };

      if (!workspaceId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'workspaceId is required' }));
        return;
      }

      const agentManager = this.getAgentManager();
      const session = agentManager?.getSession(workspaceId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      await agentManager!.stop(workspaceId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : 'Stop failed',
        })
      );
    }
  }

  private async handleAgentCheckpoint(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);

    try {
      const { workspaceId } = JSON.parse(body) as { workspaceId: string };
      if (!workspaceId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'workspaceId is required' }));
        return;
      }

      const agentManager = this.getAgentManager();
      if (!agentManager) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Agent manager unavailable' }));
        return;
      }

      const saved = await agentManager.checkpointSession(workspaceId);
      if (!saved) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session could not be checkpointed' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, session: saved }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : 'Checkpoint failed',
        })
      );
    }
  }

  private async serveStatus(res: http.ServerResponse): Promise<void> {
    const agentManager = this.getAgentManager();
    const sessions = agentManager?.getAllSessions() ?? [];
    const activeAgents = (agentManager?.getActiveSessions() ?? []).map((agent) => ({
      ...agent,
      attachedContextCount: this.workspaceManager.getAttachedContextItems(
        agent.workspaceId
      ).length,
    }));
    const recentHistory = (agentManager?.getHistorySessions(6) ?? []).map(
      (agent) => ({
        ...agent,
        attachedContextCount: this.workspaceManager.getAttachedContextItems(
          agent.workspaceId
        ).length,
      })
    );
    const savedSessions = (agentManager?.getSavedSessions() ?? []).map(
      (session) => ({
        ...session,
        attachedContextCount: (session.attachedContextItems || []).length,
      })
    );
    const devWorkspaces = this.workspaceManager.getDevServerWorkspaces();
    const auth = this.getAuthState();
    const templates = this.workspaceManager.listTemplates();
    const directories = this.directoryManager.getState();

    let nextEvent: string | null = null;
    const exfClient = this.getExfClient();
    if (exfClient) {
      try {
        const today = new Date().toISOString().split('T')[0];
        const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
        const cal = await exfClient.listCalendarEvents({ startDate: today, endDate: tomorrow, limit: 1 });
        if (cal.data?.events?.[0]) {
          nextEvent = (cal.data.events[0] as { title: string }).title;
        }
      } catch { /* non-critical */ }
    }

    // Include execuTerm workspace list for the standalone context section
    let cmuxWorkspaces: Array<{ id: string; title: string; selected: boolean }> = [];
    const cmux = this.getCmux?.();
    if (cmux?.isConnected()) {
      try {
        const wsList = await cmux.workspaceList();
        cmuxWorkspaces = (wsList.workspaces || []).map((w) => ({
          id: w.id,
          title: w.title,
          selected: w.selected,
        }));
      } catch { /* non-critical */ }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        auth,
        agents: sessions,
        activeAgents,
        recentHistory,
        savedSessions,
        devServers: devWorkspaces.map((w) => ({ id: w.id, title: w.title, state: w.state })),
        templates: templates.map((t) => ({ id: t.id, name: t.name, kind: t.kind, color: t.color })),
        directories,
        nextEvent,
        cmuxWorkspaces,
      })
    );
  }

  private async serveResumableSessions(
    res: http.ServerResponse
  ): Promise<void> {
    const agentManager = this.getAgentManager();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        sessions: agentManager?.getSavedSessions() ?? [],
      })
    );
  }

  private async handleRestoreResumableSessions(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);

    try {
      const parsed = JSON.parse(body || '{}') as {
        sessionId?: string;
        restoreAll?: boolean;
      };
      const agentManager = this.getAgentManager();
      if (!agentManager) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Agent manager unavailable' }));
        return;
      }

      const workspaceIds: string[] = [];
      if (parsed.restoreAll) {
        const saved = agentManager.getSavedSessions();
        for (const session of saved) {
          const workspaceId = await agentManager.restoreSavedSession(session.id);
          workspaceIds.push(workspaceId);
        }
      } else if (parsed.sessionId) {
        workspaceIds.push(await agentManager.restoreSavedSession(parsed.sessionId));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'sessionId or restoreAll is required' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, workspaceIds }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : 'Restore failed',
        })
      );
    }
  }

  private toDashboardTask(record: Record<string, unknown>) {
    const projectId = record.projectId as string | undefined;
    const directory = this.directoryManager.describeTaskDirectory(projectId);
    return {
      id: record.id,
      title: record.title,
      projectId,
      priority: record.priority,
      effort: record.effort,
      phase: record.phase,
      status: record.status,
      when: record.when,
      executorAgent: record.executorAgent,
      resolvedDirectory: directory.cwd,
      directorySource: directory.source,
      preferredAgent:
        this.directoryManager.resolvePreferredAgent(projectId) || 'codex',
    };
  }

  private async serveTasks(url: URL, res: http.ServerResponse): Promise<void> {
    const exfClient = this.getExfClient();
    if (!exfClient) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tasks: [] }));
      return;
    }

    try {
      const priority = url.searchParams.get('priority') || undefined;
      const phase = url.searchParams.get('phase') || undefined;
      const result = await exfClient.listTasks({ limit: 100, priority, phase });
      const tasks = (result.data?.tasks ?? []).map((t) =>
        this.toDashboardTask(t as Record<string, unknown>)
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tasks }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tasks: [] }));
    }
  }

  private async handleCreateTask(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);
    const exfClient = this.getExfClient();
    if (!exfClient) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not authenticated' }));
      return;
    }

    try {
      const payload = JSON.parse(body) as {
        title: string;
        description?: string;
        priority?: string;
        effort?: string;
        projectId?: string;
        when?: string;
        rationale?: string;
        deliverable?: string;
        verification?: string;
        approachConstraints?: string[];
        acceptanceCriteria?: Array<{ text: string; met?: boolean }>;
        phase?: string;
        executorAgent?: string;
        goalId?: string;
      };

      if (!payload.title) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'title is required' }));
        return;
      }

      // Strip empty strings to avoid validation issues
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(payload)) {
        if (v !== '' && v !== undefined && v !== null) clean[k] = v;
      }
      if (!clean.priority) {
        clean.priority = 'do_now';
      }

      const result = await exfClient.createTask(clean as typeof payload);
      const createdTask =
        result.data && typeof result.data === 'object' && 'task' in result.data
          ? (result.data as { task?: Record<string, unknown> }).task
          : undefined;
      const upstreamError =
        result.error ||
        (result.data && typeof result.data === 'object' && 'error' in result.data
          ? String((result.data as { error?: unknown }).error)
          : undefined);
      if (result.statusCode >= 400 || !createdTask) {
        res.writeHead(result.statusCode >= 400 ? result.statusCode : 502, {
          'Content-Type': 'application/json',
        });
        res.end(
          JSON.stringify({
            error:
              upstreamError ||
              'ExecuFunction rejected the task create request',
          })
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, task: createdTask }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Create failed' }));
    }
  }

  private async serveTaskDetail(
    taskId: string,
    res: http.ServerResponse
  ): Promise<void> {
    const exfClient = this.getExfClient();
    if (!exfClient) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not authenticated' }));
      return;
    }

    try {
      const result = await exfClient.getTask(taskId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ task: result.data?.task }));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch task' }));
    }
  }

  private async serveProjects(res: http.ServerResponse): Promise<void> {
    const exfClient = this.getExfClient();
    if (!exfClient) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ projects: [] }));
      return;
    }

    try {
      const result = await exfClient.listProjects();
      const projects = (result.data?.projects ?? []).map((p) => ({
        id: (p as Record<string, unknown>).id,
        name: (p as Record<string, unknown>).name,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ projects }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ projects: [] }));
    }
  }

  private async serveCalendar(res: http.ServerResponse): Promise<void> {
    const exfClient = this.getExfClient();
    if (!exfClient) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events: [] }));
      return;
    }

    try {
      const today = new Date().toISOString().split('T')[0];
      const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
      const cal = await exfClient.listCalendarEvents({
        startDate: today,
        endDate: tomorrow,
        limit: 5,
      });
      const events = (cal.data?.events ?? []).map((e) => ({
        id: (e as Record<string, unknown>).id,
        title: (e as Record<string, unknown>).title,
        startTime: (e as Record<string, unknown>).startTime,
        endTime: (e as Record<string, unknown>).endTime,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events: [] }));
    }
  }

  private async handleAgentFocus(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);

    try {
      const { workspaceId } = JSON.parse(body) as { workspaceId: string };

      if (!workspaceId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'workspaceId is required' }));
        return;
      }

      const cmux = this.getCmux?.();
      if (!cmux) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'execuTerm unavailable' }));
        return;
      }

      await cmux.workspaceSelect(workspaceId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Focus failed' }));
    }
  }

  private serveNotifications(res: http.ServerResponse): void {
    const config = readDaemonConfig();
    const prefs = config.notifications || DEFAULT_NOTIFICATION_PREFS;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(prefs));
  }

  private serveDashboardSettings(res: http.ServerResponse): void {
    const config = readDaemonConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        refreshMode:
          config.dashboardRefreshMode || DEFAULT_DASHBOARD_REFRESH_MODE,
        refreshIntervalMs:
          config.dashboardRefreshIntervalMs ||
          DEFAULT_DASHBOARD_REFRESH_INTERVAL_MS,
      } satisfies DashboardSettingsPayload)
    );
  }

  private async handleUpdateNotifications(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);

    try {
      const prefs = JSON.parse(body) as Partial<NotificationPreferences>;
      const config = readDaemonConfig();
      config.notifications = {
        ...(config.notifications || DEFAULT_NOTIFICATION_PREFS),
        ...prefs,
      };
      writeDaemonConfig(config);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, notifications: config.notifications }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid request' }));
    }
  }

  private async handleUpdateDashboardSettings(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);

    try {
      const parsed = JSON.parse(body || '{}') as Partial<DashboardSettingsPayload>;
      const refreshMode = parsed.refreshMode === 'manual' ? 'manual' : 'timed';
      const refreshIntervalMs = [5000, 10000, 30000, 60000].includes(
        Number(parsed.refreshIntervalMs)
      )
        ? Number(parsed.refreshIntervalMs)
        : DEFAULT_DASHBOARD_REFRESH_INTERVAL_MS;

      const config = readDaemonConfig();
      config.dashboardRefreshMode = refreshMode;
      config.dashboardRefreshIntervalMs = refreshIntervalMs;
      writeDaemonConfig(config);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          settings: {
            refreshMode,
            refreshIntervalMs,
          } satisfies DashboardSettingsPayload,
        })
      );
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : 'Invalid request',
        })
      );
    }
  }

  private async handleSearchNotes(
    url: URL,
    res: http.ServerResponse
  ): Promise<void> {
    const q = url.searchParams.get('q') || '';
    const exfClient = this.getExfClient();
    if (!exfClient || !q) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ notes: [] }));
      return;
    }

    try {
      const result = await exfClient.searchNotes({ query: q, limit: 10 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ notes: result.data?.notes ?? [] }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ notes: [] }));
    }
  }

  private async handleSearchPeople(
    url: URL,
    res: http.ServerResponse
  ): Promise<void> {
    const q = url.searchParams.get('q') || '';
    const exfClient = this.getExfClient();
    if (!exfClient || !q) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ people: [] }));
      return;
    }

    try {
      const result = await exfClient.searchPeople({ query: q, limit: 10 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ people: result.data?.people ?? [] }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ people: [] }));
    }
  }

  private async handleSearchCodeMemories(
    url: URL,
    res: http.ServerResponse
  ): Promise<void> {
    const q = url.searchParams.get('q') || '';
    const exfClient = this.getExfClient();
    if (!exfClient || !q) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ memories: [] }));
      return;
    }

    try {
      const result = await exfClient.searchCodeMemories({ query: q, limit: 10 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ memories: result.data?.memories ?? [] }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ memories: [] }));
    }
  }

  private async handleSearchTasks(
    url: URL,
    res: http.ServerResponse
  ): Promise<void> {
    const q = url.searchParams.get('q') || '';
    const priority = url.searchParams.get('priority') || undefined;
    const phase = url.searchParams.get('phase') || undefined;
    const limit = Math.min(
      Math.max(Number(url.searchParams.get('limit') || '20') || 20, 1),
      100
    );
    const exfClient = this.getExfClient();
    if (!exfClient) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tasks: [] }));
      return;
    }

    try {
      const result = await exfClient.listTasks({
        limit: Math.max(limit * 3, 50),
        priority,
        phase,
      });
      const lower = q.toLowerCase().trim();
      const terms = lower.split(/\s+/).filter(Boolean);
      const ranked = (result.data?.tasks ?? [])
        .map((t) => t as Record<string, unknown>)
        .filter((record) => {
          const title = String(record.title || '').toLowerCase();
          if (!lower) return true;
          if (title.includes(lower)) return true;
          return terms.every((term) => title.includes(term));
        })
        .sort((a, b) => {
          const aTitle = String(a.title || '').toLowerCase();
          const bTitle = String(b.title || '').toLowerCase();
          const score = (title: string) => {
            if (title === lower) return 0;
            if (title.startsWith(lower)) return 1;
            if (title.includes(lower)) return 2;
            if (terms.every((term) => title.startsWith(term) || title.includes(` ${term}`))) return 3;
            return 4;
          };
          return score(aTitle) - score(bTitle);
        })
        .slice(0, limit)
        .map((record) => this.toDashboardTask(record));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tasks: ranked }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tasks: [] }));
    }
  }

  private estimateContextChars(
    title: string,
    excerpt: string,
    filePath?: string
  ): number {
    return [title, excerpt, filePath || ''].join('\n').trim().length;
  }

  private normalizeContextSourceType(
    value: unknown
  ): ContextSourceType | null {
    if (
      value === 'note' ||
      value === 'memory' ||
      value === 'task' ||
      value === 'file'
    ) {
      return value;
    }
    return null;
  }

  private truncateContextText(
    text: string,
    maxChars = 4200
  ): { renderedText: string; estimatedChars: number; truncated: boolean } {
    const estimatedChars = text.length;
    if (estimatedChars <= maxChars) {
      return {
        renderedText: text,
        estimatedChars,
        truncated: false,
      };
    }
    const suffix = '\n\n[Context truncated for size]';
    return {
      renderedText: text.slice(0, maxChars - suffix.length) + suffix,
      estimatedChars,
      truncated: true,
    };
  }

  private async buildSessionTaskSection(
    workspaceId: string
  ): Promise<ContextPreviewSection | null> {
    const workspace = this.workspaceManager.getWorkspace(workspaceId);
    if (!workspace?.taskId) {
      return null;
    }

    const exfClient = this.getExfClient();
    if (!exfClient) {
      return null;
    }

    try {
      const result = await exfClient.getTask(workspace.taskId);
      const record = result.data?.task as Record<string, unknown> | undefined;
      if (!record) {
        return null;
      }

      const lines: string[] = [];
      const title = String(record.title || workspace.title || 'Task');
      lines.push(`- **${title}**`);

      const description = String(
        record.rationale || record.description || ''
      ).trim();
      if (description) {
        lines.push(
          `- Why: ${description.replace(/\s+/g, ' ').slice(0, 280)}`
        );
      }

      const deliverable = String(record.deliverable || '').trim();
      if (deliverable) {
        lines.push(
          `- Deliverable: ${deliverable.replace(/\s+/g, ' ').slice(0, 220)}`
        );
      }

      const verification = String(record.verification || '').trim();
      if (verification) {
        lines.push(
          `- Verification: ${verification.replace(/\s+/g, ' ').slice(0, 220)}`
        );
      }

      return {
        title: 'Task',
        body: lines.join('\n'),
      };
    } catch {
      return null;
    }
  }

  private async buildContextPreview(
    workspaceId: string
  ): Promise<ContextPreviewPayload> {
    const items = this.workspaceManager.getAttachedContextItems(workspaceId);
    const sections: ContextPreviewSection[] = [];
    const taskSection = await this.buildSessionTaskSection(workspaceId);
    if (taskSection) {
      sections.push(taskSection);
    }

    const memories = items.filter((item) => item.sourceType === 'memory');
    const notes = items.filter((item) => item.sourceType === 'note');
    const tasks = items.filter((item) => item.sourceType === 'task');
    const files = items.filter((item) => item.sourceType === 'file');

    if (memories.length > 0) {
      sections.push({
        title: 'Relevant Code Memories',
        body: memories
          .map((item) =>
            `- **${item.title}**${item.filePath ? ` (${item.filePath})` : ''}${
              item.excerpt ? ` — ${item.excerpt}` : ''
            }`
          )
          .join('\n'),
      });
    }

    if (notes.length > 0) {
      sections.push({
        title: 'Relevant Notes',
        body: notes
          .map((item) => `**${item.title}**\n${item.excerpt}`)
          .join('\n\n'),
      });
    }

    if (tasks.length > 0) {
      sections.push({
        title: 'Related Tasks',
        body: tasks
          .map((item) => `- **${item.title}**${item.excerpt ? ` — ${item.excerpt}` : ''}`)
          .join('\n'),
      });
    }

    if (files.length > 0) {
      sections.push({
        title: 'Relevant Files',
        body: files
          .map((item) => {
            const location = item.filePath || item.title;
            return `- \`${location}\`${item.excerpt ? ` — ${item.excerpt}` : ''}`;
          })
          .join('\n'),
      });
    }

    const rawText =
      sections.length > 0
        ? `## Session Context\n\n${sections
            .map((section) => `### ${section.title}\n${section.body}`)
            .join('\n\n')}`
        : '';
    const truncated = this.truncateContextText(rawText);

    return {
      items,
      sections,
      renderedText: truncated.renderedText,
      estimatedChars: truncated.estimatedChars,
      truncated: truncated.truncated,
    };
  }

  private async serveContextPreview(
    workspaceId: string,
    res: http.ServerResponse
  ): Promise<void> {
    const workspace = this.workspaceManager.getWorkspace(workspaceId);
    if (!workspace) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Workspace not found' }));
      return;
    }

    const preview = await this.buildContextPreview(workspaceId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(preview));
  }

  private async handleContextSearch(
    url: URL,
    res: http.ServerResponse
  ): Promise<void> {
    const q = url.searchParams.get('q') || '';
    const exfClient = this.getExfClient();
    if (!exfClient || !q) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [] }));
      return;
    }

    try {
      const [notesResult, memoriesResult, tasksResult] = await Promise.allSettled([
        exfClient.searchNotes({ query: q, limit: 4 }),
        exfClient.searchCodeMemories({ query: q, limit: 4 }),
        exfClient.listTasks({ limit: 12 }),
      ]);

      const lower = q.toLowerCase().trim();
      const terms = lower.split(/\s+/).filter(Boolean);
      const scoreText = (title: string, excerpt: string) => {
        const lowerTitle = title.toLowerCase();
        const haystack = `${title} ${excerpt}`.toLowerCase();
        if (lowerTitle === lower) return 0;
        if (lowerTitle.startsWith(lower)) return 1;
        if (lowerTitle.includes(lower)) return 2;
        if (terms.every((term) => haystack.includes(term))) return 3;
        return 4;
      };
      const typeWeight: Record<ContextSearchResult['sourceType'], number> = {
        memory: 0,
        note: 1,
        task: 2,
      };
      const results: ContextSearchResult[] = [];

      if (notesResult.status === 'fulfilled' && notesResult.value.data?.notes) {
        for (const note of notesResult.value.data.notes) {
          const n = note as Record<string, unknown>;
          const title = String(n.title || 'Untitled Note');
          const excerpt = String(n.content || n.body || '')
            .replace(/\s+/g, ' ')
            .slice(0, 160);
          results.push({
            id: String(n.id || ''),
            sourceType: 'note',
            title,
            excerpt,
            projectId: n.projectId ? String(n.projectId) : undefined,
            estimatedChars: this.estimateContextChars(title, excerpt),
          });
        }
      }

      if (memoriesResult.status === 'fulfilled' && memoriesResult.value.data?.memories) {
        for (const mem of memoriesResult.value.data.memories) {
          const title = `[${mem.factType}] ${mem.content.slice(0, 60)}`;
          const excerpt = mem.content.replace(/\s+/g, ' ').slice(0, 160);
          results.push({
            id: mem.id,
            sourceType: 'memory',
            title,
            excerpt,
            filePath: mem.filePath,
            estimatedChars: this.estimateContextChars(title, excerpt, mem.filePath),
          });
        }
      }

      if (tasksResult.status === 'fulfilled' && tasksResult.value.data?.tasks) {
        const matched = (tasksResult.value.data.tasks as Record<string, unknown>[])
          .filter((record) => {
            const title = String(record.title || '').toLowerCase();
            if (title.includes(lower)) return true;
            return terms.every((term) => title.includes(term));
          })
          .slice(0, 4);
        for (const t of matched) {
          const title = String(t.title || '');
          const excerpt = String(
            t.rationale || t.description || t.deliverable || ''
          )
            .replace(/\s+/g, ' ')
            .slice(0, 160);
          results.push({
            id: String(t.id || ''),
            sourceType: 'task',
            title,
            excerpt,
            projectId: t.projectId ? String(t.projectId) : undefined,
            estimatedChars: this.estimateContextChars(title, excerpt),
          });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          results: results
            .filter((item) => item.id && item.title)
            .sort((a, b) => {
              const scoreDiff =
                scoreText(a.title, a.excerpt) - scoreText(b.title, b.excerpt);
              if (scoreDiff !== 0) return scoreDiff;
              return typeWeight[a.sourceType] - typeWeight[b.sourceType];
            })
            .slice(0, 8),
        })
      );
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [] }));
    }
  }

  private async handleContextAttach(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);

    try {
      const { workspaceId, item } = JSON.parse(body) as {
        workspaceId: string;
        item: {
          id: string;
          sourceType?: ContextSourceType;
          type?: ContextSourceType;
          title: string;
          excerpt: string;
          filePath?: string;
          projectId?: string;
          estimatedChars?: number;
          pinned?: boolean;
        };
      };
      const sourceType = this.normalizeContextSourceType(
        item?.sourceType || item?.type
      );

      if (!workspaceId || !item?.id || !sourceType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'workspaceId and item are required' }));
        return;
      }

      if (!this.workspaceManager.getWorkspace(workspaceId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Workspace not found' }));
        return;
      }
      const items = this.workspaceManager.attachContextItem(workspaceId, {
        id: item.id,
        sourceType,
        title: item.title,
        excerpt: item.excerpt,
        filePath: item.filePath,
        projectId: item.projectId,
        estimatedChars: item.estimatedChars,
        pinned: item.pinned,
      });
      const preview = await this.buildContextPreview(workspaceId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, items, preview }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
  }

  private async handleContextDetach(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);

    try {
      const { workspaceId, itemId, itemType } = JSON.parse(body) as {
        workspaceId: string;
        itemId: string;
        itemType: string;
      };
      const sourceType = this.normalizeContextSourceType(itemType);

      if (!workspaceId || !itemId || !sourceType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'workspaceId, itemId, and itemType are required' }));
        return;
      }

      if (!this.workspaceManager.getWorkspace(workspaceId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Workspace not found' }));
        return;
      }
      const items = this.workspaceManager.detachContextItem(
        workspaceId,
        itemId,
        sourceType
      );
      const preview = await this.buildContextPreview(workspaceId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, items, preview }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
  }

  private async handleContextSend(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);

    try {
      const { workspaceId } = JSON.parse(body) as { workspaceId: string };

      if (!workspaceId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'workspaceId is required' }));
        return;
      }

      const preview = await this.buildContextPreview(workspaceId);
      if (preview.items.length === 0 || !preview.renderedText) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No context items attached' }));
        return;
      }

      const cmux = this.getCmux?.();
      if (!cmux) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'execuTerm unavailable' }));
        return;
      }

      // Find surface ID — try managed session first, then execuTerm surface list
      const agentManager = this.getAgentManager();
      const session = agentManager?.getSession(workspaceId);
      let surfaceId = session?.surfaceId;
      if (!surfaceId) {
        try {
          const surfaceList = await cmux.surfaceList(workspaceId);
          const focusedSurface = surfaceList.surfaces?.find(
            (s: { focused: boolean; type: string }) => s.focused && s.type === 'terminal'
          );
          const firstTerminal = surfaceList.surfaces?.find(
            (s: { type: string }) => s.type === 'terminal'
          );
          surfaceId = (focusedSurface || firstTerminal)?.id;
        } catch { /* execuTerm query failed */ }
      }
      if (!surfaceId) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No active surface for workspace' }));
        return;
      }

      await cmux.surfaceSendText(preview.renderedText + '\n', surfaceId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          charsSent: preview.renderedText.length,
          truncated: preview.truncated,
        })
      );
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Send failed' }));
    }
  }

  private async serveDashboard(res: http.ServerResponse): Promise<void> {
    const html = this.buildDashboardHtml();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  private serveContextPage(url: URL, res: http.ServerResponse): void {
    const workspaceId = url.searchParams.get('workspace') || '';
    const surfaceId = url.searchParams.get('surface') || '';
    const html = this.buildContextPageHtml(workspaceId, surfaceId);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  private async handleContextInject(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);

    try {
      const { surfaceId, item } = JSON.parse(body) as {
        surfaceId: string;
        item: {
          sourceType: string;
          title: string;
          excerpt: string;
        };
      };

      if (!surfaceId || !item?.title) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'surfaceId and item are required' }));
        return;
      }

      const cmux = this.getCmux?.();
      if (!cmux) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'execuTerm unavailable' }));
        return;
      }

      const formatted = `---\n## Context: ${item.title} (${item.sourceType})\n${item.excerpt}\n---`;
      await cmux.surfaceSendText(formatted, surfaceId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, charsSent: formatted.length }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : 'Inject failed',
        })
      );
    }
  }

  private buildContextPageHtml(workspaceId: string, surfaceId: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Add Context</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%23161616'/><defs><linearGradient id='f' x1='0' y1='0' x2='1' y2='1'><stop offset='0%25' stop-color='%233bceac'/><stop offset='100%25' stop-color='%232188dd'/></linearGradient></defs><path d='M8 9l5 4-5 4' fill='none' stroke='url(%23f)' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/><rect x='16' y='11.5' width='9' height='3' rx='1.5' fill='%2352525b'/></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #09090b; --surface: #131316; --surface-raised: #1a1a1f;
      --border: #1f1f25; --border-subtle: #16161a;
      --text: #e4e4e7; --text-dim: #71717a; --text-muted: #52525b;
      --brand-teal: #3bceac; --brand-blue: #2188dd;
      --brand-gradient: linear-gradient(135deg, var(--brand-teal), var(--brand-blue));
      --font-sans: 'IBM Plex Mono', 'SF Mono', monospace;
      --font-mono: 'IBM Plex Mono', 'SF Mono', monospace;
    }
    body {
      font-family: var(--font-sans); background: var(--bg); color: var(--text);
      padding: 12px; line-height: 1.4; height: 100vh; overflow: hidden;
      display: flex; flex-direction: column;
    }
    .search-wrap {
      position: relative; margin-bottom: 8px; flex-shrink: 0;
    }
    .search-wrap svg {
      position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
      width: 14px; height: 14px; color: var(--text-muted);
    }
    input {
      width: 100%; padding: 8px 10px 8px 32px; border-radius: 6px;
      border: 1px solid var(--border); background: var(--surface);
      color: var(--text); font-family: var(--font-sans); font-size: 13px;
      outline: none; transition: border-color 0.15s;
    }
    input:focus { border-color: var(--brand-teal); }
    input::placeholder { color: var(--text-muted); }
    .results {
      flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;
    }
    .results::-webkit-scrollbar { width: 4px; }
    .results::-webkit-scrollbar-track { background: transparent; }
    .results::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
    .result-row {
      display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px;
      border-radius: 6px; cursor: pointer; transition: background 0.1s;
      position: relative; flex-shrink: 0;
    }
    .result-row:hover { background: var(--surface-raised); }
    .result-row.sent { background: rgba(59, 206, 172, 0.08); }
    .badge {
      font-size: 9px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase;
      padding: 2px 5px; border-radius: 3px; flex-shrink: 0; margin-top: 2px;
      font-family: var(--font-mono);
    }
    .badge-note { background: rgba(147, 51, 234, 0.15); color: #a855f7; }
    .badge-memory { background: rgba(59, 206, 172, 0.15); color: var(--brand-teal); }
    .badge-task { background: rgba(33, 136, 221, 0.15); color: var(--brand-blue); }
    .result-content { flex: 1; min-width: 0; }
    .result-title {
      font-size: 12px; font-weight: 500; color: var(--text);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .result-excerpt {
      font-size: 11px; color: var(--text-dim); margin-top: 2px;
      display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .sent-indicator {
      position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
      font-size: 10px; color: var(--brand-teal); font-weight: 600;
      opacity: 0; transition: opacity 0.15s;
    }
    .result-row.sent .sent-indicator { opacity: 1; }
    .empty {
      color: var(--text-muted); font-size: 12px; text-align: center;
      padding: 24px 0;
    }
    .header {
      font-size: 11px; color: var(--text-muted); margin-bottom: 8px;
      font-weight: 500; letter-spacing: 0.3px; flex-shrink: 0;
    }
  </style>
</head>
<body>
  <div class="header">ADD CONTEXT</div>
  <div class="search-wrap">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
    </svg>
    <input id="search" type="text" placeholder="Search notes, memories, tasks..." autofocus>
  </div>
  <div id="results" class="results">
    <div class="empty">Type to search your knowledge base</div>
  </div>
  <script>
    const surfaceId = ${JSON.stringify(surfaceId)};
    const searchInput = document.getElementById('search');
    const resultsEl = document.getElementById('results');
    let debounce;

    searchInput.addEventListener('input', () => {
      clearTimeout(debounce);
      const q = searchInput.value.trim();
      if (!q) {
        resultsEl.innerHTML = '<div class="empty">Type to search your knowledge base</div>';
        return;
      }
      debounce = setTimeout(() => doSearch(q), 150);
    });

    async function doSearch(q) {
      try {
        const r = await fetch('/api/context/search?q=' + encodeURIComponent(q));
        const data = await r.json();
        renderResults(data.results || []);
      } catch {
        resultsEl.innerHTML = '<div class="empty">Search failed</div>';
      }
    }

    function renderResults(results) {
      if (results.length === 0) {
        resultsEl.innerHTML = '<div class="empty">No results</div>';
        return;
      }
      resultsEl.innerHTML = results.map((item, i) => {
        const badgeClass = 'badge-' + item.sourceType;
        const label = item.sourceType === 'memory' ? 'MEM' :
                      item.sourceType === 'note' ? 'NOTE' : 'TASK';
        return '<div class="result-row" data-idx="' + i + '">' +
          '<span class="badge ' + badgeClass + '">' + label + '</span>' +
          '<div class="result-content">' +
            '<div class="result-title">' + escapeHtml(item.title) + '</div>' +
            '<div class="result-excerpt">' + escapeHtml(item.excerpt) + '</div>' +
          '</div>' +
          '<span class="sent-indicator">Sent</span>' +
        '</div>';
      }).join('');

      resultsEl.querySelectorAll('.result-row').forEach((row, i) => {
        row.addEventListener('click', () => injectItem(results[i], row));
      });
    }

    async function injectItem(item, row) {
      try {
        await fetch('/api/context/inject', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ surfaceId, item })
        });
        row.classList.add('sent');
        setTimeout(() => row.classList.remove('sent'), 1200);
      } catch { /* ignore */ }
    }

    function escapeHtml(s) {
      const d = document.createElement('div');
      d.textContent = s || '';
      return d.innerHTML;
    }
  </script>
</body>
</html>`;
  }

  private buildDashboardHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>execuTerm</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%23161616'/><defs><linearGradient id='f' x1='0' y1='0' x2='1' y2='1'><stop offset='0%25' stop-color='%233bceac'/><stop offset='100%25' stop-color='%232188dd'/></linearGradient></defs><path d='M8 9l5 4-5 4' fill='none' stroke='url(%23f)' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/><rect x='16' y='11.5' width='9' height='3' rx='1.5' fill='%2352525b'/></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #09090b; --surface: #131316; --surface-raised: #1a1a1f;
      --border: #1f1f25; --border-subtle: #16161a;
      --text: #e4e4e7; --text-dim: #71717a; --text-muted: #52525b;
      --brand-teal: #3bceac; --brand-blue: #2188dd;
      --brand-gradient: linear-gradient(135deg, var(--brand-teal), var(--brand-blue));
      --font-sans: 'IBM Plex Mono', 'SF Mono', monospace;
      --font-mono: 'IBM Plex Mono', 'SF Mono', monospace;
    }
    body {
      font-family: var(--font-sans); background: var(--bg); color: var(--text);
      padding: 20px; line-height: 1.4;
      background-image: radial-gradient(circle at 1px 1px, #ffffff06 1px, transparent 0);
      background-size: 24px 24px;
    }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--brand-gradient); }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding-bottom: 14px; border-bottom: none; position: relative; }
    .header::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 1px; background: linear-gradient(90deg, var(--brand-teal), var(--brand-blue), transparent); opacity: 0.4; }
    .header__brand { display: flex; align-items: center; gap: 10px; }
    .header__logo { width: 36px; height: 36px; flex-shrink: 0; }
    .header__title { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; background: var(--brand-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .header__title span { -webkit-text-fill-color: var(--text-dim); font-weight: 400; }
    .header__event { font-family: var(--font-mono); font-size: 11px; color: var(--text-dim); background: var(--surface); padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); max-width: 340px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .header__event::before { content: ''; display: inline-block; width: 6px; height: 6px; background: var(--brand-teal); border-radius: 50%; margin-right: 6px; vertical-align: middle; }
    .section-label { font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px; margin-top: 20px; padding-bottom: 6px; border-bottom: 1px solid var(--border-subtle); display: flex; align-items: center; gap: 6px; }
    .section-label::before { content: ''; width: 3px; height: 12px; border-radius: 1px; background: var(--brand-gradient); }
    .agent-grid { display: flex; flex-direction: column; gap: 6px; }
    .agent-card { display: flex; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; transition: border-color 0.15s, box-shadow 0.15s; cursor: pointer; }
    .agent-card:hover { border-color: #2a2a30; background: linear-gradient(var(--surface), var(--surface)) padding-box, linear-gradient(135deg, var(--brand-teal)33, var(--brand-blue)33) border-box; border-color: transparent; }
    .agent-card--running { border-left: 2px solid transparent; border-image: var(--brand-gradient) 1; border-image-slice: 1; }
    .agent-card__stripe { width: 3px; flex-shrink: 0; }
    .agent-card__body { flex: 1; padding: 10px 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .agent-card__header { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 140px; }
    .agent-card__name { font-family: var(--font-mono); font-size: 12px; font-weight: 600; }
    .agent-card__state { font-size: 11px; font-weight: 600; }
    .agent-card__meta { display: flex; align-items: center; gap: 12px; font-size: 11px; }
    .agent-card__task-title { color: var(--text); font-size: 11px; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .saved-session-list { display: flex; flex-direction: column; gap: 6px; }
    .saved-session-row { display: grid; grid-template-columns: minmax(160px, 1.4fr) minmax(180px, 1fr) auto; gap: 10px; align-items: center; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; }
    .saved-session__title { font-size: 12px; font-weight: 600; color: var(--text); }
    .saved-session__meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); }
    .saved-session__path { font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .saved-session__actions { display: flex; align-items: center; gap: 6px; justify-content: flex-end; }
    .led { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 0 4px color-mix(in srgb, var(--led) 50%, transparent), 0 0 8px color-mix(in srgb, var(--led) 25%, transparent); }
    .led--pulse { animation: pulse 2s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .mono { font-family: var(--font-mono); font-size: 11px; color: var(--text-dim); }
    .dim { color: var(--text-muted); font-size: 11px; }
    .empty { color: var(--text-muted); font-size: 12px; font-style: italic; padding: 12px 0; display: flex; align-items: center; gap: 6px; }
    .empty::before { content: ''; display: inline-block; width: 12px; height: 12px; background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%233bceac'/%3E%3Cstop offset='100%25' stop-color='%232188dd'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M3 2l4 4-4 4' fill='none' stroke='url(%23g)' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat center; flex-shrink: 0; opacity: 0.6; }
    .btn-stop { font-family: var(--font-mono); font-size: 10px; color: #FF3B30; background: transparent; border: 1px solid #FF3B3033; padding: 2px 8px; border-radius: 3px; cursor: pointer; margin-left: auto; transition: background 0.15s; }
    .btn-stop:hover { background: #FF3B3015; border-color: #FF3B3066; }
    .launch-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-top: 8px; }
    .launch-btn { font-family: var(--font-mono); font-size: 11px; font-weight: 600; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; cursor: pointer; transition: border-color 0.15s, color 0.15s, background 0.15s, transform 0.15s; display: flex; align-items: center; gap: 8px; justify-content: center; }
    .launch-btn:hover { border-color: color-mix(in srgb, var(--brand-teal) 40%, var(--border)); color: var(--text); background: var(--surface-raised); }
    .launch-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .launch-btn__dot { width: 6px; height: 6px; border-radius: 50%; background: var(--brand-gradient); }
    .dir-card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .dir-card__row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .dir-card__path { font-family: var(--font-mono); font-size: 11px; color: var(--text-dim); flex: 1; min-width: 220px; }
    .dir-chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .dir-chip { font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); border: 1px solid var(--border); border-radius: 999px; padding: 3px 8px; background: var(--bg); cursor: pointer; }
    .dir-map-list { display: flex; flex-direction: column; gap: 6px; }
    .dir-map-row { display: grid; grid-template-columns: minmax(120px, 180px) 1fr auto; gap: 8px; align-items: center; }
    .dir-map-project { font-size: 11px; color: var(--text); font-weight: 500; }
    .dir-source { font-family: var(--font-mono); font-size: 9px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
    .btn-secondary { font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); background: transparent; border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; cursor: pointer; }
    .btn-secondary:hover { background: var(--surface-raised); color: var(--text); }
    .finished-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    .finished-tag { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); background: var(--surface); border: 1px solid var(--border-subtle); border-radius: 3px; padding: 2px 8px; display: flex; align-items: center; gap: 4px; }
    .finished-tag__dot { width: 5px; height: 5px; border-radius: 50%; }
    .auth-card { background: linear-gradient(var(--surface), var(--surface)) padding-box, linear-gradient(135deg, var(--brand-teal)44, var(--brand-blue)44, var(--border) 50%) border-box; border: 1px solid transparent; border-radius: 6px; padding: 12px 14px; font-size: 12px; margin-bottom: 16px; }
    .auth-card strong { color: var(--text); font-weight: 600; }
    .auth-card a { color: var(--brand-blue); text-decoration: none; }
    .auth-card .code { font-family: var(--font-mono); font-size: 14px; font-weight: 500; background: var(--bg); padding: 2px 8px; border-radius: 3px; letter-spacing: 0.05em; }

    /* Calendar strip */
    .cal-strip { display: flex; flex-direction: column; gap: 4px; }
    .cal-row { display: flex; align-items: center; gap: 10px; padding: 5px 8px; border-left: 2px solid; border-image: var(--brand-gradient) 1; font-size: 12px; }
    .cal-row__time { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); min-width: 90px; }
    .cal-row__title { color: var(--text-dim); }

    /* Task list */
    .task-toolbar { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
    .task-toolbar__top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .task-toolbar__chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .task-toolbar__chip { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 5px 9px; cursor: pointer; text-transform: uppercase; letter-spacing: 0.05em; transition: border-color 0.15s, color 0.15s, background 0.15s; }
    .task-toolbar__chip:hover { color: var(--text); border-color: #2a2a30; }
    .task-toolbar__chip--active { color: var(--bg); border-color: transparent; background: var(--brand-gradient); }
    .task-toolbar__search { position: relative; flex: 1; min-width: 260px; }
    .task-toolbar__search input { width: 100%; font-family: var(--font-sans); font-size: 12px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 8px 68px 8px 12px; outline: none; }
    .task-toolbar__search input:focus { border-color: var(--brand-teal); }
    .task-toolbar__search input::placeholder { color: var(--text-muted); }
    .task-toolbar__clear { position: absolute; top: 50%; right: 8px; transform: translateY(-50%); font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); background: transparent; border: 1px solid var(--border); border-radius: 4px; padding: 3px 7px; cursor: pointer; }
    .task-toolbar__clear:hover { color: var(--text); background: var(--surface-raised); }
    .task-toolbar__refresh { display: flex; align-items: center; gap: 6px; margin-left: auto; }
    .task-toolbar__refresh-label { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); white-space: nowrap; }
    .task-toolbar__refresh-select { font-family: var(--font-mono); font-size: 10px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 7px 8px; }
    .task-toolbar__refresh-btn { font-family: var(--font-mono); font-size: 10px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; cursor: pointer; white-space: nowrap; }
    .task-toolbar__refresh-btn:hover { background: var(--surface-raised); }
    .task-toolbar__refresh-status { font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); }
    .task-toolbar__meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); }
    .task-toolbar__meta-left { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .task-toolbar__suggestions { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
    .task-toolbar__suggestion { width: 100%; text-align: left; background: transparent; border: none; border-top: 1px solid var(--border-subtle); padding: 9px 12px; cursor: pointer; display: flex; align-items: center; gap: 10px; }
    .task-toolbar__suggestion:first-child { border-top: none; }
    .task-toolbar__suggestion:hover { background: var(--surface-raised); }
    .task-toolbar__suggestion-title { font-size: 12px; color: var(--text); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .task-toolbar__suggestion-meta { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .task-toolbar__notice { font-size: 12px; color: var(--text-dim); background: color-mix(in srgb, var(--brand-teal) 10%, transparent); border: 1px solid color-mix(in srgb, var(--brand-teal) 18%, transparent); border-radius: 6px; padding: 8px 10px; }
    .task-list { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
    .task-row { display: flex; align-items: center; gap: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 5px; padding: 8px 10px; transition: border-color 0.15s, background 0.15s; cursor: pointer; }
    .task-row:hover { border-color: #2a2a30; }
    .task-row__title { font-size: 12px; font-weight: 500; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .task-row__meta { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); flex-shrink: 0; }
    .task-row__priority { font-family: var(--font-mono); font-size: 9px; padding: 1px 5px; border-radius: 2px; flex-shrink: 0; text-transform: uppercase; letter-spacing: 0.04em; }
    .task-row__priority--chip { background: color-mix(in srgb, currentColor 10%, transparent); }
    .task-row__dispatch { font-family: var(--font-mono); font-size: 10px; color: var(--bg); background: var(--brand-gradient); border: none; border-radius: 3px; padding: 4px 10px; cursor: pointer; flex-shrink: 0; font-weight: 600; transition: box-shadow 0.15s, opacity 0.15s; }
    .task-row__dispatch:hover { box-shadow: 0 0 8px color-mix(in srgb, var(--brand-teal) 40%, transparent); }
    .task-row__dispatch:disabled { background: var(--border); color: var(--text-muted); cursor: not-allowed; box-shadow: none; opacity: 0.6; }
    .task-row__agent-select { font-family: var(--font-mono); font-size: 10px; background: var(--bg); color: var(--text-dim); border: 1px solid var(--border); border-radius: 3px; padding: 3px 4px; flex-shrink: 0; }
    .task-row__dir { font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .task-row__dir-source { font-family: var(--font-mono); font-size: 9px; color: var(--text-muted); flex-shrink: 0; text-transform: uppercase; letter-spacing: 0.05em; }

    /* Task expansion panel */
    .task-expand { background: var(--surface-raised); border: 1px solid var(--border); border-top: none; border-radius: 0 0 5px 5px; padding: 10px 12px; margin-top: -4px; font-size: 12px; animation: slideDown 0.15s ease-out; }
    @keyframes slideDown { from { opacity: 0; max-height: 0; } to { opacity: 1; max-height: 400px; } }
    .task-expand__field { margin-bottom: 8px; }
    .task-expand__label { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 2px; }
    .task-expand__value { color: var(--text-dim); font-size: 12px; line-height: 1.5; }
    .task-expand__criteria { list-style: none; padding: 0; }
    .task-expand__criteria li { padding: 2px 0; color: var(--text-dim); font-size: 12px; }
    .task-expand__criteria li::before { content: '\\2610 '; font-size: 13px; margin-right: 4px; }

    /* Task create form */
    .task-create { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-top: 6px; display: flex; flex-direction: column; gap: 10px; animation: slideDown 0.15s ease-out; }
    .task-create__row { display: flex; gap: 8px; align-items: center; }
    .task-create__row--brief { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .task-create input[type="text"], .task-create textarea { flex: 1; font-family: var(--font-sans); font-size: 12px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 6px 8px; outline: none; resize: vertical; }
    .task-create input[type="text"]:focus, .task-create textarea:focus { border-color: var(--brand-teal); }
    .task-create input::placeholder, .task-create textarea::placeholder { color: var(--text-muted); }
    .task-create textarea { min-height: 48px; font-size: 11px; }
    .task-create select { font-family: var(--font-mono); font-size: 10px; background: var(--bg); color: var(--text-dim); border: 1px solid var(--border); border-radius: 3px; padding: 4px 6px; }
    .task-create__label { font-family: var(--font-mono); font-size: 9px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 3px; }
    .task-create__field { display: flex; flex-direction: column; }
    .task-create__brief-section { border-top: 1px solid var(--border-subtle); padding-top: 10px; }
    .task-create__brief-header { font-family: var(--font-mono); font-size: 10px; color: var(--brand-teal); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
    .task-create__brief-toggle { font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); background: transparent; border: 1px dashed var(--border); border-radius: 4px; padding: 5px 8px; cursor: pointer; align-self: flex-start; }
    .task-create__brief-toggle:hover { color: var(--text); border-color: var(--brand-teal); }
    .task-create__actions { display: flex; gap: 6px; justify-content: flex-end; border-top: 1px solid var(--border-subtle); padding-top: 10px; }
    .task-create__btn-create { font-family: var(--font-mono); font-size: 10px; color: var(--bg); background: var(--brand-gradient); border: none; border-radius: 3px; padding: 5px 14px; cursor: pointer; font-weight: 600; transition: box-shadow 0.15s; }
    .task-create__btn-create:hover { box-shadow: 0 0 8px color-mix(in srgb, var(--brand-teal) 40%, transparent); }
    .task-create__btn-cancel { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); background: transparent; border: 1px solid var(--border); border-radius: 3px; padding: 4px 10px; cursor: pointer; }
    .task-create__btn-cancel:hover { background: var(--surface-raised); color: var(--text); }
    .task-create-toggle { font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); background: none; border: 1px dashed var(--border); border-radius: 5px; padding: 6px 10px; width: 100%; cursor: pointer; margin-top: 6px; text-align: left; transition: color 0.15s, border-color 0.15s; }
    .task-create-toggle:hover { color: var(--brand-teal); border-color: transparent; background: linear-gradient(var(--bg), var(--bg)) padding-box, var(--brand-gradient) border-box; border-style: dashed; }

    /* Notification toggles */
    .notif-row { display: flex; align-items: center; gap: 10px; padding: 4px 0; }
    .notif-row label { font-family: var(--font-mono); font-size: 11px; color: var(--text-dim); cursor: pointer; display: flex; align-items: center; gap: 6px; }
    .notif-row input[type="checkbox"] { accent-color: var(--brand-teal); }

    .dev-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 12px; }
    .dev-row + .dev-row { border-top: 1px solid var(--border-subtle); }
    .dev-dot { width: 6px; height: 6px; border-radius: 50%; }

  </style>
</head>
<body>
  <div class="header">
    <div class="header__brand">
      <svg class="header__logo" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="pg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#3bceac"/><stop offset="100%" stop-color="#2188dd"/></linearGradient></defs>
        <rect x="86" y="86" width="340" height="340" rx="85" fill="#161616"/>
        <path d="M 160 146 L 200 176 L 160 206" fill="none" stroke="url(#pg)" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>
        <rect x="240" y="158" width="115" height="36" rx="18" fill="#52525b"/>
        <circle cx="176" cy="256" r="14" fill="#52525b"/><rect x="240" y="238" width="95" height="36" rx="18" fill="#52525b"/>
        <circle cx="176" cy="336" r="14" fill="#52525b"/><rect x="240" y="318" width="85" height="36" rx="18" fill="#52525b"/>
      </svg>
      <div class="header__title">execuTerm <span>/ dashboard</span></div>
    </div>
    <div id="event-slot"></div>
  </div>
  <div id="agents-slot"></div>
  <div id="saved-sessions-slot"></div>
  <div id="tasks-slot"></div>
  <div id="directories-slot"></div>
  <div id="launch-slot"></div>
  <div id="calendar-slot"></div>
  <div id="devservers-slot"></div>
  <div id="notifications-slot"></div>
  <div id="auth-slot"></div>

  <script>
    function esc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/[<]/g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

    const STATE_CFG = {
      starting:     { color: '#FFB84D', label: 'Starting',     pulse: true },
      running:      { color: '#34C759', label: 'Running',      pulse: true },
      waiting_input:{ color: '#007AFF', label: 'Needs Input',  pulse: false },
      review_ready: { color: '#FF9500', label: 'Review Ready', pulse: false },
      failed:       { color: '#FF3B30', label: 'Failed',       pulse: false },
      stopped:      { color: '#555',    label: 'Stopped',      pulse: false },
    };
    const AGENT_COLORS = { 'claude-code': '#D97706', codex: '#2563EB' };
    const PRIORITY_COLORS = {
      do_now: '#FF3B30',
      schedule: '#8B5CF6',
      delegate: '#007AFF',
      someday: '#6B7280'
    };
    const TASK_PRIORITY_OPTIONS = [
      { value: '', label: 'All' },
      { value: 'do_now', label: 'Do now' },
      { value: 'schedule', label: 'Schedule' },
      { value: 'delegate', label: 'Delegate' },
      { value: 'someday', label: 'Someday' },
    ];
    const DASHBOARD_REFRESH_DEFAULT = { refreshMode: 'timed', refreshIntervalMs: 10000 };
    const DASHBOARD_REFRESH_OPTIONS = [
      { value: 'default', label: 'Default' },
      { value: '5000', label: '5s' },
      { value: '10000', label: '10s' },
      { value: '30000', label: '30s' },
      { value: '60000', label: '60s' },
      { value: 'manual', label: 'Manual' },
    ];
    let cachedDirectories = { projectDirectories: {}, recentDirectories: [], lastLaunchDirectory: null, projectAgentPreferences: {}, lastAgentType: null };
    let cachedTasks = [];
    let cachedTemplates = [];
    let cachedNotifPrefs = { onNeedsInput: true, onFinished: true, onFailed: true };
    let cachedProjects = [];
    let cachedSavedSessions = [];
    let selectedTaskAgents = {};
    let expandedTasks = new Set();
    let taskDetailsCache = {};
    let taskPriorityFilter = '';
    let taskSearchQuery = '';
    let taskSuggestions = [];
    let taskSearchSubmitted = false;
    let taskToolbarNotice = '';
    let taskSearchDebounceTimer = null;
    let taskFeedRequestId = 0;
    let showCreateForm = false;
    let showTaskBriefFields = false;
    let isSubmittingTask = false;
    let newTaskDraft = defaultTaskDraft();

    let dashboardRefreshSettings = { ...DASHBOARD_REFRESH_DEFAULT };
    let dashboardRefreshOverride = readDashboardRefreshOverride();
    let dashboardPollTimer = null;
    let dashboardPollInFlight = false;
    let dashboardPollQueued = false;
    let lastRenderedSignatures = {};

    function defaultTaskDraft() {
      return {
        title: '',
        description: '',
        priority: 'do_now',
        when: 'soon',
        effort: 'medium',
        phase: 'open',
        projectId: '',
        rationale: '',
        deliverable: '',
        verification: '',
      };
    }

    function resetNewTaskDraft() {
      newTaskDraft = defaultTaskDraft();
    }

    function updateTaskDraftField(key, value) {
      newTaskDraft[key] = value;
    }

    function readDashboardRefreshOverride() {
      try {
        var raw = sessionStorage.getItem('executerm.dashboardRefreshOverride') || 'default';
        return normalizeDashboardRefreshOverride(raw);
      } catch {
        return 'default';
      }
    }

    function writeDashboardRefreshOverride(value) {
      dashboardRefreshOverride = normalizeDashboardRefreshOverride(value);
      try {
        sessionStorage.setItem('executerm.dashboardRefreshOverride', dashboardRefreshOverride);
      } catch {}
    }

    function normalizeDashboardRefreshOverride(value) {
      if (value === 'manual' || value === 'default') return value;
      return ['5000', '10000', '30000', '60000'].indexOf(String(value)) >= 0
        ? String(value)
        : 'default';
    }

    function effectiveDashboardRefresh() {
      if (dashboardRefreshOverride === 'manual') {
        return { refreshMode: 'manual', refreshIntervalMs: dashboardRefreshSettings.refreshIntervalMs || 10000 };
      }
      if (dashboardRefreshOverride !== 'default') {
        return { refreshMode: 'timed', refreshIntervalMs: Number(dashboardRefreshOverride) || 10000 };
      }
      return {
        refreshMode: dashboardRefreshSettings.refreshMode || DASHBOARD_REFRESH_DEFAULT.refreshMode,
        refreshIntervalMs: dashboardRefreshSettings.refreshIntervalMs || DASHBOARD_REFRESH_DEFAULT.refreshIntervalMs,
      };
    }

    function effectiveDashboardRefreshLabel() {
      var effective = effectiveDashboardRefresh();
      if (effective.refreshMode === 'manual') return 'Manual';
      return String(Math.round(effective.refreshIntervalMs / 1000)) + 's';
    }

    function shouldPollInBackground() {
      return effectiveDashboardRefresh().refreshMode === 'timed';
    }

    function nextDashboardPollDelay() {
      var effective = effectiveDashboardRefresh();
      if (effective.refreshMode !== 'timed') return null;
      if (document.visibilityState === 'hidden') {
        return Math.max(effective.refreshIntervalMs, 60000);
      }
      return effective.refreshIntervalMs;
    }

    function clearDashboardPollTimer() {
      if (dashboardPollTimer) {
        clearTimeout(dashboardPollTimer);
        dashboardPollTimer = null;
      }
    }

    function scheduleDashboardPoll(delayMs) {
      clearDashboardPollTimer();
      if (!shouldPollInBackground()) {
        return;
      }
      var delay = typeof delayMs === 'number' ? delayMs : nextDashboardPollDelay();
      if (typeof delay !== 'number') {
        return;
      }
      dashboardPollTimer = setTimeout(function() {
        requestDashboardRefresh('timer');
      }, delay);
    }

    function setSectionSignature(key, payload) {
      lastRenderedSignatures[key] = JSON.stringify(payload || null);
    }

    function shouldRenderSection(key, payload) {
      var next = JSON.stringify(payload || null);
      if (lastRenderedSignatures[key] === next) {
        return false;
      }
      lastRenderedSignatures[key] = next;
      return true;
    }

    function elapsed(iso) {
      const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 60) return s + 's ago';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm ago';
      return Math.floor(m / 60) + 'h ' + (m % 60) + 'm ago';
    }

    function shortPath(path) {
      if (!path) return 'Not set';
      var home = path.indexOf('/Users/');
      if (home === 0) { var i = path.indexOf('/', 7); return '~' + (i > 0 ? path.substring(i) : ''); }
      return path;
    }

    function baseName(path) {
      if (!path) return 'Not set';
      var clean = path;
      while (clean.length > 1 && clean.endsWith('/')) {
        clean = clean.slice(0, -1);
      }
      var idx = clean.lastIndexOf('/');
      return idx >= 0 ? clean.substring(idx + 1) : clean;
    }

    function agentLabel(agentType) {
      if (agentType === 'claude-code') return 'Claude Code';
      if (agentType === 'codex') return 'Codex';
      return agentType || 'Agent';
    }

    function priorityLabel(priority) {
      if (!priority) return '';
      return String(priority).replace(/_/g, ' ');
    }

    function directorySourceLabel(source) {
      if (source === 'project') return 'project mapping';
      if (source === 'global') return 'global default';
      return 'folder required';
    }

    function formatTime(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
    }

    function getTaskDirectory(task) {
      if (typeof task.resolvedDirectory === 'string') return task.resolvedDirectory;
      if (task.projectId && cachedDirectories.projectDirectories) {
        return cachedDirectories.projectDirectories[task.projectId] || null;
      }
      return cachedDirectories.lastLaunchDirectory || null;
    }

    function getTaskDirectorySource(task) {
      if (task.directorySource) return task.directorySource;
      if (task.projectId && getTaskDirectory(task)) return 'project';
      if (!task.projectId && getTaskDirectory(task)) return 'global';
      return 'missing';
    }

    function getProjectName(projectId) {
      if (!projectId) return 'No project';
      var match = cachedProjects.find(function(p) { return p.id === projectId; });
      return match ? match.name : projectId;
    }

    function isCompletedTask(task) {
      return task.phase === 'done' || task.status === 'completed' || task.status === 'archived';
    }

    function isDefaultActionableTask(task) {
      if (isCompletedTask(task)) return false;
      return !(task.phase === 'in_flight' && task.executorAgent);
    }

    function taskMatchesToolbar(task) {
      if (!task) return false;
      if (isCompletedTask(task)) return false;
      if (taskPriorityFilter && task.priority !== taskPriorityFilter) return false;
      if (taskSearchQuery.trim()) {
        var title = String(task.title || '').toLowerCase();
        var query = taskSearchQuery.trim().toLowerCase();
        if (title.includes(query)) return true;
        return query.split(/\s+/).filter(Boolean).every(function(term) {
          return title.includes(term);
        });
      }
      return isDefaultActionableTask(task);
    }

    function getSelectedTaskAgent(task) {
      if (!task || !task.id) return 'codex';
      if (selectedTaskAgents[task.id]) {
        return selectedTaskAgents[task.id];
      }
      const preferred = task.preferredAgent || 'codex';
      selectedTaskAgents[task.id] = preferred;
      return preferred;
    }

    function setTaskAgent(taskId, agentType) {
      if (!taskId) return;
      selectedTaskAgents[taskId] = agentType || 'codex';
    }

    function buildTaskUrl() {
      const params = new URLSearchParams();
      if (taskPriorityFilter) params.set('priority', taskPriorityFilter);
      const query = taskSearchQuery.trim();
      if (query) {
        params.set('q', query);
        params.set('limit', taskSearchSubmitted ? '50' : '6');
        return '/api/search/tasks?' + params.toString();
      }
      const qs = params.toString();
      return qs ? '/api/tasks?' + qs : '/api/tasks';
    }

    async function loadTaskFeed() {
      const requestId = ++taskFeedRequestId;
      const response = await fetch(buildTaskUrl()).then(function(r) { return r.json(); });
      if (requestId !== taskFeedRequestId) return null;
      cachedTasks = response.tasks || [];
      taskSuggestions = taskSearchQuery.trim() ? cachedTasks.slice(0, 6) : [];
      return cachedTasks;
    }

    function scheduleTaskSearchRefresh() {
      if (taskSearchDebounceTimer) {
        clearTimeout(taskSearchDebounceTimer);
        taskSearchDebounceTimer = null;
      }
      if (!taskSearchQuery.trim()) {
        taskSuggestions = [];
        taskSearchSubmitted = false;
        taskToolbarNotice = '';
        requestDashboardRefresh('toolbar');
        return;
      }
      taskSearchDebounceTimer = setTimeout(function() {
        loadTaskFeed()
          .then(function() {
            renderTasks(cachedTasks, cachedTemplates);
          })
          .catch(function() {});
      }, 180);
    }

    function setTaskPriorityFilter(priority) {
      taskPriorityFilter = priority || '';
      taskToolbarNotice = '';
      if (!taskSearchQuery.trim()) {
        cachedTasks = [];
        renderTasks(cachedTasks, cachedTemplates);
      }
      requestDashboardRefresh('toolbar');
    }

    function updateTaskSearchQuery(value) {
      taskSearchQuery = value || '';
      taskSearchSubmitted = false;
      taskToolbarNotice = '';
      if (taskSearchQuery.trim()) {
        cachedTasks = [];
        taskSuggestions = [];
      }
      renderTasks(cachedTasks, cachedTemplates);
      scheduleTaskSearchRefresh();
    }

    async function submitTaskSearch() {
      if (!taskSearchQuery.trim()) {
        resetTaskToolbar();
        return;
      }
      taskSearchSubmitted = true;
      taskToolbarNotice = '';
      try {
        await loadTaskFeed();
        renderTasks(cachedTasks, cachedTemplates);
      } catch {}
    }

    function handleTaskSearchKeydown(event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitTaskSearch();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        resetTaskToolbar();
      }
    }

    function resetTaskToolbar() {
      taskPriorityFilter = '';
      taskSearchQuery = '';
      taskSuggestions = [];
      taskSearchSubmitted = false;
      taskToolbarNotice = '';
      if (taskSearchDebounceTimer) {
        clearTimeout(taskSearchDebounceTimer);
        taskSearchDebounceTimer = null;
      }
      requestDashboardRefresh('toolbar');
    }

    function applyTaskSuggestion(taskId) {
      var match = taskSuggestions.find(function(task) { return task.id === taskId; });
      if (!match) return;
      taskSearchQuery = match.title || '';
      taskSearchSubmitted = true;
      taskSuggestions = [];
      cachedTasks = [match];
      taskToolbarNotice = '';
      renderTasks(cachedTasks, cachedTemplates);
    }

    function renderAuth(auth) {
      const slot = document.getElementById('auth-slot');
      if (!auth || auth.status === 'authenticated') {
        slot.innerHTML = '';
        return;
      }
      let html = '<div class="auth-card">';
      if (auth.status === 'device_flow') {
        html += '<strong>Connect execuTerm to ExecuFunction</strong><br>';
        if (auth.message) html += esc(auth.message) + '<br>';
        if (auth.userCode) html += 'Code <span class="code">' + esc(auth.userCode) + '</span><br>';
        if (auth.verificationUriComplete || auth.verificationUri) {
          const url = auth.verificationUriComplete || auth.verificationUri;
          html += '<a href="' + esc(url) + '">Open verification page</a>';
        }
      } else {
        html += '<strong>Authentication issue</strong><br>' + esc(auth.message || 'Unknown error');
      }
      html += '</div>';
      slot.innerHTML = html;
    }

    // ---- Rendering ----

    function renderCalendar(events) {
      setSectionSignature('calendar', events || []);
      var slot = document.getElementById('calendar-slot');
      if (!events || events.length === 0) { slot.innerHTML = ''; return; }
      const seen = new Set();
      let html = '<div class="section-label">Schedule</div><div class="cal-strip">';
      for (const e of events) {
        const key = [formatTime(e.startTime), formatTime(e.endTime), e.title].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        html += '<div class="cal-row">'
          + '<span class="cal-row__time">' + esc(formatTime(e.startTime)) + (e.endTime ? ' - ' + esc(formatTime(e.endTime)) : '') + '</span>'
          + '<span class="cal-row__title">' + esc(e.title) + '</span>'
          + '</div>';
      }
      html += '</div>';
      slot.innerHTML = html;
    }

    function renderAgents(active, finished, tasks) {
      setSectionSignature('agents', { active: active || [], finished: finished || [] });
      let html = '';

      if (active.length > 0) {
        html += '<div class="section-label">Active Agents</div><div class="agent-grid">';
        for (const a of active) {
          const sc = STATE_CFG[a.state] || STATE_CFG.stopped;
          const ac = AGENT_COLORS[a.agentType] || '#666';
          const task = tasks.find(t => t.id === a.taskId);
          const taskLabel = task ? esc(task.title) : (a.taskId ? esc(a.taskId.slice(0,8)) : 'no task');
          const runCls = a.state === 'running' ? ' agent-card--running' : '';
          html += '<div class="agent-card'+runCls+'" style="--accent:'+ac+'" onclick="focusAgent(&#39;'+esc(a.workspaceId)+'&#39;)">'
            + '<div class="agent-card__stripe" style="background:'+ac+'"></div>'
            + '<div class="agent-card__body">'
            + '<div class="agent-card__header">'
            + '<span class="agent-card__name">'+esc(agentLabel(a.agentType))+'</span>'
            + '<span class="led '+(sc.pulse?'led--pulse':'')+'" style="--led:'+sc.color+';background:'+sc.color+'"></span>'
            + '<span class="agent-card__state" style="color:'+sc.color+'">'+esc(sc.label)+'</span>'
            + '</div>'
            + '<div class="agent-card__meta">'
            + '<span class="agent-card__task-title" title="'+(task?esc(task.title):'')+'">'+taskLabel+'</span>'
            + '<span class="dim">'+elapsed(a.lastStateChange)+'</span>'
            + '</div>'
            + '<button class="btn-secondary" onclick="event.stopPropagation();checkpointAgent(&#39;'+esc(a.workspaceId)+'&#39;)">Save</button>'
            + '<button class="btn-stop" onclick="event.stopPropagation();stopAgent(&#39;'+esc(a.workspaceId)+'&#39;)">Stop</button>'
            + '</div></div>';
        }
        html += '</div>';
      }

      if (active.length === 0 && finished.length === 0) {
        html += '<p class="empty">No agents running</p>';
      }

      if (finished.length > 0) {
        html += '<div class="section-label">History</div><div class="finished-list">';
        for (const a of finished.slice(0, 6)) {
          const sc = STATE_CFG[a.state] || STATE_CFG.stopped;
          html += '<span class="finished-tag"><span class="finished-tag__dot" style="background:'+sc.color+'"></span>'+esc(agentLabel(a.agentType))+' '+esc(sc.label.toLowerCase())+'</span>';
        }
        html += '</div>';
      }

      html += '<div style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);margin-top:8px;padding-left:2px;">right-click in agent sessions to add context</div>';
      document.getElementById('agents-slot').innerHTML = html;
    }

    function renderSavedSessions(savedSessions) {
      setSectionSignature('savedSessions', savedSessions || []);
      const slot = document.getElementById('saved-sessions-slot');
      if (!savedSessions || savedSessions.length === 0) {
        slot.innerHTML = '';
        return;
      }
      let html = '<div class="section-label">Saved Sessions</div>';
      html += '<div class="saved-session-list">';
      html += '<div class="saved-session__actions" style="justify-content:flex-end;margin-bottom:2px;"><button class="btn-secondary" onclick="restoreSavedSessions()">Restore All</button></div>';
      for (const session of savedSessions) {
        html += '<div class="saved-session-row">'
          + '<div>'
          + '<div class="saved-session__title">' + esc(session.title || agentLabel(session.agentType)) + '</div>'
          + '<div class="saved-session__meta">'
          + '<span>' + esc(agentLabel(session.agentType)) + '</span>'
          + (session.taskId ? '<span>task ' + esc(String(session.taskId).slice(0, 8)) + '</span>' : '')
          + '<span>saved ' + esc(elapsed(session.checkpointedAt)) + '</span>'
          + '</div>'
          + '</div>'
          + '<div class="saved-session__path"><strong>' + esc(baseName(session.cwd)) + '</strong> <span class="dim">' + esc(shortPath(session.cwd)) + '</span></div>'
          + '<div class="saved-session__actions"><button class="task-row__dispatch" onclick="restoreSavedSession(&#39;' + esc(session.id) + '&#39;)">restore</button></div>'
          + '</div>';
      }
      html += '</div>';
      slot.innerHTML = html;
    }

    function renderDirectories() {
      setSectionSignature('directories', cachedDirectories);
      let html = '<div class="section-label">Directories</div><div class="dir-card">';
      html += '<div class="dir-card__row">'
        + '<span class="dim">Current launch directory</span>'
        + '<span class="dir-card__path"><strong>'+esc(baseName(cachedDirectories.lastLaunchDirectory))+'</strong> <span class="dim">'+esc(shortPath(cachedDirectories.lastLaunchDirectory))+'</span></span>'
        + '<button class="btn-secondary" onclick="selectDirectory()">Choose Folder</button>'
        + '</div>';

      const mappings = cachedDirectories.projectDirectories || {};
      const mappingEntries = Object.keys(mappings);
      if (mappingEntries.length > 0) {
        html += '<div class="dir-map-list">';
        for (const projectId of mappingEntries) {
          const cwd = mappings[projectId];
          html += '<div class="dir-map-row">'
            + '<div><div class="dir-map-project">'+esc(getProjectName(projectId))+'</div><div class="dir-source">project mapping</div></div>'
            + '<div class="dir-card__path"><strong>'+esc(baseName(cwd))+'</strong> <span class="dim">'+esc(shortPath(cwd))+'</span></div>'
            + '<button class="btn-secondary" onclick="selectDirectory(&#39;'+esc(projectId)+'&#39;)">Change</button>'
            + '</div>';
        }
        html += '</div>';
      }

      const mappedValues = Object.values(mappings);
      const recentUnique = (cachedDirectories.recentDirectories || []).filter(function(cwd) {
        return cwd !== cachedDirectories.lastLaunchDirectory && mappedValues.indexOf(cwd) === -1;
      });
      if (recentUnique.length > 0) {
        html += '<div class="dir-chip-row">';
        for (const cwd of recentUnique) {
          html += '<button class="dir-chip" onclick="saveDirectory(null, &quot;'+esc(cwd)+'&quot;)">'+esc(shortPath(cwd))+'</button>';
        }
        html += '</div>';
      }

      html += '</div>';
      document.getElementById('directories-slot').innerHTML = html;
    }

    function renderLaunch(templates) {
      setSectionSignature('launch', (templates || []).filter(function(t) { return t.kind === 'agent'; }).map(function(t) { return { id: t.id, color: t.color, kind: t.kind, name: t.name }; }));
      const agents = templates.filter(t => t.kind === 'agent');
      const hasLaunchDirectory = !!cachedDirectories.lastLaunchDirectory;
      let html = '<div class="section-label">Launch</div><div class="launch-row">';
      for (const t of agents) {
        html += '<button class="launch-btn" style="--accent:'+(t.color||'#666')+'" onclick="createWorkspace(&#39;'+esc(t.id)+'&#39;)" '+(hasLaunchDirectory ? '' : 'disabled')+'>'
          + '<span class="launch-btn__dot"></span>'+esc(t.name)+'</button>';
      }
      html += '</div>';
      html += '<div class="mono" style="margin-top:8px;">'
        + (hasLaunchDirectory ? 'Launching in ' + esc(shortPath(cachedDirectories.lastLaunchDirectory)) + (cachedDirectories.lastAgentType ? ' · last agent ' + esc(agentLabel(cachedDirectories.lastAgentType)) : '') : 'Choose a launch directory first')
        + '</div>';
      document.getElementById('launch-slot').innerHTML = html;
    }

    function renderTaskExpansion(taskId) {
      const detail = taskDetailsCache[taskId];
      if (!detail) return '<div class="task-expand"><span class="dim">Loading...</span></div>';
      let html = '<div class="task-expand">';
      if (detail.agentBrief?.rationale) {
        html += '<div class="task-expand__field"><div class="task-expand__label">Rationale</div><div class="task-expand__value">' + esc(detail.agentBrief.rationale) + '</div></div>';
      }
      if (detail.agentBrief?.deliverable) {
        html += '<div class="task-expand__field"><div class="task-expand__label">Deliverable</div><div class="task-expand__value">' + esc(detail.agentBrief.deliverable) + '</div></div>';
      }
      if (detail.agentBrief?.verification) {
        html += '<div class="task-expand__field"><div class="task-expand__label">Verification</div><div class="task-expand__value">' + esc(detail.agentBrief.verification) + '</div></div>';
      }
      const criteria = detail.acceptanceCriteria || [];
      if (criteria.length > 0) {
        html += '<div class="task-expand__field"><div class="task-expand__label">Acceptance Criteria</div><ul class="task-expand__criteria">';
        for (const c of criteria) {
          const text = typeof c === 'string' ? c : (c.criterion || c.text || JSON.stringify(c));
          html += '<li>' + esc(text) + '</li>';
        }
        html += '</ul></div>';
      }
      if (!detail.agentBrief?.rationale && !detail.agentBrief?.deliverable && criteria.length === 0) {
        html += '<span class="dim">No additional details</span>';
      }
      html += '</div>';
      return html;
    }

    async function toggleTaskExpand(taskId) {
      if (expandedTasks.has(taskId)) {
        expandedTasks.delete(taskId);
        renderTasksUI();
        return;
      }
      expandedTasks.add(taskId);
      renderTasksUI();
      if (!taskDetailsCache[taskId]) {
        try {
          const r = await fetch('/api/tasks/' + encodeURIComponent(taskId)).then(r => r.json());
          if (r.task) taskDetailsCache[taskId] = r.task;
        } catch {}
        renderTasksUI();
      }
    }

    function renderTasks(tasks, templates) {
      setSectionSignature('tasks', {
        tasks: tasks || [],
        agentIds: (templates || []).filter(function(t) { return t.kind === 'agent'; }).map(function(t) { return t.id; }),
      });
      cachedTasksForRender = tasks;
      cachedTemplatesForRender = templates;
      renderTasksUI();
    }

    let cachedTasksForRender = [];
    let cachedTemplatesForRender = [];

    function renderTasksUI() {
      var slot = document.getElementById('tasks-slot');
      var activeElement = document.activeElement;
      var restoreFocusId = '';
      var restoreSelectionStart = null;
      var restoreSelectionEnd = null;
      if (activeElement && slot.contains(activeElement) && activeElement.id) {
        restoreFocusId = activeElement.id;
        if (
          typeof activeElement.selectionStart === 'number' &&
          typeof activeElement.selectionEnd === 'number'
        ) {
          restoreSelectionStart = activeElement.selectionStart;
          restoreSelectionEnd = activeElement.selectionEnd;
        }
      }
      const tasks = cachedTasksForRender;
      const templates = cachedTemplatesForRender;
      const agents = templates.filter(t => t.kind === 'agent');
      const filteredTasks = tasks.filter(function(task) {
        if (taskSearchQuery.trim()) return !isCompletedTask(task);
        if (taskPriorityFilter) return !isCompletedTask(task);
        return isDefaultActionableTask(task);
      });

      let html = '<div class="section-label">Tasks</div>';
      html += '<div class="task-toolbar">';
      html += '<div class="task-toolbar__top">';
      html += '<div class="task-toolbar__chips">';
      for (const option of TASK_PRIORITY_OPTIONS) {
        const active = option.value === taskPriorityFilter;
        html += '<button class="task-toolbar__chip' + (active ? ' task-toolbar__chip--active' : '') + '" onclick="setTaskPriorityFilter(&#39;' + esc(option.value) + '&#39;)">' + esc(option.label) + '</button>';
      }
      html += '</div>';
      html += '<div class="task-toolbar__search">';
      html += '<input type="text" id="task-search" placeholder="Search tasks..." value="' + esc(taskSearchQuery) + '" oninput="updateTaskSearchQuery(this.value)" onkeydown="handleTaskSearchKeydown(event)" />';
      html += '<button class="task-toolbar__clear" onclick="resetTaskToolbar()"' + (!taskPriorityFilter && !taskSearchQuery.trim() ? ' disabled' : '') + '>Clear</button>';
      html += '</div>';
      html += '<div class="task-toolbar__refresh">';
      html += '<span class="task-toolbar__refresh-label">Refresh ' + esc(effectiveDashboardRefreshLabel()) + '</span>';
      html += '<select id="dashboard-refresh-override" class="task-toolbar__refresh-select" onchange="updateDashboardRefreshOverride(this.value)">';
      for (const option of DASHBOARD_REFRESH_OPTIONS) {
        html += '<option value="' + esc(option.value) + '"' + (option.value === dashboardRefreshOverride ? ' selected' : '') + '>' + esc(option.label) + '</option>';
      }
      html += '</select>';
      html += '<button class="task-toolbar__refresh-btn" onclick="refreshDashboardNow()">Refresh now</button>';
      html += '</div>';
      html += '</div>';
      html += '<div class="task-toolbar__meta"><div class="task-toolbar__meta-left">';
      if (taskSearchQuery.trim()) {
        html += '<span>' + (taskSearchSubmitted ? 'Search results' : 'Suggestions') + ' for "' + esc(taskSearchQuery) + '"</span>';
      } else if (taskPriorityFilter) {
        html += '<span>Filtered by ' + esc(priorityLabel(taskPriorityFilter)) + '</span>';
      } else {
        html += '<span>Actionable tasks first</span>';
      }
      html += '<span>' + esc(String(filteredTasks.length)) + ' visible</span>';
      html += '</div></div>';
      html += '<div class="task-toolbar__refresh-status">' + esc(
        effectiveDashboardRefresh().refreshMode === 'manual'
          ? 'Manual mode: background polling is off'
          : ('Timed mode: polls every ' + effectiveDashboardRefreshLabel() + (document.visibilityState === 'hidden' ? ' (background clamped)' : ''))
      ) + '</div>';
      if (taskSuggestions.length > 0 && taskSearchQuery.trim() && !taskSearchSubmitted) {
        html += '<div class="task-toolbar__suggestions">';
        for (const suggestion of taskSuggestions) {
          const projectName = suggestion.projectId ? getProjectName(suggestion.projectId) : 'No project';
          html += '<button class="task-toolbar__suggestion" onclick="applyTaskSuggestion(&#39;' + esc(suggestion.id) + '&#39;)">'
            + '<span class="task-toolbar__suggestion-title">' + esc(suggestion.title || '') + '</span>'
            + '<span class="task-toolbar__suggestion-meta">'
            + (suggestion.priority ? '<span>' + esc(priorityLabel(suggestion.priority)) + '</span>' : '')
            + (suggestion.phase ? '<span>' + esc(String(suggestion.phase).replace(/_/g, ' ')) + '</span>' : '')
            + '<span>' + esc(projectName) + '</span>'
            + '</span>'
            + '</button>';
        }
        html += '</div>';
      }
      if (taskToolbarNotice) {
        html += '<div class="task-toolbar__notice">' + esc(taskToolbarNotice) + '</div>';
      }
      html += '</div>';

      if (filteredTasks.length > 0) {
        html += '<div class="task-list">';
        for (const t of filteredTasks) {
          const pc = PRIORITY_COLORS[t.priority] || '#52525b';
          const priLabel = t.priority ? t.priority.replace(/_/g, ' ') : '';
          const resolvedDirectory = getTaskDirectory(t);
          const directorySource = getTaskDirectorySource(t);
          const dispatchDisabled = !resolvedDirectory;
          const isExpanded = expandedTasks.has(t.id);
          html += '<div class="task-row" onclick="toggleTaskExpand(&#39;'+esc(t.id)+'&#39;)" style="'+(isExpanded ? 'border-radius:5px 5px 0 0;border-bottom-color:transparent;border-left:2px solid var(--brand-teal);' : '')+'">'
            + (priLabel ? '<span class="task-row__priority task-row__priority--chip" style="color:'+pc+';border:1px solid '+pc+'33">'+esc(priLabel)+'</span>' : '')
            + '<span class="task-row__title">'+esc(t.title || '')+'</span>'
            + '<span class="task-row__dir">'+esc(shortPath(resolvedDirectory))+'</span>'
            + '<span class="task-row__dir-source">'+esc(directorySourceLabel(directorySource))+'</span>'
            + (t.effort ? '<span class="task-row__meta">'+esc(t.effort)+'</span>' : '')
            + '<select class="task-row__agent-select" id="agent-'+esc(t.id)+'" onclick="event.stopPropagation()" onchange="event.stopPropagation();setTaskAgent(&#39;'+esc(t.id)+'&#39;, this.value)">'
            + agents.map(a => '<option value="'+esc(a.id)+'" '+(a.id === getSelectedTaskAgent(t) ? 'selected' : '')+'>'+esc(a.name)+'</option>').join('')
            + '</select>'
            + '<button class="btn-secondary" onclick="event.stopPropagation();selectDirectory(&#39;'+esc(t.projectId || '')+'&#39;)">'+(resolvedDirectory ? 'Change Folder' : 'Map Folder')+'</button>'
            + '<button class="task-row__dispatch" onclick="event.stopPropagation();dispatchTask(&#39;'+esc(t.id)+'&#39;,&#39;'+esc(t.id)+'&#39;)" '+(dispatchDisabled ? 'disabled' : '')+'>dispatch</button>'
            + '</div>';
          if (isExpanded) {
            html += renderTaskExpansion(t.id);
          }
        }
        html += '</div>';
      } else {
        html += '<p class="empty">' + esc(
          taskSearchQuery.trim()
            ? 'No tasks match this search'
            : (taskPriorityFilter ? 'No tasks match this filter' : 'No actionable tasks')
        ) + '</p>';
      }

      // Create task form
      if (showCreateForm) {
        html += '<div class="task-create">'
          // Title row
          + '<input type="text" id="new-task-title" placeholder="Task title..." autofocus value="'+esc(newTaskDraft.title || '')+'" oninput="updateTaskDraftField(&#39;title&#39;, this.value)" />'
          // Description
          + '<textarea id="new-task-desc" placeholder="Context or next steps..." rows="2" oninput="updateTaskDraftField(&#39;description&#39;, this.value)">'+esc(newTaskDraft.description || '')+'</textarea>'
          // Metadata row
          + '<div class="task-create__row">'
          + '<div class="task-create__field"><div class="task-create__label">Priority</div><select id="new-task-priority" onchange="updateTaskDraftField(&#39;priority&#39;, this.value)"><option value="do_now"'+(newTaskDraft.priority === 'do_now' ? ' selected' : '')+'>do now</option><option value="schedule"'+(newTaskDraft.priority === 'schedule' ? ' selected' : '')+'>schedule</option><option value="delegate"'+(newTaskDraft.priority === 'delegate' ? ' selected' : '')+'>delegate</option><option value="someday"'+(newTaskDraft.priority === 'someday' ? ' selected' : '')+'>someday</option></select></div>'
          + '<div class="task-create__field"><div class="task-create__label">When</div><select id="new-task-when" onchange="updateTaskDraftField(&#39;when&#39;, this.value)"><option value="today"'+(newTaskDraft.when === 'today' ? ' selected' : '')+'>Today</option><option value="soon"'+(newTaskDraft.when === 'soon' ? ' selected' : '')+'>Soon</option><option value="later"'+(newTaskDraft.when === 'later' ? ' selected' : '')+'>Later</option><option value="now"'+(newTaskDraft.when === 'now' ? ' selected' : '')+'>Now</option></select></div>'
          + '<div class="task-create__field"><div class="task-create__label">Effort</div><select id="new-task-effort" onchange="updateTaskDraftField(&#39;effort&#39;, this.value)"><option value="trivial"'+(newTaskDraft.effort === 'trivial' ? ' selected' : '')+'>trivial</option><option value="small"'+(newTaskDraft.effort === 'small' ? ' selected' : '')+'>small</option><option value="medium"'+(newTaskDraft.effort === 'medium' ? ' selected' : '')+'>medium</option><option value="large"'+(newTaskDraft.effort === 'large' ? ' selected' : '')+'>large</option><option value="epic"'+(newTaskDraft.effort === 'epic' ? ' selected' : '')+'>epic</option></select></div>'
          + '<div class="task-create__field"><div class="task-create__label">Phase</div><select id="new-task-phase" onchange="updateTaskDraftField(&#39;phase&#39;, this.value)"><option value="open"'+(newTaskDraft.phase === 'open' ? ' selected' : '')+'>open</option><option value="draft"'+(newTaskDraft.phase === 'draft' ? ' selected' : '')+'>draft</option><option value="in_flight"'+(newTaskDraft.phase === 'in_flight' ? ' selected' : '')+'>in flight</option></select></div>'
          + '<div class="task-create__field"><div class="task-create__label">Project</div><select id="new-task-project" onchange="updateTaskDraftField(&#39;projectId&#39;, this.value)"><option value="">No project</option>'
          + cachedProjects.map(function(p) { return '<option value="'+esc(p.id)+'"'+(newTaskDraft.projectId === p.id ? ' selected' : '')+'>'+esc(p.name)+'</option>'; }).join('')
          + '</select></div>'
          + '</div>'
          + (showTaskBriefFields
              ? '<div class="task-create__brief-section">'
                + '<div class="task-create__brief-header">Task Brief</div>'
                + '<div class="task-create__row--brief">'
                + '<div class="task-create__field"><div class="task-create__label">Why this matters</div><textarea id="new-task-rationale" placeholder="Why does this task exist now?" rows="2" oninput="updateTaskDraftField(&#39;rationale&#39;, this.value)">'+esc(newTaskDraft.rationale || '')+'</textarea></div>'
                + '<div class="task-create__field"><div class="task-create__label">Deliverable</div><textarea id="new-task-deliverable" placeholder="What artifact or state change when done?" rows="2" oninput="updateTaskDraftField(&#39;deliverable&#39;, this.value)">'+esc(newTaskDraft.deliverable || '')+'</textarea></div>'
                + '</div>'
                + '<div class="task-create__field" style="margin-top:6px"><div class="task-create__label">Verification</div><textarea id="new-task-verification" placeholder="How to verify completion..." rows="1" oninput="updateTaskDraftField(&#39;verification&#39;, this.value)">'+esc(newTaskDraft.verification || '')+'</textarea></div>'
                + '</div>'
              : '<button class="task-create__brief-toggle" onclick="showTaskBriefFields=true;renderTasksUI();">Add task brief details</button>')
          // Actions
          + '<div class="task-create__actions">'
          + '<button class="task-create__btn-cancel" onclick="showCreateForm=false;showTaskBriefFields=false;resetNewTaskDraft();renderTasksUI();">Cancel</button>'
          + '<button class="task-create__btn-create" onclick="submitNewTask()">Create Task</button>'
          + '</div>'
          + '</div>';
      } else {
        html += '<button class="task-create-toggle" onclick="showCreateForm=true;renderTasksUI();">+ New Task</button>';
      }

      slot.innerHTML = html;
      if (restoreFocusId) {
        var nextFocusElement = document.getElementById(restoreFocusId);
        if (nextFocusElement) {
          nextFocusElement.focus();
          if (
            typeof restoreSelectionStart === 'number' &&
            typeof restoreSelectionEnd === 'number' &&
            typeof nextFocusElement.setSelectionRange === 'function'
          ) {
            nextFocusElement.setSelectionRange(
              restoreSelectionStart,
              restoreSelectionEnd
            );
          }
        }
      }
    }

    function renderDevServers(devServers) {
      setSectionSignature('devServers', devServers || []);
      if (!devServers || devServers.length === 0) {
        document.getElementById('devservers-slot').innerHTML = '';
        return;
      }
      let html = '<div class="section-label">Dev Servers</div>';
      for (const d of devServers) {
        const ok = d.state === 'running';
        html += '<div class="dev-row"><span class="dev-dot" style="background:'+(ok?'#34C759':'#FF3B30')+'"></span><span>'+esc(d.title)+'</span><span class="dim">'+esc(d.state)+'</span></div>';
      }
      document.getElementById('devservers-slot').innerHTML = html;
    }

    function renderEvent(nextEvent) {
      setSectionSignature('event', nextEvent || '');
      document.getElementById('event-slot').innerHTML = nextEvent
        ? '<div class="header__event">'+esc(nextEvent)+'</div>' : '';
    }

    function renderNotifications(prefs) {
      setSectionSignature('notifications', prefs || {});
      const slot = document.getElementById('notifications-slot');
      let html = '<div class="section-label">Notifications</div>';
      html += '<div class="notif-row"><label><input type="checkbox" '+(prefs.onNeedsInput?'checked':'')+' onchange="updateNotif(&#39;onNeedsInput&#39;,this.checked)"> Needs Input</label></div>';
      html += '<div class="notif-row"><label><input type="checkbox" '+(prefs.onFinished?'checked':'')+' onchange="updateNotif(&#39;onFinished&#39;,this.checked)"> Finished</label></div>';
      html += '<div class="notif-row"><label><input type="checkbox" '+(prefs.onFailed?'checked':'')+' onchange="updateNotif(&#39;onFailed&#39;,this.checked)"> Failed</label></div>';
      slot.innerHTML = html;
    }

    async function loadDashboardSettings() {
      try {
        const response = await fetch('/api/dashboard/settings').then(function(r) { return r.json(); });
        dashboardRefreshSettings = {
          refreshMode: response.refreshMode === 'manual' ? 'manual' : 'timed',
          refreshIntervalMs: [5000, 10000, 30000, 60000].indexOf(Number(response.refreshIntervalMs)) >= 0
            ? Number(response.refreshIntervalMs)
            : DASHBOARD_REFRESH_DEFAULT.refreshIntervalMs,
        };
      } catch {
        dashboardRefreshSettings = { ...DASHBOARD_REFRESH_DEFAULT };
      }
    }

    function updateDashboardRefreshOverride(value) {
      writeDashboardRefreshOverride(value);
      renderTasks(cachedTasks, cachedTemplates);
      requestDashboardRefresh('override');
    }

    function refreshDashboardNow() {
      requestDashboardRefresh('manual-refresh');
    }

    // ---- Actions ----

    async function postJSON(url, data) {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      return r.json();
    }
    async function saveDirectory(projectId, cwd) {
      const payload = projectId ? { projectId, cwd } : { cwd };
      const r = await postJSON('/api/directories/select', payload);
      if (r.error) { alert(r.error); return; }
      cachedDirectories = r.directories || cachedDirectories;
      requestDashboardRefresh('mutation');
    }
    async function selectDirectory(projectId) {
      const payload = projectId ? { projectId } : {};
      const r = await postJSON('/api/directories/select', payload);
      if (!r.error) {
        cachedDirectories = r.directories || cachedDirectories;
        requestDashboardRefresh('mutation');
        return;
      }
      const existing = projectId && cachedDirectories.projectDirectories[projectId]
        ? cachedDirectories.projectDirectories[projectId]
        : (cachedDirectories.lastLaunchDirectory || '');
      const manual = window.prompt('Enter a working directory path', existing);
      if (!manual) return;
      await saveDirectory(projectId || null, manual);
    }
    async function createWorkspace(templateId) {
      const r = await postJSON('/api/workspace', { templateId });
      if (r.error) alert(r.error);
      else requestDashboardRefresh('mutation');
    }
    async function dispatchTask(taskId, selectSuffix) {
      const sel = document.getElementById('agent-' + selectSuffix);
      const agentType = (sel ? sel.value : null) || selectedTaskAgents[taskId] || 'codex';
      selectedTaskAgents[taskId] = agentType;
      const r = await postJSON('/api/dispatch', { taskId, agentType });
      if (r.error) alert(r.error);
      else requestDashboardRefresh('mutation');
    }
    async function stopAgent(workspaceId) {
      const r = await postJSON('/api/agent/stop', { workspaceId });
      if (r.error) alert(r.error);
      else requestDashboardRefresh('mutation');
    }
    async function checkpointAgent(workspaceId) {
      const r = await postJSON('/api/agent/checkpoint', { workspaceId });
      if (r.error) alert(r.error);
      else requestDashboardRefresh('mutation');
    }
    async function focusAgent(workspaceId) {
      await postJSON('/api/agent/focus', { workspaceId });
    }
    async function restoreSavedSession(sessionId) {
      const r = await postJSON('/api/resumable-sessions/restore', { sessionId });
      if (r.error) alert(r.error);
      else requestDashboardRefresh('mutation');
    }
    async function restoreSavedSessions() {
      const r = await postJSON('/api/resumable-sessions/restore', { restoreAll: true });
      if (r.error) alert(r.error);
      else requestDashboardRefresh('mutation');
    }
    async function submitNewTask() {
      const title = (newTaskDraft.title || '').trim();
      if (!title) return;
      if (isSubmittingTask) return;
      isSubmittingTask = true;
      try {
        const payload = {
          title: title,
          description: (newTaskDraft.description || '').trim(),
          priority: newTaskDraft.priority || 'do_now',
          when: newTaskDraft.when || 'soon',
          effort: newTaskDraft.effort || 'medium',
          phase: newTaskDraft.phase || 'open',
          projectId: newTaskDraft.projectId || '',
          rationale: (newTaskDraft.rationale || '').trim(),
          deliverable: (newTaskDraft.deliverable || '').trim(),
          verification: (newTaskDraft.verification || '').trim(),
        };
        const r = await postJSON('/api/tasks/create', payload);
        if (r.error) {
          alert(r.error);
          return;
        }
        if (r.task) {
          if (taskMatchesToolbar(r.task)) {
            cachedTasks = [r.task].concat((cachedTasks || []).filter(function(task) {
              return task.id !== r.task.id;
            }));
            taskToolbarNotice = '';
          } else if (taskPriorityFilter || taskSearchQuery.trim()) {
            taskToolbarNotice = 'Task created. Clear filters to view it.';
          } else {
            taskToolbarNotice = 'Task created.';
          }
        }
        showCreateForm = false;
        showTaskBriefFields = false;
        resetNewTaskDraft();
        renderTasks(cachedTasks, cachedTemplates);
        requestDashboardRefresh('mutation');
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to create task');
      }
      isSubmittingTask = false;
    }
    async function updateNotif(key, value) {
      const payload = {};
      payload[key] = value;
      await postJSON('/api/notifications', payload);
      requestDashboardRefresh('mutation');
    }

    // ---- Polling ----

    async function runDashboardPoll() {
      try {
        await loadTaskFeed();
        const [statusRes, calRes, notifRes, projRes] = await Promise.all([
          fetch('/api/status').then(r => r.json()),
          fetch('/api/calendar').then(r => r.json()),
          fetch('/api/notifications').then(r => r.json()),
          fetch('/api/projects').then(r => r.json()),
        ]);
        cachedTemplates = statusRes.templates || cachedTemplates;
        cachedDirectories = statusRes.directories || cachedDirectories;
        cachedNotifPrefs = notifRes || cachedNotifPrefs;
        cachedProjects = projRes.projects || cachedProjects;
        cachedSavedSessions = statusRes.savedSessions || cachedSavedSessions;

        if (shouldRenderSection('auth', statusRes.auth || null)) {
          renderAuth(statusRes.auth);
        }
        if (shouldRenderSection('event', statusRes.nextEvent || '')) {
          renderEvent(statusRes.nextEvent);
        }
        if (
          shouldRenderSection('agents', {
            active: statusRes.activeAgents || statusRes.agents || [],
            finished: statusRes.recentHistory || [],
          })
        ) {
          renderAgents(
            statusRes.activeAgents || statusRes.agents || [],
            statusRes.recentHistory || [],
            cachedTasks
          );
        }
        if (shouldRenderSection('savedSessions', cachedSavedSessions)) {
          renderSavedSessions(cachedSavedSessions);
        }
        if (
          (!showCreateForm || isSubmittingTask) &&
          shouldRenderSection('tasks', {
            tasks: cachedTasks,
            agentIds: (cachedTemplates || [])
              .filter(function(t) { return t.kind === 'agent'; })
              .map(function(t) { return t.id; }),
          })
        ) {
          renderTasks(cachedTasks, cachedTemplates);
        }
        if (shouldRenderSection('directories', cachedDirectories)) {
          renderDirectories();
        }
        if (
          shouldRenderSection(
            'launch',
            (cachedTemplates || [])
              .filter(function(t) { return t.kind === 'agent'; })
              .map(function(t) {
                return { id: t.id, color: t.color, kind: t.kind, name: t.name };
              })
          )
        ) {
          renderLaunch(cachedTemplates);
        }
        if (shouldRenderSection('calendar', calRes.events || [])) {
          renderCalendar(calRes.events || []);
        }
        if (shouldRenderSection('devServers', statusRes.devServers || [])) {
          renderDevServers(statusRes.devServers);
        }
        if (shouldRenderSection('notifications', cachedNotifPrefs)) {
          renderNotifications(cachedNotifPrefs);
        }
      } catch {
        /* silently retry next cycle */
      }
    }

    async function requestDashboardRefresh(reason) {
      if (dashboardPollInFlight) {
        if (reason !== 'timer') {
          dashboardPollQueued = true;
        }
        return;
      }

      clearDashboardPollTimer();
      dashboardPollInFlight = true;
      try {
        await runDashboardPoll();
      } finally {
        dashboardPollInFlight = false;
        if (dashboardPollQueued) {
          dashboardPollQueued = false;
          requestDashboardRefresh('queued');
          return;
        }
        scheduleDashboardPoll();
      }
    }

    document.addEventListener('visibilitychange', function() {
      if (effectiveDashboardRefresh().refreshMode !== 'timed') {
        return;
      }
      if (document.visibilityState === 'visible') {
        requestDashboardRefresh('visibility');
      } else {
        scheduleDashboardPoll();
      }
    });

    async function initializeDashboard() {
      await loadDashboardSettings();
      await requestDashboardRefresh('initial');
    }

    initializeDashboard();
  </script>
</body>
</html>`;
  }
}
