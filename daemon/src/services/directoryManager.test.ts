import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DirectoryManager, DirectoryRequiredError } from './directoryManager.js';
import type { DaemonConfig } from '../types.js';

describe('DirectoryManager', () => {
  const originalConfigDir = process.env.EXF_CONFIG_DIR;
  let sandboxDir: string;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), 'exf-directory-manager-'));
    process.env.EXF_CONFIG_DIR = sandboxDir;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.EXF_CONFIG_DIR;
    } else {
      process.env.EXF_CONFIG_DIR = originalConfigDir;
    }
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it('persists a project directory mapping and resolves it for task dispatch', () => {
    const projectDir = join(sandboxDir, 'project-a');
    mkdirSync(projectDir, { recursive: true });

    const config: DaemonConfig = {
      apiUrl: 'https://execufunction.com',
      pollIntervalMs: 10000,
      dashboardRefreshMode: 'timed',
      dashboardRefreshIntervalMs: 10000,
      projectDirectories: {},
      recentDirectories: [],
    };

    const manager = new DirectoryManager(config);
    manager.setProjectDirectory('project-1', projectDir);

    expect(manager.resolveTaskDirectory('project-1')).toBe(projectDir);
    expect(manager.getState()).toEqual({
      projectDirectories: { 'project-1': projectDir },
      recentDirectories: [projectDir],
      lastLaunchDirectory: projectDir,
      projectAgentPreferences: {},
      lastAgentType: null,
    });
  });

  it('uses the last launch directory for ad hoc launches', () => {
    const launchDir = join(sandboxDir, 'launch');
    mkdirSync(launchDir, { recursive: true });

    const config: DaemonConfig = {
      apiUrl: 'https://execufunction.com',
      pollIntervalMs: 10000,
      dashboardRefreshMode: 'timed',
      dashboardRefreshIntervalMs: 10000,
      projectDirectories: {},
      recentDirectories: [],
    };

    const manager = new DirectoryManager(config);
    manager.setLastLaunchDirectory(launchDir);

    expect(manager.resolveTaskDirectory()).toBe(launchDir);
  });

  it('throws a structured error when a project directory is required but missing', () => {
    const config: DaemonConfig = {
      apiUrl: 'https://execufunction.com',
      pollIntervalMs: 10000,
      dashboardRefreshMode: 'timed',
      dashboardRefreshIntervalMs: 10000,
      projectDirectories: {},
      recentDirectories: [],
    };

    const manager = new DirectoryManager(config);

    expect(() => manager.resolveTaskDirectory('project-1')).toThrow(
      DirectoryRequiredError
    );
  });

  it('remembers the last used agent globally and per project', () => {
    const config: DaemonConfig = {
      apiUrl: 'https://execufunction.com',
      pollIntervalMs: 10000,
      dashboardRefreshMode: 'timed',
      dashboardRefreshIntervalMs: 10000,
      projectDirectories: {},
      recentDirectories: [],
    };

    const manager = new DirectoryManager(config);
    manager.rememberAgentPreference('claude-code', 'project-1');
    manager.rememberAgentPreference('codex');

    expect(manager.resolvePreferredAgent('project-1')).toBe('claude-code');
    expect(manager.resolvePreferredAgent('project-2')).toBe('codex');
    expect(manager.getState()).toEqual({
      projectDirectories: {},
      recentDirectories: [],
      lastLaunchDirectory: null,
      projectAgentPreferences: { 'project-1': 'claude-code' },
      lastAgentType: 'codex',
    });
  });

  it('normalizes stored directory state and removes duplicate trailing-slash variants', () => {
    const projectDir = join(sandboxDir, 'project-b');
    mkdirSync(projectDir, { recursive: true });

    const config: DaemonConfig = {
      apiUrl: 'https://execufunction.com',
      pollIntervalMs: 10000,
      dashboardRefreshMode: 'timed',
      dashboardRefreshIntervalMs: 10000,
      projectDirectories: { 'project-1': `${projectDir}/` },
      recentDirectories: [`${projectDir}/`, projectDir],
      lastLaunchDirectory: `${projectDir}/`,
    };

    const manager = new DirectoryManager(config);

    expect(manager.getState()).toEqual({
      projectDirectories: { 'project-1': projectDir },
      recentDirectories: [projectDir],
      lastLaunchDirectory: projectDir,
      projectAgentPreferences: {},
      lastAgentType: null,
    });
  });
});
