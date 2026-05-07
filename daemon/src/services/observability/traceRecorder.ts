import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { getTraceFilePath } from '../../config.js';

export interface TraceRecord {
  timestamp: string;
  name: string;
  durationMs?: number;
  attributes?: Record<string, unknown>;
  outcome?: 'success' | 'failure' | 'skipped';
  error?: string;
}

function redactAttributes(
  attributes?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!attributes) return undefined;
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (/token|secret|pat|password|key/i.test(key)) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

export class TraceRecorder {
  constructor(private readonly traceFilePath = getTraceFilePath()) {}

  record(input: Omit<TraceRecord, 'timestamp'>): void {
    const record: TraceRecord = {
      timestamp: new Date().toISOString(),
      ...input,
      attributes: redactAttributes(input.attributes),
    };
    try {
      mkdirSync(dirname(this.traceFilePath), { recursive: true, mode: 0o700 });
      appendFileSync(this.traceFilePath, JSON.stringify(record) + '\n', {
        mode: 0o600,
      });
    } catch {
      // Tracing is diagnostic only; daemon behavior must not depend on local file I/O.
    }
  }

  async span<T>(
    name: string,
    attributes: Record<string, unknown> | undefined,
    run: () => Promise<T>
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await run();
      this.record({
        name,
        attributes,
        durationMs: Date.now() - startedAt,
        outcome: 'success',
      });
      return result;
    } catch (error) {
      this.record({
        name,
        attributes,
        durationMs: Date.now() - startedAt,
        outcome: 'failure',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
