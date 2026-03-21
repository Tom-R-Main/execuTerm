import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DEFAULT_DASHBOARD_REFRESH_INTERVAL_MS,
  DEFAULT_DASHBOARD_REFRESH_MODE,
  readDaemonConfig,
  writeDaemonConfig,
} from './config.js';

describe('daemon dashboard refresh config', () => {
  const originalConfigDir = process.env.EXF_CONFIG_DIR;
  let sandboxDir = '';

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), 'executerm-dashboard-config-'));
    process.env.EXF_CONFIG_DIR = sandboxDir;
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) {
      delete process.env.EXF_CONFIG_DIR;
    } else {
      process.env.EXF_CONFIG_DIR = originalConfigDir;
    }
  });

  it('uses the dashboard refresh defaults when no terminal config exists', () => {
    const config = readDaemonConfig();

    expect(config.dashboardRefreshMode).toBe(DEFAULT_DASHBOARD_REFRESH_MODE);
    expect(config.dashboardRefreshIntervalMs).toBe(
      DEFAULT_DASHBOARD_REFRESH_INTERVAL_MS
    );
  });

  it('normalizes invalid dashboard refresh values on write/read', () => {
    writeDaemonConfig({
      ...readDaemonConfig(),
      dashboardRefreshMode: 'invalid' as any,
      dashboardRefreshIntervalMs: 1234 as any,
    });

    const config = readDaemonConfig();

    expect(config.dashboardRefreshMode).toBe(DEFAULT_DASHBOARD_REFRESH_MODE);
    expect(config.dashboardRefreshIntervalMs).toBe(
      DEFAULT_DASHBOARD_REFRESH_INTERVAL_MS
    );
  });
});
