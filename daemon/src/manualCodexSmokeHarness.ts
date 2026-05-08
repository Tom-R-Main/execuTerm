import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ExfClient, type AgentWorkItemResponse } from './exfClient.js';
import {
  readAuthToken,
  readDaemonConfig,
  writeDaemonConfig,
} from './config.js';

const PASS_COMMANDS = ['npm run build', 'npm test'];
const FAIL_COMMANDS = [
  'node -e "console.log(\'Bearer abc.def.ghi exf_pat_fake_secret_123456789012 claim-1234-secret OPENAI_API_KEY=sk-testfake123456789012\'); process.exit(1)"',
];

function requireCommand(command: string, args: string[] = []): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function postJson(url: string, token: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-execuTerm-Dashboard-Token': token,
    },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`POST ${url} failed ${response.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GET ${url} failed ${response.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed as T;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function createTempRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    scripts: {
      build: 'node -e "console.log(\'build ok\')"',
      test: 'node -e "console.log(\'test ok\')"',
    },
  }, null, 2));
  writeFileSync(join(repo, 'README.md'), 'execuTerm worktree smoke repo\n');
  run('git', ['init'], repo);
  run('git', ['config', 'user.email', 'smoke@execufunction.local'], repo);
  run('git', ['config', 'user.name', 'execuTerm Smoke'], repo);
  run('git', ['add', 'package.json', 'README.md'], repo);
  run('git', ['commit', '-m', 'initial smoke repo'], repo);
  return repo;
}

function configureTemporaryVcs(worktreeRoot: string): () => void {
  const original = readDaemonConfig();
  writeDaemonConfig({
    ...original,
    vcs: {
      ...(original.vcs || {}),
      enabled: true,
      autoCreateWorktree: true,
      worktreeRoot,
      jjEnabled: false,
      autoMerge: false,
      allowPush: false,
    },
  });
  return () => writeDaemonConfig(original);
}

function findVerificationArtifact(workItem: AgentWorkItemResponse, status?: 'passed' | 'failed') {
  const artifacts = Array.isArray(workItem.artifactRefs) ? workItem.artifactRefs : [];
  return artifacts.find((artifact) => {
    const candidate = artifact as { type?: unknown; aggregateStatus?: unknown };
    return candidate.type === 'verification_result' && (!status || candidate.aggregateStatus === status);
  }) as
    | {
        type: 'verification_result';
        aggregateStatus: 'passed' | 'failed';
        commands: Array<{ command: string; exitCode: number | null; stdoutTail?: string; stderrTail?: string }>;
      }
    | undefined;
}

function findArtifact(workItem: AgentWorkItemResponse, type: string) {
  const artifacts = Array.isArray(workItem.artifactRefs) ? workItem.artifactRefs : [];
  return artifacts.find((artifact) => {
    const candidate = artifact as { type?: unknown };
    return candidate.type === type;
  }) as Record<string, unknown> | undefined;
}

function artifactTypes(workItem: AgentWorkItemResponse): string[] {
  return (Array.isArray(workItem.artifactRefs) ? workItem.artifactRefs : [])
    .map((artifact) => (artifact as { type?: unknown }).type)
    .filter((type): type is string => typeof type === 'string');
}

async function waitForRalphRun(
  dashboardUrl: string,
  workItemId: string,
  predicate: (run: {
    workItemId: string;
    status: string;
    stopReason?: string;
    currentIteration?: number;
  }) => boolean,
  label: string
) {
  const deadline = Date.now() + 90_000;
  let latest: unknown;
  while (Date.now() < deadline) {
    const status = await getJson<{
      ralphRuns?: Array<{
        workItemId: string;
        status: string;
        stopReason?: string;
        currentIteration?: number;
      }>;
    }>(`${dashboardUrl}/api/status`);
    const run = status.ralphRuns?.find((candidate) => candidate.workItemId === workItemId);
    latest = run;
    if (run && predicate(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${label}; latest=${JSON.stringify(latest)}`);
}

function hasRawFakeSecret(value: string): boolean {
  return /Bearer abc\.def\.ghi|exf_pat_fake_secret|claim-1234-secret|OPENAI_API_KEY=sk-testfake/.test(value);
}

