import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentWorkItemResponse, ExfClient } from '../exfClient.js';
import type {
  AgentType,
  RalphIterationRecord,
  RalphRunSnapshot,
  RalphStopReason,
  SourceControlState,
} from '../types.js';
import { readDaemonConfig } from '../config.js';
import type { AgentManager } from './agentManager.js';
import type { TaskDispatcher } from './taskDispatcher.js';
import { GitArtifactService } from './vcs/gitArtifactService.js';
import {
  WorkItemVerificationService,
  type VerificationArtifact,
} from './workItemVerificationService.js';
import type { WorkspaceManager } from './workspaceManager.js';

export interface RalphRunOptions {
  agentType?: AgentType;
  maxIterations?: number;
  stopOnVerificationPassed?: boolean;
  stopOnRepeatedFailure?: boolean;
  stopOnSensitivePaths?: boolean;
}

interface ActiveRalphRun {
  stopRequested: boolean;
}

const DEFAULT_OPTIONS: Required<RalphRunOptions> = {
  agentType: 'codex',
  maxIterations: 3,
  stopOnVerificationPassed: true,
  stopOnRepeatedFailure: true,
  stopOnSensitivePaths: true,
};

const RECEIPT_TIMEOUT_MS = 45 * 60 * 1000;
const SNAPSHOT_TEXT_LIMIT = 20_000;

function nowIso(): string {
  return new Date().toISOString();
}

function clampMaxIterations(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 3;
  return Math.max(1, Math.min(10, Math.floor(n)));
}

function artifactObjects(workItem: AgentWorkItemResponse): Record<string, unknown>[] {
  return Array.isArray(workItem.artifactRefs)
    ? workItem.artifactRefs.filter((artifact): artifact is Record<string, unknown> =>
        !!artifact && typeof artifact === 'object'
      )
    : [];
}

function changedFilesFrom(workItem: AgentWorkItemResponse): Array<{ path: string; status?: string }> {
  const changed = artifactObjects(workItem)
    .filter((artifact) => artifact.type === 'changed_files')
    .at(-1);
  const files = changed && Array.isArray(changed.files) ? changed.files : [];
  return files
    .map((file) => {
      if (typeof file === 'string') return { path: file };
      if (file && typeof file === 'object' && typeof (file as { path?: unknown }).path === 'string') {
        return {
          path: String((file as { path: string }).path),
          status:
            typeof (file as { status?: unknown }).status === 'string'
              ? String((file as { status: string }).status)
              : undefined,
        };
      }
      return null;
    })
    .filter((file): file is { path: string; status?: string } => !!file?.path);
}

function firstFailedCommand(artifact: VerificationArtifact): string | null {
  const failed = artifact.commands.find((command) => command.exitCode !== 0);
  return failed?.command || null;
}

function isSensitivePath(path: string): boolean {
  return path === 'cloudbuild.yaml'
    || path.startsWith('Dockerfile')
    || path.startsWith('infra/')
    || path.startsWith('terraform/')
    || path.startsWith('firebase/')
    || path.startsWith('gcp/')
    || path.startsWith('src/services/orchestrator/')
    || path.startsWith('src/services/operator')
    || path.startsWith('src/services/tools/domains/')
    || path === 'src/services/workspaceContextService.ts';
}

function tailText(value: string): string {
  return value.length > SNAPSHOT_TEXT_LIMIT
    ? value.slice(value.length - SNAPSHOT_TEXT_LIMIT)
    : value;
}

function safeRead(path: string): string {
  try {
    return tailText(readFileSync(path, 'utf8'));
  } catch {
    return '';
  }
}

export class RalphRunService {
  private activeRuns = new Map<string, ActiveRalphRun>();

  constructor(
    private exfClient: ExfClient,
    private taskDispatcher: TaskDispatcher,
    private agentManager: AgentManager,
    private workspaceManager: WorkspaceManager,
    private verificationService = new WorkItemVerificationService(),
    private gitArtifactService = new GitArtifactService()
  ) {}

  listRuns(): RalphRunSnapshot[] {
    return this.workspaceManager.listRalphRuns();
  }

  getRun(workItemId: string): RalphRunSnapshot | undefined {
    return this.workspaceManager.getRalphRun(workItemId);
  }

