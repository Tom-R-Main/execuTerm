import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DashboardServer } from './dashboardServer.js';
import { DirectoryRequiredError } from './directoryManager.js';
import { readDaemonConfig } from '../config.js';
import type { DaemonAuthState } from '../types.js';

function makeRequest(body: object, url = '/api/agent/stop') {
  const payload = JSON.stringify(body);
  return {
    method: 'POST',
    url,
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  } as any;
}

function makeGetRequest(url = '/api/tasks') {
  return {
    method: 'GET',
    url,
    async *[Symbol.asyncIterator]() {},
  } as any;
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(statusCode: number, headers?: Record<string, string>) {
      this.statusCode = statusCode;
      this.headers = headers || {};
      return this;
    },
    end(chunk?: string) {
      this.body = chunk || '';
      return this;
    },
  };
}

describe('DashboardServer agent stop API', () => {
  const authState: DaemonAuthState = { status: 'authenticated' };
  const directoryManager = {
    getState: jest.fn(() => ({
      projectDirectories: {},
      recentDirectories: [],
      lastLaunchDirectory: null,
      projectAgentPreferences: {},
    })),
    resolveTaskDirectory: jest.fn(() => '/Users/thomasmain/projects/execufunction'),
    describeTaskDirectory: jest.fn(() => ({
      cwd: '/Users/thomasmain/projects/execufunction',
      source: 'global',
    })),
    resolvePreferredAgent: jest.fn(() => 'codex'),
  };
  const mockCmux = {
    workspaceSelect: jest.fn(async () => {}),
  };

  it('stops an existing agent session via AgentManager.stop', async () => {
    const agentManager = {
      getSession: jest.fn(() => ({ workspaceId: 'ws-1' })),
      stop: jest.fn(async () => {}),
    };
    const workspaceManager = {} as any;
    const server = new DashboardServer(
      () => agentManager as any,
      directoryManager as any,
      workspaceManager,
      () => null,
      () => authState,
      () => null,
      () => mockCmux as any
    );
    const response = makeResponse();

    await (server as any).handleRequest(makeRequest({ workspaceId: 'ws-1' }), response);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    expect(agentManager.stop).toHaveBeenCalledWith('ws-1');
  });

  it('returns 404 when the requested session is unknown', async () => {
    const agentManager = {
      getSession: jest.fn(() => undefined),
      stop: jest.fn(async () => {}),
    };
    const workspaceManager = {} as any;
    const server = new DashboardServer(
      () => agentManager as any,
      directoryManager as any,
      workspaceManager,
      () => null,
      () => authState,
      () => null,
      () => mockCmux as any
    );
    const response = makeResponse();

    await (server as any).handleRequest(
      makeRequest({ workspaceId: 'missing-ws' }),
      response
    );

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Session not found',
    });
    expect(agentManager.stop).not.toHaveBeenCalled();
  });

  it('returns a structured directory error when dispatch has no configured cwd', async () => {
    const workspaceManager = {} as any;
    const dispatcher = {
      dispatch: jest.fn(async () => {
        throw new DirectoryRequiredError('project-1');
      }),
    };
    const server = new DashboardServer(
      () => null,
      directoryManager as any,
      workspaceManager,
      () => null,
      () => authState,
      () => dispatcher as any,
      () => mockCmux as any
    );
    const response = makeResponse();

    await (server as any).handleRequest(
      makeRequest(
        { taskId: 'task-1', agentType: 'codex' },
        '/api/dispatch'
      ),
      response
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'No working directory configured for project project-1',
      code: 'directory_required',
      projectId: 'project-1',
    });
  });

  it('focuses an agent workspace via cmux.workspaceSelect', async () => {
    const cmux = { workspaceSelect: jest.fn(async () => {}) };
    const workspaceManager = {} as any;
    const server = new DashboardServer(
      () => null,
      directoryManager as any,
      workspaceManager,
      () => null,
      () => authState,
      () => null,
      () => cmux as any
    );
    const response = makeResponse();

    await (server as any).handleRequest(
      makeRequest({ workspaceId: 'ws-focus' }, '/api/agent/focus'),
      response
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    expect(cmux.workspaceSelect).toHaveBeenCalledWith('ws-focus');
  });
});

