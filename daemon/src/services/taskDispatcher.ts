import { randomUUID } from 'node:crypto';

import { readDaemonConfig } from '../config.js';
import type { AgentWorkItemResponse } from '../exfClient.js';
import type { ExfClient } from '../exfClient.js';
import { buildTaskPrompt } from '../promptBuilder.js';
import type { CodeMemory, ProjectContext, TaskContext } from '../promptBuilder.js';
import type { AgentType } from '../types.js';
import type { AgentManager } from './agentManager.js';
import type { DirectoryManager } from './directoryManager.js';
import { TraceRecorder } from './observability/traceRecorder.js';
import { GitWorktreeManager } from './vcs/gitWorktreeManager.js';
import type { WorkspaceManager } from './workspaceManager.js';

const MAX_QUERY_LENGTH = 500;
const DEFAULT_LEASE_SECONDS = 3600;

function agentAliasFor(agentType: AgentType): string {
  return agentType;
}

function claimOwnerFor(agentType: AgentType): string {
  return `executerm:${agentType}`;
}

function buildMemorySearchQuery(task: Record<string, unknown>): string {
  const parts: string[] = [];
  if (task.title) parts.push(task.title as string);
  if (task.rationale) parts.push(task.rationale as string);
  else if (task.description) parts.push(task.description as string);
  if (task.deliverable) parts.push(task.deliverable as string);
  const scope = task.scope as { include?: string[] } | undefined;
  if (scope?.include?.length) parts.push(scope.include.join(' '));
  const criteria = task.acceptanceCriteria as Array<{ text: string }> | undefined;
  if (criteria?.length) parts.push(criteria.map((c) => c.text).join(' '));
  return parts.join(' ').trim().slice(0, MAX_QUERY_LENGTH);
}

export class TaskDispatcher {
  constructor(
    private exfClient: ExfClient,
    private directoryManager: DirectoryManager,
    private workspaceManager: WorkspaceManager,
    private agentManager: AgentManager,
    private gitWorktreeManager = new GitWorktreeManager(),
    private trace = new TraceRecorder()
  ) {}

  async dispatch(
    taskId: string,
    agentType: AgentType,
    opts?: { cwdOverride?: string }
  ): Promise<string> {
    return this.trace.span(
      'dispatch.task',
      { taskId, agentType },
      () => this.dispatchTaskInternal(taskId, agentType, opts)
    );
  }

