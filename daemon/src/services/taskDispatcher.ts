import type { ExfClient } from '../exfClient.js';
import { buildTaskPrompt } from '../promptBuilder.js';
import type { CodeMemory, ProjectContext, TaskContext } from '../promptBuilder.js';
import type { AgentType } from '../types.js';
import { toTaskExecutorAgent } from '../types.js';
import type { AgentManager } from './agentManager.js';
import type { WorkspaceManager } from './workspaceManager.js';

export class TaskDispatcher {
  constructor(
    private exfClient: ExfClient,
    private workspaceManager: WorkspaceManager,
    private agentManager: AgentManager
  ) {}

  async dispatch(taskId: string, agentType: AgentType): Promise<string> {
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
    const searchQuery =
      (task.title as string) +
      ' ' +
      ((task.rationale as string) || (task.description as string) || '');
    const memResult = await this.exfClient.searchCodeMemories({
      query: searchQuery.trim(),
      limit: 5,
    });
    if (memResult.data?.memories) {
      memories = memResult.data.memories.map((m) => ({
        fact: m.content,
        category: m.factType,
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

    // 5. Build prompt
    const prompt = buildTaskPrompt(taskContext, projectContext, memories);

    // 6. Create workspace from template
    const workspaceId = await this.workspaceManager.createFromTemplate(
      agentType,
      {
        taskId,
        projectId: task.projectId as string | undefined,
        title: task.title as string,
        initialPrompt: prompt,
      }
    );

    // 7. Update task in ExecuFunction (use correct backend enum)
    await this.exfClient.updateTask(taskId, {
      executorAgent: toTaskExecutorAgent(agentType),
      phase: 'in_flight',
    });

    // 8. Register agent session
    this.agentManager.register({
      workspaceId,
      taskId,
      agentType,
      state: 'starting',
      startedAt: new Date().toISOString(),
      lastStateChange: new Date().toISOString(),
    });

    return workspaceId;
  }
}
