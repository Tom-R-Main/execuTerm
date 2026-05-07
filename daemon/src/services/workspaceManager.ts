import { randomUUID } from 'node:crypto';

import type { ExecuTermSocket } from '../execuTermSocket.js';
import type {
  AttachedContextItem,
  ContextSourceType,
  DaemonState,
  LocalWorkspace,
  ResumeCapability,
  SavedResumableSession,
  SourceControlState,
  WorkspaceTemplate,
} from '../types.js';
import { readDaemonConfig, writeDaemonState } from '../config.js';
import { getShimInstallDir } from './shimInstaller.js';

const TEMPLATES: WorkspaceTemplate[] = [
  {
    id: 'codex',
    name: 'Codex',
    kind: 'agent',
    agentType: 'codex',
    command: 'codex',
    icon: 'terminal',
    color: '#2563EB',
    launchMode: 'prompt_argument',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    kind: 'agent',
    agentType: 'claude-code',
    command: 'claude',
    managedCommand: 'EXECUTERM_MANAGED_AGENT=1 claude',
    icon: 'brain.head.profile',
    color: '#D97706',
    launchMode: 'interactive_message',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    kind: 'agent',
    agentType: 'gemini',
    command: 'gemini',
    icon: 'sparkles',
    color: '#059669',
    hidden: true,
    launchMode: 'prompt_argument',
  },
  {
    id: 'dev-backend',
    name: 'Backend Dev Server',
    kind: 'dev_server',
    command: 'npm run start:dev --workspace exf-app',
    icon: 'server.rack',
    color: '#34C759',
    port: 8080,
  },
  {
    id: 'dev-frontend',
    name: 'Frontend Dev Server',
    kind: 'dev_server',
    command: 'npm run start:web',
    icon: 'globe',
    color: '#007AFF',
    port: 3000,
  },
  {
    id: 'shell',
    name: 'Shell',
    kind: 'shell',
    command: process.env.SHELL || '/bin/zsh',
    icon: 'terminal',
    color: '#8E8E93',
  },
];

function shSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildAugmentPreamble(
  env: Record<string, string | undefined>
): string {
  const parts: string[] = [];
  for (const [key, rawValue] of Object.entries(env)) {
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    parts.push(`export ${key}=${shSingleQuote(String(rawValue))}`);
  }
  return parts.length > 0 ? parts.join('; ') + '; ' : '';
}

export class WorkspaceManager {
  constructor(
    private cmux: ExecuTermSocket,
    private state: DaemonState
  ) {}

