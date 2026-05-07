import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentManager } from './agentManager.js';
import { TaskDispatcher } from './taskDispatcher.js';
import { WorkspaceManager } from './workspaceManager.js';
import type { DaemonState } from '../types.js';

function makeSurfaceListResult(workspaceId: string, surfaceId: string) {
  return {
    window_id: 'window-1',
    window_ref: 'window:1',
    workspace_id: workspaceId,
    workspace_ref: `workspace:${workspaceId}`,
    surfaces: [
      {
        id: surfaceId,
        ref: `surface:${surfaceId}`,
        index: 0,
        type: 'terminal',
        title: 'Codex',
        focused: true,
        pane_id: 'pane-1',
        pane_ref: 'pane:1',
        index_in_pane: 0,
        selected_in_pane: true,
      },
    ],
  };
}

describe('execuTerm task-to-work-item e2e flow', () => {
  const originalConfigDir = process.env.EXF_CONFIG_DIR;
  let configDir = '';

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'executerm-e2e-'));
    process.env.EXF_CONFIG_DIR = configDir;
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'terminal.json'), JSON.stringify({}));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) {
      delete process.env.EXF_CONFIG_DIR;
    } else {
      process.env.EXF_CONFIG_DIR = originalConfigDir;
    }
  });

  it('dispatches a human task as Codex work, then promotes the work item to review', async () => {
    const state: DaemonState = {
      workspaces: {},
      savedSessions: {},
      hookServerPort: 0,
      lastSync: '2026-05-07T00:00:00.000Z',
    };
    const cmux = {
      workspaceCreate: jest.fn(async () => ({ workspace_id: 'ws-codex' })),
      workspaceRename: jest.fn(async () => {}),
      surfaceList: jest.fn(async () => makeSurfaceListResult('ws-codex', 'surface-codex')),
      setStatus: jest.fn(async () => ''),
      surfaceSendText: jest.fn(async () => {}),
      notificationCreate: jest.fn(async () => {}),
    };
    const exfClient = {
      getTask: jest.fn(async () => ({
        data: {
          task: {
            id: 'task-demo',
            title: 'Add demo booking system',
            description: 'Implement the product-owned booking loop',
            projectId: 'project-1',
            verification: 'npm test -- --runInBand',
          },
        },
      })),
      getProjectContext: jest.fn(async () => ({ data: { project: { id: 'project-1' } } })),
      searchCodeMemories: jest.fn(async () => ({ data: { memories: [] } })),
      updateTask: jest.fn(async () => ({ data: {} })),
      createWorkItem: jest.fn(async () => ({
        data: {
          workItem: {
            id: 'work-demo',
            taskId: 'task-demo',
            projectId: 'project-1',
            title: 'Add demo booking system',
            status: 'queued',
            assignedAlias: 'codex',
          },
        },
      })),
      claimWorkItem: jest.fn(async () => ({
        data: {
          workItem: {
            id: 'work-demo',
            taskId: 'task-demo',
            projectId: 'project-1',
            title: 'Add demo booking system',
            status: 'claimed',
            assignedAlias: 'codex',
            claimToken: 'claim-token-demo',
          },
        },
      })),
      startWorkItem: jest.fn(async () => ({
        data: {
          workItem: {
            id: 'work-demo',
            taskId: 'task-demo',
            projectId: 'project-1',
            title: 'Add demo booking system',
            status: 'running',
            assignedAlias: 'codex',
            claimToken: 'claim-token-demo',
          },
        },
      })),
      heartbeatWorkItem: jest.fn(async () => ({ data: {} })),
      markWorkItemNeedsReview: jest.fn(async () => ({ data: {} })),
      failWorkItem: jest.fn(async () => ({ data: {} })),
      releaseWorkItem: jest.fn(async () => ({ data: {} })),
    };
    const directoryManager = {
      resolveTaskDirectory: jest.fn(() => '/Users/thomasmain/projects/execufunction'),
      rememberAgentPreference: jest.fn(),
    };
    const gitArtifactService = {
      collectChangedFiles: jest.fn(async () => [
        {
          type: 'changed_files',
          files: [{ path: 'apps/execuTerm/daemon/src/index.ts', status: 'M' }],
        },
      ]),
    };

    const workspaceManager = new WorkspaceManager(cmux as any, state);
    const agentManager = new AgentManager(
      cmux as any,
      exfClient as any,
      workspaceManager,
      20000,
      gitArtifactService as any
    );
    const dispatcher = new TaskDispatcher(
      exfClient as any,
      directoryManager as any,
      workspaceManager,
      agentManager
    );

    const workspaceId = await dispatcher.dispatch('task-demo', 'codex');
    await agentManager.transition(workspaceId, 'running');
    workspaceManager.updateWorkspace(workspaceId, {
      sourceControl: {
        mode: 'git-worktree',
        repoRoot: '/repo/main',
        worktreePath: '/repo/worktree',
        baseRevision: 'abc123',
        branchName: 'exf/agent/work-demo/ws-codex',
      },
    });
    const needsReviewReceipt = agentManager.waitForReceipt(
      'work_item.needs_review_synced',
      (receipt) => receipt.workItemId === 'work-demo',
      1000
    );
    await agentManager.transition(workspaceId, 'review_ready');

    expect(workspaceId).toBe('ws-codex');
    expect(exfClient.createWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-demo',
        assignedAlias: 'codex',
        verificationCommands: ['npm test -- --runInBand'],
      })
    );
    expect(exfClient.updateTask).not.toHaveBeenCalled();
    expect(cmux.surfaceSendText).toHaveBeenCalledWith(
      expect.stringMatching(/^codex "\$\(cat .*exf-prompt-.*\.md\)"\n$/),
      'surface-codex'
    );
    expect(exfClient.heartbeatWorkItem).toHaveBeenCalledWith(
      'work-demo',
      expect.objectContaining({
        claimOwner: 'executerm:codex',
        claimToken: 'claim-token-demo',
      })
    );
    expect(exfClient.markWorkItemNeedsReview).toHaveBeenCalledWith(
      'work-demo',
      expect.objectContaining({
        claimOwner: 'executerm:codex',
        claimToken: 'claim-token-demo',
        artifactRefs: expect.arrayContaining([
          { type: 'branch', name: 'exf/agent/work-demo/ws-codex' },
          { type: 'worktree', path: '/repo/worktree' },
          { type: 'base_revision', sha: 'abc123' },
          {
            type: 'changed_files',
            files: [{ path: 'apps/execuTerm/daemon/src/index.ts', status: 'M' }],
          },
        ]),
      })
    );
    await expect(needsReviewReceipt).resolves.toEqual(
      expect.objectContaining({
        type: 'work_item.needs_review_synced',
        workspaceId: 'ws-codex',
        workItemId: 'work-demo',
        attributes: { artifactCount: 4 },
      })
    );
  });
});
