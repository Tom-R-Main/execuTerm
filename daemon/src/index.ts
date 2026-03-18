#!/usr/bin/env node

/**
 * execuTerm Daemon
 *
 * Orchestrates AI coding agents (Claude Code, Codex, Gemini) and dev servers
 * via the cmux terminal socket API, backed by ExecuFunction for task context.
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
import { CmuxSocket } from './cmuxSocket.js';
import { WorkspaceManager } from './services/workspaceManager.js';
import { AgentManager } from './services/agentManager.js';
import { HookObserver } from './services/hookObserver.js';
import { SidebarUpdater } from './services/sidebarUpdater.js';
import { TaskDispatcher } from './services/taskDispatcher.js';
import { DashboardServer } from './services/dashboardServer.js';
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

  // 2. Connect to cmux socket (auto-discovers path)
  const cmux = new CmuxSocket();
  try {
    await cmux.connect(args.socketPath);
    // Verify connection with a ping
    await cmux.systemPing();
    console.log('Connected to cmux socket');
  } catch (err) {
    console.error(
      'Error: Could not connect to cmux socket.',
      err instanceof Error ? err.message : err
    );
    process.exit(1);
  }

  // 3. Load or initialize daemon state
  const state: DaemonState = readDaemonState() || {
    workspaces: {},
    hookServerPort: 0,
    lastSync: new Date().toISOString(),
  };

  // 4. Initialize core managers
  const workspaceManager = new WorkspaceManager(cmux, state);
  let exfClient: ExfClient | null = null;
  let sidebarUpdater: SidebarUpdater | null = null;
  let agentManager: AgentManager | null = null;
  let hookObserver: HookObserver | null = null;

  const startAuthenticatedServices = async (client: ExfClient): Promise<void> => {
    if (exfClient) {
      return;
    }

    exfClient = client;
    agentManager = new AgentManager(cmux, client);

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

    const agentManager = new AgentManager(cmux, exfClient);
    const taskDispatcher = new TaskDispatcher(
      exfClient,
      workspaceManager,
      agentManager
    );
    const wsId = await taskDispatcher.dispatch(args.taskId, args.agentType);
    console.log(`Dispatched task ${args.taskId} to ${args.agentType} in workspace ${wsId}`);
    cmux.disconnect();
    process.exit(0);
  }

  // 7. Reconcile state with actual cmux workspaces (cleanup orphans)
  await workspaceManager.reconcile();

  if (!exfClient) {
    console.log('ExecuFunction features waiting on authentication');
  }

  // 10. Start dashboard HTTP server
  const dashboard = new DashboardServer(
    () => agentManager,
    workspaceManager,
    () => exfClient,
    () => authCoordinator.getState()
  );
  const dashboardPort = await dashboard.start(config.dashboardPort);
  state.hookServerPort = dashboardPort;
  writeDaemonState(state);
  console.log(
    `Dashboard: http://127.0.0.1:${dashboardPort}/dashboard`
  );

  // 11. Graceful shutdown
  const shutdown = () => {
    console.log('Shutting down...');
    sidebarUpdater?.stop();
    hookObserver?.stop();
    dashboard.stop();
    cmux.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
