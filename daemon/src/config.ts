import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type {
  AttachedContextItem,
  DashboardRefreshMode,
  DaemonConfig,
  DaemonState,
  LocalWorkspace,
  RalphRunSnapshot,
  SavedResumableSession,
  ToolAugmentConfig,
  VcsConfig,
} from './types.js';

export const DEFAULT_NOTIFICATION_PREFS = {
  onNeedsInput: true,
  onFinished: true,
  onFailed: true,
};

export const DEFAULT_AUGMENT_CONFIG: ToolAugmentConfig = {
  enabled: false,
  tools: ['grep', 'rg'],
  semanticTimeoutMs: 1500,
  maxSemanticResults: 8,
  minQueryLength: 3,
};

export const DEFAULT_VCS_CONFIG: VcsConfig = {
  enabled: false,
  worktreeRoot: join(homedir(), '.execufunction', 'worktrees'),
  jjEnabled: false,
  autoCreateWorktree: false,
  autoMerge: false,
  allowPush: false,
};

const VALID_AUGMENT_TOOLS = new Set(['grep', 'rg']);

function normalizeAugmentConfig(
  input: Partial<ToolAugmentConfig> | undefined
): ToolAugmentConfig {
  const merged = { ...DEFAULT_AUGMENT_CONFIG, ...(input || {}) };
  const tools = Array.isArray(merged.tools)
    ? Array.from(
        new Set(
          merged.tools
            .map((t) => String(t).toLowerCase())
            .filter((t) => VALID_AUGMENT_TOOLS.has(t))
        )
      )
    : DEFAULT_AUGMENT_CONFIG.tools;
  const clamp = (n: unknown, lo: number, hi: number, fallback: number) => {
    const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
    return Math.max(lo, Math.min(hi, v));
  };
  return {
    enabled: !!merged.enabled,
    tools: tools.length > 0 ? tools : DEFAULT_AUGMENT_CONFIG.tools,
    semanticTimeoutMs: clamp(
      merged.semanticTimeoutMs,
      100,
      10000,
      DEFAULT_AUGMENT_CONFIG.semanticTimeoutMs
    ),
    maxSemanticResults: clamp(
      merged.maxSemanticResults,
      1,
      50,
      DEFAULT_AUGMENT_CONFIG.maxSemanticResults
    ),
    minQueryLength: clamp(
      merged.minQueryLength,
      1,
      20,
      DEFAULT_AUGMENT_CONFIG.minQueryLength
    ),
    repositoryId: merged.repositoryId ? String(merged.repositoryId) : undefined,
  };
}

function normalizeVcsConfig(
  input: Partial<VcsConfig> | undefined
): VcsConfig {
  const merged = { ...DEFAULT_VCS_CONFIG, ...(input || {}) };
  const worktreeRoot =
    typeof merged.worktreeRoot === 'string' && merged.worktreeRoot.trim()
      ? merged.worktreeRoot.trim().replace(/^~(?=\/|$)/, homedir())
      : DEFAULT_VCS_CONFIG.worktreeRoot;
  return {
    enabled: !!merged.enabled,
    worktreeRoot,
    jjEnabled: !!merged.jjEnabled,
    autoCreateWorktree: !!merged.autoCreateWorktree,
    autoMerge: false,
    allowPush: false,
  };
}

export const DEFAULT_DASHBOARD_REFRESH_MODE: DashboardRefreshMode = 'timed';
export const DEFAULT_DASHBOARD_REFRESH_INTERVAL_MS = 10000;
const VALID_DASHBOARD_REFRESH_INTERVALS = new Set([5000, 10000, 30000, 60000]);

const DEFAULT_CONFIG: DaemonConfig = {
  apiUrl: 'https://execufunction.com',
  pollIntervalMs: 10000,
  dashboardRefreshMode: DEFAULT_DASHBOARD_REFRESH_MODE,
  dashboardRefreshIntervalMs: DEFAULT_DASHBOARD_REFRESH_INTERVAL_MS,
  projectDirectories: {},
  recentDirectories: [],
  projectAgentPreferences: {},
  lastAgentType: 'codex',
  launchFailureTimeoutMs: 20000,
  notifications: { ...DEFAULT_NOTIFICATION_PREFS },
  augment: { ...DEFAULT_AUGMENT_CONFIG },
  vcs: { ...DEFAULT_VCS_CONFIG },
};