function killSmokeCodex(title: string): void {
  const ps = run('ps', ['-axo', 'pid=,command=']);
  const matches = ps
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('codex') && line.includes(title))
    .map((line) => Number(line.split(/\s+/, 1)[0]))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
  for (const pid of matches) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Best effort cleanup for manual smoke processes.
    }
  }
}

async function waitForWorkItem(
  client: ExfClient,
  workItemId: string,
  predicate: (workItem: AgentWorkItemResponse) => boolean,
  label: string,
  timeoutMs = 30_000
): Promise<AgentWorkItemResponse> {
  const deadline = Date.now() + timeoutMs;
  let latest: AgentWorkItemResponse | undefined;
  while (Date.now() < deadline) {
    const result = await client.getWorkItem(workItemId);
    if (result.data?.workItem) {
      latest = result.data.workItem;
      if (predicate(latest)) return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${label}; latest status=${latest?.status || 'unknown'}`);
}

async function waitForWorkspace(
  dashboardUrl: string,
  workItemId: string
): Promise<{ workspaceId: string; worktreePath: string }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = await getJson<{
      agents?: Array<{
        workspaceId?: string;
        workItemId?: string;
        state?: string;
        sourceControl?: { worktreePath?: string };
      }>;
    }>(`${dashboardUrl}/api/status`);
    const agent = status.agents?.find((candidate) => candidate.workItemId === workItemId);
    if (agent?.workspaceId && agent.state === 'running' && agent.sourceControl?.worktreePath) {
      return {
        workspaceId: agent.workspaceId,
        worktreePath: agent.sourceControl.worktreePath,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for worktree workspace for ${workItemId}`);
}

async function createSyntheticTask(client: ExfClient, title: string) {
  const result = await client.createTask({
    title,
    description: 'Synthetic worktree-backed execuTerm verification smoke.',
    priority: 'delegate',
    effort: 'trivial',
    phase: 'open',
    acceptanceCriteria: [
      { text: 'work item reaches needs_review', met: false },
      { text: 'verification artifacts persist', met: false },
      { text: 'task executorAgent remains unchanged', met: false },
    ],
    scope: {
      include: ['synthetic smoke only', 'temporary git repo only'],
      exclude: ['production implementation tasks', 'openmemory.md', 'node_modules'],
    },
  });
  assert(result.data?.task?.id, result.error || 'Failed to create synthetic task');
  return result.data.task as { id: string; title: string; executorAgent?: string | null };
}

async function createSyntheticWorkItem(
  client: ExfClient,
  task: { id: string; title: string },
  title: string,
  commands: string[]
): Promise<AgentWorkItemResponse> {
  const result = await client.createWorkItem({
    title,
    taskId: task.id,
    assignedAlias: 'codex',
    prompt: `# Task: ${title}\n\nSynthetic execuTerm worktree verification smoke. Do not touch production files.`,
    inputContext: {
      source: 'executerm.manual_worktree_smoke',
      taskId: task.id,
    },
    acceptanceCriteria: [
      { text: 'worktree artifacts attach', met: false },
      { text: 'verification result persists', met: false },
    ],
    writeScope: {
      include: ['temporary git worktree only'],
      exclude: ['production files', 'node_modules', 'openmemory.md'],
    },
    verificationCommands: commands,
  });
  assert(result.data?.workItem?.id, result.error || 'Failed to create synthetic work item');
  return result.data.workItem;
}

async function runWorktreeCase(input: {
  client: ExfClient;
  dashboardUrl: string;
  dashboardToken: string;
  repo: string;
  task: { id: string; title: string; executorAgent?: string | null };
  title: string;
  commands: string[];
  expectedStatus: 'passed' | 'failed';
}) {
  const workItem = await createSyntheticWorkItem(
    input.client,
    input.task,
    input.title,
    input.commands
  );
  await postJson(`${input.dashboardUrl}/api/work-items/dispatch`, input.dashboardToken, {
    workItemId: workItem.id,
    agentType: 'codex',
    cwdOverride: input.repo,
  });
  const workspace = await waitForWorkspace(input.dashboardUrl, workItem.id);
  writeFileSync(
    join(workspace.worktreePath, `executerm-smoke-${input.expectedStatus}.txt`),
    `execuTerm ${input.expectedStatus} smoke\n`
  );
  await postJson(`${input.dashboardUrl}/hooks/agent`, input.dashboardToken, {
    workspaceId: workspace.workspaceId,
    state: 'review_ready',
  });
  const reviewReady = await waitForWorkItem(
    input.client,
    workItem.id,
    (candidate) => candidate.status === 'needs_review',
    `${workItem.id} needs_review`
  );
  const types = artifactTypes(reviewReady);
  for (const expected of ['branch', 'worktree', 'base_revision', 'changed_files']) {
    assert(types.includes(expected), `Missing ${expected} artifact for ${workItem.id}: ${types.join(', ')}`);
  }
  const checks = await postJson(
    `${input.dashboardUrl}/api/work-items/${encodeURIComponent(workItem.id)}/run-checks`,
    input.dashboardToken,
    {}
  ) as { artifact?: unknown };
  assert(!!checks.artifact, `Run checks did not return an artifact for ${workItem.id}`);
  const verified = await waitForWorkItem(
    input.client,
    workItem.id,
    (candidate) => !!findVerificationArtifact(candidate, input.expectedStatus),
    `${workItem.id} verification artifact`
  );
  const verification = findVerificationArtifact(verified, input.expectedStatus);
  assert(verification, `Missing ${input.expectedStatus} verification artifact`);
  assert(verification.commands[0]?.exitCode === (input.expectedStatus === 'passed' ? 0 : 1), 'Unexpected first verification exit code');
  if (input.expectedStatus === 'failed') {
    const output = verification.commands
      .map((command) => `${command.stdoutTail || ''}\n${command.stderrTail || ''}`)
      .join('\n');
    assert(!hasRawFakeSecret(output), 'Verification artifact persisted an unredacted fake secret');
    assert(verified.status === 'needs_review', 'Artifact append should not transition failed verification status');
    await postJson(
      `${input.dashboardUrl}/api/work-items/${encodeURIComponent(workItem.id)}/changes-with-output`,
      input.dashboardToken,
      { note: 'Synthetic smoke: request changes after failed verification.' }
    );
    await waitForWorkItem(
      input.client,
      workItem.id,
      (candidate) => candidate.status === 'queued',
      `${workItem.id} released after request changes`
    );
  }
  killSmokeCodex(input.title);
  return {
    workItemId: workItem.id,
    workspaceId: workspace.workspaceId,
    worktreePath: workspace.worktreePath,
    verificationStatus: input.expectedStatus,
  };
}

async function runWorktreeE2e(): Promise<void> {
  const dashboardUrl = process.env.EXECUTERM_DASHBOARD_URL?.replace(/\/$/, '');
  const dashboardToken = process.env.EXECUTERM_DASHBOARD_TOKEN;
  assert(dashboardUrl, 'EXECUTERM_DASHBOARD_URL is required for --worktree-e2e');
  assert(dashboardToken, 'EXECUTERM_DASHBOARD_TOKEN is required for --worktree-e2e');

  const config = readDaemonConfig();
  const pat = readAuthToken();
  assert(pat, 'execuTerm auth token is required for --worktree-e2e');
  const client = new ExfClient({ apiUrl: config.apiUrl, pat });

  const suffix = Date.now();
  const repo = createTempRepo('executerm-vcs-smoke-');
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'executerm-vcs-worktrees-'));
  const restoreConfig = configureTemporaryVcs(worktreeRoot);
  const createdTitles: string[] = [];

  try {
    const task = await createSyntheticTask(client, `execuTerm worktree verification smoke ${suffix}`);
    const passTitle = `execuTerm worktree verification pass ${suffix}`;
    const failTitle = `execuTerm worktree verification fail ${suffix}`;
    createdTitles.push(passTitle, failTitle);
    const pass = await runWorktreeCase({
      client,
      dashboardUrl,
      dashboardToken,
      repo,
      task,
      title: passTitle,
      commands: PASS_COMMANDS,
      expectedStatus: 'passed',
    });
    const taskAfterPass = await client.getTask(task.id);
    assert(
      (taskAfterPass.data?.task as { executorAgent?: unknown } | undefined)?.executorAgent == null,
      'Parent task executorAgent changed after passing smoke'
    );
    const fail = await runWorktreeCase({
      client,
      dashboardUrl,
      dashboardToken,
      repo,
      task,
      title: failTitle,
      commands: FAIL_COMMANDS,
      expectedStatus: 'failed',
    });
    const taskAfterFail = await client.getTask(task.id);
    assert(
      (taskAfterFail.data?.task as { executorAgent?: unknown } | undefined)?.executorAgent == null,
      'Parent task executorAgent changed after failing smoke'
    );
    console.log(JSON.stringify({
      ok: true,
      mode: 'worktree-e2e',
      taskId: task.id,
      repo,
      worktreeRoot,
      pass,
      fail,
    }, null, 2));
  } finally {
    restoreConfig();
    for (const title of createdTitles) killSmokeCodex(title);
  }
}

