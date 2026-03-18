// Workspace templates
export type WorkspaceKind = 'agent' | 'dev_server' | 'dashboard' | 'shell';
export type AgentType = 'claude-code' | 'codex' | 'gemini';
export type SessionState =
  | 'starting'
  | 'running'
  | 'waiting_input'
  | 'review_ready'
  | 'failed'
  | 'stopped';

// Maps local agent type to ExecuFunction task executorAgent enum
export type TaskExecutorAgent = 'claude_code' | 'codex' | 'gemini';

export function toTaskExecutorAgent(agent: AgentType): TaskExecutorAgent {
  const map: Record<AgentType, TaskExecutorAgent> = {
    'claude-code': 'claude_code',
    codex: 'codex',
    gemini: 'gemini',
  };
  return map[agent];
}

// cmux v2 response shapes (match real protocol)
export interface CmuxWorkspace {
  id: string;
  ref: string; // e.g. "workspace:1"
  index: number;
  title: string;
  selected: boolean;
  pinned: boolean;
  listening_ports?: number[];
  current_directory?: string;
  custom_color?: string;
}

export interface CmuxSurface {
  id: string;
  ref: string; // e.g. "surface:1"
  index: number;
  type: 'terminal' | 'browser';
  title: string;
  focused: boolean;
  pane_id: string;
  pane_ref: string;
  index_in_pane: number;
  selected_in_pane: boolean;
}

export interface WorkspaceListResult {
  window_id: string;
  window_ref: string;
  workspaces: CmuxWorkspace[];
}

export interface SurfaceListResult {
  window_id: string;
  window_ref: string;
  workspace_id: string;
  workspace_ref: string;
  surfaces: CmuxSurface[];
}

export interface WorkspaceCreateResult {
  window_id: string;
  window_ref: string;
  workspace_id: string;
  workspace_ref: string;
}

export interface BrowserOpenResult {
  surface_id: string;
  surface_ref: string;
  workspace_id: string;
  pane_id: string;
  window_id: string;
}

// Local workspace tracking
export interface LocalWorkspace {
  id: string; // cmux workspace UUID
  title: string;
  cwd: string;
  kind: WorkspaceKind;
  agentType?: AgentType;
  taskId?: string;
  projectId?: string;
  surfaceId?: string;
  state: SessionState;
  lastActivity: string; // ISO timestamp
}

export interface DaemonConfig {
  apiUrl: string; // default: https://execufunction.com
  pollIntervalMs: number; // default: 10000
  defaultProjectId?: string;
  dashboardPort?: number; // default: auto-assign
}

export interface DaemonState {
  workspaces: Record<string, LocalWorkspace>;
  hookServerPort: number;
  lastSync: string;
}

export interface WorkspaceTemplate {
  id: string;
  name: string;
  kind: WorkspaceKind;
  agentType?: AgentType;
  command: string;
  cwd?: string;
  icon?: string;
  color?: string;
  port?: number; // for dev servers
}

export interface AgentSession {
  workspaceId: string;
  surfaceId?: string;
  taskId?: string;
  agentType: AgentType;
  state: SessionState;
  startedAt: string;
  lastStateChange: string;
  error?: string;
}

// Real claude-hook-sessions.json format
export interface ClaudeHookSessionStoreFile {
  version: number;
  sessions: Record<string, ClaudeHookSessionRecord>;
}

export interface ClaudeHookSessionRecord {
  sessionId: string;
  workspaceId: string;
  surfaceId: string;
  cwd?: string;
  pid?: number;
  lastSubtitle?: string;
  lastBody?: string;
  startedAt: number; // Unix timestamp
  updatedAt: number; // Unix timestamp
}
