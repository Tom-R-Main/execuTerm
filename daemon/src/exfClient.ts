/**
 * Minimal ExecuFunction API client for the daemon.
 *
 * Standalone — does not depend on the private monorepo.
 * Uses PAT (Personal Access Token) for authentication, same as exf CLI.
 */

interface ApiResponse<T> {
  data?: T;
  error?: string;
  statusCode: number;
}

export interface AgentWorkItemResponse {
  id: string;
  taskId?: string | null;
  projectId?: string | null;
  title: string;
  status: string;
  assignedAlias?: string | null;
  assignedAliasDisplayName?: string | null;
  assignedAliasAgentType?: string | null;
  claimOwner?: string | null;
  claimToken?: string | null;
  claimExpiresAt?: string | null;
  artifactRefs?: unknown[];
  updatedAt?: string;
}

export interface WorkLeaseInput {
  claimOwner?: string;
  claimToken?: string;
  leaseSeconds?: number;
}

export interface WorkResultInput extends WorkLeaseInput {
  resultSummary?: string | null;
  artifactRefs?: unknown[];
}

export interface ExfClientConfig {
  apiUrl: string;
  pat: string;
}

function generateIdempotencyKey(): string {
  return `daemon-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class ExfClient {
  private apiUrl: string;
  private pat: string;

  constructor(config: ExfClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.pat = config.pat;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<ApiResponse<T>> {
    const url = `${this.apiUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.pat}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    };

    // Mutation requests require an idempotency key
    if ((method === 'PATCH' || method === 'POST' || method === 'DELETE') && !headers['Idempotency-Key']) {
      headers['Idempotency-Key'] = generateIdempotencyKey();
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      const data = (await response.json()) as T;
      return { data, statusCode: response.status };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
        statusCode: 0,
      };
    }
  }

  // Tasks

  async listProjects(options?: { status?: string; includeArchived?: boolean }) {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.includeArchived) params.set('includeArchived', 'true');
    const query = params.toString();
    return this.request<{ projects: Record<string, unknown>[] }>(
      'GET',
      `/api/v1/projects${query ? `?${query}` : ''}`
    );
  }

  async getTask(taskId: string) {
    return this.request<{ task: Record<string, unknown> }>(
      'GET',
      `/api/v1/tasks/${taskId}`
    );
  }

  async updateTask(
    taskId: string,
    updates: {
      status?: string;
      phase?: string;
      executorAgent?: string;
      blockedReason?: string | null;
    }
  ) {
    return this.request<{ task: Record<string, unknown> }>(
      'PATCH',
      `/api/v1/tasks/${taskId}`,
      updates
    );
  }

  async listTasks(options?: {
    status?: string;
    limit?: number;
    phase?: string;
    priority?: string;
  }) {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.phase) params.set('phase', options.phase);
    if (options?.priority) params.set('priority', options.priority);
    const query = params.toString();
    return this.request<{ tasks: Record<string, unknown>[] }>(
      'GET',
      `/api/v1/tasks${query ? `?${query}` : ''}`
    );
  }

  // Projects

  async getProjectContext(projectId: string) {
    return this.request<{
      project: Record<string, unknown>;
    }>('GET', `/api/v1/projects/${projectId}/context`);
  }

  // Calendar

  async listCalendarEvents(options?: {
    startDate?: string;
    endDate?: string;
    limit?: number;
  }) {
    const params = new URLSearchParams();
    if (options?.startDate) params.set('startDate', options.startDate);
    if (options?.endDate) params.set('endDate', options.endDate);
    if (options?.limit) params.set('limit', options.limit.toString());
    const query = params.toString();
    return this.request<{ events: Record<string, unknown>[] }>(
      'GET',
      `/api/v1/calendar/events${query ? `?${query}` : ''}`
    );
  }

  async createTask(options: {
    title: string;
    description?: string;
    priority?: string;
    effort?: string;
    projectId?: string;
    when?: string;
    rationale?: string;
    deliverable?: string;
    verification?: string;
    approachConstraints?: string[];
    acceptanceCriteria?: Array<{ text: string; met?: boolean }>;
    scope?: { include?: string[]; exclude?: string[] };
    phase?: string;
    executorAgent?: string;
    goalId?: string;
    dueAt?: string;
    scheduledAt?: string;
  }) {
    return this.request<{ task: Record<string, unknown> }>(
      'POST',
      '/api/v1/tasks',
      options
    );
  }

  // Agent work items

  async listWorkItems(options?: {
    status?: string;
    assignedAlias?: string;
    assignedAliasId?: string;
    projectId?: string;
    taskId?: string;
    limit?: number;
  }) {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.assignedAlias) params.set('assignedAlias', options.assignedAlias);
    if (options?.assignedAliasId) params.set('assignedAliasId', options.assignedAliasId);
    if (options?.projectId) params.set('projectId', options.projectId);
    if (options?.taskId) params.set('taskId', options.taskId);
    if (options?.limit) params.set('limit', options.limit.toString());
    const query = params.toString();
    return this.request<{ workItems: AgentWorkItemResponse[] }>(
      'GET',
      `/api/v1/work-items${query ? `?${query}` : ''}`
    );
  }

  async getWorkItem(id: string) {
    return this.request<{ workItem: AgentWorkItemResponse }>(
      'GET',
      `/api/v1/work-items/${encodeURIComponent(id)}`
    );
  }

  async createWorkItem(input: {
    title: string;
    prompt?: string | null;
    taskId?: string | null;
    projectId?: string | null;
    assignedAlias?: string | null;
    queueRank?: number;
    inputContext?: Record<string, unknown>;
    acceptanceCriteria?: unknown[];
    allowedActions?: Record<string, unknown>;
    writeScope?: Record<string, unknown>;
    verificationCommands?: string[];
  }) {
    return this.request<{ workItem: AgentWorkItemResponse }>(
      'POST',
      '/api/v1/work-items',
      input
    );
  }

  async claimWorkItem(input: {
    workItemId?: string;
    assignedAlias?: string;
    assignedAliasId?: string;
    claimOwner: string;
    leaseSeconds?: number;
  }) {
    return this.request<{ workItem: AgentWorkItemResponse }>(
      'POST',
      '/api/v1/work-items/claim',
      input
    );
  }

  async startWorkItem(id: string, input: WorkLeaseInput) {
    return this.request<{ workItem: AgentWorkItemResponse }>(
      'POST',
      `/api/v1/work-items/${encodeURIComponent(id)}/start`,
      input
    );
  }

  async heartbeatWorkItem(id: string, input: WorkLeaseInput) {
    return this.request<{ workItem: AgentWorkItemResponse }>(
      'POST',
      `/api/v1/work-items/${encodeURIComponent(id)}/heartbeat`,
      input
    );
  }

  async markWorkItemNeedsReview(id: string, input: WorkResultInput) {
    return this.request<{ workItem: AgentWorkItemResponse }>(
      'POST',
      `/api/v1/work-items/${encodeURIComponent(id)}/review`,
      input
    );
  }

  async completeWorkItem(id: string, input: WorkResultInput) {
    return this.request<{ workItem: AgentWorkItemResponse }>(
      'POST',
      `/api/v1/work-items/${encodeURIComponent(id)}/complete`,
      input
    );
  }

  async failWorkItem(
    id: string,
    input: WorkResultInput & { failureReason?: string | null }
  ) {
    return this.request<{ workItem: AgentWorkItemResponse }>(
      'POST',
      `/api/v1/work-items/${encodeURIComponent(id)}/fail`,
      input
    );
  }

  async releaseWorkItem(id: string, input: { claimToken?: string } = {}) {
    return this.request<{ workItem: AgentWorkItemResponse }>(
      'POST',
      `/api/v1/work-items/${encodeURIComponent(id)}/release`,
      input
    );
  }

  async cancelWorkItem(id: string, input: { resultSummary?: string | null } = {}) {
    return this.request<{ workItem: AgentWorkItemResponse }>(
      'POST',
      `/api/v1/work-items/${encodeURIComponent(id)}/cancel`,
      input
    );
  }

  // Notes

  async searchNotes(options: { query: string; limit?: number }) {
    const params = new URLSearchParams();
    params.set('query', options.query);
    if (options.limit) params.set('limit', options.limit.toString());
    return this.request<{ notes: Record<string, unknown>[] }>(
      'GET',
      `/api/v1/notes/search?${params.toString()}`
    );
  }

  // People

  async searchPeople(options: { query: string; limit?: number }) {
    const params = new URLSearchParams();
    params.set('query', options.query);
    if (options.limit) params.set('limit', options.limit.toString());
    return this.request<{ people: Record<string, unknown>[] }>(
      'GET',
      `/api/v1/people/search?${params.toString()}`
    );
  }

  // Code Memory

  async searchCodeMemories(options: {
    query: string;
    scopePaths?: string[];
    limit?: number;
  }) {
    return this.request<{
      memories: Array<{
        id: string;
        factType: string;
        content: string;
        filePath?: string;
        confidence: number;
        distance?: number;
        relevanceScore?: number;
      }>;
    }>('POST', '/api/v1/code/memories/search', options);
  }
}