export function getConfigDir(): string {
  if (process.env.EXF_CONFIG_DIR) {
    return process.env.EXF_CONFIG_DIR;
  }
  const baseDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(baseDir, 'exf');
}

function getAuthFile(): string {
  return join(getConfigDir(), 'auth.json');
}

export function getAuthFilePath(): string {
  return getAuthFile();
}

function getDaemonConfigFile(): string {
  return join(getConfigDir(), 'terminal.json');
}

function getDaemonStateFile(): string {
  return join(getConfigDir(), 'terminal-state.json');
}

export function getTraceFilePath(): string {
  if (process.env.EXECUTERM_TRACE_FILE) {
    return process.env.EXECUTERM_TRACE_FILE;
  }
  return join(getConfigDir(), 'logs', 'executerm.trace.ndjson');
}

export function readAuthToken(): string | null {
  try {
    const content = readFileSync(getAuthFile(), 'utf-8');
    const config = JSON.parse(content) as { token?: string };
    return config.token || null;
  } catch {
    return null;
  }
}

export function writeAuthToken(token: string): void {
  mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  writeFileSync(getAuthFile(), JSON.stringify({ token }, null, 2), {
    mode: 0o600,
  });
}

export function deleteAuthToken(): void {
  try {
    unlinkSync(getAuthFile());
  } catch {
    // Already gone
  }
}

export function readDaemonConfig(): DaemonConfig {
  try {
    const content = readFileSync(getDaemonConfigFile(), 'utf-8');
    const fileConfig = JSON.parse(content) as Partial<DaemonConfig>;
    return normalizeDaemonConfig({ ...DEFAULT_CONFIG, ...fileConfig });
  } catch {
    return normalizeDaemonConfig({ ...DEFAULT_CONFIG });
  }
}

export function writeDaemonConfig(config: DaemonConfig): void {
  mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  writeFileSync(
    getDaemonConfigFile(),
    JSON.stringify(normalizeDaemonConfig(config), null, 2),
    {
      mode: 0o600,
    }
  );
}

export function normalizeDaemonConfig(config: Partial<DaemonConfig>): DaemonConfig {
  const merged = { ...DEFAULT_CONFIG, ...config };
  const refreshMode: DashboardRefreshMode =
    merged.dashboardRefreshMode === 'manual' ? 'manual' : 'timed';
  const refreshInterval = VALID_DASHBOARD_REFRESH_INTERVALS.has(
    Number(merged.dashboardRefreshIntervalMs)
  )
    ? Number(merged.dashboardRefreshIntervalMs)
    : DEFAULT_DASHBOARD_REFRESH_INTERVAL_MS;

  return {
    ...merged,
    dashboardRefreshMode: refreshMode,
    dashboardRefreshIntervalMs: refreshInterval,
    augment: normalizeAugmentConfig(merged.augment),
    vcs: normalizeVcsConfig(merged.vcs),
  };
}

export function writeDaemonState(state: DaemonState): void {
  mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  writeFileSync(getDaemonStateFile(), JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
}

function normalizeAttachedContextItems(
  items: unknown
): AttachedContextItem[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => item as Partial<AttachedContextItem>)
    .filter((item) => !!item.id && !!item.sourceType && typeof item.title === 'string')
    .map((item) => ({
      id: String(item.id),
      sourceType: item.sourceType as AttachedContextItem['sourceType'],
      title: String(item.title || ''),
      excerpt: String(item.excerpt || ''),
      filePath: item.filePath ? String(item.filePath) : undefined,
      projectId: item.projectId ? String(item.projectId) : undefined,
      attachedAt: String(item.attachedAt || new Date().toISOString()),
      pinned: item.pinned !== false,
      estimatedChars:
        typeof item.estimatedChars === 'number'
          ? item.estimatedChars
          : String(item.excerpt || '').length,
    }));
}

