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
    confidence: 'high',
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

  it('deleteEntry also removes import edges sourced from the file', () => {
    store.setEntry('src/a.ts', 'hash1', null);
    const db = getDatabase(tempDir);
    db.prepare(
      'INSERT INTO imports (source, target, specifiers, import_type) VALUES (?, ?, ?, ?)',
    ).run('src/a.ts', 'src/b.ts', '["b"]', 'static');
    db.prepare(
      'INSERT INTO imports (source, target, specifiers, import_type) VALUES (?, ?, ?, ?)',
    ).run('src/c.ts', 'src/a.ts', '["a"]', 'static');

    store.deleteEntry('src/a.ts');

    const rows = db.prepare('SELECT source, target FROM imports').all() as Array<{
      source: string;
      target: string;
    }>;
    // Outgoing edges die with the entry; incoming edges belong to src/c.ts.
    expect(rows).toEqual([{ source: 'src/c.ts', target: 'src/a.ts' }]);
  });

  it('touchEntry refreshes last_checked without altering hash or summary', () => {
    store.setEntry('src/a.ts', 'hash1', testSummary);
    const db = getDatabase(tempDir);
    const oldTimestamp = Date.now() - 60_000;
    db.prepare('UPDATE files SET last_checked = ? WHERE path = ?').run(oldTimestamp, 'src/a.ts');

    store.touchEntry('src/a.ts');

    const entry = store.getEntry('src/a.ts');
    expect(entry!.lastChecked).toBeGreaterThan(oldTimestamp);
    expect(entry!.hash).toBe('hash1');
    expect(entry!.summary).toEqual(testSummary);
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

  it('clearAllSummariesAndSetMeta clears summaries and writes the tag together', () => {
    store.setEntry('a.ts', 'hash-a', testSummary);
    store.setEntry('b.ts', 'hash-b', testSummary);

    store.clearAllSummariesAndSetMeta('summarizer_generation', 'ast:99');

    expect(store.getEntry('a.ts')!.summary).toBeNull();
    expect(store.getEntry('b.ts')!.summary).toBeNull();
    expect(store.getEntry('a.ts')!.hash).toBe('hash-a'); // hashes survive
    expect(store.getMeta('summarizer_generation')).toBe('ast:99');
  });

  it('clearAllSummariesAndSetMeta rolls back the clear when the tag write fails (I4)', () => {
    store.setEntry('a.ts', 'hash-a', testSummary);
    store.setMeta('summarizer_generation', 'ast:1');

    // meta.value is NOT NULL — binding null makes the second statement of the
    // transaction fail, and the clear must roll back with it.
    expect(() =>
      store.clearAllSummariesAndSetMeta('summarizer_generation', null as unknown as string),
    ).toThrow();

    expect(store.getEntry('a.ts')!.summary).toEqual(testSummary);
    expect(store.getMeta('summarizer_generation')).toBe('ast:1');
  });

  it('deleteAllEntries removes every row', () => {
    store.setEntry('a.ts', 'hash-a', null);
    store.setEntry('b.ts', 'hash-b', testSummary);

    store.deleteAllEntries();

    expect(store.getAllEntries()).toHaveLength(0);
  });

  it('withWriteLock returns the callback result and commits its writes', () => {
    const result = store.withWriteLock(() => {
      store.setEntry('locked.ts', 'hash-l', null);
      return 'done';
    });

    expect(result).toBe('done');
    expect(store.getEntry('locked.ts')).not.toBeNull();
  });
});
