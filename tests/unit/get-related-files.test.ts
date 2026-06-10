import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
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
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns direct dependencies as related', async () => {
    const result = await getRelatedFiles(tempDir, 'src/index.ts');
    const paths = result.relatedFiles.map((f) => f.path);
    expect(paths).toContain('src/helper.ts');
  });

  it('returns direct dependents as related', async () => {
    const result = await getRelatedFiles(tempDir, 'src/helper.ts');
    const paths = result.relatedFiles.map((f) => f.path);
    expect(paths).toContain('src/index.ts');
  });

  it('classifies relationships correctly', async () => {
    const result = await getRelatedFiles(tempDir, 'src/index.ts');
    const helperEntry = result.relatedFiles.find((f) => f.path === 'src/helper.ts');
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

  it('returns only paths that exist on disk', async () => {
    // index.ts imports './helper.js' — the graph must resolve it to helper.ts
    const result = await getRelatedFiles(tempDir, 'src/index.ts');
    expect(result.relatedFiles.length).toBeGreaterThan(0);
    for (const f of result.relatedFiles) {
      expect(existsSync(join(tempDir, f.path)), `${f.path} should exist`).toBe(true);
    }
  });

  it('ranks direct imports above two-hop files above same-directory bystanders', async () => {
    // From src/index.ts: helper.ts is a direct import (1 hop), util.ts is two
    // hops away (index -> helper -> util), other.ts is only a same-directory
    // neighbor with no edges.
    const result = await getRelatedFiles(tempDir, 'src/index.ts');
    const score = (path: string) => result.relatedFiles.find((f) => f.path === path)?.score;

    const helperScore = score('src/helper.ts');
    const utilScore = score('src/util.ts');
    const otherScore = score('src/other.ts');

    expect(helperScore).toBeDefined();
    expect(utilScore).toBeDefined();
    expect(otherScore).toBeDefined();
    expect(helperScore!).toBeGreaterThan(utilScore!);
    expect(utilScore!).toBeGreaterThanOrEqual(otherScore!);
  });

  it('does not return identical scores for structurally different files (no task)', async () => {
    // Regression: every source file used to tie at exactly 0.325 because no
    // live signal differentiated candidates in the no-task path.
    const result = await getRelatedFiles(tempDir, 'src/helper.ts');
    expect(result.relatedFiles.length).toBeGreaterThan(1);
    const distinctScores = new Set(result.relatedFiles.map((f) => f.score));
    expect(distinctScores.size).toBeGreaterThan(1);
  });

  it('is deterministic: repeated calls return the same order', async () => {
    const first = await getRelatedFiles(tempDir, 'src/index.ts');
    const second = await getRelatedFiles(tempDir, 'src/index.ts');
    expect(second.relatedFiles.map((f) => f.path)).toEqual(
      first.relatedFiles.map((f) => f.path),
    );
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