function normalizeWorkspace(
  workspace: Partial<LocalWorkspace>
): LocalWorkspace {
  return {
    ...(workspace as LocalWorkspace),
    id: String(workspace.id || ''),
    title: String(workspace.title || ''),
    cwd: String(workspace.cwd || ''),
    kind: (workspace.kind || 'shell') as LocalWorkspace['kind'],
    workItemId: workspace.workItemId ? String(workspace.workItemId) : undefined,
    claimToken: workspace.claimToken ? String(workspace.claimToken) : undefined,
    claimOwner: workspace.claimOwner ? String(workspace.claimOwner) : undefined,
    assignedAlias: workspace.assignedAlias ? String(workspace.assignedAlias) : undefined,
    state: (workspace.state || 'stopped') as LocalWorkspace['state'],
    lastActivity: String(workspace.lastActivity || new Date().toISOString()),
    attachedContextItems: normalizeAttachedContextItems(
      workspace.attachedContextItems
    ),
  };
}

function normalizeSavedSession(
  session: Partial<SavedResumableSession>
): SavedResumableSession {
  return {
    ...(session as SavedResumableSession),
    id: String(session.id || ''),
    workspaceId: String(session.workspaceId || ''),
    title: String(session.title || ''),
    cwd: String(session.cwd || ''),
    agentType: (session.agentType || 'codex') as SavedResumableSession['agentType'],
    workItemId: session.workItemId ? String(session.workItemId) : undefined,
    claimToken: session.claimToken ? String(session.claimToken) : undefined,
    claimOwner: session.claimOwner ? String(session.claimOwner) : undefined,
    assignedAlias: session.assignedAlias ? String(session.assignedAlias) : undefined,
    resumeId: String(session.resumeId || ''),
    resumeCommand: String(session.resumeCommand || ''),
    resumeCapability: (session.resumeCapability || 'codex') as SavedResumableSession['resumeCapability'],
    checkpointStatus: 'saved',
    checkpointedAt: String(session.checkpointedAt || new Date().toISOString()),
    attachedContextItems: normalizeAttachedContextItems(
      session.attachedContextItems
    ),
  };
}

function normalizeRalphRun(
  run: Partial<RalphRunSnapshot>
): RalphRunSnapshot {
  const now = new Date().toISOString();
  return {
    workItemId: String(run.workItemId || ''),
    taskId: run.taskId ? String(run.taskId) : undefined,
    status: (run.status || 'idle') as RalphRunSnapshot['status'],
    agentType: (run.agentType || 'codex') as RalphRunSnapshot['agentType'],
    maxIterations:
      typeof run.maxIterations === 'number' && Number.isFinite(run.maxIterations)
        ? run.maxIterations
        : 3,
    currentIteration:
      typeof run.currentIteration === 'number' && Number.isFinite(run.currentIteration)
        ? run.currentIteration
        : 0,
    startedAt: String(run.startedAt || now),
    updatedAt: String(run.updatedAt || now),
    completedAt: run.completedAt ? String(run.completedAt) : undefined,
    currentWorkspaceId: run.currentWorkspaceId
      ? String(run.currentWorkspaceId)
      : undefined,
    stopReason: run.stopReason as RalphRunSnapshot['stopReason'],
    error: run.error ? String(run.error) : undefined,
    iterations: Array.isArray(run.iterations)
      ? run.iterations.map((iteration) => ({
          ...(iteration as RalphRunSnapshot['iterations'][number]),
          iteration: Number((iteration as { iteration?: unknown }).iteration || 0),
          startedAt: String(
            (iteration as { startedAt?: unknown }).startedAt || now
          ),
        }))
      : [],
  };
}

export function readDaemonState(): DaemonState | null {
  try {
    const content = readFileSync(getDaemonStateFile(), 'utf-8');
    const parsed = JSON.parse(content) as Partial<DaemonState>;
    const workspaces = Object.fromEntries(
      Object.entries(parsed.workspaces || {}).map(([id, workspace]) => [
        id,
        normalizeWorkspace(workspace as Partial<LocalWorkspace>),
      ])
    );
    const savedSessions = Object.fromEntries(
      Object.entries(parsed.savedSessions || {}).map(([id, session]) => [
        id,
        normalizeSavedSession(session as Partial<SavedResumableSession>),
      ])
    );
    const ralphRuns = Object.fromEntries(
      Object.entries(parsed.ralphRuns || {}).map(([id, run]) => [
        id,
        normalizeRalphRun(run as Partial<RalphRunSnapshot>),
      ])
    );
    return {
      workspaces,
      savedSessions,
      ralphRuns,
      hookServerPort: parsed.hookServerPort || 0,
      lastSync: parsed.lastSync || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
