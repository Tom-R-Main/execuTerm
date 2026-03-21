import { AgentManager } from './agentManager.js';
import type { CmuxSurface, SurfaceListResult } from '../types.js';

function makeSurface(id: string): CmuxSurface {
  return {
    id,
    ref: `surface:${id}`,
    index: 0,
    type: 'terminal',
    title: 'Codex',
    focused: true,
    pane_id: 'pane-1',
    pane_ref: 'pane:1',
    index_in_pane: 0,
    selected_in_pane: true,
  };
}

function makeSurfaceListResult(surfaceId: string): SurfaceListResult {
  return {
    window_id: 'window-1',
    window_ref: 'window:1',
    workspace_id: 'ws-1',
    workspace_ref: 'workspace:1',
    surfaces: [makeSurface(surfaceId)],
  };
}

function makeSurfaceListResultWithTitle(
  workspaceId: string,
  surfaceId: string,
  title: string
): SurfaceListResult {
  return {
    window_id: 'window-1',
    window_ref: 'window:1',
    workspace_id: workspaceId,
    workspace_ref: 'workspace:1',
    surfaces: [
      {
        ...makeSurface(surfaceId),
        title,
      },
    ],
  };
}

function makeWorkspaceManager(overrides?: Record<string, unknown>) {
  return {
    getWorkspace: jest.fn(() => undefined),
    updateWorkspace: jest.fn(() => undefined),
    listSavedResumableSessions: jest.fn(() => []),
    getSavedResumableSession: jest.fn(() => undefined),
    saveResumableSession: jest.fn(() => {}),
    removeSavedResumableSession: jest.fn(() => {}),
    createFromTemplate: jest.fn(async () => 'restored-ws'),
    ...overrides,
  };
}

describe('AgentManager.stop', () => {
  it('sends ctrl-c to the agent surface and marks the session stopped', async () => {
    const cmux = {
      surfaceList: jest.fn(async () => makeSurfaceListResult('surface-1')),
      surfaceSendText: jest.fn(async () => {}),
      setStatus: jest.fn(async () => ''),
      notificationCreate: jest.fn(async () => {}),
    };
    const exfClient = {
      updateTask: jest.fn(async () => {}),
    };

    const manager = new AgentManager(
      cmux as any,
      exfClient as any,
      makeWorkspaceManager() as any
    );
    manager.register({
      workspaceId: 'ws-1',
      agentType: 'codex',
      state: 'running',
      startedAt: '2026-03-18T00:00:00.000Z',
      lastStateChange: '2026-03-18T00:00:00.000Z',
    });

    await manager.stop('ws-1');

    expect(cmux.surfaceList).toHaveBeenCalledWith('ws-1');
    expect(cmux.surfaceSendText).toHaveBeenCalledWith('\u0003', 'surface-1');
    expect(manager.getSession('ws-1')?.state).toBe('stopped');
  });

  it('reuses a known surface id without re-querying cmux', async () => {
    const cmux = {
      surfaceList: jest.fn(async () => makeSurfaceListResult('surface-1')),
      surfaceSendText: jest.fn(async () => {}),
      setStatus: jest.fn(async () => ''),
      notificationCreate: jest.fn(async () => {}),
    };
    const exfClient = {
      updateTask: jest.fn(async () => {}),
    };

    const manager = new AgentManager(
      cmux as any,
      exfClient as any,
      makeWorkspaceManager() as any
    );
    manager.register({
      workspaceId: 'ws-1',
      surfaceId: 'surface-known',
      agentType: 'codex',
      state: 'running',
      startedAt: '2026-03-18T00:00:00.000Z',
      lastStateChange: '2026-03-18T00:00:00.000Z',
    });

    await manager.stop('ws-1');

    expect(cmux.surfaceList).not.toHaveBeenCalled();
    expect(cmux.surfaceSendText).toHaveBeenCalledWith('\u0003', 'surface-known');
    expect(manager.getSession('ws-1')?.state).toBe('stopped');
  });
});

