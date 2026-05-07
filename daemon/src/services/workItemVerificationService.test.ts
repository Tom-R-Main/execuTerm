import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  redactVerificationOutput,
  selectVerificationCommands,
  WorkItemVerificationService,
} from './workItemVerificationService.js';
import type { AgentWorkItemResponse } from '../exfClient.js';

describe('WorkItemVerificationService', () => {
  let sandbox = '';

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'executerm-verification-'));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function workItem(overrides: Partial<AgentWorkItemResponse> = {}): AgentWorkItemResponse {
    return {
      id: 'work-1',
      title: 'Verify work',
      status: 'needs_review',
      artifactRefs: [{ type: 'worktree', path: sandbox }],
      ...overrides,
    };
  }

  it('captures passing command results as a verification artifact', async () => {
    writeFileSync(join(sandbox, 'package.json'), JSON.stringify({}));
    const service = new WorkItemVerificationService();

    const artifact = await service.run(workItem(), {
      commands: ['node -e "console.log(process.cwd())"'],
    });

    expect(artifact).toEqual(
      expect.objectContaining({
        type: 'verification_result',
        source: 'executerm',
        aggregateStatus: 'passed',
      })
    );
    expect(artifact.commands[0]).toEqual(
      expect.objectContaining({
        command: 'node -e "console.log(process.cwd())"',
        exitCode: 0,
      })
    );
    expect(artifact.commands[0].stdoutTail).toContain(sandbox);
  });

  it('stops on the first failed command', async () => {
    const service = new WorkItemVerificationService();

    const artifact = await service.run(workItem(), {
      commands: ['node -e "process.exit(7)"', 'node -e "console.log(never)"'],
    });

    expect(artifact.aggregateStatus).toBe('failed');
    expect(artifact.commands).toHaveLength(1);
    expect(artifact.commands[0].exitCode).toBe(7);
  });

  it('redacts claim tokens and bearer credentials from command output', () => {
    expect(
      redactVerificationOutput(
        'Bearer abc.def.ghi exf_pat_fake_secret_123456789012 claim-1234-secret OPENAI_API_KEY=sk-testfake123456789012'
      )
    ).toBe(
      'Bearer [REDACTED] [REDACTED_TOKEN] [REDACTED_CLAIM] OPENAI_API_KEY=[REDACTED]'
    );
  });

  it('uses configured commands before execuTerm defaults', () => {
    expect(
      selectVerificationCommands(
        workItem({ verificationCommands: ['npm run custom'] }),
        '/Users/thomasmain/projects/execufunction/apps/execuTerm/daemon'
      )
    ).toEqual(['npm run custom']);
  });
});
