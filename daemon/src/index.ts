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

  // 1. Read auth token (shared with exf CLI at ~/.config/exf/auth.json)
  const token = readAuthToken();
  if (!token) {
    console.error('Error: Not authenticated. Run `exf auth login` first.');
    process.exit(1);
  }

  // 2. Read daemon config
  const config = readDaemonConfig();

  // 3. Create ExfClient (standalone, no monorepo dependency)
  const exfClient = new ExfClient({
    apiUrl: config.apiUrl,
    pat: token,
  });

  // 4. Connect to cmux socket (auto-discovers path)
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

  // 5. Load or initialize daemon state
  const state: DaemonState = readDaemonState() || {
    workspaces: {},
    hookServerPort: 0,
    lastSync: new Date().toISOString(),
  };

  // 6. Initialize managers
  const workspaceManager = new WorkspaceManager(cmux, state);
  const agentManager = new AgentManager(cmux, exfClient);
  const taskDispatcher = new TaskDispatcher(
    exfClient,
    workspaceManager,
    agentManager
  );

  // Handle dispatch command (one-shot, not daemon mode)
  if (args.command === 'dispatch') {
    if (!args.taskId || !args.agentType) {
      console.error(
        'Usage: exf-terminal-daemon dispatch <taskId> <agentType>'
      );
      process.exit(1);
    }

    const wsId = await taskDispatcher.dispatch(args.taskId, args.agentType);
    console.log(`Dispatched task ${args.taskId} to ${args.agentType} in workspace ${wsId}`);
    cmux.disconnect();
    process.exit(0);
  }

  // 7. Reconcile state with actual cmux workspaces (cleanup orphans)
  await workspaceManager.reconcile();

  // 8. Start sidebar updater (dev server health + ExecuFunction sync)
  const sidebarUpdater = new SidebarUpdater(
    cmux,
    exfClient,
    agentManager,
    workspaceManager,
    config
  );
  sidebarUpdater.start();
  console.log('Sidebar updater started');

  // 9. Start hook observer (watches Claude hook session file)
  const hookObserver = new HookObserver(agentManager);
  hookObserver.start();
  console.log('Hook observer started');

  // 10. Start dashboard HTTP server
  const dashboard = new DashboardServer(
    agentManager,
    workspaceManager,
    exfClient
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
    sidebarUpdater.stop();
    hookObserver.stop();
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
