import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CacheStore } from '../../src/cache/store.js';
import { closeDatabase } from '../../src/persistence/db.js';
import { forceReread } from '../../src/tools/force-reread.js';

describe('forceReread', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'repo-memory-test-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should always return fresh data', async () => {
    const filePath = 'src/hello.ts';
    const absolutePath = join(tempDir, filePath);
    writeFileSync(absolutePath, 'export const hello = "world";', 'utf-8');

    const result = await forceReread(tempDir, filePath);

    expect(result.reread).toBe(true);
    expect(result.path).toBe(filePath);
    expect(result.hash).toBeTypeOf('string');
    expect(result.hash.length).toBe(64); // SHA-256 hex
    expect(result.summary).toBeDefined();
    expect(result.summary.exports).toContain('hello');
  });

  it('should update the cache entry', async () => {
    const filePath = 'src/counter.ts';
    const absolutePath = join(tempDir, filePath);
    writeFileSync(absolutePath, 'export const count = 1;', 'utf-8');

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
    const absolutePath = join(tempDir, filePath);
    writeFileSync(absolutePath, 'export function greet() {}', 'utf-8');

    const store = new CacheStore(tempDir);
    expect(store.getEntry(filePath)).toBeNull();

    const result = await forceReread(tempDir, filePath);

    expect(result.reread).toBe(true);
    expect(result.summary.exports).toContain('greet');

    const entry = store.getEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.hash).toBe(result.hash);
  });
});
