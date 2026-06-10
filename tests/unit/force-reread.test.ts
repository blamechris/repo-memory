import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CacheStore } from '../../src/cache/store.js';
import { closeDatabase, getDatabase } from '../../src/persistence/db.js';
import { forceReread } from '../../src/tools/force-reread.js';

describe('forceReread', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'repo-memory-test-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('should always return fresh data', async () => {
    const filePath = 'src/hello.ts';
    writeFileSync(join(tempDir, filePath), 'export const hello = "world";', 'utf-8');

    const result = await forceReread(tempDir, filePath);

    expect(result.reread).toBe(true);
    expect(result.path).toBe(filePath);
    expect(result.hash).toBeTypeOf('string');
    expect(result.hash.length).toBe(64);
    expect(result.summary).toBeDefined();
    expect(result.summary.exports).toContain('hello');
    expect(result.reason).toBe('force_reread: explicitly requested');
  });

  it('should update the cache entry', async () => {
    const filePath = 'src/counter.ts';
    writeFileSync(join(tempDir, filePath), 'export const count = 1;', 'utf-8');

    const store = new CacheStore(tempDir);
    store.setEntry(filePath, 'old-hash', null);

    const result = await forceReread(tempDir, filePath);

    const entry = store.getEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.hash).toBe(result.hash);
    expect(entry!.hash).not.toBe('old-hash');
    expect(entry!.summary).toEqual(result.summary);
  });

  it('should work when no cache entry exists', async () => {
    const filePath = 'src/brand-new.ts';
    writeFileSync(join(tempDir, filePath), 'export function greet() {}', 'utf-8');

    const store = new CacheStore(tempDir);
    expect(store.getEntry(filePath)).toBeNull();

    const result = await forceReread(tempDir, filePath);

    expect(result.reread).toBe(true);
    expect(result.summary.exports).toContain('greet');

    const entry = store.getEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.hash).toBe(result.hash);
  });

  it('persists the file import edges alongside the summary', async () => {
    writeFileSync(join(tempDir, 'src', 'util.ts'), 'export const util = 1;', 'utf-8');
    writeFileSync(
      join(tempDir, 'src', 'app.ts'),
      `import { util } from './util.js';\nexport const app = util;`,
      'utf-8',
    );

    await forceReread(tempDir, 'src/app.ts');

    const rows = getDatabase(tempDir)
      .prepare('SELECT target FROM imports WHERE source = ?')
      .all('src/app.ts') as Array<{ target: string }>;
    expect(rows).toEqual([{ target: 'src/util.ts' }]);
  });
});