  async start(workItemId: string, options: RalphRunOptions = {}): Promise<RalphRunSnapshot> {
    if (this.activeRuns.has(workItemId)) {
      throw new Error('Ralph is already running for this work item');
    }
    const config = readDaemonConfig();
    if (!config.vcs?.enabled || !config.vcs.autoCreateWorktree) {
      throw new Error('Ralph Mode requires vcs.enabled and vcs.autoCreateWorktree');
    }

    const workItemResult = await this.exfClient.getWorkItem(workItemId);
    const workItem = workItemResult.data?.workItem;
    if (!workItem) {
      throw new Error(workItemResult.error || 'Work item not found');
    }

    const settings: Required<RalphRunOptions> = {
      ...DEFAULT_OPTIONS,
      ...options,
      maxIterations: clampMaxIterations(options.maxIterations),
      agentType: options.agentType || DEFAULT_OPTIONS.agentType,
    };
    const startedAt = nowIso();
    const snapshot: RalphRunSnapshot = this.persist({
      workItemId,
      taskId: workItem.taskId,
      status: 'running',
      agentType: settings.agentType,
      maxIterations: settings.maxIterations,
      currentIteration: 0,
      startedAt,
      updatedAt: startedAt,
      iterations: [],
    });

    this.activeRuns.set(workItemId, { stopRequested: false });
    await this.exfClient.appendWorkItemArtifacts(workItemId, [{
      type: 'ralph_run_started',
      source: 'executerm',
      startedAt,
      agentType: settings.agentType,
      maxIterations: settings.maxIterations,
    }]);
    void this.runLoop(workItem, settings, snapshot).catch((error) => {
      void this.failRun(workItemId, error);
    });
    return snapshot;
  }

  async stop(workItemId: string): Promise<RalphRunSnapshot> {
    const active = this.activeRuns.get(workItemId);
    if (active) active.stopRequested = true;
    const existing = this.workspaceManager.getRalphRun(workItemId);
    const next = this.persist({
      ...(existing || this.emptySnapshot(workItemId)),
      status: 'stopping',
      stopReason: 'manual_stop',
      updatedAt: nowIso(),
    });
    if (next.currentWorkspaceId) {
      await this.agentManager.stop(next.currentWorkspaceId).catch(() => {});
    }
    await this.exfClient.releaseWorkItem(workItemId, {}).catch(() => {});
    return next;
  }

  private async runLoop(
    initialWorkItem: AgentWorkItemResponse,
    settings: Required<RalphRunOptions>,
    initialSnapshot: RalphRunSnapshot
  ): Promise<void> {
    let workItem = initialWorkItem;
    let snapshot = initialSnapshot;
    let previousFailedCommand: string | null = null;
    let previousVerificationFeedback = '';

    for (let iteration = 1; iteration <= settings.maxIterations; iteration++) {
      const active = this.activeRuns.get(workItem.id);
      if (!active || active.stopRequested) {
        await this.finishNeedsReview(snapshot, 'manual_stop');
        return;
      }

      if (iteration > 1) {
        await this.exfClient.releaseWorkItem(workItem.id, {});
      }

      const iterationStartedAt = nowIso();
      const record: RalphIterationRecord = {
        iteration,
        startedAt: iterationStartedAt,
      };
      snapshot = this.persist({
        ...snapshot,
        status: 'running',
        currentIteration: iteration,
        currentWorkspaceId: undefined,
        iterations: [...snapshot.iterations, record],
        updatedAt: iterationStartedAt,
      });

      const prompt = this.buildIterationPrompt(workItem, iteration, settings, previousVerificationFeedback);
      const workspaceId = await this.taskDispatcher.dispatchWorkItem(
        workItem.id,
        settings.agentType,
        {
          promptOverride: prompt,
          prepareWorktree: async (worktreePath, sourceControl) => {
            this.writeRalphFiles(worktreePath, {
              workItem,
              iteration,
              settings,
              prompt,
              previousVerificationFeedback,
              sourceControl,
            });
          },
        }
      );
      snapshot = this.updateIteration(snapshot, iteration, {
        workspaceId,
      }, { currentWorkspaceId: workspaceId });

      await this.agentManager.waitForReceipt(
        'work_item.needs_review_synced',
        (receipt) =>
          receipt.workItemId === workItem.id &&
          new Date(receipt.timestamp).getTime() >= new Date(iterationStartedAt).getTime(),
        RECEIPT_TIMEOUT_MS
      );

      const latestResult = await this.exfClient.getWorkItem(workItem.id);
      if (latestResult.data?.workItem) workItem = latestResult.data.workItem;
      const verification = await this.verificationService.run(workItem);
      const changedFiles = changedFilesFrom(workItem);
      const worktreePath = this.worktreePath(workItem);
      const snapshotArtifacts = worktreePath
        ? await this.collectIterationArtifacts(worktreePath, iteration, verification, changedFiles)
        : [];

      await this.exfClient.appendWorkItemArtifacts(workItem.id, [
        verification,
        ...snapshotArtifacts,
      ]);
      const verifiedResult = await this.exfClient.getWorkItem(workItem.id);
      if (verifiedResult.data?.workItem) workItem = verifiedResult.data.workItem;

      const completedAt = nowIso();
      snapshot = this.updateIteration(snapshot, iteration, {
        completedAt,
        verificationStatus: verification.aggregateStatus,
        changedFiles,
      });

      const sensitiveChanged = settings.stopOnSensitivePaths
        && changedFiles.some((file) => isSensitivePath(file.path));
      const failedCommand = firstFailedCommand(verification);
      const repeatedFailure =
        settings.stopOnRepeatedFailure &&
        !!failedCommand &&
        failedCommand === previousFailedCommand;

      let stopReason: RalphStopReason | null = null;
      if (sensitiveChanged) stopReason = 'sensitive_path_changed';
      else if (settings.stopOnVerificationPassed && verification.aggregateStatus === 'passed') stopReason = 'verification_passed';
      else if (repeatedFailure) stopReason = 'repeated_verification_failure';
      else if (iteration >= settings.maxIterations) stopReason = 'max_iterations';

      if (stopReason) {
        await this.finishNeedsReview(snapshot, stopReason);
        return;
      }

      previousFailedCommand = failedCommand;
      previousVerificationFeedback = this.feedbackFromVerification(verification);
    }

    await this.finishNeedsReview(snapshot, 'max_iterations');
  }

