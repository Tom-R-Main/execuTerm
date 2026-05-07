import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readDaemonConfig, writeDaemonConfig } from '../config.js';
import type { AgentWorkItemResponse } from '../exfClient.js';
import type { RalphRunSnapshot, SourceControlState } from '../types.js';
import { RalphRunService } from './ralphRunService.js';
import type { VerificationArtifact } from './workItemVerificationService.js';

describe('RalphRunService', () => {
  const originalConfigDir = process.env.EXF_CONFIG_DIR;
  let configDir = '';
  let worktree = '';

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'executerm-ralph-config-'));
    worktree = mkdtempSync(join(tmpdir(), 'executerm-ralph-worktree-'));
    process.env.EXF_CONFIG_DIR = configDir;
    writeDaemonConfig({
      ...readDaemonConfig(),
      vcs: {
        enabled: true,
        worktreeRoot: join(configDir, 'worktrees'),
        jjEnabled: false,
        autoCreateWorktree: true,
        autoMerge: false,
        allowPush: false,
      },
    });
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
    if (originalConfigDir === undefined) {
      delete process.env.EXF_CONFIG_DIR;
    } else {
      process.env.EXF_CONFIG_DIR = originalConfigDir;
    }
  });

  function verification(status: 'passed' | 'failed', command = 'npm test'): VerificationArtifact {
    return {
      type: 'verification_result',
      source: 'executerm',
      aggregateStatus: status,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      commands: [{
        command,
        exitCode: status === 'passed' ? 0 : 1,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1,
        stdoutTail: status === 'passed' ? 'ok' : '',
        stderrTail: status === 'passed' ? '' : 'failed',
      }],
    };
  }

  function makeHarness(opts: {
    verificationArtifacts?: VerificationArtifact[];
    dispatchThrows?: Error;
    waitForReceipt?: () => Promise<unknown>;
    changedFiles?: Array<{ path: string; status?: string }>;
  } = {}) {
    const sourceControl: SourceControlState = {
      mode: 'git-worktree',
      repoRoot: '/repo/main',
      coordinatorRoot: '/repo/main',
      worktreePath: worktree,
      branchName: 'exf/agent/work-1/ws-1',
      baseRevision: 'abc123',
      mergeStatus: 'none',
    };
    const changedFiles = opts.changedFiles || [{ path: 'src/app.ts', status: 'M' }];
    let currentWorkItem: AgentWorkItemResponse = {
      id: 'work-1',
      taskId: 'task-1',
      projectId: 'project-1',
      title: 'Ralph test work',
      status: 'queued',
      assignedAlias: 'codex',
      verificationCommands: ['npm test'],
      artifactRefs: [],
    };
    const appended: unknown[] = [];
    const runs = new Map<string, RalphRunSnapshot>();
    const verificationArtifacts = opts.verificationArtifacts || [verification('passed')];
    let verificationIndex = 0;

    const exfClient = {
      getWorkItem: jest.fn(async () => ({ data: { workItem: currentWorkItem } })),
      appendWorkItemArtifacts: jest.fn(async (_id: string, artifacts: unknown[]) => {
        appended.push(...artifacts);
        currentWorkItem = {
          ...currentWorkItem,
          artifactRefs: [...(currentWorkItem.artifactRefs || []), ...artifacts],
        };
        return { data: { workItem: currentWorkItem }, statusCode: 200 };
      }),
      releaseWorkItem: jest.fn(async () => {
        currentWorkItem = { ...currentWorkItem, status: 'queued' };
        return { data: { workItem: currentWorkItem }, statusCode: 200 };
      }),
      failWorkItem: jest.fn(async () => ({ data: { workItem: currentWorkItem }, statusCode: 200 })),
    };
    const taskDispatcher = {
      dispatchWorkItem: jest.fn(async (
        _workItemId: string,
        _agentType: string,
        dispatchOpts?: {
          prepareWorktree?: (path: string, sourceControl?: SourceControlState) => Promise<void> | void;
        }
      ) => {
        if (opts.dispatchThrows) throw opts.dispatchThrows;
        await dispatchOpts?.prepareWorktree?.(worktree, sourceControl);
        currentWorkItem = {
          ...currentWorkItem,
          status: 'needs_review',
          artifactRefs: [
            ...(currentWorkItem.artifactRefs || []),
            { type: 'branch', name: sourceControl.branchName },
            { type: 'worktree', path: worktree },
            { type: 'base_revision', sha: sourceControl.baseRevision },
            { type: 'changed_files', files: changedFiles },
          ],
        };
        writeFileSync(join(worktree, 'result.txt'), 'changed', 'utf8');
        return 'workspace-1';
      }),
    };
    const agentManager = {
      waitForReceipt: jest.fn(opts.waitForReceipt || (async () => ({
        workItemId: 'work-1',
        timestamp: new Date().toISOString(),
      }))),
      stop: jest.fn(async () => {}),
    };
    const workspaceManager = {
      listRalphRuns: jest.fn(() => Array.from(runs.values())),
      getRalphRun: jest.fn((id: string) => runs.get(id)),
      saveRalphRun: jest.fn((run: RalphRunSnapshot) => {
        const next = { ...run };
        runs.set(run.workItemId, next);
        return next;
      }),
    };
    const verificationService = {
      run: jest.fn(async () => {
        const artifact = verificationArtifacts[Math.min(verificationIndex, verificationArtifacts.length - 1)];
        verificationIndex += 1;
        return artifact;
      }),
    };
    const gitArtifactService = {
      collectChangedFiles: jest.fn(async () => [{ type: 'changed_files', files: changedFiles }]),
    };
    const service = new RalphRunService(
      exfClient as any,
      taskDispatcher as any,
      agentManager as any,
      workspaceManager as any,
      verificationService as any,
      gitArtifactService as any
    );
    return {
      service,
      exfClient,
      taskDispatcher,
      agentManager,
      workspaceManager,
      verificationService,
      appended,
      runs,
    };
  }

  async function waitForRun(
    service: RalphRunService,
    status: RalphRunSnapshot['status'],
    timeoutMs = 1000
  ): Promise<RalphRunSnapshot> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = service.getRun('work-1');
      if (run?.status === status) return run;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for Ralph run status ${status}`);
  }

  it('writes Ralph loop files and stops on passing verification', async () => {
    const harness = makeHarness();

    await harness.service.start('work-1', { maxIterations: 3 });
    const run = await waitForRun(harness.service, 'needs_review');

    expect(run.stopReason).toBe('verification_passed');
    expect(run.iterations).toHaveLength(1);
    expect(existsSync(join(worktree, 'RALPH', 'PROMPT.md'))).toBe(true);
    expect(existsSync(join(worktree, 'RALPH', 'IMPLEMENTATION_PLAN.md'))).toBe(true);
    expect(existsSync(join(worktree, 'RALPH', 'VERIFY.md'))).toBe(true);
    expect(existsSync(join(worktree, 'RALPH', 'STATE.json'))).toBe(true);
    expect(harness.appended).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'ralph_run_started' }),
        expect.objectContaining({ type: 'verification_result', aggregateStatus: 'passed' }),
        expect.objectContaining({ type: 'ralph_iteration', iteration: 1 }),
        expect.objectContaining({ type: 'ralph_plan_snapshot', iteration: 1 }),
        expect.objectContaining({ type: 'ralph_verification_summary', aggregateStatus: 'passed' }),
        expect.objectContaining({ type: 'ralph_stop_reason', reason: 'verification_passed' }),
      ])
    );
    expect(harness.exfClient.failWorkItem).not.toHaveBeenCalled();
  });

  it('stops with needs_review after the same verification command fails twice', async () => {
    const harness = makeHarness({
      verificationArtifacts: [
        verification('failed', 'npm test'),
        verification('failed', 'npm test'),
      ],
    });

    await harness.service.start('work-1', {
      maxIterations: 3,
      stopOnVerificationPassed: true,
      stopOnRepeatedFailure: true,
    });
    const run = await waitForRun(harness.service, 'needs_review');

    expect(run.stopReason).toBe('repeated_verification_failure');
    expect(run.iterations).toHaveLength(2);
    expect(harness.exfClient.releaseWorkItem).toHaveBeenCalledTimes(1);
    expect(harness.exfClient.failWorkItem).not.toHaveBeenCalled();
  });

  it('stops with needs_review when sensitive files change', async () => {
    const harness = makeHarness({
      verificationArtifacts: [verification('failed')],
      changedFiles: [{ path: 'cloudbuild.yaml', status: 'M' }],
    });

    await harness.service.start('work-1', {
      maxIterations: 3,
      stopOnSensitivePaths: true,
    });
    const run = await waitForRun(harness.service, 'needs_review');

    expect(run.stopReason).toBe('sensitive_path_changed');
    expect(harness.exfClient.failWorkItem).not.toHaveBeenCalled();
  });

  it('marks orchestration failures as failed work items', async () => {
    const harness = makeHarness({ dispatchThrows: new Error('launch failed') });

    await harness.service.start('work-1');
    const run = await waitForRun(harness.service, 'failed');

    expect(run.stopReason).toBe('orchestration_failure');
    expect(run.error).toContain('launch failed');
    expect(harness.exfClient.failWorkItem).toHaveBeenCalledWith(
      'work-1',
      expect.objectContaining({
        failureReason: 'launch failed',
      })
    );
  });

  it('rejects duplicate active runs and stop requests release the work item', async () => {
    let releaseReceipt: (() => void) | null = null;
    const harness = makeHarness({
      waitForReceipt: () => new Promise((resolve) => {
        releaseReceipt = () => resolve({ workItemId: 'work-1', timestamp: new Date().toISOString() });
      }),
    });

    await harness.service.start('work-1');
    await expect(harness.service.start('work-1')).rejects.toThrow('already running');
    await waitForRun(harness.service, 'running');
    const stopped = await harness.service.stop('work-1');

    expect(stopped.status).toBe('stopping');
    expect(harness.agentManager.stop).toHaveBeenCalledWith('workspace-1');
    expect(harness.exfClient.releaseWorkItem).toHaveBeenCalledWith('work-1', {});

    if (releaseReceipt) {
      (releaseReceipt as () => void)();
    }
  });
});
