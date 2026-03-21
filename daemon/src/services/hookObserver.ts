import { watch, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { AgentManager } from './agentManager.js';
import type {
  ClaudeHookSessionStoreFile,
  ClaudeHookSessionRecord,
  SessionState,
} from '../types.js';

function getHookSessionsPath(): string {
  return (
    process.env.CMUX_CLAUDE_HOOK_STATE_PATH ||
    join(homedir(), '.cmuxterm', 'claude-hook-sessions.json')
  );
}

/** Patterns in lastSubtitle that indicate the agent is waiting for user input */
const WAITING_INPUT_PATTERNS = /permission|tool use|question|confirm|approve|allow|deny/i;
/** Patterns in lastBody that indicate the agent hit an error */
const ERROR_PATTERNS = /error|fail|crash|exception|panic|abort/i;

/**
 * Infer agent state from hook session record metadata.
 *
 * - lastSubtitle matches permission/question patterns → 'waiting_input'
 * - lastBody matches error patterns → 'failed'
 * - Otherwise → 'running'
 */
function inferStateFromRecord(record: ClaudeHookSessionRecord): SessionState {
  if (record.lastSubtitle && WAITING_INPUT_PATTERNS.test(record.lastSubtitle)) {
    return 'waiting_input';
  }
  if (record.lastBody && ERROR_PATTERNS.test(record.lastBody)) {
    return 'failed';
  }
  return 'running';
}

export class HookObserver {
  private watcher: ReturnType<typeof watch> | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  // Track known sessions to detect additions/removals
  private knownSessions = new Map<string, ClaudeHookSessionRecord>();

  constructor(private agentManager: AgentManager) {}

  start(): void {
    const path = getHookSessionsPath();
    this.readAndProcess();

    try {
      this.watcher = watch(path, () => {
        this.readAndProcess();
      });
    } catch {
      // File may not exist yet — retry on interval
      this.retryTimer = setInterval(() => {
        try {
          this.watcher = watch(path, () => {
            this.readAndProcess();
          });
          if (this.retryTimer) {
            clearInterval(this.retryTimer);
            this.retryTimer = null;
          }
        } catch {
          // Keep retrying
        }
      }, 5000);
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private readAndProcess(): void {
    let storeFile: ClaudeHookSessionStoreFile;
    try {
      const content = readFileSync(getHookSessionsPath(), 'utf-8');
      storeFile = JSON.parse(content);
    } catch {
      return;
    }

    if (!storeFile.sessions || typeof storeFile.sessions !== 'object') return;

    const currentSessionIds = new Set(Object.keys(storeFile.sessions));

    // Detect new or updated sessions
    for (const [sessionId, record] of Object.entries(storeFile.sessions)) {
      let { workspaceId } = record;
      // Try to match via surfaceId if workspaceId is missing
      if (!workspaceId && record.surfaceId) {
        const session = this.agentManager
          .getAllSessions()
          .find((s) => s.surfaceId === record.surfaceId);
        if (session) {
          workspaceId = session.workspaceId;
        }
      }
      if (!workspaceId) continue;

      const previous = this.knownSessions.get(sessionId);

      if (!previous) {
        // New session appeared → agent is running
        this.agentManager.transition(workspaceId, 'running').catch(() => {});
      } else if (previous.updatedAt !== record.updatedAt) {
        // Session updated — infer new state from metadata
        const state = inferStateFromRecord(record);
        this.agentManager.transition(workspaceId, state).catch(() => {});
      }

      this.knownSessions.set(sessionId, { ...record });
    }

    // Detect removed sessions (consumed = Claude finished)
    for (const [sessionId, record] of this.knownSessions) {
      if (!currentSessionIds.has(sessionId)) {
        this.agentManager
          .transition(record.workspaceId, 'review_ready')
          .catch(() => {});
        this.knownSessions.delete(sessionId);
      }
    }
  }
}
