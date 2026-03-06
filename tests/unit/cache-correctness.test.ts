import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { CacheStore } from '../../src/cache/store.js';
import { hashFile, hashContents } from '../../src/cache/hash.js';
import { getFileSummary } from '../../src/tools/get-file-summary.js';
import { getChangedFiles } from '../../src/tools/get-changed-files.js';
import { closeDatabase } from '../../src/persistence/db.js';

function createTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cache-test-'));
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

function addAndCommit(dir: string, files: string[]): void {
  for (const f of files) {
    execSync(`git add "${f}"`, { cwd: dir, stdio: 'ignore' });
  }
  execSync('git commit -m "test" --allow-empty', { cwd: dir, stdio: 'ignore' });
}

describe('Cache correctness regression tests', () => {
  let tmpDir: string;

  afterEach(() => {
    closeDatabase();
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should detect file modified between checks', async () => {
    tmpDir = createTempProject();
    const filePath = 'src/example.ts';
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    const absPath = join(tmpDir, filePath);
    writeFileSync(absPath, 'export const a = 1;\n');
    addAndCommit(tmpDir, [filePath]);

    // First call — populates cache
    const result1 = await getFileSummary(tmpDir, filePath);
    expect(result1.fromCache).toBe(false);

    // Second call — cache hit
    const result2 = await getFileSummary(tmpDir, filePath);
    expect(result2.fromCache).toBe(true);
    expect(result2.hash).toBe(result1.hash);

    // Modify the file
    writeFileSync(absPath, 'export const a = 2;\n');

    // Third call — should detect change
    const result3 = await getFileSummary(tmpDir, filePath);
    expect(result3.fromCache).toBe(false);
    expect(result3.hash).not.toBe(result1.hash);
  });

  it('should handle file deleted after caching', async () => {
    tmpDir = createTempProject();
    const filePath = 'deleted.ts';
    const absPath = join(tmpDir, filePath);
    writeFileSync(absPath, 'export const x = 1;\n');
    addAndCommit(tmpDir, [filePath]);

    // Populate cache
    await getFileSummary(tmpDir, filePath);

    // Delete the file and remove from git tracking
    execSync(`git rm -f "${filePath}"`, { cwd: tmpDir, stdio: 'ignore' });

    // getFileSummary should throw (ENOENT)
    await expect(getFileSummary(tmpDir, filePath)).rejects.toThrow();

    // getChangedFiles should list it as deleted (file is in cache but not on disk)
    const changes = await getChangedFiles(tmpDir);
    expect(changes.deleted).toContain(filePath);
  });

  it('should detect file rename as delete + add', async () => {
    tmpDir = createTempProject();
    const oldPath = 'old-name.ts';
    const newPath = 'new-name.ts';
    const content = 'export const renamed = true;\n';

    writeFileSync(join(tmpDir, oldPath), content);
    addAndCommit(tmpDir, [oldPath]);

    // Populate cache for old path
    await getFileSummary(tmpDir, oldPath);

    // Rename the file and update git index
    renameSync(join(tmpDir, oldPath), join(tmpDir, newPath));
    execSync(`git rm --cached "${oldPath}"`, { cwd: tmpDir, stdio: 'ignore' });
    execSync(`git add "${newPath}"`, { cwd: tmpDir, stdio: 'ignore' });

    // getChangedFiles should list old as deleted, new as added
    const changes = await getChangedFiles(tmpDir);
    expect(changes.deleted).toContain(oldPath);
    expect(changes.added).toContain(newPath);
  });

  it('should return cache hit when file replaced with identical content', async () => {
    tmpDir = createTempProject();
    const filePath = 'stable.ts';
    const absPath = join(tmpDir, filePath);
    const originalContent = 'export const stable = true;\n';
    writeFileSync(absPath, originalContent);
    addAndCommit(tmpDir, [filePath]);

    // Populate cache
    const result1 = await getFileSummary(tmpDir, filePath);
    expect(result1.fromCache).toBe(false);

    // Modify file
    writeFileSync(absPath, 'export const stable = false;\n');

    // Force fresh summary
    const result2 = await getFileSummary(tmpDir, filePath);
    expect(result2.fromCache).toBe(false);

    // Restore original content — same hash as result1
    writeFileSync(absPath, originalContent);

    // Cache has result2's hash, so this is a miss that regenerates and updates cache
    const result3 = await getFileSummary(tmpDir, filePath);
    expect(result3.fromCache).toBe(false);
    expect(result3.hash).toBe(result1.hash);

    // Now the cache has the original hash+summary again — this should be a hit
    const result4 = await getFileSummary(tmpDir, filePath);
    expect(result4.fromCache).toBe(true);
    expect(result4.hash).toBe(result1.hash);
  });

  it('should handle empty files gracefully', async () => {
    tmpDir = createTempProject();
    const filePath = 'empty.ts';
    const absPath = join(tmpDir, filePath);
    writeFileSync(absPath, '');
    addAndCommit(tmpDir, [filePath]);

    const result = await getFileSummary(tmpDir, filePath);
    expect(result.summary.lineCount).toBe(0);
    expect(result.fromCache).toBe(false);
    expect(result.hash).toBeTruthy();
  });

  it('should hash binary files without crashing', async () => {
    tmpDir = createTempProject();
    const filePath = join(tmpDir, 'image.bin');
    // Write binary content (not a real PNG but contains non-UTF8 bytes)
    const binaryBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0xff, 0xfe, 0xfd,
    ]);
    writeFileSync(filePath, binaryBuffer);

    const hash = await hashFile(filePath);
    expect(hash).toBeTruthy();
    expect(hash).toHaveLength(64); // SHA-256 hex

    // hashContents should also handle buffer
    const hash2 = hashContents(binaryBuffer);
    expect(hash2).toBe(hash);
  });

  it('should handle very long file names', async () => {
    tmpDir = createTempProject();
    // 200+ char name
    const longName = 'a'.repeat(200) + '.ts';
    const absPath = join(tmpDir, longName);
    writeFileSync(absPath, 'export const long = true;\n');
    addAndCommit(tmpDir, [longName]);

    const store = new CacheStore(tmpDir);
    const hash = hashContents('export const long = true;\n');
    store.setEntry(longName, hash, null);

    const entry = store.getEntry(longName);
    expect(entry).not.toBeNull();
    expect(entry!.path).toBe(longName);
    expect(entry!.hash).toBe(hash);
  });

  it('should reflect current content after rapid successive modifications', async () => {
    tmpDir = createTempProject();
    const filePath = 'rapid.ts';
    const absPath = join(tmpDir, filePath);
    writeFileSync(absPath, 'export const v = 1;\n');
    addAndCommit(tmpDir, [filePath]);

    // First modification
    writeFileSync(absPath, 'export const v = 2;\n');
    const result1 = await getFileSummary(tmpDir, filePath);
    const hash1 = result1.hash;

    // Second modification
    writeFileSync(absPath, 'export const v = 3;\n');
    const result2 = await getFileSummary(tmpDir, filePath);
    const hash2 = result2.hash;

    // Each should have a different hash
    expect(hash1).not.toBe(hash2);
    expect(result2.fromCache).toBe(false);

    // Third modification
    writeFileSync(absPath, 'export const v = 4;\n');
    const result3 = await getFileSummary(tmpDir, filePath);
    expect(result3.hash).not.toBe(hash2);
    expect(result3.fromCache).toBe(false);
  });

  it('should regenerate summary when cache entry has no summary', async () => {
    tmpDir = createTempProject();
    const filePath = 'no-summary.ts';
    const absPath = join(tmpDir, filePath);
    const content = 'export function hello() { return 1; }\n';
    writeFileSync(absPath, content);
    addAndCommit(tmpDir, [filePath]);

    // Manually insert cache entry with hash but no summary
    const store = new CacheStore(tmpDir);
    const hash = hashContents(content);
    store.setEntry(filePath, hash, null);

    // Verify entry exists without summary
    const entry = store.getEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.summary).toBeNull();

    // getFileSummary should detect missing summary and regenerate
    const result = await getFileSummary(tmpDir, filePath);
    expect(result.fromCache).toBe(false);
    expect(result.summary).toBeTruthy();
    expect(result.summary.exports).toContain('hello');

    // Now it should be cached
    const result2 = await getFileSummary(tmpDir, filePath);
    expect(result2.fromCache).toBe(true);
  });

  it('should handle concurrent cache operations for different files', async () => {
    tmpDir = createTempProject();
    const store = new CacheStore(tmpDir);
    const fileCount = 50;

    // Create many files and set entries concurrently
    const promises = Array.from({ length: fileCount }, (_, i) => {
      const filePath = `concurrent-${i}.ts`;
      const content = `export const n = ${i};\n`;
      const hash = hashContents(content);
      return Promise.resolve().then(() => {
        store.setEntry(filePath, hash, {
          purpose: 'source',
          exports: ['n'],
          imports: [],
          lineCount: 1,
          topLevelDeclarations: [`const n`],
          confidence: 'high',
        });
      });
    });

    await Promise.all(promises);

    // Verify all entries exist
    const allEntries = store.getAllEntries();
    expect(allEntries.length).toBe(fileCount);

    // Verify each entry is correct
    for (let i = 0; i < fileCount; i++) {
      const entry = store.getEntry(`concurrent-${i}.ts`);
      expect(entry).not.toBeNull();
      expect(entry!.summary?.exports).toEqual(['n']);
    }
  });
});
