import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface VcsCommandResult {
  stdout: string;
  stderr: string;
}

export interface VcsCommandRunnerOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

export class VcsCommandRunner {
  constructor(private readonly defaults: VcsCommandRunnerOptions = {}) {}

  async run(
    command: string,
    args: string[],
    opts: VcsCommandRunnerOptions & { cwd: string }
  ): Promise<VcsCommandResult> {
    const result = await execFileAsync(command, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? this.defaults.timeoutMs ?? 5000,
      maxBuffer: opts.maxBuffer ?? this.defaults.maxBuffer ?? 1024 * 1024,
    });
    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  }
}
