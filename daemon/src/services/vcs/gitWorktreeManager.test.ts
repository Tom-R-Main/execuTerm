import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitWorktreeManager } from './gitWorktreeManager.js';
import type { VcsConfig } from '../../types.js';

describe('GitWorktreeManager', () => {
  it('creates a task-scoped branch worktree and returns source-control metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'executerm-worktrees-'));
    const repoRoot = join(root, 'execufunction');
    const worktreeRoot = join(root, 'worktrees');
    const commands: Array<{ command: string; args: string[]; cwd: string }> = [];
    const repoDetector = {
      detect: jest.fn(async () => ({
        cwd: repoRoot,
        isGitRepo: true,
        repoRoot,
        headRevision: 'abc123',
      })),
    };
    const commandRunner = {
      run: jest.fn(async (command: string, args: string[], opts: { cwd: string }) => {
        commands.push({ command, args, cwd: opts.cwd });
        return { stdout: '', stderr: '' };
      }),
    };
    const manager = new GitWorktreeManager(
      repoDetector as any,
      commandRunner as any
    );
    const config: VcsConfig = {
      enabled: true,
      worktreeRoot,
      jjEnabled: false,
      autoCreateWorktree: true,
      autoMerge: false,
      allowPush: false,
    };

    try {
      const result = await manager.createForSession({
        cwd: repoRoot,
        workspaceId: 'workspace-123456789',
        workItemId: 'work-abcdef',
        taskId: 'task-abcdef',
        config,
      });

      expect(result.cwd).toBe(join(worktreeRoot, 'execufunction', 'workspace-12'));
      expect(result.sourceControl).toEqual(
        expect.objectContaining({
          mode: 'git-worktree',
          repoRoot,
          coordinatorRoot: repoRoot,
          worktreePath: result.cwd,
          baseRevision: 'abc123',
          branchName: 'exf/agent/work-abcdef/workspace-12',
          mergeStatus: 'none',
        })
      );
      expect(commands).toEqual([
        {
          command: 'git',
          args: [
            'worktree',
            'add',
            '-b',
            'exf/agent/work-abcdef/workspace-12',
            result.cwd,
            'abc123',
          ],
          cwd: repoRoot,
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves cwd unchanged when the launch directory is not a Git repository', async () => {
    const repoDetector = {
      detect: jest.fn(async () => ({
        cwd: '/tmp/not-a-repo',
        isGitRepo: false,
      })),
    };
    const commandRunner = { run: jest.fn() };
    const manager = new GitWorktreeManager(
      repoDetector as any,
      commandRunner as any
    );

    const result = await manager.createForSession({
      cwd: '/tmp/not-a-repo',
      workspaceId: 'workspace-1',
      config: {
        enabled: true,
        worktreeRoot: '/tmp/worktrees',
        jjEnabled: false,
        autoCreateWorktree: true,
        autoMerge: false,
        allowPush: false,
      },
    });

    expect(result).toEqual({ cwd: '/tmp/not-a-repo' });
    expect(commandRunner.run).not.toHaveBeenCalled();
  });
});
