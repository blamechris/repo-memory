import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CacheStore } from '../../src/cache/store.js';
import { closeDatabase, getDatabase } from '../../src/persistence/db.js';
import type { FileSummary } from '../../src/types.js';

describe('CacheStore', () => {
  let tempDir: string;
  let store: CacheStore;

  const testSummary: FileSummary = {
    purpose: 'Test utility module',
    exports: ['foo', 'bar'],
    imports: ['fs', 'path'],
    lineCount: 42,
    topLevelDeclarations: ['function foo', 'const bar'],
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'repo-memory-test-'));
    store = new CacheStore(tempDir);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should set and get an entry with summary', () => {
    store.setEntry('src/index.ts', 'abc123', testSummary);

    const entry = store.getEntry('src/index.ts');
    expect(entry).not.toBeNull();
    expect(entry!.path).toBe('src/index.ts');
    expect(entry!.hash).toBe('abc123');
    expect(entry!.lastChecked).toBeGreaterThan(0);
    expect(entry!.summary).toEqual(testSummary);
  });

  it('should set and get an entry with null summary', () => {
    store.setEntry('src/empty.ts', 'def456', null);

    const entry = store.getEntry('src/empty.ts');
    expect(entry).not.toBeNull();
    expect(entry!.summary).toBeNull();
  });

  it('should return null for a missing path', () => {
    const entry = store.getEntry('nonexistent.ts');
    expect(entry).toBeNull();
  });

  it('should return all stored entries', () => {
    store.setEntry('a.ts', 'hash1', null);
    store.setEntry('b.ts', 'hash2', testSummary);
    store.setEntry('c.ts', 'hash3', null);

    const entries = store.getAllEntries();
    expect(entries).toHaveLength(3);

    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('should delete an entry', () => {
    store.setEntry('to-delete.ts', 'hash1', null);
    expect(store.getEntry('to-delete.ts')).not.toBeNull();

    store.deleteEntry('to-delete.ts');
    expect(store.getEntry('to-delete.ts')).toBeNull();
  });

  it('should return stale entries filtered by age', () => {
    store.setEntry('fresh.ts', 'hash1', null);
    store.setEntry('also-fresh.ts', 'hash2', null);

    // Manually insert a stale entry by updating last_checked to an old timestamp
    const db = getDatabase(tempDir);
    const oldTimestamp = Date.now() - 60_000; // 60 seconds ago
    db.prepare('UPDATE files SET last_checked = ? WHERE path = ?').run(oldTimestamp, 'fresh.ts');

    const stale = store.getStaleEntries(30_000); // max age 30 seconds
    expect(stale).toHaveLength(1);
    expect(stale[0].path).toBe('fresh.ts');
  });

  it('should upsert an existing entry', () => {
    store.setEntry('src/index.ts', 'hash-v1', null);
    const first = store.getEntry('src/index.ts');
    expect(first!.hash).toBe('hash-v1');
    expect(first!.summary).toBeNull();

    store.setEntry('src/index.ts', 'hash-v2', testSummary);
    const second = store.getEntry('src/index.ts');
    expect(second!.hash).toBe('hash-v2');
    expect(second!.summary).toEqual(testSummary);
    expect(second!.lastChecked).toBeGreaterThanOrEqual(first!.lastChecked);

    // Should still be only one entry
    const all = store.getAllEntries();
    expect(all).toHaveLength(1);
  });
});
