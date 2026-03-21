import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceManager } from './workspaceManager.js';
import type {
  DaemonState,
  SurfaceListResult,
  WorkspaceCreateResult,
} from '../types.js';

function makeWorkspaceCreateResult(workspaceId: string): WorkspaceCreateResult {
  return {
    window_id: 'window-1',
    window_ref: 'window:1',
    workspace_id: workspaceId,
    workspace_ref: 'workspace:1',
  };
}

function makeSurfaceListResult(
  workspaceId: string,
  surfaceId: string
): SurfaceListResult {
  return {
    window_id: 'window-1',
    window_ref: 'window:1',
    workspace_id: workspaceId,
    workspace_ref: 'workspace:1',
    surfaces: [
      {
        id: surfaceId,
        ref: `surface:${surfaceId}`,
        index: 0,
        type: 'terminal',
        title: 'Terminal',
        focused: true,
        pane_id: 'pane-1',
        pane_ref: 'pane:1',
        index_in_pane: 0,
        selected_in_pane: true,
      },
    ],
  };
}

describe('WorkspaceManager.createFromTemplate', () => {
  const originalConfigDir = process.env.EXF_CONFIG_DIR;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalConfigDir === undefined) {
      delete process.env.EXF_CONFIG_DIR;
    } else {
      process.env.EXF_CONFIG_DIR = originalConfigDir;
    }
  });

  it('creates a Claude workspace and injects the prompt after interactive startup', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'exf-workspace-manager-'));
    process.env.EXF_CONFIG_DIR = configDir;

    try {
      const state: DaemonState = {
        workspaces: {},
        savedSessions: {},
        hookServerPort: 0,
        lastSync: '2026-03-18T00:00:00.000Z',
      };
      const cmux = {
        workspaceCreate: jest.fn(async () => makeWorkspaceCreateResult('ws-1')),
        workspaceRename: jest.fn(async () => {}),
        surfaceList: jest.fn(async () => makeSurfaceListResult('ws-1', 'surface-1')),
        setStatus: jest.fn(async () => ''),
        surfaceSendText: jest.fn(async () => {}),
      };

      const manager = new WorkspaceManager(cmux as any, state);
      const createPromise = manager.createFromTemplate('claude-code', {
        cwd: '/Users/thomasmain',
        initialPrompt: '# Task: Smoke test',
      });
      await createPromise;

      expect(cmux.workspaceCreate).toHaveBeenCalledWith({
        working_directory: '/Users/thomasmain',
      });
      expect(cmux.surfaceSendText).toHaveBeenCalledWith(
        expect.stringMatching(/^EXECUTERM_MANAGED_AGENT=1 claude --session-id [0-9a-f-]{36}\n$/),
        'surface-1'
      );
      expect(state.workspaces['ws-1']?.resumeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(state.workspaces['ws-1']?.resumeCommand).toBe(
        `claude --resume ${state.workspaces['ws-1']?.resumeId}`
      );
      jest.advanceTimersByTime(1800);
      await Promise.resolve();
      expect(cmux.surfaceSendText).toHaveBeenCalledWith(
        '# Task: Smoke test\n',
        'surface-1'
      );
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('creates a Codex workspace with the prompt as a positional startup argument', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'exf-workspace-manager-'));
    process.env.EXF_CONFIG_DIR = configDir;

    try {
      const state: DaemonState = {
        workspaces: {},
        savedSessions: {},
        hookServerPort: 0,
        lastSync: '2026-03-18T00:00:00.000Z',
      };
      const cmux = {
        workspaceCreate: jest.fn(async () => makeWorkspaceCreateResult('ws-1')),
        workspaceRename: jest.fn(async () => {}),
        surfaceList: jest.fn(async () => makeSurfaceListResult('ws-1', 'surface-1')),
        setStatus: jest.fn(async () => ''),
        surfaceSendText: jest.fn(async () => {}),
      };

      const manager = new WorkspaceManager(cmux as any, state);
      await manager.createFromTemplate('codex', {
        cwd: '/Users/thomasmain/projects/execufunction',
        initialPrompt: '# Task: Smoke test',
      });

      expect(cmux.surfaceSendText).toHaveBeenCalledWith(
        expect.stringMatching(/^codex "\$\(cat .*exf-prompt-.*\.md\)"\n$/),
        'surface-1'
      );
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('starts dev-server templates by sending their command to the new surface', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'exf-workspace-manager-'));
    process.env.EXF_CONFIG_DIR = configDir;

    try {
      const state: DaemonState = {
        workspaces: {},
        savedSessions: {},
        hookServerPort: 0,
        lastSync: '2026-03-18T00:00:00.000Z',
      };
      const cmux = {
        workspaceCreate: jest.fn(async () => makeWorkspaceCreateResult('ws-1')),
        workspaceRename: jest.fn(async () => {}),
        surfaceList: jest.fn(async () => makeSurfaceListResult('ws-1', 'surface-1')),
        setStatus: jest.fn(async () => ''),
        surfaceSendText: jest.fn(async () => {}),
      };

      const manager = new WorkspaceManager(cmux as any, state);
      await manager.createFromTemplate('dev-backend', {
        cwd: '/Users/thomasmain/projects/execufunction',
      });

      expect(cmux.workspaceCreate).toHaveBeenCalledWith({
        working_directory: '/Users/thomasmain/projects/execufunction',
      });
      expect(cmux.surfaceSendText).toHaveBeenCalledWith(
        'npm run start:dev --workspace exf-app\n',
        'surface-1'
      );
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('persists attached context items on workspaces without duplicating source entries', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'exf-workspace-manager-'));
    process.env.EXF_CONFIG_DIR = configDir;

    try {
      const state: DaemonState = {
        workspaces: {
          'ws-1': {
            id: 'ws-1',
            title: 'Claude',
            cwd: '/Users/thomasmain/projects/execufunction',
            kind: 'agent',
            agentType: 'claude-code',
            state: 'running',
            lastActivity: '2026-03-18T00:00:00.000Z',
          },
        },
        savedSessions: {},
        hookServerPort: 0,
        lastSync: '2026-03-18T00:00:00.000Z',
      };
      const manager = new WorkspaceManager({} as any, state);

      manager.attachContextItem('ws-1', {
        id: 'mem-1',
        sourceType: 'memory',
        title: 'Architecture',
        excerpt: 'Use the persisted workspace state',
      });
      manager.attachContextItem('ws-1', {
        id: 'mem-1',
        sourceType: 'memory',
        title: 'Architecture',
        excerpt: 'Use the persisted workspace state',
      });

      expect(manager.getAttachedContextItems('ws-1')).toHaveLength(1);
      expect(state.workspaces['ws-1']?.attachedContextItems).toEqual([
        expect.objectContaining({
          id: 'mem-1',
          sourceType: 'memory',
          pinned: true,
        }),
      ]);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