async function runRalphE2e(): Promise<void> {
  const dashboardUrl = process.env.EXECUTERM_DASHBOARD_URL?.replace(/\/$/, '');
  const dashboardToken = process.env.EXECUTERM_DASHBOARD_TOKEN;
  assert(dashboardUrl, 'EXECUTERM_DASHBOARD_URL is required for --ralph-e2e');
  assert(dashboardToken, 'EXECUTERM_DASHBOARD_TOKEN is required for --ralph-e2e');
  assert(
    process.env.EXECUTERM_CONFIRM_REAL_CODEX === '1',
    [
      'EXECUTERM_CONFIRM_REAL_CODEX=1 is required for --ralph-e2e.',
      'Do not set it until you are running the tagged dev app and can visually confirm Codex is the actor.',
      'This prevents the smoke from silently passing on a forced review_ready hook alone.',
    ].join(' ')
  );

  const config = readDaemonConfig();
  const pat = readAuthToken();
  assert(pat, 'execuTerm auth token is required for --ralph-e2e');
  const client = new ExfClient({ apiUrl: config.apiUrl, pat });

  const suffix = Date.now();
  const repo = createTempRepo('executerm-ralph-smoke-');
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'executerm-ralph-worktrees-'));
  const restoreConfig = configureTemporaryVcs(worktreeRoot);
  const title = `execuTerm Ralph smoke ${suffix}`;

  try {
    const task = await createSyntheticTask(client, title);
    const workItem = await createSyntheticWorkItem(client, task, title, PASS_COMMANDS);
    await postJson(
      `${dashboardUrl}/api/work-items/${encodeURIComponent(workItem.id)}/ralph/start`,
      dashboardToken,
      {
        agentType: 'codex',
        maxIterations: 1,
        stopOnVerificationPassed: true,
        stopOnRepeatedFailure: true,
        stopOnSensitivePaths: true,
      }
    );
    const workspace = await waitForWorkspace(dashboardUrl, workItem.id);
    assert(existsSync(join(workspace.worktreePath, 'RALPH', 'PROMPT.md')), 'RALPH/PROMPT.md was not written');
    assert(existsSync(join(workspace.worktreePath, 'RALPH', 'IMPLEMENTATION_PLAN.md')), 'RALPH/IMPLEMENTATION_PLAN.md was not written');
    assert(existsSync(join(workspace.worktreePath, 'RALPH', 'VERIFY.md')), 'RALPH/VERIFY.md was not written');
    assert(existsSync(join(workspace.worktreePath, 'RALPH', 'STATE.json')), 'RALPH/STATE.json was not written');

    const naturalTimeoutMs = Number(process.env.EXECUTERM_RALPH_NATURAL_TIMEOUT_MS || '120000');
    let forcedReviewReadyFallback = false;
    try {
      await waitForWorkItem(
        client,
        workItem.id,
        (candidate) => candidate.status === 'needs_review',
        `${workItem.id} natural Ralph needs_review`,
        Number.isFinite(naturalTimeoutMs) ? naturalTimeoutMs : 120_000
      );
    } catch (error) {
      if (process.env.EXECUTERM_RALPH_FORCE_REVIEW_READY !== '1') {
        throw new Error(
          [
            error instanceof Error ? error.message : String(error),
            'Real Codex did not naturally reach needs_review within the timeout.',
            'If you visually confirmed Codex launched and received the Ralph prompt, rerun with EXECUTERM_RALPH_FORCE_REVIEW_READY=1 to explicitly label the forced hook as a fallback.',
          ].join(' ')
        );
      }
      forcedReviewReadyFallback = true;
      writeFileSync(
        join(workspace.worktreePath, 'ralph-smoke-result.txt'),
        'execuTerm Ralph forced review_ready fallback smoke result\n'
      );
      await postJson(`${dashboardUrl}/hooks/agent`, dashboardToken, {
        workspaceId: workspace.workspaceId,
        state: 'review_ready',
      });
    }

    const run = await waitForRalphRun(
      dashboardUrl,
      workItem.id,
      (candidate) => candidate.status === 'needs_review',
      `${workItem.id} Ralph needs_review`
    );
    assert(run.stopReason === 'verification_passed', `Unexpected Ralph stop reason: ${run.stopReason}`);
    const reviewed = await waitForWorkItem(
      client,
      workItem.id,
      (candidate) =>
        candidate.status === 'needs_review' &&
        !!findVerificationArtifact(candidate, 'passed') &&
        !!findArtifact(candidate, 'ralph_iteration') &&
        !!findArtifact(candidate, 'ralph_stop_reason'),
      `${workItem.id} Ralph artifacts`
    );
    for (const expected of ['branch', 'worktree', 'base_revision', 'changed_files', 'verification_result', 'ralph_iteration', 'ralph_stop_reason']) {
      assert(artifactTypes(reviewed).includes(expected), `Missing ${expected} artifact for Ralph smoke`);
    }
    const taskAfter = await client.getTask(task.id);
    assert(
      (taskAfter.data?.task as { executorAgent?: unknown } | undefined)?.executorAgent == null,
      'Parent task executorAgent changed after Ralph smoke'
    );
    console.log(JSON.stringify({
      ok: true,
      mode: 'ralph-e2e',
      taskId: task.id,
      workItemId: workItem.id,
      repo,
      worktreeRoot,
      workspace,
      ralphRun: run,
      forcedReviewReadyFallback,
      realCodexAssertion: 'EXECUTERM_CONFIRM_REAL_CODEX=1 was set by the operator before running this smoke.',
    }, null, 2));
  } finally {
    restoreConfig();
    killSmokeCodex(title);
  }
}

