import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CacheStore } from '../../src/cache/store.js';
import { DependencyGraph } from '../../src/graph/dependency-graph.js';
import { closeDatabase, getDatabase } from '../../src/persistence/db.js';
import { invalidateCache } from '../../src/tools/invalidate.js';

describe('invalidateCache', () => {
  let tempDir: string;
  let store: CacheStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'repo-memory-test-'));
    store = new CacheStore(tempDir);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should invalidate a single path and remove that entry', async () => {
    store.setEntry('src/a.ts', 'hash-a', null);
    store.setEntry('src/b.ts', 'hash-b', null);

    const result = await invalidateCache(tempDir, 'src/a.ts');

    expect(result.invalidated).toBe('src/a.ts');
    expect(result.entriesRemoved).toBe(1);
    expect(store.getEntry('src/a.ts')).toBeNull();
    expect(store.getEntry('src/b.ts')).not.toBeNull();
  });

  it('should invalidate all entries when no path is provided', async () => {
    store.setEntry('src/a.ts', 'hash-a', null);
    store.setEntry('src/b.ts', 'hash-b', null);
    store.setEntry('src/c.ts', 'hash-c', null);

    const result = await invalidateCache(tempDir);

    expect(result.invalidated).toBe('all');
    expect(result.entriesRemoved).toBe(3);
    expect(store.getAllEntries()).toHaveLength(0);
  });

  it('removes the import edges extracted from an invalidated file', async () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'util.ts'), 'export const util = 1;\n');
    const contents = `import { util } from './util.js';\n`;
    writeFileSync(join(tempDir, 'src', 'a.ts'), contents);

    new DependencyGraph(tempDir).updateFile('src/a.ts', contents);
    store.setEntry('src/a.ts', 'hash-a', null);

    await invalidateCache(tempDir, 'src/a.ts');

    const rows = getDatabase(tempDir)
      .prepare('SELECT source FROM imports WHERE source = ?')
      .all('src/a.ts');
    expect(rows).toEqual([]);
  });

  it('should return correct count of entries removed', async () => {
    store.setEntry('src/one.ts', 'h1', null);
    store.setEntry('src/two.ts', 'h2', null);

    const resultAll = await invalidateCache(tempDir);
    expect(resultAll.entriesRemoved).toBe(2);

    const resultEmpty = await invalidateCache(tempDir);
    expect(resultEmpty.entriesRemoved).toBe(0);
  });
});