  private async finishNeedsReview(
    snapshot: RalphRunSnapshot,
    stopReason: RalphStopReason
  ): Promise<void> {
    const completedAt = nowIso();
    const next = this.persist({
      ...snapshot,
      status: 'needs_review',
      stopReason,
      completedAt,
      currentWorkspaceId: undefined,
      updatedAt: completedAt,
    });
    await this.exfClient.appendWorkItemArtifacts(next.workItemId, [{
      type: 'ralph_stop_reason',
      source: 'executerm',
      reason: stopReason,
      completedAt,
      iterations: next.iterations.length,
    }]).catch(() => {});
    this.activeRuns.delete(next.workItemId);
  }

  private async failRun(workItemId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const existing = this.workspaceManager.getRalphRun(workItemId) || this.emptySnapshot(workItemId);
    const completedAt = nowIso();
    this.persist({
      ...existing,
      status: 'failed',
      stopReason: 'orchestration_failure',
      error: message,
      completedAt,
      updatedAt: completedAt,
    });
    await this.exfClient.failWorkItem(workItemId, {
      failureReason: message,
      resultSummary: `Ralph Mode orchestration failed: ${message}`,
      artifactRefs: [{
        type: 'ralph_stop_reason',
        source: 'executerm',
        reason: 'orchestration_failure',
        error: message,
        completedAt,
      }],
    }).catch(() => {});
    this.activeRuns.delete(workItemId);
  }

  private persist(snapshot: RalphRunSnapshot): RalphRunSnapshot {
    return this.workspaceManager.saveRalphRun({
      ...snapshot,
      updatedAt: snapshot.updatedAt || nowIso(),
    });
  }

  private emptySnapshot(workItemId: string): RalphRunSnapshot {
    const now = nowIso();
    return {
      workItemId,
      status: 'idle',
      agentType: 'codex',
      maxIterations: 3,
      currentIteration: 0,
      startedAt: now,
      updatedAt: now,
      iterations: [],
    };
  }

  private updateIteration(
    snapshot: RalphRunSnapshot,
    iteration: number,
    patch: Partial<RalphIterationRecord>,
    runPatch: Partial<RalphRunSnapshot> = {}
  ): RalphRunSnapshot {
    const updatedAt = nowIso();
    return this.persist({
      ...snapshot,
      ...runPatch,
      iterations: snapshot.iterations.map((record) =>
        record.iteration === iteration ? { ...record, ...patch } : record
      ),
      updatedAt,
    });
  }