async function runPreflight(): Promise<void> {
  const codexPath = requireCommand('sh', ['-lc', 'command -v codex']);
  const codexVersion = requireCommand('codex', ['--version']);
  const sandbox = mkdtempSync(join(tmpdir(), 'executerm-codex-smoke-'));
  writeFileSync(join(sandbox, 'package.json'), JSON.stringify({
    scripts: {
      build: 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(0)"',
    },
  }, null, 2));
  writeFileSync(join(sandbox, 'README.md'), 'execuTerm Codex smoke sandbox\n');

  const dashboardUrl = process.env.EXECUTERM_DASHBOARD_URL;
  const dashboardToken = process.env.EXECUTERM_DASHBOARD_TOKEN;
  const taskId = process.env.EXECUTERM_SMOKE_TASK_ID;

  console.log(JSON.stringify({
    ok: true,
    codexPath,
    codexVersion,
    sandbox,
    expectedCommandShape: 'codex "$(cat <prompt-file>)"',
    dispatchReady: Boolean(dashboardUrl && dashboardToken && taskId),
  }, null, 2));

  if (dashboardUrl && dashboardToken && taskId) {
    const result = await postJson(
      `${dashboardUrl.replace(/\/$/, '')}/api/dispatch`,
      dashboardToken,
      { taskId, agentType: 'codex' }
    );
    console.log(JSON.stringify({ dispatched: true, result }, null, 2));
  } else if (!existsSync(sandbox)) {
    throw new Error('Smoke sandbox was not created');
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--ralph-e2e') || process.env.EXECUTERM_SMOKE_MODE === 'ralph-e2e') {
    await runRalphE2e();
    return;
  }
  if (process.argv.includes('--worktree-e2e') || process.env.EXECUTERM_SMOKE_MODE === 'worktree-e2e') {
    await runWorktreeE2e();
    return;
  }
  await runPreflight();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
