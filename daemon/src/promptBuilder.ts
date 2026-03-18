export interface TaskContext {
  title: string;
  description?: string | null;
  rationale?: string | null;
  deliverable?: string | null;
  verification?: string | null;
  approachConstraints?: string[];
  acceptanceCriteria?: Array<{ text: string; met?: boolean }>;
  scope?: { include?: string[]; exclude?: string[] };
}

export interface ProjectContext {
  name: string;
  brief?: string | null;
  goals?: Array<{ text: string; status: string }>;
  successCriteria?: string[];
}

export interface CodeMemory {
  fact: string;
  category: string;
}

export function buildTaskPrompt(
  task: TaskContext,
  project?: ProjectContext | null,
  memories?: CodeMemory[]
): string {
  const sections: string[] = [];

  // Task header
  sections.push(`# Task: ${task.title}`);

  if (task.description) {
    sections.push(task.description);
  }

  // Rationale
  if (task.rationale) {
    sections.push(`## Why This Matters\n${task.rationale}`);
  }

  // Deliverable
  if (task.deliverable) {
    sections.push(`## Deliverable\n${task.deliverable}`);
  }

  // Verification
  if (task.verification) {
    sections.push(`## Verification\n${task.verification}`);
  }

  // Approach constraints
  if (task.approachConstraints && task.approachConstraints.length > 0) {
    const items = task.approachConstraints.map((c) => `- ${c}`).join('\n');
    sections.push(`## Constraints\n${items}`);
  }

  // Acceptance criteria
  if (task.acceptanceCriteria && task.acceptanceCriteria.length > 0) {
    const items = task.acceptanceCriteria
      .map((c) => {
        const checkbox = c.met ? '[x]' : '[ ]';
        return `- ${checkbox} ${c.text}`;
      })
      .join('\n');
    sections.push(`## Acceptance Criteria\n${items}`);
  }

  // Scope
  if (task.scope) {
    const scopeParts: string[] = [];
    if (task.scope.include && task.scope.include.length > 0) {
      scopeParts.push(
        '**In scope:**\n' + task.scope.include.map((s) => `- ${s}`).join('\n')
      );
    }
    if (task.scope.exclude && task.scope.exclude.length > 0) {
      scopeParts.push(
        '**Out of scope:**\n' +
          task.scope.exclude.map((s) => `- ${s}`).join('\n')
      );
    }
    if (scopeParts.length > 0) {
      sections.push(`## Scope\n${scopeParts.join('\n\n')}`);
    }
  }

  // Project context
  if (project) {
    const projectParts: string[] = [];
    projectParts.push(`## Project: ${project.name}`);

    if (project.brief) {
      projectParts.push(project.brief);
    }

    if (project.goals && project.goals.length > 0) {
      const goalItems = project.goals
        .map((g) => `- [${g.status}] ${g.text}`)
        .join('\n');
      projectParts.push(`### Goals\n${goalItems}`);
    }

    if (project.successCriteria && project.successCriteria.length > 0) {
      const criteria = project.successCriteria
        .map((c) => `- ${c}`)
        .join('\n');
      projectParts.push(`### Success Criteria\n${criteria}`);
    }

    sections.push(projectParts.join('\n\n'));
  }

  // Code memories
  if (memories && memories.length > 0) {
    const memoryItems = memories
      .map((m) => `- **[${m.category}]** ${m.fact}`)
      .join('\n');
    sections.push(`## Relevant Code Knowledge\n${memoryItems}`);
  }

  return sections.join('\n\n');
}
