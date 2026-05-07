// Workspace templates
export type WorkspaceKind = 'agent' | 'dev_server' | 'dashboard' | 'shell';
export type AgentType = 'claude-code' | 'codex' | 'gemini';
export type AgentLaunchMode =
  | 'command_only'
  | 'prompt_argument'
  | 'interactive_message';
export type SessionState =
  | 'starting'
  | 'running'
  | 'waiting_input'
  | 'review_ready'
  | 'failed'
  | 'stopped';
export type ResumeCapability = 'claude' | 'codex' | 'none';
export type CheckpointStatus = 'idle' | 'pending' | 'saved' | 'failed';
export type ContextSourceType = 'note' | 'memory' | 'task' | 'file';
export type DashboardRefreshMode = 'timed' | 'manual';
export type SourceControlMode =
  | 'none'
  | 'git-worktree'
  | 'jj-coordinator'
  | 'jj-workspace-experimental';
export type MergeStatus =
  | 'none'
  | 'candidate'
  | 'clean'
  | 'conflicted'
  | 'failed'
  | 'landed'
  | 'dismissed';

export type AgentWorkStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'blocked'
  | 'needs_review'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface AgentWorkItem {
  id: string;
  taskId?: string | null;
  projectId?: string | null;
  title: string;
  status: AgentWorkStatus;
  assignedAlias?: string | null;
  assignedAliasDisplayName?: string | null;
  assignedAliasAgentType?: string | null;
  claimOwner?: string | null;
  claimToken?: string | null;
  claimExpiresAt?: string | null;
  verificationCommands?: string[];
  artifactRefs?: unknown[];
  updatedAt?: string;
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
  workItemId?: string;
  claimToken?: string;
  claimOwner?: string;
  assignedAlias?: string;
  projectId?: string;
  surfaceId?: string;
  state: SessionState;
  lastActivity: string; // ISO timestamp
  resumeId?: string;
  resumeCommand?: string;
  resumeCapability?: ResumeCapability;
  checkpointStatus?: CheckpointStatus;
  checkpointedAt?: string;
  attachedContextItems?: AttachedContextItem[];
  sourceControl?: SourceControlState;
}

export interface SourceControlState {
  mode: SourceControlMode;
  repoRoot: string;
  coordinatorRoot?: string;
  worktreePath?: string;
  baseRevision?: string;
  branchName?: string;
  jjChangeId?: string;
  opIdBefore?: string;
  opIdAfter?: string;
  mergeStatus?: MergeStatus;
  lastSnapshotAt?: string;
}

export interface AttachedContextItem {
  id: string;
  sourceType: ContextSourceType;
  title: string;
  excerpt: string;
  filePath?: string;
  projectId?: string;
  attachedAt: string;
  pinned: boolean;
  estimatedChars: number;
}

export interface SavedResumableSession {
  id: string;
  workspaceId: string;
  title: string;
  cwd: string;
  agentType: AgentType;
  taskId?: string;
  workItemId?: string;
  claimToken?: string;
  claimOwner?: string;
  assignedAlias?: string;
  projectId?: string;
  resumeId: string;
  resumeCommand: string;
  resumeCapability: Exclude<ResumeCapability, 'none'>;
  checkpointStatus: 'saved';
  checkpointedAt: string;
  attachedContextItems?: AttachedContextItem[];
  sourceControl?: SourceControlState;
}

export interface NotificationPreferences {
  onNeedsInput: boolean;
  onFinished: boolean;
  onFailed: boolean;
}

export interface ToolAugmentConfig {
  enabled: boolean;
  tools: string[];
  semanticTimeoutMs: number;
  maxSemanticResults: number;
  minQueryLength: number;
  repositoryId?: string;
}

export interface VcsConfig {
  enabled: boolean;
  worktreeRoot: string;
  jjEnabled: boolean;
  autoCreateWorktree: boolean;
  autoMerge: boolean;
  allowPush: boolean;
}

export interface SourceControlStatus {
  cwd: string;
  isGitRepo: boolean;
  repoRoot?: string;
  branchName?: string;
  headRevision?: string;
  isDirty?: boolean;
  isWorktree?: boolean;
  jjColocated?: boolean;
  jjAvailable?: boolean;
  jjRoot?: string;
  error?: string;
}

export interface AugmentLogEntry {
  timestamp: string;
  workspaceId?: string;
  tool: string;
  query: string;
  cwd: string;
  realDurationMs: number;
  semanticDurationMs: number;
  semanticResultCount: number;
  semanticStatus: 'ok' | 'timeout' | 'error' | 'skipped';
  semanticError?: string;
}

export interface DaemonConfig {
  apiUrl: string; // default: https://execufunction.com
  pollIntervalMs: number; // default: 10000
  dashboardRefreshMode: DashboardRefreshMode; // default: timed
  dashboardRefreshIntervalMs: number; // default: 10000
  defaultProjectId?: string;
  dashboardPort?: number; // default: auto-assign
  projectDirectories?: Record<string, string>;
  recentDirectories?: string[];
  lastLaunchDirectory?: string;
  projectAgentPreferences?: Partial<Record<string, AgentType>>;
  lastAgentType?: AgentType;
  launchFailureTimeoutMs?: number;
  notifications?: NotificationPreferences;
  augment?: ToolAugmentConfig;
  vcs?: VcsConfig;
}

export interface DaemonState {
  workspaces: Record<string, LocalWorkspace>;
  savedSessions: Record<string, SavedResumableSession>;
  hookServerPort: number;
  lastSync: string;
}

export type DaemonAuthStatus =
  | 'authenticated'
  | 'unauthenticated'
  | 'device_flow'
  | 'error';

export interface DaemonAuthState {
  status: DaemonAuthStatus;
  message?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  expiresAt?: string;
}

export interface WorkspaceTemplate {
  id: string;
  name: string;
  kind: WorkspaceKind;
  agentType?: AgentType;
  command: string;
  managedCommand?: string;
  cwd?: string;
  icon?: string;
  color?: string;
  port?: number; // for dev servers
  hidden?: boolean;
  launchMode?: AgentLaunchMode;
}

export interface AgentSession {
  workspaceId: string;
  surfaceId?: string;
  taskId?: string;
  workItemId?: string;
  claimToken?: string;
  claimOwner?: string;
  assignedAlias?: string;
  agentType: AgentType;
  state: SessionState;
  startedAt: string;
  lastStateChange: string;
  error?: string;
  resumeId?: string;
  resumeCommand?: string;
  resumeCapability?: ResumeCapability;
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
