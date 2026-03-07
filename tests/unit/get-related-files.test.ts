import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getRelatedFiles } from '../../src/tools/get-related-files.js';
import { closeDatabase } from '../../src/persistence/db.js';

describe('getRelatedFiles', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'related-files-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    mkdirSync(join(tempDir, 'src', 'utils'), { recursive: true });

    writeFileSync(
      join(tempDir, 'src', 'index.ts'),
      `import { helper } from './helper.js';\nexport function main() { helper(); }\n`,
    );
    writeFileSync(
      join(tempDir, 'src', 'helper.ts'),
      `import { util } from './util.js';\nexport function helper() { util(); }\n`,
    );
    writeFileSync(
      join(tempDir, 'src', 'util.ts'),
      `export function util() { return 42; }\n`,
    );
    writeFileSync(
      join(tempDir, 'src', 'other.ts'),
      `export function other() { return 'other'; }\n`,
    );
    writeFileSync(
      join(tempDir, 'src', 'utils', 'format.ts'),
      `export function format(s: string) { return s.trim(); }\n`,
    );

    execFileSync('git', ['init'], { cwd: tempDir });
    execFileSync('git', ['add', '.'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns direct dependencies as related', async () => {
    const result = await getRelatedFiles(tempDir, 'src/index.ts');
    const paths = result.relatedFiles.map((f) => f.path);
    expect(paths).toContain('src/helper.js');
  });

  it('returns direct dependents as related', async () => {
    const result = await getRelatedFiles(tempDir, 'src/helper.ts');
    const paths = result.relatedFiles.map((f) => f.path);
    expect(paths).toContain('src/index.ts');
  });

  it('classifies relationships correctly', async () => {
    const result = await getRelatedFiles(tempDir, 'src/index.ts');
    const helperEntry = result.relatedFiles.find((f) => f.path === 'src/helper.js');
    expect(helperEntry).toBeDefined();
    expect(helperEntry!.relationship).toBe('imports');

    const result2 = await getRelatedFiles(tempDir, 'src/helper.ts');
    const indexEntry = result2.relatedFiles.find((f) => f.path === 'src/index.ts');
    expect(indexEntry).toBeDefined();
    expect(indexEntry!.relationship).toBe('imported-by');

    // same-directory files
    const otherEntry = result2.relatedFiles.find((f) => f.path === 'src/other.ts');
    if (otherEntry) {
      expect(otherEntry.relationship).toBe('same-directory');
    }
  });

  it('respects limit parameter', async () => {
    const result = await getRelatedFiles(tempDir, 'src/helper.ts', { limit: 2 });
    expect(result.relatedFiles.length).toBeLessThanOrEqual(2);
  });

  it('works without task context', async () => {
    const result = await getRelatedFiles(tempDir, 'src/index.ts');
    expect(result.path).toBe('src/index.ts');
    expect(result.relatedFiles).toBeDefined();
    expect(Array.isArray(result.relatedFiles)).toBe(true);
    for (const f of result.relatedFiles) {
      expect(f).toHaveProperty('path');
      expect(f).toHaveProperty('score');
      expect(f).toHaveProperty('relationship');
      expect(typeof f.score).toBe('number');
    }
  });
});
