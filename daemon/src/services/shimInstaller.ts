import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

export interface ShimInstallResult {
  destDir: string;
  installed: string[];
  skipped: string[];
  sourceDir: string;
}

function getShimsSourceDir(): string {
  if (process.env.CMUX_AUGMENT_SHIMS_DIR) return process.env.CMUX_AUGMENT_SHIMS_DIR;
  // Walk up from the daemon entry script, then from cwd, looking for a
  // sibling `shims/` directory next to a package.json. Works whether we're
  // running from `dist/index.js` or via ts-node/ts-jest.
  const anchors = [process.argv[1], process.cwd()].filter(Boolean) as string[];
  for (const anchor of anchors) {
    let dir = existsSync(anchor) && statSync(anchor).isDirectory()
      ? anchor
      : dirname(anchor);
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, 'shims');
      if (
        existsSync(join(dir, 'package.json')) &&
        existsSync(candidate) &&
        statSync(candidate).isDirectory()
      ) {
        return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return join(process.cwd(), 'shims');
}

export function getShimInstallDir(): string {
  if (process.env.CMUX_AUGMENT_BIN) return process.env.CMUX_AUGMENT_BIN;
  return join(homedir(), '.cmuxterm', 'bin');
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Materialize shim scripts into the user's ~/.cmuxterm/bin/. Idempotent: skips
 * files whose contents already match by sha256. Returns the destination dir so
 * callers can prepend it to PATH.
 */
export function installShims(
  options: { tools?: string[]; sourceDir?: string; destDir?: string } = {}
): ShimInstallResult {
  const sourceDir = options.sourceDir || getShimsSourceDir();
  const destDir = options.destDir || getShimInstallDir();
  mkdirSync(destDir, { recursive: true, mode: 0o755 });

  const tools = options.tools && options.tools.length > 0
    ? options.tools
    : ['grep', 'rg'];

  // Always install the common helper.
  const installed: string[] = [];
  const skipped: string[] = [];
  const toInstall = new Set<string>(['_augment-common.sh', ...tools]);

  for (const name of toInstall) {
    const src = join(sourceDir, name);
    if (!existsSync(src)) {
      skipped.push(name);
      continue;
    }
    const dst = join(destDir, name);
    const srcHash = hashFile(src);
    let dstHash = '';
    try {
      dstHash = hashFile(dst);
    } catch {
      dstHash = '';
    }
    if (srcHash === dstHash) {
      skipped.push(name);
      continue;
    }
    copyFileSync(src, dst);
    // Helper doesn't need exec bit; scripts do.
    if (name !== '_augment-common.sh') {
      chmodSync(dst, 0o755);
    } else {
      chmodSync(dst, 0o644);
    }
    installed.push(name);
  }

  // Write a small marker describing how this dir was provisioned. Useful for
  // audit and for a human checking what a shim is.
  const marker = join(destDir, '.cmux-augment.json');
  const markerBody = {
    installedAt: new Date().toISOString(),
    tools,
    sourceDir,
    note: 'Shims here run when PATH is prefixed with this dir AND CMUX_AUGMENT=1.',
  };
  try {
    writeFileSync(marker, JSON.stringify(markerBody, null, 2), { mode: 0o644 });
  } catch {
    // non-fatal
  }

  // List everything so tests can assert.
  try {
    readdirSync(destDir);
  } catch {
    // already handled
  }

  return { destDir, installed, skipped, sourceDir };
}