  private resolveAugmentEnvFor(
    template: WorkspaceTemplate,
    workspaceId: string
  ): Record<string, string | undefined> | null {
    if (template.kind !== 'agent') return null;
    let config;
    try {
      config = readDaemonConfig();
    } catch {
      return null;
    }
    const augment = config.augment;
    if (!augment || !augment.enabled) return null;
    if (!augment.tools || augment.tools.length === 0) return null;

    const shimDir = getShimInstallDir();
    const port = this.state.hookServerPort;
    const logUrl = port ? `http://127.0.0.1:${port}/api/augment/log` : undefined;

    return {
      CMUX_AUGMENT: '1',
      CMUX_AUGMENT_BIN: shimDir,
      CMUX_AUGMENT_EXF_BIN: process.env.CMUX_AUGMENT_EXF_BIN || 'exf',
      CMUX_AUGMENT_TIMEOUT_MS: String(augment.semanticTimeoutMs),
      CMUX_AUGMENT_MAX_RESULTS: String(augment.maxSemanticResults),
      CMUX_AUGMENT_MIN_QUERY_LEN: String(augment.minQueryLength),
      CMUX_AUGMENT_REPO_ID: augment.repositoryId,
      CMUX_AUGMENT_LOG_URL: logUrl,
      CMUX_WORKSPACE_ID: workspaceId,
      PATH: `${shimDir}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
    };
  }

  getTemplate(templateId: string): WorkspaceTemplate | undefined {
    return TEMPLATES.find((t) => t.id === templateId);
  }

  listTemplates(): WorkspaceTemplate[] {
    return TEMPLATES.filter((t) => !t.hidden).map((t) => ({ ...t }));
  }

  async createFromTemplate(
    templateId: string,
    opts?: {
      taskId?: string;
      workItemId?: string;
      claimToken?: string;
      claimOwner?: string;
      assignedAlias?: string;
      projectId?: string;
      title?: string;
      cwd?: string;
      initialPrompt?: string;
      startupCommandOverride?: string;
      resumeId?: string;
      resumeCommand?: string;
      checkpointStatus?: LocalWorkspace['checkpointStatus'];
      checkpointedAt?: string;
      attachedContextItems?: AttachedContextItem[];
      sourceControl?: SourceControlState;
    }
  ): Promise<string> {
    const template = this.getTemplate(templateId);
    if (!template) {
      throw new Error(`Unknown workspace template: ${templateId}`);
    }

    const title = opts?.title || template.name;
    const cwd = opts?.cwd || process.env.HOME || process.cwd();

    // cmux CLI launches a workspace, then sends command text into the surface.
    // Doing the same here is more reliable than relying on workspace.create
    // to execute startup commands for app-managed sessions.
    const managedCommand = template.managedCommand || template.command;
    let startupCommand: string | null =
      opts?.startupCommandOverride ||
      (template.kind === 'shell' ? null : managedCommand);
    let promptFile: string | null = null;
    let deferredPrompt: string | null = null;
    let resumeId = opts?.resumeId;
    let resumeCommand = opts?.resumeCommand;
    let resumeCapability: ResumeCapability =
      template.agentType === 'claude-code'
        ? 'claude'
        : template.agentType === 'codex'
          ? 'codex'
          : 'none';

    if (
      template.kind === 'agent' &&
      template.agentType === 'claude-code' &&
      !opts?.startupCommandOverride &&
      !opts?.resumeId
    ) {
      resumeId = randomUUID().toLowerCase();
      startupCommand = `${managedCommand} --session-id ${resumeId}`;
      resumeCommand = `claude --resume ${resumeId}`;
    }

    if (opts?.initialPrompt && template.kind === 'agent') {
      if (template.launchMode === 'prompt_argument') {
        // Write prompt to temp file to avoid shell escaping issues with long/complex text
        const { writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { tmpdir } = await import('node:os');
        const { randomUUID } = await import('node:crypto');
        promptFile = join(tmpdir(), `exf-prompt-${randomUUID().slice(0, 8)}.md`);
        writeFileSync(promptFile, opts.initialPrompt, 'utf-8');
        startupCommand = `${managedCommand} "$(cat ${promptFile})"`;
      } else if (template.launchMode === 'interactive_message') {
        startupCommand = startupCommand || managedCommand;
        deferredPrompt = opts.initialPrompt;
      }
    }

    // Create the workspace first; startup command is sent after surface creation.
    const result = await this.cmux.workspaceCreate({
      working_directory: cwd,
    });

    const workspaceId = result.workspace_id;

    // Rename workspace to our title
    await this.cmux.workspaceRename(workspaceId, title);

    // Get default surface (v2: unwrap surfaces array from result envelope)
    const surfaceResult = await this.cmux.surfaceList(workspaceId);
    const surfaceId = surfaceResult.surfaces[0]?.id;

    // Set initial sidebar status via v1 command
    if (template.icon) {
      await this.cmux
        .setStatus(template.kind, 'Starting...', {
          icon: template.icon,
          color: template.color,
          workspaceId,
        })
        .catch(() => {});
    }

    if (startupCommand && surfaceId) {
      const augmentEnv = this.resolveAugmentEnvFor(template, workspaceId);
      const preamble = augmentEnv ? buildAugmentPreamble(augmentEnv) : '';
      await this.cmux.surfaceSendText(preamble + startupCommand + '\n', surfaceId);
    }

    if (deferredPrompt && surfaceId) {
      const promptText = deferredPrompt;
      const promptTimer = setTimeout(() => {
        void this.cmux.surfaceSendText(promptText + '\n', surfaceId);
      }, 1800);
      promptTimer.unref?.();
    }

    // Register workspace in state
    const workspace: LocalWorkspace = {
      id: workspaceId,
      title,
      cwd,
      kind: template.kind,
      agentType: template.agentType,
      taskId: opts?.taskId,
      workItemId: opts?.workItemId,
      claimToken: opts?.claimToken,
      claimOwner: opts?.claimOwner,
      assignedAlias: opts?.assignedAlias,
      projectId: opts?.projectId,
      surfaceId,
      state: 'starting',
      lastActivity: new Date().toISOString(),
      resumeId,
      resumeCommand,
      resumeCapability,
      checkpointStatus: opts?.checkpointStatus || 'idle',
      checkpointedAt: opts?.checkpointedAt,
      attachedContextItems: this.normalizeAttachedContextItems(
        opts?.attachedContextItems || []
      ),
      sourceControl: opts?.sourceControl,
    };

    this.state.workspaces[workspaceId] = workspace;
    writeDaemonState(this.state);

    // Clean up prompt temp file after agent has had time to read it
    if (promptFile) {
      const pf = promptFile;
      const cleanupTimer = setTimeout(async () => {
        const { unlink } = await import('node:fs/promises');
        await unlink(pf).catch(() => {});
      }, 10000);
      cleanupTimer.unref?.();
    }

    return workspaceId;
  }

  async reconcile(): Promise<void> {
    // v2: workspaceList returns { workspaces: [...] } inside result envelope
    const result = await this.cmux.workspaceList();
    const cmuxIds = new Set(result.workspaces.map((w) => w.id));

    // Remove orphaned state entries
    for (const id of Object.keys(this.state.workspaces)) {
      if (!cmuxIds.has(id)) {
        delete this.state.workspaces[id];
      }
    }

    writeDaemonState(this.state);
  }

  updateWorkspace(
    workspaceId: string,
    updates: Partial<LocalWorkspace>
  ): LocalWorkspace | undefined {
    const workspace = this.state.workspaces[workspaceId];
    if (!workspace) return undefined;
    const next = { ...workspace, ...updates };
    this.state.workspaces[workspaceId] = next;
    writeDaemonState(this.state);
    return next;
  }

  saveResumableSession(session: SavedResumableSession): void {
    this.state.savedSessions[session.id] = {
      ...session,
      attachedContextItems: this.normalizeAttachedContextItems(
        session.attachedContextItems || []
      ),
    };
    writeDaemonState(this.state);
  }

  listSavedResumableSessions(): SavedResumableSession[] {
    return Object.values(this.state.savedSessions).sort(
      (a, b) =>
        new Date(b.checkpointedAt).getTime() -
        new Date(a.checkpointedAt).getTime()
    );
  }

  getSavedResumableSession(sessionId: string): SavedResumableSession | undefined {
    return this.state.savedSessions[sessionId];
  }

  removeSavedResumableSession(sessionId: string): void {
    if (this.state.savedSessions[sessionId]) {
      delete this.state.savedSessions[sessionId];
      writeDaemonState(this.state);
    }
  }

  getWorkspace(workspaceId: string): LocalWorkspace | undefined {
    return this.state.workspaces[workspaceId];
  }

  getAttachedContextItems(workspaceId: string): AttachedContextItem[] {
    return this.normalizeAttachedContextItems(
      this.state.workspaces[workspaceId]?.attachedContextItems || []
    );
  }

  setAttachedContextItems(
    workspaceId: string,
    items: AttachedContextItem[]
  ): AttachedContextItem[] {
    const workspace = this.state.workspaces[workspaceId];
    if (!workspace) {
      return [];
    }
    const nextItems = this.normalizeAttachedContextItems(items);
    this.state.workspaces[workspaceId] = {
      ...workspace,
      attachedContextItems: nextItems,
      lastActivity: new Date().toISOString(),
    };
    writeDaemonState(this.state);
    return nextItems;
  }

  attachContextItem(
    workspaceId: string,
    item: Omit<AttachedContextItem, 'attachedAt' | 'estimatedChars' | 'pinned'> &
      Partial<Pick<AttachedContextItem, 'attachedAt' | 'estimatedChars' | 'pinned'>>
  ): AttachedContextItem[] {
    const existing = this.getAttachedContextItems(workspaceId);
    if (
      existing.some(
        (candidate) =>
          candidate.id === item.id &&
          candidate.sourceType === item.sourceType
      )
    ) {
      return existing;
    }
    return this.setAttachedContextItems(workspaceId, [
      ...existing,
      {
        ...item,
        attachedAt: item.attachedAt || new Date().toISOString(),
        pinned: item.pinned !== false,
        estimatedChars:
          typeof item.estimatedChars === 'number'
            ? item.estimatedChars
            : item.excerpt.length,
      },
    ]);
  }

  detachContextItem(
    workspaceId: string,
    itemId: string,
    sourceType: ContextSourceType
  ): AttachedContextItem[] {
    const existing = this.getAttachedContextItems(workspaceId);
    return this.setAttachedContextItems(
      workspaceId,
      existing.filter(
        (item) => !(item.id === itemId && item.sourceType === sourceType)
      )
    );
  }

  getAgentWorkspaces(): LocalWorkspace[] {
    return Object.values(this.state.workspaces).filter(
      (w) => w.kind === 'agent'
    );
  }

  getDevServerWorkspaces(): LocalWorkspace[] {
    return Object.values(this.state.workspaces).filter(
      (w) => w.kind === 'dev_server'
    );
  }

  private normalizeAttachedContextItems(
    items: AttachedContextItem[]
  ): AttachedContextItem[] {
    const seen = new Set<string>();
    const normalized: AttachedContextItem[] = [];
    for (const item of items || []) {
      if (!item?.id || !item?.sourceType) {
        continue;
      }
      const key = `${item.sourceType}:${item.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      normalized.push({
        id: item.id,
        sourceType: item.sourceType,
        title: item.title,
        excerpt: item.excerpt,
        filePath: item.filePath,
        projectId: item.projectId,
        attachedAt: item.attachedAt,
        pinned: item.pinned !== false,
        estimatedChars:
          typeof item.estimatedChars === 'number'
            ? item.estimatedChars
            : item.excerpt.length,
      });
    }
    return normalized;
  }
}