describe('DashboardServer task creation API', () => {
  const authState: DaemonAuthState = { status: 'authenticated' };
  const directoryManager = {
    getState: jest.fn(() => ({
      projectDirectories: {},
      recentDirectories: [],
      lastLaunchDirectory: null,
      projectAgentPreferences: {},
    })),
    describeTaskDirectory: jest.fn(() => ({
      cwd: '/Users/thomasmain/projects/execufunction',
      source: 'global',
    })),
    resolvePreferredAgent: jest.fn(() => 'codex'),
  };

  it('defaults dashboard-created tasks to do_now priority when omitted', async () => {
    const exfClient = {
      createTask: jest.fn(async (payload) => ({ data: { task: { id: 'task-1', ...payload } } })),
    };
    const workspaceManager = {} as any;
    const server = new DashboardServer(
      () => null,
      directoryManager as any,
      workspaceManager,
      () => exfClient as any,
      () => authState,
      () => null,
      () => ({ workspaceSelect: jest.fn(async () => {}) } as any)
    );
    const response = makeResponse();

    await (server as any).handleRequest(
      makeRequest(
        {
          title: 'Dashboard create task',
          description: 'repro',
          when: 'soon',
          effort: 'medium',
          phase: 'open',
        },
        '/api/tasks/create'
      ),
      response
    );

    expect(response.statusCode).toBe(200);
    expect(exfClient.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Dashboard create task',
        priority: 'do_now',
      })
    );
  });

  it('surfaces upstream task creation errors instead of returning a fake success', async () => {
    const exfClient = {
      createTask: jest.fn(async () => ({ statusCode: 400, data: { error: 'Invalid priority' } })),
    };
    const workspaceManager = {} as any;
    const server = new DashboardServer(
      () => null,
      directoryManager as any,
      workspaceManager,
      () => exfClient as any,
      () => authState,
      () => null,
      () => ({ workspaceSelect: jest.fn(async () => {}) } as any)
    );
    const response = makeResponse();

    await (server as any).handleRequest(
      makeRequest(
        {
          title: 'Broken Dashboard create task',
          priority: 'bad-value',
        },
        '/api/tasks/create'
      ),
      response
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Invalid priority',
    });
  });

  it('filters /api/tasks by priority when requested', async () => {
    const exfClient = {
      listTasks: jest.fn(async () => ({
        data: {
          tasks: [
            {
              id: 'task-do-now',
              title: 'Important task',
              priority: 'do_now',
              effort: 'medium',
              phase: 'open',
              status: 'inbox',
            },
          ],
        },
      })),
    };
    const workspaceManager = {} as any;
    const server = new DashboardServer(
      () => null,
      directoryManager as any,
      workspaceManager,
      () => exfClient as any,
      () => authState,
      () => null,
      () => ({ workspaceSelect: jest.fn(async () => {}) } as any)
    );
    const response = makeResponse();

    await (server as any).handleRequest(
      makeGetRequest('/api/tasks?priority=do_now'),
      response
    );

    expect(response.statusCode).toBe(200);
    expect(exfClient.listTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 100,
        priority: 'do_now',
      })
    );
    expect(JSON.parse(response.body)).toEqual({
      tasks: [
        expect.objectContaining({
          id: 'task-do-now',
          priority: 'do_now',
          preferredAgent: 'codex',
        }),
      ],
    });
  });

  it('uses /api/search/tasks to return ranked title matches', async () => {
    const exfClient = {
      listTasks: jest.fn(async () => ({
        data: {
          tasks: [
            { id: '2', title: 'Alpha hunter cleanup', priority: 'schedule', phase: 'open', status: 'inbox' },
            { id: '1', title: 'Hunter alpha migration', priority: 'do_now', phase: 'open', status: 'inbox' },
            { id: '3', title: 'Unrelated', priority: 'delegate', phase: 'open', status: 'inbox' },
          ],
        },
      })),
    };
    const workspaceManager = {} as any;
    const server = new DashboardServer(
      () => null,
      directoryManager as any,
      workspaceManager,
      () => exfClient as any,
      () => authState,
      () => null,
      () => ({ workspaceSelect: jest.fn(async () => {}) } as any)
    );
    const response = makeResponse();

    await (server as any).handleRequest(
      makeGetRequest('/api/search/tasks?q=hunter%20alpha&limit=5'),
      response
    );

    expect(response.statusCode).toBe(200);
    expect(exfClient.listTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 50,
      })
    );
    expect(JSON.parse(response.body)).toEqual({
      tasks: [
        expect.objectContaining({ id: '1', title: 'Hunter alpha migration' }),
        expect.objectContaining({ id: '2', title: 'Alpha hunter cleanup' }),
      ],
    });
  });
});