describe('AgentManager launch timeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('marks a session failed if it stays in starting past the timeout', async () => {
    const cmux = {
      setStatus: jest.fn(async () => ''),
      notificationCreate: jest.fn(async () => {}),
    };
    const exfClient = {
      updateTask: jest.fn(async () => {}),
    };

    const manager = new AgentManager(
      cmux as any,
      exfClient as any,
      makeWorkspaceManager() as any,
      50
    );
    manager.register({
      workspaceId: 'ws-1',
      agentType: 'claude-code',
      state: 'starting',
      startedAt: '2026-03-18T00:00:00.000Z',
      lastStateChange: '2026-03-18T00:00:00.000Z',
    });

    jest.advanceTimersByTime(50);
    await Promise.resolve();

    expect(manager.getSession('ws-1')?.state).toBe('failed');
    expect(manager.getSession('ws-1')?.error).toBe(
      'Agent did not become ready before the launch timeout elapsed'
    );
  });

  it('promotes non-Claude agents to running after a short startup grace', async () => {
    const cmux = {
      surfaceList: jest.fn(async () => makeSurfaceListResult('surface-2')),
      setStatus: jest.fn(async () => ''),
      notificationCreate: jest.fn(async () => {}),
    };
    const exfClient = {
      updateTask: jest.fn(async () => {}),
    };

    const manager = new AgentManager(
      cmux as any,
      exfClient as any,
      makeWorkspaceManager() as any,
      50
    );
    manager.register({
      workspaceId: 'ws-2',
      agentType: 'codex',
      state: 'starting',
      startedAt: '2026-03-18T00:00:00.000Z',
      lastStateChange: '2026-03-18T00:00:00.000Z',
    });

    await jest.advanceTimersByTimeAsync(1500);

    expect(manager.getSession('ws-2')?.state).toBe('running');
  });

  it('promotes Claude to running once the interactive surface title appears', async () => {
    const cmux = {
      surfaceList: jest.fn(async () =>
        makeSurfaceListResultWithTitle('ws-3', 'surface-3', '✳ Claude Code')
      ),
      setStatus: jest.fn(async () => ''),
      notificationCreate: jest.fn(async () => {}),
    };
    const exfClient = {
      updateTask: jest.fn(async () => {}),
    };

    const manager = new AgentManager(
      cmux as any,
      exfClient as any,
      makeWorkspaceManager() as any,
      5000
    );
    manager.register({
      workspaceId: 'ws-3',
      agentType: 'claude-code',
      state: 'starting',
      startedAt: '2026-03-18T00:00:00.000Z',
      lastStateChange: '2026-03-18T00:00:00.000Z',
    });

    jest.advanceTimersByTime(1000);
    await Promise.resolve();

    expect(manager.getSession('ws-3')?.state).toBe('running');
  });

  it('splits active and history sessions for dashboard rendering', () => {
    const cmux = {
      setStatus: jest.fn(async () => ''),
      notificationCreate: jest.fn(async () => {}),
    };
    const exfClient = {
      updateTask: jest.fn(async () => {}),
    };

    const manager = new AgentManager(
      cmux as any,
      exfClient as any,
      makeWorkspaceManager() as any,
      50
    );
    manager.register({
      workspaceId: 'ws-running',
      agentType: 'codex',
      state: 'running',
      startedAt: '2026-03-18T00:00:00.000Z',
      lastStateChange: '2026-03-18T00:00:00.000Z',
    });
    manager.register({
      workspaceId: 'ws-failed',
      agentType: 'claude-code',
      state: 'failed',
      startedAt: '2026-03-18T00:00:00.000Z',
      lastStateChange: '2026-03-18T00:00:00.000Z',
      error: 'launch failed',
    });
    manager.register({
      workspaceId: 'ws-review',
      agentType: 'codex',
      state: 'review_ready',
      startedAt: '2026-03-18T00:00:00.000Z',
      lastStateChange: '2026-03-18T00:00:00.000Z',
    });

    expect(manager.getActiveSessions().map((session) => session.workspaceId)).toEqual([
      'ws-running',
    ]);
    expect(manager.getHistorySessions().map((session) => session.workspaceId)).toEqual([
      'ws-failed',
      'ws-review',
    ]);
  });
});

