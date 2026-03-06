import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CacheStore } from '../../src/cache/store.js';
import { CacheInvalidator } from '../../src/cache/invalidation.js';
import { hashFile } from '../../src/cache/hash.js';
import { closeDatabase } from '../../src/persistence/db.js';

describe('CacheInvalidator', () => {
  let projectRoot: string;
  let store: CacheStore;
  let invalidator: CacheInvalidator;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cache-invalidation-'));
    store = new CacheStore(projectRoot);
    invalidator = new CacheInvalidator(projectRoot, store);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  describe('validateEntry', () => {
    it('detects a changed file as invalid', async () => {
      const filePath = join(projectRoot, 'file.ts');
      writeFileSync(filePath, 'original content');
      const originalHash = await hashFile(filePath);
      store.setEntry('file.ts', originalHash!, null);

      writeFileSync(filePath, 'modified content');
      const result = await invalidator.validateEntry(filePath);

      expect(result.valid).toBe(false);
      expect(result.currentHash).not.toBe(originalHash);
      expect(result.currentHash).not.toBeNull();
    });

    it('detects an unchanged file as valid', async () => {
      const filePath = join(projectRoot, 'file.ts');
      writeFileSync(filePath, 'stable content');
      const hash = await hashFile(filePath);
      store.setEntry('file.ts', hash!, null);

      const result = await invalidator.validateEntry(filePath);

      expect(result.valid).toBe(true);
      expect(result.currentHash).toBe(hash);
    });

    it('detects a deleted/missing file as invalid', async () => {
      const filePath = join(projectRoot, 'gone.ts');
      store.setEntry('gone.ts', 'somehash', null);

      const result = await invalidator.validateEntry(filePath);

      expect(result.valid).toBe(false);
      expect(result.currentHash).toBeNull();
    });
  });

  describe('invalidate', () => {
    it('removes a single cache entry', () => {
      store.setEntry('a.ts', 'hash-a', null);
      store.setEntry('b.ts', 'hash-b', null);

      invalidator.invalidate('a.ts');

      expect(store.getEntry('a.ts')).toBeNull();
      expect(store.getEntry('b.ts')).not.toBeNull();
    });
  });

  describe('invalidateAll', () => {
    it('clears all cache entries', () => {
      store.setEntry('a.ts', 'hash-a', null);
      store.setEntry('b.ts', 'hash-b', null);
      store.setEntry('c.ts', 'hash-c', null);

      invalidator.invalidateAll();

      expect(store.getAllEntries()).toHaveLength(0);
    });
  });

  describe('findChangedFiles', () => {
    it('returns files whose hash differs from cache', async () => {
      const fileA = join(projectRoot, 'a.ts');
      const fileB = join(projectRoot, 'b.ts');
      writeFileSync(fileA, 'content-a');
      writeFileSync(fileB, 'content-b');

      const hashA = await hashFile(fileA);
      const hashB = await hashFile(fileB);
      store.setEntry('a.ts', hashA!, null);
      store.setEntry('b.ts', hashB!, null);

      // Modify only a.ts
      writeFileSync(fileA, 'content-a-modified');

      const changed = await invalidator.findChangedFiles(['a.ts', 'b.ts']);

      expect(changed).toEqual(['a.ts']);
    });

    it('includes new files with no cache entry', async () => {
      const filePath = join(projectRoot, 'new.ts');
      writeFileSync(filePath, 'new file content');

      const changed = await invalidator.findChangedFiles(['new.ts']);

      expect(changed).toEqual(['new.ts']);
    });

    it('includes deleted files', async () => {
      const filePath = join(projectRoot, 'deleted.ts');
      writeFileSync(filePath, 'will be deleted');
      const hash = await hashFile(filePath);
      store.setEntry('deleted.ts', hash!, null);

      unlinkSync(filePath);

      const changed = await invalidator.findChangedFiles(['deleted.ts']);

      expect(changed).toEqual(['deleted.ts']);
    });

    it('returns empty array when nothing changed', async () => {
      const filePath = join(projectRoot, 'stable.ts');
      writeFileSync(filePath, 'stable');
      const hash = await hashFile(filePath);
      store.setEntry('stable.ts', hash!, null);

      const changed = await invalidator.findChangedFiles(['stable.ts']);

      expect(changed).toEqual([]);
    });
  });
});
