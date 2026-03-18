import { buildTaskPrompt } from './promptBuilder.js';
import type { TaskContext, ProjectContext, CodeMemory } from './promptBuilder.js';

describe('buildTaskPrompt', () => {
  it('builds prompt with only title', () => {
    const task: TaskContext = { title: 'Fix login bug' };
    const result = buildTaskPrompt(task);
    expect(result).toBe('# Task: Fix login bug');
  });

  it('includes description', () => {
    const task: TaskContext = {
      title: 'Fix login bug',
      description: 'Users cannot log in with email',
    };
    const result = buildTaskPrompt(task);
    expect(result).toContain('# Task: Fix login bug');
    expect(result).toContain('Users cannot log in with email');
  });

  it('includes rationale', () => {
    const task: TaskContext = {
      title: 'Migrate auth',
      rationale: 'Legal compliance requires new token storage',
    };
    const result = buildTaskPrompt(task);
    expect(result).toContain('## Why This Matters');
    expect(result).toContain('Legal compliance requires new token storage');
  });

  it('includes deliverable and verification', () => {
    const task: TaskContext = {
      title: 'Add search',
      deliverable: 'Working search endpoint with tests',
      verification: 'Run npm test and verify all pass',
    };
    const result = buildTaskPrompt(task);
    expect(result).toContain('## Deliverable');
    expect(result).toContain('Working search endpoint with tests');
    expect(result).toContain('## Verification');
    expect(result).toContain('Run npm test and verify all pass');
  });

  it('includes approach constraints', () => {
    const task: TaskContext = {
      title: 'Refactor DB',
      approachConstraints: ['No ORM changes', 'Keep backward compat'],
    };
    const result = buildTaskPrompt(task);
    expect(result).toContain('## Constraints');
    expect(result).toContain('- No ORM changes');
    expect(result).toContain('- Keep backward compat');
  });

  it('includes acceptance criteria with checkboxes', () => {
    const task: TaskContext = {
      title: 'Add feature',
      acceptanceCriteria: [
        { text: 'Unit tests pass', met: true },
        { text: 'No regressions', met: false },
        { text: 'Docs updated' },
      ],
    };
    const result = buildTaskPrompt(task);
    expect(result).toContain('## Acceptance Criteria');
    expect(result).toContain('- [x] Unit tests pass');
    expect(result).toContain('- [ ] No regressions');
    expect(result).toContain('- [ ] Docs updated');
  });

  it('includes scope with include and exclude', () => {
    const task: TaskContext = {
      title: 'Update API',
      scope: {
        include: ['src/controllers/', 'src/routes/'],
        exclude: ['tests/', 'scripts/'],
      },
    };
    const result = buildTaskPrompt(task);
    expect(result).toContain('## Scope');
    expect(result).toContain('**In scope:**');
    expect(result).toContain('- src/controllers/');
    expect(result).toContain('**Out of scope:**');
    expect(result).toContain('- tests/');
  });

  it('includes scope with only include', () => {
    const task: TaskContext = {
      title: 'Update API',
      scope: { include: ['src/'] },
    };
    const result = buildTaskPrompt(task);
    expect(result).toContain('**In scope:**');
    expect(result).not.toContain('**Out of scope:**');
  });

  it('skips scope section for empty arrays', () => {
    const task: TaskContext = {
      title: 'Update API',
      scope: { include: [], exclude: [] },
    };
    const result = buildTaskPrompt(task);
    expect(result).not.toContain('## Scope');
  });

  it('includes project context', () => {
    const task: TaskContext = { title: 'Fix bug' };
    const project: ProjectContext = {
      name: 'ExecuFunction',
      brief: 'AI executive function assistant',
      goals: [
        { text: 'Ship v2', status: 'active' },
        { text: 'Reduce latency', status: 'completed' },
      ],
      successCriteria: ['All tests pass', 'Sub-200ms p95'],
    };
    const result = buildTaskPrompt(task, project);
    expect(result).toContain('## Project: ExecuFunction');
    expect(result).toContain('AI executive function assistant');
    expect(result).toContain('- [active] Ship v2');
    expect(result).toContain('- [completed] Reduce latency');
    expect(result).toContain('### Success Criteria');
    expect(result).toContain('- All tests pass');
  });

  it('includes code memories', () => {
    const task: TaskContext = { title: 'Fix bug' };
    const memories: CodeMemory[] = [
      { fact: 'RLS is required on all queries', category: 'architecture' },
      { fact: 'Use set_config for user context', category: 'pattern' },
    ];
    const result = buildTaskPrompt(task, null, memories);
    expect(result).toContain('## Relevant Code Knowledge');
    expect(result).toContain(
      '- **[architecture]** RLS is required on all queries'
    );
    expect(result).toContain(
      '- **[pattern]** Use set_config for user context'
    );
  });

  it('builds full prompt with all fields', () => {
    const task: TaskContext = {
      title: 'Implement search endpoint',
      description: 'Add full-text search to notes API',
      rationale: 'Users need to find notes quickly',
      deliverable: 'GET /api/v1/notes/search with query param',
      verification: 'curl the endpoint and verify results',
      approachConstraints: ['Use pgvector', 'No external services'],
      acceptanceCriteria: [
        { text: 'Returns ranked results', met: false },
        { text: 'Handles empty query', met: false },
      ],
      scope: {
        include: ['src/controllers/notes.ts', 'src/services/noteService.ts'],
        exclude: ['frontend/'],
      },
    };
    const project: ProjectContext = {
      name: 'ExecuFunction',
      brief: 'AI assistant platform',
    };
    const memories: CodeMemory[] = [
      { fact: 'Notes table has tsvector column', category: 'schema' },
    ];

    const result = buildTaskPrompt(task, project, memories);

    // Verify section order
    const titleIdx = result.indexOf('# Task:');
    const rationaleIdx = result.indexOf('## Why This Matters');
    const deliverableIdx = result.indexOf('## Deliverable');
    const verificationIdx = result.indexOf('## Verification');
    const constraintsIdx = result.indexOf('## Constraints');
    const criteriaIdx = result.indexOf('## Acceptance Criteria');
    const scopeIdx = result.indexOf('## Scope');
    const projectIdx = result.indexOf('## Project:');
    const memoriesIdx = result.indexOf('## Relevant Code Knowledge');

    expect(titleIdx).toBeLessThan(rationaleIdx);
    expect(rationaleIdx).toBeLessThan(deliverableIdx);
    expect(deliverableIdx).toBeLessThan(verificationIdx);
    expect(verificationIdx).toBeLessThan(constraintsIdx);
    expect(constraintsIdx).toBeLessThan(criteriaIdx);
    expect(criteriaIdx).toBeLessThan(scopeIdx);
    expect(scopeIdx).toBeLessThan(projectIdx);
    expect(projectIdx).toBeLessThan(memoriesIdx);
  });

  it('handles null optional fields gracefully', () => {
    const task: TaskContext = {
      title: 'Simple task',
      description: null,
      rationale: null,
      deliverable: null,
      verification: null,
    };
    const result = buildTaskPrompt(task, null, []);
    expect(result).toBe('# Task: Simple task');
  });

  it('handles empty memories array', () => {
    const task: TaskContext = { title: 'Task' };
    const result = buildTaskPrompt(task, null, []);
    expect(result).not.toContain('## Relevant Code Knowledge');
  });

  it('handles project with no optional fields', () => {
    const task: TaskContext = { title: 'Task' };
    const project: ProjectContext = { name: 'MyProject' };
    const result = buildTaskPrompt(task, project);
    expect(result).toContain('## Project: MyProject');
    expect(result).not.toContain('### Goals');
    expect(result).not.toContain('### Success Criteria');
  });
});