describe('DashboardServer dashboard settings API', () => {
  const authState: DaemonAuthState = { status: 'authenticated' };
  const originalConfigDir = process.env.EXF_CONFIG_DIR;
  let sandboxDir = '';
  const directoryManager = {
    getState: jest.fn(() => ({
      projectDirectories: {},
      recentDirectories: [],
      lastLaunchDirectory: null,
      projectAgentPreferences: {},
    })),
    describeTaskDirectory: jest.fn(() => ({
      cwd: '/Users/thomasmain/projects/execufunction',
      source: 'global',
    })),
    resolvePreferredAgent: jest.fn(() => 'codex'),
  };

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), 'executerm-dashboard-server-'));
    process.env.EXF_CONFIG_DIR = sandboxDir;
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) {
      delete process.env.EXF_CONFIG_DIR;
    } else {
      process.env.EXF_CONFIG_DIR = originalConfigDir;
    }
  });

  it('returns the persisted dashboard refresh settings', async () => {
    const workspaceManager = {} as any;
    const server = new DashboardServer(
      () => null,
      directoryManager as any,
      workspaceManager,
      () => null,
      () => authState,
      () => null,
      () => ({ workspaceSelect: jest.fn(async () => {}) } as any)
    );
    const response = makeResponse();

    await (server as any).handleRequest(
      makeGetRequest('/api/dashboard/settings'),
      response
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      refreshMode: expect.any(String),
      refreshIntervalMs: expect.any(Number),
    });
  });

  it('updates only dashboard refresh settings via POST', async () => {
    const workspaceManager = {} as any;
    const server = new DashboardServer(
      () => null,
      directoryManager as any,
      workspaceManager,
      () => null,
      () => authState,
      () => null,
      () => ({ workspaceSelect: jest.fn(async () => {}) } as any)
    );
    const response = makeResponse();

    await (server as any).handleRequest(
      makeRequest(
        {
          refreshMode: 'manual',
          refreshIntervalMs: 60000,
        },
        '/api/dashboard/settings'
      ),
      response
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      ok: true,
      settings: {
        refreshMode: 'manual',
        refreshIntervalMs: 60000,
      },
    });

    const persisted = readDaemonConfig();
    expect(persisted.dashboardRefreshMode).toBe('manual');
    expect(persisted.dashboardRefreshIntervalMs).toBe(60000);
    expect(persisted.pollIntervalMs).toBe(10000);
  });
});

