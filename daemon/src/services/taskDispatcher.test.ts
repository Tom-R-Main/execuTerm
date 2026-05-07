import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskDispatcher } from './taskDispatcher.js';

describe('TaskDispatcher VCS launch behavior', () => {
  const originalConfigDir = process.env.EXF_CONFIG_DIR;
  let configDir = '';

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'executerm-task-dispatcher-'));
    process.env.EXF_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) {
      delete process.env.EXF_CONFIG_DIR;
    } else {
      process.env.EXF_CONFIG_DIR = originalConfigDir;
    }
  });

  function writeConfig(config: object) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'terminal.json'), JSON.stringify(config));
  }

  function makeDispatcher(gitWorktreeManager: { createForSession: jest.Mock }) {
    const exfClient = {
      getTask: jest.fn(async () => ({
        data: {
          task: {
            id: 'task-1',
            title: 'Ship worktree launch',
            description: 'Create isolated agent workspaces',
            projectId: 'project-1',
          },
        },
      })),
      getProjectContext: jest.fn(async () => ({ data: {} })),
      searchCodeMemories: jest.fn(async () => ({ data: { memories: [] } })),
      updateTask: jest.fn(async () => ({ data: {} })),
      createWorkItem: jest.fn(async () => ({
        data: {
          workItem: {
            id: 'work-1',
            taskId: 'task-1',
            projectId: 'project-1',
            title: 'Ship worktree launch',
            status: 'queued',
            assignedAlias: 'codex',
          },
        },
      })),
      claimWorkItem: jest.fn(async () => ({
        data: {
          workItem: {
            id: 'work-1',
            taskId: 'task-1',
            projectId: 'project-1',
            title: 'Ship worktree launch',
            status: 'claimed',
            assignedAlias: 'codex',
            claimToken: 'claim-token-1',
          },
        },
      })),
      startWorkItem: jest.fn(async () => ({
        data: {
          workItem: {
            id: 'work-1',
            taskId: 'task-1',
            projectId: 'project-1',
            title: 'Ship worktree launch',
            status: 'running',
            assignedAlias: 'codex',
            claimToken: 'claim-token-1',
          },
        },
      })),
    };
    const directoryManager = {
      resolveTaskDirectory: jest.fn(() => '/repo/main'),
      rememberAgentPreference: jest.fn(),
    };
    const workspaceManager = {
      createFromTemplate: jest.fn(async () => 'workspace-1'),
    };
    const agentManager = {
      register: jest.fn(),
    };
    return {
      dispatcher: new TaskDispatcher(
        exfClient as any,
        directoryManager as any,
        workspaceManager as any,
        agentManager as any,
        gitWorktreeManager as any
      ),
      exfClient,
      directoryManager,
      workspaceManager,
      agentManager,
    };
  }

  it('keeps dispatch in the resolved project directory by default', async () => {
    writeConfig({});
    const gitWorktreeManager = { createForSession: jest.fn() };
    const { dispatcher, exfClient, workspaceManager } = makeDispatcher(gitWorktreeManager);

    await dispatcher.dispatch('task-1', 'codex');

    expect(gitWorktreeManager.createForSession).not.toHaveBeenCalled();
    expect(workspaceManager.createFromTemplate).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        taskId: 'task-1',
        workItemId: 'work-1',
        claimToken: 'claim-token-1',
        claimOwner: 'executerm:codex',
        assignedAlias: 'codex',
        projectId: 'project-1',
        cwd: '/repo/main',
        sourceControl: undefined,
      })
    );
    expect(exfClient.updateTask).not.toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ executorAgent: expect.anything() })
    );
  });

  it('launches into a Git worktree when VCS auto-create is enabled', async () => {
    writeConfig({
      vcs: {
        enabled: true,
        worktreeRoot: '/tmp/exf-worktrees',
        jjEnabled: false,
        autoCreateWorktree: true,
        autoMerge: false,
        allowPush: false,
      },
    });
    const sourceControl = {
      mode: 'git-worktree',
      repoRoot: '/repo/main',
      coordinatorRoot: '/repo/main',
      worktreePath: '/tmp/exf-worktrees/repo/workspace-1',
      baseRevision: 'abc123',
      branchName: 'exf/agent/work-1/workspace-1',
      mergeStatus: 'none',
    };
    const gitWorktreeManager = {
      createForSession: jest.fn(async () => ({
        cwd: '/tmp/exf-worktrees/repo/workspace-1',
        sourceControl,
      })),
    };
    const { dispatcher, workspaceManager } = makeDispatcher(gitWorktreeManager);

    await dispatcher.dispatch('task-1', 'codex');

    expect(gitWorktreeManager.createForSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/repo/main',
        taskId: 'task-1',
        workItemId: 'work-1',
        projectId: 'project-1',
        config: expect.objectContaining({
          enabled: true,
          autoCreateWorktree: true,
          autoMerge: false,
          allowPush: false,
        }),
      })
    );
    expect(workspaceManager.createFromTemplate).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        cwd: '/tmp/exf-worktrees/repo/workspace-1',
        workItemId: 'work-1',
        sourceControl,
      })
    );
  });

  it('claims and starts an existing work item for explicit queue dispatch', async () => {
    writeConfig({});
    const gitWorktreeManager = { createForSession: jest.fn() };
    const { dispatcher, exfClient, workspaceManager } = makeDispatcher(gitWorktreeManager);
    exfClient.claimWorkItem.mockResolvedValueOnce({
      data: {
        workItem: {
          id: 'work-existing',
          taskId: 'task-1',
          projectId: 'project-1',
          title: 'Existing work',
          status: 'claimed',
          assignedAlias: 'claude-code',
          claimToken: 'claim-token-2',
        },
      },
    });
    exfClient.startWorkItem.mockResolvedValueOnce({
      data: {
        workItem: {
          id: 'work-existing',
          taskId: 'task-1',
          projectId: 'project-1',
          title: 'Existing work',
          status: 'running',
          assignedAlias: 'claude-code',
          claimToken: 'claim-token-2',
        },
      },
    });

    await dispatcher.dispatchWorkItem('work-existing', 'claude-code');

    expect(exfClient.createWorkItem).not.toHaveBeenCalled();
    expect(exfClient.claimWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: 'work-existing',
        assignedAlias: 'claude-code',
        claimOwner: 'executerm:claude-code',
      })
    );
    expect(exfClient.startWorkItem).toHaveBeenCalledWith(
      'work-existing',
      expect.objectContaining({
        claimOwner: 'executerm:claude-code',
        claimToken: 'claim-token-2',
      })
    );
    expect(workspaceManager.createFromTemplate).toHaveBeenCalledWith(
      'claude-code',
      expect.objectContaining({
        workItemId: 'work-existing',
        claimToken: 'claim-token-2',
        claimOwner: 'executerm:claude-code',
      })
    );
  });
});
