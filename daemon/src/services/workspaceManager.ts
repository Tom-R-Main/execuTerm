import type { CmuxSocket } from '../cmuxSocket.js';
import type {
  DaemonState,
  LocalWorkspace,
  WorkspaceTemplate,
} from '../types.js';
import { writeDaemonState } from '../config.js';

const TEMPLATES: WorkspaceTemplate[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    kind: 'agent',
    agentType: 'claude-code',
    command: 'claude',
    icon: 'brain.head.profile',
    color: '#D97706',
  },
  {
    id: 'codex',
    name: 'Codex',
    kind: 'agent',
    agentType: 'codex',
    command: 'codex',
    icon: 'terminal',
    color: '#059669',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    kind: 'agent',
    agentType: 'gemini',
    command: 'gemini',
    icon: 'sparkles',
    color: '#2563EB',
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

export class WorkspaceManager {
  constructor(
    private cmux: CmuxSocket,
    private state: DaemonState
  ) {}

  getTemplate(templateId: string): WorkspaceTemplate | undefined {
    return TEMPLATES.find((t) => t.id === templateId);
  }

  listTemplates(): WorkspaceTemplate[] {
    return [...TEMPLATES];
  }

  async createFromTemplate(
    templateId: string,
    opts?: {
      taskId?: string;
      projectId?: string;
      title?: string;
      cwd?: string;
      initialPrompt?: string;
    }
  ): Promise<string> {
    const template = this.getTemplate(templateId);
    if (!template) {
      throw new Error(`Unknown workspace template: ${templateId}`);
    }

    const title = opts?.title || template.name;
    const cwd = opts?.cwd || process.cwd();

    // Build initial command for agent workspaces with prompts
    let initialCommand = template.command;
    if (opts?.initialPrompt && template.kind === 'agent') {
      if (template.agentType === 'claude-code') {
        const escaped = opts.initialPrompt.replace(/'/g, "'\\''");
        initialCommand = `claude --prompt '${escaped}'`;
      }
      // For codex/gemini, send command first then prompt separately below
    }

    // Create cmux workspace (v2: uses working_directory, initial_command)
    const result = await this.cmux.workspaceCreate({
      working_directory: cwd,
      initial_command:
        template.agentType === 'claude-code' || template.kind !== 'agent'
          ? initialCommand
          : template.command,
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

    // For non-Claude agents with prompts, send prompt after agent starts
    if (
      opts?.initialPrompt &&
      template.kind === 'agent' &&
      template.agentType !== 'claude-code' &&
      surfaceId
    ) {
      await new Promise((r) => setTimeout(r, 1500));
      await this.cmux.surfaceSendText(opts.initialPrompt + '\n', surfaceId);
    }

    // Register workspace in state
    const workspace: LocalWorkspace = {
      id: workspaceId,
      title,
      cwd,
      kind: template.kind,
      agentType: template.agentType,
      taskId: opts?.taskId,
      projectId: opts?.projectId,
      surfaceId,
      state: 'starting',
      lastActivity: new Date().toISOString(),
    };

    this.state.workspaces[workspaceId] = workspace;
    writeDaemonState(this.state);

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

  getWorkspace(workspaceId: string): LocalWorkspace | undefined {
    return this.state.workspaces[workspaceId];
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
}