  private async dispatchTaskInternal(
    taskId: string,
    agentType: AgentType,
    opts?: { cwdOverride?: string }
  ): Promise<string> {
    // 1. Fetch task
    const taskResult = await this.exfClient.getTask(taskId);
    if (!taskResult.data?.task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const task = taskResult.data.task as Record<string, unknown>;

    // 2. Fetch project context if available
    let projectContext: ProjectContext | null = null;
    if (task.projectId) {
      const ctxResult = await this.exfClient.getProjectContext(
        task.projectId as string
      );
      if (ctxResult.data?.project) {
        projectContext = ctxResult.data.project as unknown as ProjectContext;
      }
    }

    // 3. Search code memory for relevant decisions
    let memories: CodeMemory[] = [];
    const searchQuery = buildMemorySearchQuery(task);
    const scopeInclude = (task.scope as { include?: string[] } | undefined)?.include;
    const memResult = await this.exfClient.searchCodeMemories({
      query: searchQuery,
      scopePaths: scopeInclude,
      limit: 10,
    });
    if (memResult.data?.memories) {
      memories = memResult.data.memories.map((m) => ({
        fact: m.content,
        category: m.factType,
        filePath: m.filePath,
      }));
    }

    // 4. Build task context from brief fields
    const taskContext: TaskContext = {
      title: task.title as string,
      description: task.description as string | undefined,
      rationale: task.rationale as string | undefined,
      deliverable: task.deliverable as string | undefined,
      verification: task.verification as string | undefined,
      approachConstraints: task.approachConstraints as string[] | undefined,
      acceptanceCriteria: task.acceptanceCriteria as
        | Array<{ text: string; met?: boolean }>
        | undefined,
      scope: task.scope as
        | { include?: string[]; exclude?: string[] }
        | undefined,
    };

    // 5. Build prompt and create claimable agent work for this human task.
    const prompt = buildTaskPrompt(taskContext, projectContext, memories);
    const projectId = task.projectId as string | undefined;
    const assignedAlias = agentAliasFor(agentType);
    const claimOwner = claimOwnerFor(agentType);
    const created = await this.exfClient.createWorkItem({
      title: task.title as string,
      prompt,
      taskId,
      projectId: projectId ?? null,
      assignedAlias,
      inputContext: {
        source: 'executerm.task_dispatch',
        taskId,
        projectId: projectId ?? null,
      },
      acceptanceCriteria:
        (task.acceptanceCriteria as unknown[] | undefined) ?? [],
      writeScope: task.scope as Record<string, unknown> | undefined,
      verificationCommands:
        typeof task.verification === 'string' && task.verification.trim()
          ? [task.verification.trim()]
          : [],
    });
    const workItem = created.data?.workItem;
    if (!workItem?.id) {
      throw new Error(created.error || 'Failed to create agent work item');
    }

    this.trace.record({
      name: 'dispatch.work_item_created',
      attributes: {
        taskId,
        workItemId: workItem.id,
        agentType,
        assignedAlias,
      },
      outcome: 'success',
    });

    return this.dispatchClaimedWorkItem(workItem, agentType, {
      task,
      prompt,
      cwdOverride: opts?.cwdOverride,
      assignedAlias,
      claimOwner,
      projectId,
    });
  }

  async dispatchWorkItem(
    workItemId: string,
    agentType: AgentType = 'codex',
    opts?: { cwdOverride?: string }
  ): Promise<string> {
    return this.trace.span(
      'dispatch.work_item',
      { workItemId, agentType },
      () => this.dispatchWorkItemInternal(workItemId, agentType, opts)
    );
  }

  private async dispatchWorkItemInternal(
    workItemId: string,
    agentType: AgentType = 'codex',
    opts?: { cwdOverride?: string }
  ): Promise<string> {
    const claimOwner = claimOwnerFor(agentType);
    const claimed = await this.exfClient.claimWorkItem({
      workItemId,
      assignedAlias: agentAliasFor(agentType),
      claimOwner,
      leaseSeconds: DEFAULT_LEASE_SECONDS,
    });
    const workItem = claimed.data?.workItem;
    if (!workItem?.id) {
      throw new Error(claimed.error || 'Failed to claim agent work item');
    }
    this.trace.record({
      name: 'dispatch.work_item_claimed',
      attributes: {
        workItemId: workItem.id,
        agentType,
        assignedAlias: workItem.assignedAlias,
      },
      outcome: 'success',
    });

    let task: Record<string, unknown> = {
      id: workItem.taskId ?? undefined,
      title: workItem.title,
      projectId: workItem.projectId ?? undefined,
    };
    if (workItem.taskId) {
      const taskResult = await this.exfClient.getTask(workItem.taskId);
      if (taskResult.data?.task) {
        task = taskResult.data.task as Record<string, unknown>;
      }
    }

    const prompt =
      typeof (workItem as any).prompt === 'string' && (workItem as any).prompt
        ? (workItem as any).prompt
        : `# Task: ${workItem.title}\n\nExecute this claimed Siftable agent work item.\n\nWork item: ${workItem.id}`;

    return this.dispatchClaimedWorkItem(workItem, agentType, {
      task,
      prompt,
      cwdOverride: opts?.cwdOverride,
      assignedAlias: workItem.assignedAlias || agentAliasFor(agentType),
      claimOwner,
      projectId: (workItem.projectId || task.projectId) as string | undefined,
    });
  }

  private async dispatchClaimedWorkItem(
    initialWorkItem: AgentWorkItemResponse,
    agentType: AgentType,
    opts: {
      task: Record<string, unknown>;
      prompt: string;
      cwdOverride?: string;
      assignedAlias: string;
      claimOwner: string;
      projectId?: string;
    }
  ): Promise<string> {
    let workItem = initialWorkItem;
    if (workItem.status !== 'claimed') {
      const claimed = await this.exfClient.claimWorkItem({
        workItemId: workItem.id,
        assignedAlias: opts.assignedAlias,
        claimOwner: opts.claimOwner,
        leaseSeconds: DEFAULT_LEASE_SECONDS,
      });
      if (!claimed.data?.workItem) {
        throw new Error(claimed.error || 'Failed to claim agent work item');
      }
      workItem = claimed.data.workItem;
      this.trace.record({
        name: 'dispatch.work_item_claimed',
        attributes: {
          workItemId: workItem.id,
          agentType,
          assignedAlias: opts.assignedAlias,
        },
        outcome: 'success',
      });
    }

    const started = await this.exfClient.startWorkItem(workItem.id, {
      claimOwner: opts.claimOwner,
      claimToken: workItem.claimToken ?? undefined,
      leaseSeconds: DEFAULT_LEASE_SECONDS,
    });
    if (started.data?.workItem) {
      workItem = started.data.workItem;
    }
    this.trace.record({
      name: 'dispatch.work_item_started',
      attributes: {
        workItemId: workItem.id,
        taskId: workItem.taskId,
        agentType,
        assignedAlias: opts.assignedAlias,
      },
      outcome: 'success',
    });

    const projectId = opts.projectId;
    let cwd = this.directoryManager.resolveTaskDirectory(
      projectId,
      opts.cwdOverride
    );
    let sourceControl;
    const config = readDaemonConfig();
    if (config.vcs?.enabled && config.vcs.autoCreateWorktree) {
      const result = await this.gitWorktreeManager.createForSession({
        cwd,
        workspaceId: randomUUID().toLowerCase(),
        workItemId: workItem.id,
        taskId: workItem.taskId ?? undefined,
        projectId,
        config: config.vcs,
      });
      cwd = result.cwd;
      sourceControl = result.sourceControl;
    }

    // 6. Create workspace from template
    const workspaceId = await this.workspaceManager.createFromTemplate(
      agentType,
      {
        taskId: workItem.taskId ?? undefined,
        workItemId: workItem.id,
        claimToken: workItem.claimToken ?? undefined,
        claimOwner: opts.claimOwner,
        assignedAlias: opts.assignedAlias,
        projectId,
        title: opts.task.title as string,
        cwd,
        initialPrompt: opts.prompt,
        sourceControl,
      }
    );
    this.trace.record({
      name: 'dispatch.workspace_launched',
      attributes: {
        workspaceId,
        workItemId: workItem.id,
        taskId: workItem.taskId,
        agentType,
        cwd,
        sourceControlMode: sourceControl?.mode,
      },
      outcome: 'success',
    });

    this.directoryManager.rememberAgentPreference(agentType, projectId);

    // Human task assignment remains separate from executable agent work.
    // Do not write task.executorAgent here; work item status is the execution source of truth.
    this.agentManager.register({
      workspaceId,
      taskId: workItem.taskId ?? undefined,
      workItemId: workItem.id,
      claimToken: workItem.claimToken ?? undefined,
      claimOwner: opts.claimOwner,
      assignedAlias: opts.assignedAlias,
      agentType,
      state: 'starting',
      startedAt: new Date().toISOString(),
      lastStateChange: new Date().toISOString(),
    });

    return workspaceId;
  }
}
