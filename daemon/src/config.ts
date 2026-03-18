import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { DaemonConfig, DaemonState } from './types.js';

const DEFAULT_CONFIG: DaemonConfig = {
  apiUrl: 'https://execufunction.com',
  pollIntervalMs: 10000,
};

export function getConfigDir(): string {
  if (process.env.EXF_CONFIG_DIR) {
    return process.env.EXF_CONFIG_DIR;
  }
  const baseDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(baseDir, 'exf');
}

function getAuthFile(): string {
  return join(getConfigDir(), 'auth.json');
}

export function getAuthFilePath(): string {
  return getAuthFile();
}

function getDaemonConfigFile(): string {
  return join(getConfigDir(), 'terminal.json');
}

function getDaemonStateFile(): string {
  return join(getConfigDir(), 'terminal-state.json');
}

export function readAuthToken(): string | null {
  try {
    const content = readFileSync(getAuthFile(), 'utf-8');
    const config = JSON.parse(content) as { token?: string };
    return config.token || null;
  } catch {
    return null;
  }
}

export function writeAuthToken(token: string): void {
  mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  writeFileSync(getAuthFile(), JSON.stringify({ token }, null, 2), {
    mode: 0o600,
  });
}

export function deleteAuthToken(): void {
  try {
    unlinkSync(getAuthFile());
  } catch {
    // Already gone
  }
}

export function readDaemonConfig(): DaemonConfig {
  try {
    const content = readFileSync(getDaemonConfigFile(), 'utf-8');
    const fileConfig = JSON.parse(content) as Partial<DaemonConfig>;
    return { ...DEFAULT_CONFIG, ...fileConfig };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeDaemonState(state: DaemonState): void {
  mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  writeFileSync(getDaemonStateFile(), JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
}

export function readDaemonState(): DaemonState | null {
  try {
    const content = readFileSync(getDaemonStateFile(), 'utf-8');
    return JSON.parse(content) as DaemonState;
  } catch {
    return null;
  }
}
