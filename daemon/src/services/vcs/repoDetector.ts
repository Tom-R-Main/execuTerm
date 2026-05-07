import { accessSync, constants, existsSync } from 'node:fs';
import { VcsCommandRunner } from './commandRunner.js';

import type { SourceControlStatus } from '../../types.js';

const COMMAND_TIMEOUT_MS = 2500;

function canReadDirectory(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export class RepoDetector {
  constructor(
    private readonly commandRunner = new VcsCommandRunner({
      timeoutMs: COMMAND_TIMEOUT_MS,
    })
  ) {}

  private async runGit(cwd: string, args: string[]): Promise<string> {
    return (await this.commandRunner.run('git', args, { cwd })).stdout;
  }

  private async runJj(cwd: string, args: string[]): Promise<string> {
    return (await this.commandRunner.run('jj', args, { cwd })).stdout;
  }

  async detect(cwd: string): Promise<SourceControlStatus> {
    const status: SourceControlStatus = {
      cwd,
      isGitRepo: false,
    };

    if (!cwd || !canReadDirectory(cwd)) {
      return {
        ...status,
        error: 'Working directory is not readable',
      };
    }

    try {
      const repoRoot = await this.runGit(cwd, ['rev-parse', '--show-toplevel']);
      status.isGitRepo = true;
      status.repoRoot = repoRoot;
      status.branchName = await this.runGit(cwd, ['branch', '--show-current']);
      status.headRevision = await this.runGit(cwd, ['rev-parse', 'HEAD']);
      status.isDirty =
        (await this.runGit(cwd, ['status', '--porcelain'])).length > 0;
      status.isWorktree =
        (await this.runGit(cwd, ['rev-parse', '--git-common-dir'])) !== '.git';
      status.jjColocated = existsSync(`${repoRoot}/.jj`);
    } catch (err) {
      return {
        ...status,
        error: err instanceof Error ? err.message : 'Git repository detection failed',
      };
    }

    try {
      status.jjRoot = await this.runJj(cwd, ['root']);
      status.jjAvailable = true;
    } catch {
      status.jjAvailable = false;
    }

    return status;
  }
}