describe('AgentManager resumable sessions', () => {
  it('hydrates a known Claude resume id from workspace state when registering', () => {
    const workspaceManager = makeWorkspaceManager({
      getWorkspace: jest.fn(() => ({
        id: 'ws-claude',
        kind: 'agent',
        resumeId: 'c7e90bfa-c682-4867-964e-c2f6532b228e',
        resumeCommand: 'claude --resume c7e90bfa-c682-4867-964e-c2f6532b228e',
        resumeCapability: 'claude',
      })),
    });
    const cmux = {
      setStatus: jest.fn(async () => ''),
      notificationCreate: jest.fn(async () => {}),
    };
    const exfClient = {
      updateTask: jest.fn(async () => {}),
    };

    const manager = new AgentManager(
      cmux as any,
      exfClient as any,
      workspaceManager as any,
      50
    );
    manager.register({
      workspaceId: 'ws-claude',
      agentType: 'claude-code',
      state: 'starting',
      startedAt: '2026-03-18T00:00:00.000Z',
      lastStateChange: '2026-03-18T00:00:00.000Z',
    });

    expect(manager.getSession('ws-claude')?.resumeId).toBe(
      'c7e90bfa-c682-4867-964e-c2f6532b228e'
    );
    expect(manager.getSession('ws-claude')?.resumeCommand).toBe(
      'claude --resume c7e90bfa-c682-4867-964e-c2f6532b228e'
    );
  });

  it('checkpoints a managed Claude session into saved resumable state', async () => {
    const workspaceManager = makeWorkspaceManager({
      getWorkspace: jest.fn(() => ({
        id: 'ws-claude',
        title: 'Claude Resume',
        cwd: '/Users/thomasmain/projects/execufunction',
        kind: 'agent',
        agentType: 'claude-code',
        taskId: 'task-1',
        projectId: 'project-1',
        surfaceId: 'surface-1',
        resumeId: 'c7e90bfa-c682-4867-964e-c2f6532b228e',
        resumeCommand: 'claude --resume c7e90bfa-c682-4867-964e-c2f6532b228e',
        resumeCapability: 'claude',
        state: 'running',
        attachedContextItems: [
          {
            id: 'mem-1',
            sourceType: 'memory',
            title: 'Architecture',
            excerpt: 'Persist session context in daemon state',
            attachedAt: '2026-03-18T00:00:00.000Z',
            pinned: true,
            estimatedChars: 38,
          },
        ],
      })),
    });
    const cmux = {
      surfaceSendText: jest.fn(async () => {}),
      setStatus: jest.fn(async () => ''),
      notificationCreate: jest.fn(async () => {}),
    };
    const exfClient = {
      updateTask: jest.fn(async () => {}),
    };

    const manager = new AgentManager(
      cmux as any,
      exfClient as any,
      workspaceManager as any,
      50
    );
    manager.register({
      workspaceId: 'ws-claude',
      surfaceId: 'surface-1',
      taskId: 'task-1',
      agentType: 'claude-code',
      state: 'running',
      startedAt: '2026-03-18T00:00:00.000Z',
      lastStateChange: '2026-03-18T00:00:00.000Z',
    });

    const saved = await manager.checkpointSession('ws-claude');

    expect(cmux.surfaceSendText).toHaveBeenCalledWith('\u0003', 'surface-1');
    expect(saved?.resumeId).toBe('c7e90bfa-c682-4867-964e-c2f6532b228e');
    expect((workspaceManager.saveResumableSession as jest.Mock).mock.calls[0][0]).toEqual(
      expect.objectContaining({
        resumeId: 'c7e90bfa-c682-4867-964e-c2f6532b228e',
        agentType: 'claude-code',
        attachedContextItems: [
          expect.objectContaining({
            id: 'mem-1',
            sourceType: 'memory',
          }),
        ],
      })
    );
  });

  it('does not create a restorable Codex session when no resume id can be parsed', async () => {
    const workspaceManager = makeWorkspaceManager({
      getWorkspace: jest.fn(() => ({
        id: 'ws-codex',
        title: 'Codex Resume',
        cwd: '/Users/thomasmain/projects/execufunction',
        kind: 'agent',
        agentType: 'codex',
        surfaceId: 'surface-2',
        resumeCapability: 'codex',
        state: 'running',
      })),
    });
    const cmux = {
      surfaceSendText: jest.fn(async () => {}),
      surfaceReadText: jest.fn(async () => 'no resume command here'),
      setStatus: jest.fn(async () => ''),
      notificationCreate: jest.fn(async () => {}),
    };
    const exfClient = {
      updateTask: jest.fn(async () => {}),
    };

    const manager = new AgentManager(
      cmux as any,
      exfClient as any,
      workspaceManager as any,
      50
    );
    manager.register({
      workspaceId: 'ws-codex',
      surfaceId: 'surface-2',
      agentType: 'codex',
      state: 'running',
      startedAt: '2026-03-18T00:00:00.000Z',
      lastStateChange: '2026-03-18T00:00:00.000Z',
    });

    const saved = await manager.checkpointSession('ws-codex');

    expect(saved).toBeNull();
    expect(workspaceManager.saveResumableSession).not.toHaveBeenCalled();
  });

  it('restores a saved resumable session into a fresh workspace', async () => {
    const workspaceManager = makeWorkspaceManager({
      getSavedResumableSession: jest.fn(() => ({
        id: 'saved-1',
        workspaceId: 'old-ws',
        title: 'Restore me',
        cwd: '/Users/thomasmain/projects/execufunction',
        agentType: 'claude-code',
        taskId: 'task-1',
        projectId: 'project-1',
        resumeId: 'c7e90bfa-c682-4867-964e-c2f6532b228e',
        resumeCommand: 'claude --resume c7e90bfa-c682-4867-964e-c2f6532b228e',
        resumeCapability: 'claude',
        checkpointStatus: 'saved',
        checkpointedAt: '2026-03-18T00:00:00.000Z',
        attachedContextItems: [
          {
            id: 'note-1',
            sourceType: 'note',
            title: 'Deploy note',
            excerpt: 'Watch the deployment before promoting.',
            attachedAt: '2026-03-18T00:00:00.000Z',
            pinned: true,
            estimatedChars: 35,
          },
        ],
      })),
    });
    const cmux = {
      setStatus: jest.fn(async () => ''),
      notificationCreate: jest.fn(async () => {}),
    };
    const exfClient = {
      updateTask: jest.fn(async () => {}),
    };

    const manager = new AgentManager(
      cmux as any,
      exfClient as any,
      workspaceManager as any,
      50
    );
    const workspaceId = await manager.restoreSavedSession('saved-1');

    expect(workspaceId).toBe('restored-ws');
    expect(workspaceManager.createFromTemplate).toHaveBeenCalledWith(
      'claude-code',
      expect.objectContaining({
        startupCommandOverride:
          'EXECUTERM_MANAGED_AGENT=1 claude --resume c7e90bfa-c682-4867-964e-c2f6532b228e',
        attachedContextItems: [
          expect.objectContaining({
            id: 'note-1',
            sourceType: 'note',
          }),
        ],
      })
    );
    expect(workspaceManager.removeSavedResumableSession).toHaveBeenCalledWith(
      'saved-1'
    );
  });
});
