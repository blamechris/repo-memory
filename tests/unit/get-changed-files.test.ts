import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getChangedFiles } from '../../src/tools/get-changed-files.js';
import { getFileSummary } from '../../src/tools/get-file-summary.js';
import { closeDatabase } from '../../src/persistence/db.js';

describe('getChangedFiles', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'repo-memory-changed-'));
    execFileSync('git', ['init'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('should report all files as added on first run', async () => {
    writeFileSync(join(tempDir, 'a.ts'), 'const a = 1;');
    writeFileSync(join(tempDir, 'b.ts'), 'const b = 2;');
    execFileSync('git', ['add', '.'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir });

    const result = await getChangedFiles(tempDir);

    expect(result.added.sort()).toEqual(['a.ts', 'b.ts']);
    expect(result.changed).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.checkedAt).toBeTruthy();
  });

  it('should detect a modified file as changed', async () => {
    writeFileSync(join(tempDir, 'a.ts'), 'const a = 1;');
    execFileSync('git', ['add', '.'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir });

    await getChangedFiles(tempDir);

    writeFileSync(join(tempDir, 'a.ts'), 'const a = 2;');

    const result = await getChangedFiles(tempDir);

    expect(result.changed).toEqual(['a.ts']);
    expect(result.added).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it('should detect a deleted file', async () => {
    writeFileSync(join(tempDir, 'a.ts'), 'const a = 1;');
    writeFileSync(join(tempDir, 'b.ts'), 'const b = 2;');
    execFileSync('git', ['add', '.'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir });

    await getChangedFiles(tempDir);

    unlinkSync(join(tempDir, 'b.ts'));
    execFileSync('git', ['add', '.'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'delete b'], { cwd: tempDir });

    const result = await getChangedFiles(tempDir);

    expect(result.deleted).toEqual(['b.ts']);
    expect(result.added).toEqual([]);
  });

  it('never serves a stale summary after a changed file is detected', async () => {
    writeFileSync(join(tempDir, 'a.ts'), 'export const a = 1;');
    execFileSync('git', ['add', '.'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir });

    // Cache a summary for the original content.
    const original = await getFileSummary(tempDir, 'a.ts');
    expect(original.summary.exports).toEqual(['a']);

    // Change the file, then run change detection (the post-merge pattern).
    writeFileSync(join(tempDir, 'a.ts'), 'export const renamed = 2;');
    const changes = await getChangedFiles(tempDir);
    expect(changes.changed).toEqual(['a.ts']);

    // The summary must regenerate — a cache hit here would be poisoned data.
    const after = await getFileSummary(tempDir, 'a.ts');
    expect(after.fromCache).toBe(false);
    expect(after.summary.exports).toEqual(['renamed']);
  });

  it('should not report unchanged files in any list', async () => {
    writeFileSync(join(tempDir, 'a.ts'), 'const a = 1;');
    writeFileSync(join(tempDir, 'b.ts'), 'const b = 2;');
    execFileSync('git', ['add', '.'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir });

    await getChangedFiles(tempDir);

    const result = await getChangedFiles(tempDir);

    expect(result.changed).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.deleted).toEqual([]);
  });
});
