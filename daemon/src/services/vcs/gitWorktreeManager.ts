import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { SourceControlState, VcsConfig } from '../../types.js';
import { VcsCommandRunner } from './commandRunner.js';
import { RepoDetector } from './repoDetector.js';

export interface WorktreeCreateInput {
  cwd: string;
  workspaceId: string;
  workItemId?: string;
  taskId?: string;
  projectId?: string;
  config: VcsConfig;
}

export interface WorktreeCreateResult {
  cwd: string;
  sourceControl?: SourceControlState;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function shortId(value: string): string {
  return slugify(value).slice(0, 12) || 'session';
}

function buildBranchName(input: WorktreeCreateInput): string {
  const subject = input.workItemId || input.taskId || input.projectId || input.workspaceId;
  return `exf/agent/${shortId(subject)}/${shortId(input.workspaceId)}`;
}

export class GitWorktreeManager {
  constructor(
    private readonly repoDetector = new RepoDetector(),
    private readonly commandRunner = new VcsCommandRunner({
      timeoutMs: 10000,
      maxBuffer: 2 * 1024 * 1024,
    })
  ) {}

  async createForSession(
    input: WorktreeCreateInput
  ): Promise<WorktreeCreateResult> {
    const status = await this.repoDetector.detect(input.cwd);
    if (!status.isGitRepo || !status.repoRoot || !status.headRevision) {
      return { cwd: input.cwd };
    }

    const repoSlug = slugify(basename(status.repoRoot)) || 'repo';
    const workspaceSlug = shortId(input.workspaceId);
    const worktreePath = join(input.config.worktreeRoot, repoSlug, workspaceSlug);
    const branchName = buildBranchName(input);

    mkdirSync(join(input.config.worktreeRoot, repoSlug), { recursive: true });
    await this.commandRunner.run(
      'git',
      ['worktree', 'add', '-b', branchName, worktreePath, status.headRevision],
      { cwd: status.repoRoot }
    );

    return {
      cwd: worktreePath,
      sourceControl: {
        mode: 'git-worktree',
        repoRoot: status.repoRoot,
        coordinatorRoot: status.repoRoot,
        worktreePath,
        baseRevision: status.headRevision,
        branchName,
        mergeStatus: 'none',
      },
    };
  }
}
