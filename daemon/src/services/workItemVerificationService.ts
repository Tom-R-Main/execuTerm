import { spawn } from 'node:child_process';
import type { AgentWorkItemResponse } from '../exfClient.js';

export interface VerificationCommandResult {
  command: string;
  exitCode: number | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface VerificationArtifact {
  type: 'verification_result';
  source: 'executerm';
  aggregateStatus: 'passed' | 'failed';
  startedAt: string;
  completedAt: string;
  commands: VerificationCommandResult[];
}

export interface VerificationRunOptions {
  commands?: string[];
  rerunFailedFrom?: VerificationArtifact;
  timeoutMs?: number;
}

const DEFAULT_EXECUTERM_DAEMON_COMMANDS = [
  'npm run build',
  'npm test -- --runInBand',
];

const OUTPUT_TAIL_LIMIT = 12_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

export class WorkItemVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkItemVerificationError';
  }
}

function tail(value: string, limit = OUTPUT_TAIL_LIMIT): string {
  return value.length > limit ? value.slice(value.length - limit) : value;
}

export function redactVerificationOutput(value: string): string {
  return value
    .replace(/claim-[A-Za-z0-9-]+/g, '[REDACTED_CLAIM]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b(?:pat|ghp|github_pat|sk|rk|sess|tok)_[A-Za-z0-9_=-]{12,}\b/g, '[REDACTED_TOKEN]')
    .replace(/([A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PAT)[A-Z0-9_]*=)[^\s]+/gi, '$1[REDACTED]');
}

function artifactRefs(workItem: AgentWorkItemResponse): Record<string, unknown>[] {
  return Array.isArray(workItem.artifactRefs)
    ? workItem.artifactRefs.filter((artifact): artifact is Record<string, unknown> =>
      !!artifact && typeof artifact === 'object'
    )
    : [];
}

export function resolveVerificationCwd(workItem: AgentWorkItemResponse): string {
  const worktree = artifactRefs(workItem).find((artifact) =>
    artifact.type === 'worktree' && typeof artifact.path === 'string'
  );
  if (typeof worktree?.path === 'string' && worktree.path.trim()) {
    return worktree.path;
  }
  throw new WorkItemVerificationError('No worktree artifact is available for this work item.');
}

export function latestVerificationArtifact(workItem: AgentWorkItemResponse): VerificationArtifact | undefined {
  const matches = artifactRefs(workItem).filter((artifact) =>
    artifact.type === 'verification_result' &&
    Array.isArray(artifact.commands)
  ) as unknown as VerificationArtifact[];
  return matches[matches.length - 1];
}

export function selectVerificationCommands(
  workItem: AgentWorkItemResponse,
  cwd: string,
  options: VerificationRunOptions = {}
): string[] {
  if (options.commands?.length) return options.commands;
  if (options.rerunFailedFrom) {
    const failed = options.rerunFailedFrom.commands
      .filter((command) => command.exitCode !== 0)
      .map((command) => command.command);
    if (failed.length) return failed;
  }
  if (workItem.verificationCommands?.length) return workItem.verificationCommands;
  if (cwd.endsWith('/apps/execuTerm/daemon') || cwd.includes('/apps/execuTerm/daemon/')) {
    return DEFAULT_EXECUTERM_DAEMON_COMMANDS;
  }
  throw new WorkItemVerificationError('No verification commands configured for this work item.');
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<VerificationCommandResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout = tail(stdout + String(chunk));
    });
    child.stderr?.on('data', (chunk) => {
      stderr = tail(stderr + String(chunk));
    });
    child.on('error', (error) => {
      stderr = tail(stderr + `\n${error.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const completedAt = new Date().toISOString();
      resolve({
        command,
        exitCode: timedOut ? null : code,
        startedAt,
        completedAt,
        durationMs: Date.now() - startedMs,
        stdoutTail: redactVerificationOutput(stdout),
        stderrTail: redactVerificationOutput(
          timedOut ? `${stderr}\nCommand timed out after ${timeoutMs}ms` : stderr
        ),
      });
    });
  });
}

export class WorkItemVerificationService {
  async run(
    workItem: AgentWorkItemResponse,
    options: VerificationRunOptions = {}
  ): Promise<VerificationArtifact> {
    const cwd = resolveVerificationCwd(workItem);
    const commands = selectVerificationCommands(workItem, cwd, options);
    const startedAt = new Date().toISOString();
    const results: VerificationCommandResult[] = [];
    for (const command of commands) {
      const result = await runCommand(
        command,
        cwd,
        options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
      );
      results.push(result);
      if (result.exitCode !== 0) break;
    }
    return {
      type: 'verification_result',
      source: 'executerm',
      aggregateStatus: results.every((result) => result.exitCode === 0) ? 'passed' : 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      commands: results,
    };
  }
}
