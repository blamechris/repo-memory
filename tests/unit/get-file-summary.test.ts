import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDatabase } from '../../src/persistence/db.js';
import { getFileSummary } from '../../src/tools/get-file-summary.js';

describe('getFileSummary', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'repo-memory-test-'));
    await mkdir(join(tempDir, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns a fresh summary for a valid file (cache miss)', async () => {
    const filePath = 'src/example.ts';
    const fileContent = 'export function hello(): string {\n  return "hi";\n}\n';
    await writeFile(join(tempDir, filePath), fileContent, 'utf-8');

    const result = await getFileSummary(tempDir, filePath);

    expect(result.fromCache).toBe(false);
    expect(result.path).toBe(filePath);
    expect(result.summary.purpose).toBe('function hello'); // AST default
    expect(result.summary.exports).toContain('hello');
    expect(result.summary.lineCount).toBe(4);
    expect(result.cacheAge).toBeUndefined();
  });

  it('exposes only the slim response shape (no hash/reason debug fields)', async () => {
    const filePath = 'src/example.ts';
    await writeFile(join(tempDir, filePath), 'export const x = 1;\n', 'utf-8');

    const miss = await getFileSummary(tempDir, filePath);
    expect(miss).not.toHaveProperty('hash');
    expect(miss).not.toHaveProperty('reason');
    expect(miss).not.toHaveProperty('cacheAge'); // only present on cache hits
    expect(Object.keys(miss).sort()).toEqual(['fromCache', 'path', 'suggestFullRead', 'summary']);

    const hit = await getFileSummary(tempDir, filePath);
    expect(hit.fromCache).toBe(true);
    expect(hit).not.toHaveProperty('hash');
    expect(hit).not.toHaveProperty('reason');
    expect(hit.cacheAge).toBeTypeOf('number');
  });

  it('persists the file import edges when the summary regenerates', async () => {
    await writeFile(join(tempDir, 'src', 'util.ts'), 'export const util = 1;\n', 'utf-8');
    await writeFile(
      join(tempDir, 'src', 'app.ts'),
      `import { util } from './util.js';\nexport const app = util;\n`,
      'utf-8',
    );

    await getFileSummary(tempDir, 'src/app.ts');

    const rows = getDatabase(tempDir)
      .prepare('SELECT target FROM imports WHERE source = ?')
      .all('src/app.ts') as Array<{ target: string }>;
    expect(rows).toEqual([{ target: 'src/util.ts' }]);
  });

  it('returns cached summary on second call', async () => {
    const filePath = 'src/example.ts';
    const fileContent = 'export const foo = 42;\n';
    await writeFile(join(tempDir, filePath), fileContent, 'utf-8');

    const first = await getFileSummary(tempDir, filePath);
    expect(first.fromCache).toBe(false);

    const second = await getFileSummary(tempDir, filePath);
    expect(second.fromCache).toBe(true);
    expect(second.summary).toEqual(first.summary);
    expect(second.cacheAge).toBeTypeOf('number');
    expect(second.cacheAge).toBeGreaterThanOrEqual(0);
  });

  it('generates a fresh summary when file content changes', async () => {
    const filePath = 'src/example.ts';
    await writeFile(join(tempDir, filePath), 'export const a = 1;\n', {
      recursive: true,
    } as never);

    const first = await getFileSummary(tempDir, filePath);
    expect(first.fromCache).toBe(false);
    expect(first.summary.exports).toContain('a');

    // Modify the file
    await writeFile(join(tempDir, filePath), 'export const b = 2;\nexport const c = 3;\n');

    const second = await getFileSummary(tempDir, filePath);
    expect(second.fromCache).toBe(false);
    expect(second.summary.exports).toContain('b');
    expect(second.summary.exports).toContain('c');
    expect(second.summary.exports).not.toContain('a');
    expect(second.cacheAge).toBeUndefined();
  });

  it('throws when the file does not exist', async () => {
    await expect(getFileSummary(tempDir, 'nonexistent.ts')).rejects.toThrow();
  });

  it('includes suggestFullRead as false for normal .ts file', async () => {
    const filePath = 'src/example.ts';
    const fileContent = 'export function hello(): string {\n  return "hi";\n}\n';
    await writeFile(join(tempDir, filePath), fileContent, 'utf-8');

    const result = await getFileSummary(tempDir, filePath);
    expect(result.suggestFullRead).toBe(false);
  });
});
