import { GitArtifactService } from './gitArtifactService.js';

describe('GitArtifactService', () => {
  it('collects changed files and a short diff summary from a worktree', async () => {
    const commandRunner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({
          stdout: ' M daemon/src/index.ts\nR  old.ts -> new.ts\n?? notes.md\n',
          stderr: '',
        })
        .mockResolvedValueOnce({
          stdout: ' 2 files changed, 3 insertions(+), 1 deletion(-)\n',
          stderr: '',
        }),
    };
    const service = new GitArtifactService(commandRunner as any);

    await expect(service.collectChangedFiles('/repo/worktree')).resolves.toEqual([
      {
        type: 'changed_files',
        files: [
          { path: 'daemon/src/index.ts', status: 'M' },
          { path: 'new.ts', status: 'R' },
          { path: 'notes.md', status: '??' },
        ],
      },
      {
        type: 'git_diff_summary',
        summary: ' 2 files changed, 3 insertions(+), 1 deletion(-)\n',
      },
    ]);
    expect(commandRunner.run).toHaveBeenNthCalledWith(
      1,
      'git',
      ['status', '--porcelain'],
      { cwd: '/repo/worktree' }
    );
    expect(commandRunner.run).toHaveBeenNthCalledWith(
      2,
      'git',
      ['diff', '--shortstat'],
      { cwd: '/repo/worktree' }
    );
  });
});