  private buildIterationPrompt(
    workItem: AgentWorkItemResponse,
    iteration: number,
    settings: Required<RalphRunOptions>,
    previousVerificationFeedback: string
  ): string {
    const base = typeof (workItem as any).prompt === 'string' && (workItem as any).prompt
      ? (workItem as any).prompt
      : `# Task: ${workItem.title}\n\nExecute this Siftable agent work item.`;
    return [
      base,
      '',
      '# Ralph Mode Contract',
      `Iteration ${iteration} of ${settings.maxIterations}.`,
      'Make exactly one coherent unit of progress, then stop and return to the shell.',
      'Update RALPH/IMPLEMENTATION_PLAN.md with what changed and what remains.',
      'Update RALPH/VERIFY.md with checks you believe should run.',
      'Do not start a self-directed loop. Ralph will decide whether another iteration starts.',
      'Do not push, merge, or mark the work item complete.',
      previousVerificationFeedback
        ? `\nPrevious verification feedback:\n${previousVerificationFeedback}`
        : '',
    ].filter(Boolean).join('\n');
  }

  private writeRalphFiles(
    worktreePath: string,
    input: {
      workItem: AgentWorkItemResponse;
      iteration: number;
      settings: Required<RalphRunOptions>;
      prompt: string;
      previousVerificationFeedback: string;
      sourceControl?: SourceControlState;
    }
  ): void {
    const dir = join(worktreePath, 'RALPH');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'PROMPT.md'), input.prompt, 'utf8');
    writeFileSync(
      join(dir, 'IMPLEMENTATION_PLAN.md'),
      [
        `# Ralph Plan: ${input.workItem.title}`,
        '',
        `Work item: ${input.workItem.id}`,
        `Iteration: ${input.iteration}/${input.settings.maxIterations}`,
        '',
        '## Current Plan',
        '- Make one coherent unit of progress.',
        '- Keep changes inside the work item write scope.',
        '- Update this file before exiting.',
        '',
      ].join('\n'),
      'utf8'
    );
    writeFileSync(
      join(dir, 'VERIFY.md'),
      [
        '# Ralph Verification',
        '',
        'The agent should update this with recommended checks.',
        '',
      ].join('\n'),
      'utf8'
    );
    writeFileSync(
      join(dir, 'STATE.json'),
      JSON.stringify({
        workItemId: input.workItem.id,
        taskId: input.workItem.taskId || null,
        iteration: input.iteration,
        maxIterations: input.settings.maxIterations,
        agentType: input.settings.agentType,
        previousVerificationFeedback: input.previousVerificationFeedback,
        sourceControl: input.sourceControl || null,
        updatedAt: nowIso(),
      }, null, 2),
      'utf8'
    );
  }

  private async collectIterationArtifacts(
    worktreePath: string,
    iteration: number,
    verification: VerificationArtifact,
    changedFiles: Array<{ path: string; status?: string }>
  ): Promise<unknown[]> {
    const ralphDir = join(worktreePath, 'RALPH');
    const gitArtifacts = await this.gitArtifactService
      .collectChangedFiles(worktreePath)
      .catch(() => []);
    return [
      ...gitArtifacts,
      {
        type: 'ralph_iteration',
        source: 'executerm',
        iteration,
        completedAt: nowIso(),
        verificationStatus: verification.aggregateStatus,
        changedFileCount: changedFiles.length,
      },
      {
        type: 'ralph_plan_snapshot',
        source: 'executerm',
        iteration,
        implementationPlan: safeRead(join(ralphDir, 'IMPLEMENTATION_PLAN.md')),
        verifyPlan: safeRead(join(ralphDir, 'VERIFY.md')),
      },
      {
        type: 'ralph_verification_summary',
        source: 'executerm',
        iteration,
        aggregateStatus: verification.aggregateStatus,
        commands: verification.commands.map((command) => ({
          command: command.command,
          exitCode: command.exitCode,
          durationMs: command.durationMs,
        })),
      },
    ];
  }

  private worktreePath(workItem: AgentWorkItemResponse): string | null {
    const worktree = artifactObjects(workItem)
      .filter((artifact) => artifact.type === 'worktree' && typeof artifact.path === 'string')
      .at(-1);
    return typeof worktree?.path === 'string' ? worktree.path : null;
  }

  private feedbackFromVerification(verification: VerificationArtifact): string {
    const failed = verification.commands.find((command) => command.exitCode !== 0);
    if (!failed) return '';
    return [
      `Command: ${failed.command}`,
      `Exit code: ${failed.exitCode ?? 'timeout'}`,
      failed.stderrTail || failed.stdoutTail || 'Verification failed.',
    ].join('\n');
  }
}
