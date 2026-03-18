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
  }) {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.phase) params.set('phase', options.phase);
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

  // Code Memory

  async searchCodeMemories(options: { query: string; limit?: number }) {
    return this.request<{
      memories: Array<{
        id: string;
        factType: string;
        content: string;
        filePath?: string;
        confidence: number;
      }>;
    }>('POST', '/api/v1/code/memories/search', options);
  }
}
