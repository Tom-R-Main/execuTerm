import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installShims } from './shimInstaller.js';

function makeTempSource(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cmux-shim-src-'));
  writeFileSync(join(dir, '_augment-common.sh'), '# helper\n');
  writeFileSync(join(dir, 'grep'), '#!/usr/bin/env bash\necho grep-shim\n');
  writeFileSync(join(dir, 'rg'), '#!/usr/bin/env bash\necho rg-shim\n');
  return dir;
}

describe('installShims', () => {
  test('copies shim files and sets exec bit on scripts', () => {
    const sourceDir = makeTempSource();
    const destDir = mkdtempSync(join(tmpdir(), 'cmux-shim-dest-'));

    const result = installShims({ sourceDir, destDir, tools: ['grep', 'rg'] });

    expect(result.destDir).toBe(destDir);
    expect(result.installed.sort()).toEqual(['_augment-common.sh', 'grep', 'rg']);
    expect(existsSync(join(destDir, 'grep'))).toBe(true);
    expect(existsSync(join(destDir, 'rg'))).toBe(true);
    expect(existsSync(join(destDir, '_augment-common.sh'))).toBe(true);

    // Exec bit on scripts, not on helper.
    expect(statSync(join(destDir, 'grep')).mode & 0o111).not.toBe(0);
    expect(statSync(join(destDir, 'rg')).mode & 0o111).not.toBe(0);
    expect(statSync(join(destDir, '_augment-common.sh')).mode & 0o111).toBe(0);

    // Marker is written.
    const marker = JSON.parse(
      readFileSync(join(destDir, '.cmux-augment.json'), 'utf-8')
    );
    expect(marker.tools).toEqual(['grep', 'rg']);
    expect(marker.sourceDir).toBe(sourceDir);
  });

  test('is idempotent — second run installs nothing when content unchanged', () => {
    const sourceDir = makeTempSource();
    const destDir = mkdtempSync(join(tmpdir(), 'cmux-shim-dest-'));

    installShims({ sourceDir, destDir, tools: ['grep', 'rg'] });
    const second = installShims({ sourceDir, destDir, tools: ['grep', 'rg'] });

    expect(second.installed).toEqual([]);
    expect(second.skipped.sort()).toEqual(['_augment-common.sh', 'grep', 'rg']);
  });

  test('reinstalls when source content changes', () => {
    const sourceDir = makeTempSource();
    const destDir = mkdtempSync(join(tmpdir(), 'cmux-shim-dest-'));

    installShims({ sourceDir, destDir, tools: ['grep'] });
    writeFileSync(join(sourceDir, 'grep'), '#!/usr/bin/env bash\necho v2\n');
    const second = installShims({ sourceDir, destDir, tools: ['grep'] });

    expect(second.installed).toContain('grep');
    expect(readFileSync(join(destDir, 'grep'), 'utf-8')).toContain('echo v2');
  });

  test('skips tools missing from source dir', () => {
    const sourceDir = makeTempSource();
    const destDir = mkdtempSync(join(tmpdir(), 'cmux-shim-dest-'));

    const result = installShims({
      sourceDir,
      destDir,
      tools: ['grep', 'does-not-exist'],
    });

    expect(result.installed).toContain('grep');
    expect(result.skipped).toContain('does-not-exist');
  });

  test('restricts to requested tool subset', () => {
    const sourceDir = makeTempSource();
    const destDir = mkdtempSync(join(tmpdir(), 'cmux-shim-dest-'));

    const result = installShims({ sourceDir, destDir, tools: ['grep'] });

    expect(result.installed).toContain('grep');
    expect(result.installed).not.toContain('rg');
    expect(existsSync(join(destDir, 'rg'))).toBe(false);
  });
});
