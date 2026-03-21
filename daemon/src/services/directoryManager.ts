import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { AgentType, DaemonConfig } from '../types.js';
import { writeDaemonConfig } from '../config.js';

const execFileAsync = promisify(execFile);
const MAX_RECENT_DIRECTORIES = 8;

export class DirectoryRequiredError extends Error {
  code = 'directory_required';

  constructor(public projectId?: string) {
    super(
      projectId
        ? `No working directory configured for project ${projectId}`
        : 'No working directory configured'
    );
    this.name = 'DirectoryRequiredError';
  }
}

function normalizeDirectory(cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed) {
    throw new Error('Working directory cannot be empty');
  }

  const resolvedHome = trimmed === '~' ? homedir() : trimmed.replace(/^~(?=\/|$)/, homedir());
  const stat = statSync(resolvedHome, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) {
    throw new Error(`Directory not found: ${resolvedHome}`);
  }
  if (resolvedHome.length > 1) {
    return resolvedHome.replace(/\/+$/, '');
  }
  return resolvedHome;
}

export class DirectoryManager {
  constructor(private config: DaemonConfig) {
    this.normalizeStoredState();
  }

  getState(): {
    projectDirectories: Record<string, string>;
    recentDirectories: string[];
    lastLaunchDirectory: string | null;
    projectAgentPreferences: Partial<Record<string, AgentType>>;
    lastAgentType: AgentType | null;
  } {
    return {
      projectDirectories: { ...(this.config.projectDirectories || {}) },
      recentDirectories: [...(this.config.recentDirectories || [])],
      lastLaunchDirectory: this.config.lastLaunchDirectory || null,
      projectAgentPreferences: {
        ...(this.config.projectAgentPreferences || {}),
      },
      lastAgentType: this.config.lastAgentType || null,
    };
  }

  getProjectDirectory(projectId?: string): string | null {
    if (!projectId) return null;
    return this.config.projectDirectories?.[projectId] || null;
  }

  getLastLaunchDirectory(): string | null {
    return this.config.lastLaunchDirectory || null;
  }

  getProjectAgentPreference(projectId?: string): AgentType | null {
    if (!projectId) return null;
    return this.config.projectAgentPreferences?.[projectId] || null;
  }

  getLastAgentType(): AgentType | null {
    return this.config.lastAgentType || null;
  }

  setProjectDirectory(projectId: string, cwd: string): string {
    const normalized = normalizeDirectory(cwd);
    const mappings = {
      ...(this.config.projectDirectories || {}),
      [projectId]: normalized,
    };
    this.config.projectDirectories = mappings;
    this.rememberDirectory(normalized, true);
    this.persist();
    return normalized;
  }

  setLastLaunchDirectory(cwd: string): string {
    const normalized = normalizeDirectory(cwd);
    this.rememberDirectory(normalized, true);
    this.persist();
    return normalized;
  }

  resolveTaskDirectory(projectId?: string, cwdOverride?: string): string {
    if (cwdOverride) {
      return projectId
        ? this.setProjectDirectory(projectId, cwdOverride)
        : this.setLastLaunchDirectory(cwdOverride);
    }

    const projectDirectory = this.getProjectDirectory(projectId);
    if (projectDirectory) {
      this.rememberDirectory(projectDirectory, true);
      this.persist();
      return projectDirectory;
    }

    const lastLaunchDirectory = this.getLastLaunchDirectory();
    if (!projectId && lastLaunchDirectory) {
      this.rememberDirectory(lastLaunchDirectory, true);
      this.persist();
      return lastLaunchDirectory;
    }

    throw new DirectoryRequiredError(projectId);
  }

  describeTaskDirectory(projectId?: string): {
    cwd: string | null;
    source: 'project' | 'global' | 'missing';
  } {
    const projectDirectory = this.getProjectDirectory(projectId);
    if (projectDirectory) {
      return { cwd: projectDirectory, source: 'project' };
    }

    const lastLaunchDirectory = this.getLastLaunchDirectory();
    if (!projectId && lastLaunchDirectory) {
      return { cwd: lastLaunchDirectory, source: 'global' };
    }

    return { cwd: null, source: 'missing' };
  }

  resolvePreferredAgent(projectId?: string): AgentType | null {
    return (
      this.getProjectAgentPreference(projectId) ||
      this.getLastAgentType() ||
      null
    );
  }

  rememberAgentPreference(agentType: AgentType, projectId?: string): void {
    this.config.lastAgentType = agentType;
    if (projectId) {
      this.config.projectAgentPreferences = {
        ...(this.config.projectAgentPreferences || {}),
        [projectId]: agentType,
      };
    }
    this.persist();
  }

  async chooseDirectory(projectId?: string): Promise<string> {
    if (process.platform !== 'darwin') {
      throw new Error('Native directory chooser is only available on macOS');
    }

    const script =
      'POSIX path of (choose folder with prompt "Select working directory")';
    const result = await execFileAsync('/usr/bin/osascript', ['-e', script]);
    const cwd = result.stdout.trim();
    return projectId
      ? this.setProjectDirectory(projectId, cwd)
      : this.setLastLaunchDirectory(cwd);
  }

  private rememberDirectory(cwd: string, updateLastLaunchDirectory: boolean): void {
    const normalized = normalizeDirectory(cwd);
    const recent = (this.config.recentDirectories || []).filter(
      (entry) => normalizeDirectory(entry) !== normalized
    );
    recent.unshift(normalized);
    this.config.recentDirectories = recent.slice(0, MAX_RECENT_DIRECTORIES);
    if (updateLastLaunchDirectory) {
      this.config.lastLaunchDirectory = normalized;
    }
  }

  private persist(): void {
    writeDaemonConfig(this.config);
  }

  private normalizeStoredState(): void {
    if (this.config.lastLaunchDirectory) {
      this.config.lastLaunchDirectory = normalizeDirectory(
        this.config.lastLaunchDirectory
      );
    }

    if (this.config.recentDirectories?.length) {
      const seen = new Set<string>();
      this.config.recentDirectories = this.config.recentDirectories
        .map((cwd) => normalizeDirectory(cwd))
        .filter((cwd) => {
          if (seen.has(cwd)) {
            return false;
          }
          seen.add(cwd);
          return true;
        })
        .slice(0, MAX_RECENT_DIRECTORIES);
    }

    if (this.config.projectDirectories) {
      this.config.projectDirectories = Object.fromEntries(
        Object.entries(this.config.projectDirectories).map(([projectId, cwd]) => [
          projectId,
          normalizeDirectory(cwd),
        ])
      );
    }
  }
}
