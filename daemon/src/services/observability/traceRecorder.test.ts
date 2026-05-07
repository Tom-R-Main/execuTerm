import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TraceRecorder } from './traceRecorder.js';

describe('TraceRecorder', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'executerm-trace-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes ndjson trace records and redacts sensitive attributes', async () => {
    const traceFile = join(dir, 'trace.ndjson');
    const trace = new TraceRecorder(traceFile);

    trace.record({
      name: 'agent.register',
      attributes: {
        workspaceId: 'ws-1',
        claimToken: 'claim-token-secret',
        apiKey: 'api-key-secret',
      },
      outcome: 'success',
    });
    await trace.span('dispatch.task', { taskId: 'task-1', pat: 'pat-secret' }, async () => 'ok');

    const records = readFileSync(traceFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(
      expect.objectContaining({
        name: 'agent.register',
        outcome: 'success',
        attributes: {
          workspaceId: 'ws-1',
          claimToken: '[REDACTED]',
          apiKey: '[REDACTED]',
        },
      })
    );
    expect(records[1]).toEqual(
      expect.objectContaining({
        name: 'dispatch.task',
        outcome: 'success',
        durationMs: expect.any(Number),
        attributes: {
          taskId: 'task-1',
          pat: '[REDACTED]',
        },
      })
    );
  });
});
