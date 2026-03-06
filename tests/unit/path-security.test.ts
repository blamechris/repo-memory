import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { getFileSummary } from '../../src/tools/get-file-summary.js';
import { forceReread } from '../../src/tools/force-reread.js';
import { markExploredTool } from '../../src/tools/task-context.js';

describe('path security integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'repo-memory-security-'));
    await mkdir(join(tempDir, 'src'), { recursive: true });
    await writeFile(
      join(tempDir, 'src/index.ts'),
      'export const hello = "world";\n',
      'utf-8',
    );
    // Initialize git repo (needed for scanner)
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    execSync('git add .', { cwd: tempDir, stdio: 'ignore' });
    execSync(
      'git -c user.name="Test" -c user.email="test@test.com" commit -m "init"',
      { cwd: tempDir, stdio: 'ignore' },
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('getFileSummary rejects path traversal', async () => {
    await expect(
      getFileSummary(tempDir, '../../etc/passwd'),
    ).rejects.toThrow('Path traversal detected');
  });

  it('forceReread rejects path traversal', async () => {
    await expect(
      forceReread(tempDir, '../../../tmp/evil'),
    ).rejects.toThrow('Path traversal detected');
  });

  it('markExploredTool rejects path traversal', () => {
    expect(() =>
      markExploredTool(tempDir, 'task-1', '../../outside'),
    ).toThrow('Path traversal detected');
  });

  it('getFileSummary allows normal paths', async () => {
    const result = await getFileSummary(tempDir, 'src/index.ts');
    expect(result.path).toBe('src/index.ts');
    expect(result.summary).toBeDefined();
  });

  it('forceReread allows normal paths', async () => {
    const result = await forceReread(tempDir, 'src/index.ts');
    expect(result.path).toBe('src/index.ts');
    expect(result.reread).toBe(true);
  });
});
