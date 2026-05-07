import { VcsCommandRunner } from './commandRunner.js';

export interface ChangedFileArtifact {
  type: 'changed_files';
  files: Array<{
    path: string;
    status: string;
  }>;
}

export interface GitDiffSummaryArtifact {
  type: 'git_diff_summary';
  summary: string;
}

function parsePorcelainStatus(output: string): ChangedFileArtifact['files'] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim() || 'modified';
      const rawPath = line.slice(3).trim();
      const renameParts = rawPath.split(' -> ');
      return {
        status,
        path: renameParts[renameParts.length - 1] || rawPath,
      };
    })
    .filter((file) => Boolean(file.path));
}

export class GitArtifactService {
  constructor(
    private readonly commandRunner = new VcsCommandRunner({
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
    })
  ) {}

  async collectChangedFiles(
    worktreePath: string
  ): Promise<Array<ChangedFileArtifact | GitDiffSummaryArtifact>> {
    const result = await this.commandRunner.run(
      'git',
      ['status', '--porcelain'],
      { cwd: worktreePath }
    );
    const files = parsePorcelainStatus(result.stdout);
    const artifacts: Array<ChangedFileArtifact | GitDiffSummaryArtifact> =
      files.length > 0 ? [{ type: 'changed_files', files }] : [];
    const diff = await this.commandRunner
      .run('git', ['diff', '--shortstat'], { cwd: worktreePath })
      .catch(() => ({ stdout: '', stderr: '' }));
    if (diff.stdout) {
      artifacts.push({ type: 'git_diff_summary', summary: diff.stdout });
    }
    return artifacts;
  }
}
