#!/usr/bin/env node

/**
 * execuTerm Daemon
 *
 * Orchestrates AI coding agents (Claude Code, Codex, Gemini) and dev servers
 * via the execuTerm terminal socket API, backed by ExecuFunction for task context.
 *
 * Usage:
 *   exf-terminal-daemon                          Start daemon (auto-discovers socket)
 *   exf-terminal-daemon --socket /path/to/sock   Explicit socket path
 *   exf-terminal-daemon dispatch <taskId> <agent> Dispatch a task to an agent
 */

import { ExfClient } from './exfClient.js';
import {
  readAuthToken,
  readDaemonConfig,
  readDaemonState,
  writeDaemonState,
} from './config.js';
import { AuthCoordinator } from './authCoordinator.js';
import { ExecuTermSocket } from './execuTermSocket.js';
import { WorkspaceManager } from './services/workspaceManager.js';
import { AgentManager } from './services/agentManager.js';
import { HookObserver } from './services/hookObserver.js';
import { SidebarUpdater } from './services/sidebarUpdater.js';
import { TaskDispatcher } from './services/taskDispatcher.js';
import { DashboardServer } from './services/dashboardServer.js';
import { DirectoryManager } from './services/directoryManager.js';
import type { AgentType, DaemonState } from './types.js';

function parseArgs(argv: string[]): {
  socketPath?: string;
  command?: 'dispatch';
  taskId?: string;
  agentType?: AgentType;
} {
  const args = argv.slice(2);
  const result: ReturnType<typeof parseArgs> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--socket' && args[i + 1]) {
      result.socketPath = args[++i];
    } else if (args[i] === 'dispatch') {
      result.command = 'dispatch';
      result.taskId = args[++i];
      result.agentType = args[++i] as AgentType;
    }
  }

  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const isAppManaged = process.env.EXECUTERM_LAUNCHED_BY_APP === '1';

  // 1. Read daemon config
  const config = readDaemonConfig();

  // 2. Connect to execuTerm socket (auto-discovers path)
  const cmux = new ExecuTermSocket();
  const maxRetries = isAppManaged ? 15 : 3;
  const retryDelayMs = 2000;
  let connected = false;
  for (let attempt = 1; attempt <= maxRetries && !connected; attempt++) {
    try {
      await cmux.connect(args.socketPath);
      await cmux.systemPing();
      connected = true;
    } catch (err) {
      if (attempt === maxRetries) {
        console.error(
          'Could not connect to socket after',
          maxRetries,
          'attempts.',
          err instanceof Error ? err.message : err
        );
        process.exit(1);
      }
      console.log(
        `Socket connection attempt ${attempt}/${maxRetries} failed, retrying in ${retryDelayMs}ms...`
      );
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  console.log('Connected to execuTerm socket');

  // 3. Load or initialize daemon state
  const state: DaemonState = readDaemonState() || {
    workspaces: {},
    savedSessions: {},
    hookServerPort: 0,
    lastSync: new Date().toISOString(),
  };

  // 4. Initialize core managers
  const workspaceManager = new WorkspaceManager(cmux, state);
  const directoryManager = new DirectoryManager(config);
  let exfClient: ExfClient | null = null;
  let sidebarUpdater: SidebarUpdater | null = null;
  let agentManager: AgentManager | null = null;
  let hookObserver: HookObserver | null = null;
  let taskDispatcher: TaskDispatcher | null = null;

  const startAuthenticatedServices = async (client: ExfClient): Promise<void> => {
    if (exfClient) {
      return;
    }

    exfClient = client;
    agentManager = new AgentManager(
      cmux,
      client,
      workspaceManager,
      config.launchFailureTimeoutMs
    );

    sidebarUpdater = new SidebarUpdater(
      cmux,
      client,
      agentManager,
      workspaceManager,
      config
    );
    sidebarUpdater.start();
    console.log('Sidebar updater started');

    hookObserver = new HookObserver(agentManager);
    hookObserver.start();
    console.log('Hook observer started');

    // Start exit poller for agent process detection
    agentManager.startExitPoller(workspaceManager);
    console.log('Exit poller started');

    // Create task dispatcher (available to dashboard)
    taskDispatcher = new TaskDispatcher(
      client,
      directoryManager,
      workspaceManager,
      agentManager
    );
    console.log('Task dispatcher ready');
  };

  const authCoordinator = new AuthCoordinator({
    apiUrl: config.apiUrl,
    appManaged: isAppManaged,
    onAuthenticated: startAuthenticatedServices,
  });
  const token = readAuthToken();
  const initialClient = await authCoordinator.initialize(token);
  if (initialClient) {
    await startAuthenticatedServices(initialClient);
  }

  // Handle dispatch command (one-shot, not daemon mode) — requires auth
  if (args.command === 'dispatch') {
    if (!exfClient) {
      console.error('Error: dispatch requires authentication. Run `exf auth login` first.');
      process.exit(1);
    }
    if (!args.taskId || !args.agentType) {
      console.error(
        'Usage: exf-terminal-daemon dispatch <taskId> <agentType>'
      );
      process.exit(1);
    }

    const dispatchAgentManager = new AgentManager(
      cmux,
      exfClient,
      workspaceManager,
      config.launchFailureTimeoutMs
    );
    const dispatchTaskDispatcher = new TaskDispatcher(
      exfClient,
      directoryManager,
      workspaceManager,
      dispatchAgentManager
    );
    const wsId = await dispatchTaskDispatcher.dispatch(args.taskId, args.agentType);
    console.log(`Dispatched task ${args.taskId} to ${args.agentType} in workspace ${wsId}`);
    cmux.disconnect();
    process.exit(0);
  }

  // 7. Reconcile state with actual execuTerm workspaces (cleanup orphans)
  await workspaceManager.reconcile();

  if (!exfClient) {
    console.log('ExecuFunction features waiting on authentication');
  }

  // 10. Start dashboard HTTP server
  const dashboard = new DashboardServer(
    () => agentManager,
    directoryManager,
    workspaceManager,
    () => exfClient,
    () => authCoordinator.getState(),
    () => taskDispatcher,
    () => cmux
  );
  const dashboardPort = await dashboard.start(config.dashboardPort);
  state.hookServerPort = dashboardPort;
  writeDaemonState(state);
  console.log(
    `Dashboard: http://127.0.0.1:${dashboardPort}/dashboard`
  );

  // 11. Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    if (agentManager) {
      await agentManager.checkpointActiveSessionsOnShutdown().catch(() => {});
    }
    agentManager?.stopExitPoller();
    sidebarUpdater?.stop();
    hookObserver?.stop();
    dashboard.stop();
    cmux.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
