import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type {
  AttachedContextItem,
  DashboardRefreshMode,
  DaemonConfig,
  DaemonState,
  LocalWorkspace,
  SavedResumableSession,
} from './types.js';

export const DEFAULT_NOTIFICATION_PREFS = {
  onNeedsInput: true,
  onFinished: true,
  onFailed: true,
};

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
    return {
      workspaces,
      savedSessions,
      hookServerPort: parsed.hookServerPort || 0,
      lastSync: parsed.lastSync || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