describe('DashboardServer context APIs', () => {
  const authState: DaemonAuthState = { status: 'authenticated' };
  const directoryManager = {
    getState: jest.fn(() => ({
      projectDirectories: {},
      recentDirectories: [],
      lastLaunchDirectory: null,
      projectAgentPreferences: {},
    })),
    describeTaskDirectory: jest.fn(() => ({
      cwd: '/Users/thomasmain/projects/execufunction',
      source: 'global',
    })),
    resolvePreferredAgent: jest.fn(() => 'codex'),
  };

  function makeContextWorkspaceManager() {
    const items: Record<string, any[]> = { 'ws-1': [] };
    return {
      getWorkspace: jest.fn((workspaceId: string) =>
        workspaceId === 'ws-1'
          ? {
              id: 'ws-1',
              title: 'Claude Context',
              cwd: '/Users/thomasmain/projects/execufunction',
              kind: 'agent',
              taskId: 'task-1',
              state: 'running',
            }
          : undefined
      ),
      getAttachedContextItems: jest.fn((workspaceId: string) => items[workspaceId] || []),
      attachContextItem: jest.fn((workspaceId: string, item: any) => {
        const existing = items[workspaceId] || [];
        if (!existing.some((candidate) => candidate.id === item.id && candidate.sourceType === item.sourceType)) {
          existing.push({
            ...item,
            attachedAt: item.attachedAt || '2026-03-18T00:00:00.000Z',
            pinned: item.pinned !== false,
            estimatedChars:
              typeof item.estimatedChars === 'number'
                ? item.estimatedChars
                : String(item.excerpt || '').length,
          });
        }
        items[workspaceId] = existing;
        return existing;
      }),
      detachContextItem: jest.fn((workspaceId: string, itemId: string, sourceType: string) => {
        items[workspaceId] = (items[workspaceId] || []).filter(
          (item) => !(item.id === itemId && item.sourceType === sourceType)
        );
        return items[workspaceId];
      }),
      listTemplates: jest.fn(() => []),
      getDevServerWorkspaces: jest.fn(() => []),
    };
  }

  it('uses the same persisted formatter for preview and send', async () => {
    const workspaceManager = makeContextWorkspaceManager();
    const exfClient = {
      getTask: jest.fn(async () => ({
        data: {
          task: {
            id: 'task-1',
            title: 'Deploy update',
            rationale: 'Need context during deploy verification',
            deliverable: 'Healthy deploy',
            verification: 'Check Cloud Run after rollout',
          },
        },
      })),
    };
    const cmux = {
      surfaceSendText: jest.fn(async () => {}),
      workspaceSelect: jest.fn(async () => {}),
    };
    const agentManager = {
      getSession: jest.fn(() => ({ workspaceId: 'ws-1', surfaceId: 'surface-1' })),
    };
    const server = new DashboardServer(
      () => agentManager as any,
      directoryManager as any,
      workspaceManager as any,
      () => exfClient as any,
      () => authState,
      () => null,
      () => cmux as any
    );

    const attachResponse = makeResponse();
    await (server as any).handleRequest(
      makeRequest(
        {
          workspaceId: 'ws-1',
          item: {
            id: 'mem-1',
            sourceType: 'memory',
            title: 'Deployment gotcha',
            excerpt: 'Frontend and backend may finish at different times.',
          },
        },
        '/api/context/attach'
      ),
      attachResponse
    );

    expect(attachResponse.statusCode).toBe(200);

    const previewResponse = makeResponse();
    await (server as any).handleRequest(
      makeGetRequest('/api/context/ws-1/preview'),
      previewResponse
    );

    const preview = JSON.parse(previewResponse.body);
    expect(preview.renderedText).toContain('## Session Context');
    expect(preview.renderedText).toContain('### Task');
    expect(preview.renderedText).toContain('### Relevant Code Memories');

    const sendResponse = makeResponse();
    await (server as any).handleRequest(
      makeRequest({ workspaceId: 'ws-1' }, '/api/context/send'),
      sendResponse
    );

    expect(sendResponse.statusCode).toBe(200);
    expect(cmux.surfaceSendText).toHaveBeenCalledWith(
      preview.renderedText + '\n',
      'surface-1'
    );
    expect(JSON.parse(sendResponse.body)).toEqual(
      expect.objectContaining({
        ok: true,
        charsSent: preview.renderedText.length,
      })
    );
  });

  it('ranks code memories ahead of similarly matching notes in context search', async () => {
    const workspaceManager = makeContextWorkspaceManager();
    const exfClient = {
      searchNotes: jest.fn(async () => ({
        data: {
          notes: [
            {
              id: 'note-1',
              title: 'Release checklist',
              content: 'Deploy verification checklist',
            },
          ],
        },
      })),
      searchCodeMemories: jest.fn(async () => ({
        data: {
          memories: [
            {
              id: 'mem-1',
              factType: 'gotcha',
              content: 'Deploy verification requires checking both services',
              filePath: '/Users/thomasmain/projects/execufunction/exf-app/src/server.ts',
              confidence: 0.9,
            },
          ],
        },
      })),
      listTasks: jest.fn(async () => ({
        data: {
          tasks: [
            {
              id: 'task-1',
              title: 'Deploy update',
              rationale: 'verify rollout',
            },
          ],
        },
      })),
    };
    const server = new DashboardServer(
      () => null,
      directoryManager as any,
      workspaceManager as any,
      () => exfClient as any,
      () => authState,
      () => null,
      () => ({ workspaceSelect: jest.fn(async () => {}) } as any)
    );
    const response = makeResponse();

    await (server as any).handleRequest(
      makeGetRequest('/api/context/search?q=deploy'),
      response
    );

    expect(response.statusCode).toBe(200);
    const results = JSON.parse(response.body).results;
    const memoryIndex = results.findIndex((item: any) => item.sourceType === 'memory');
    const noteIndex = results.findIndex((item: any) => item.sourceType === 'note');
    expect(memoryIndex).toBeGreaterThanOrEqual(0);
    expect(noteIndex).toBeGreaterThanOrEqual(0);
    expect(memoryIndex).toBeLessThan(noteIndex);
  });
});
