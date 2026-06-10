import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/persistence/db.js';
import { scanProject } from '../../src/indexer/scanner.js';
import { getFileSummary } from '../../src/tools/get-file-summary.js';
import { createPerfFixture } from '../benchmarks/perf-utils.js';

// Budgets are calibrated on Linux/macOS; Windows CI runners miss them on
// filesystem-heavy paths (observed ~3x). The budgets guard regressions on the
// primary platform — correctness on Windows is covered by the rest of the suite.
describe.skipIf(process.platform === 'win32')('performance budgets', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'repo-memory-perf-budget-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('getFileSummary completes within 100ms', async () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    const content = [
      'export function hello(): string {',
      '  return "world";',
      '}',
      '',
      'export const value = 42;',
      '',
    ].join('\n');
    writeFileSync(join(tempDir, 'src/test.ts'), content, 'utf-8');

    // Initialize git so scanProject works correctly
    const { execFileSync } = await import('child_process');
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['commit', '-m', 'init', '--no-gpg-sign'],
      {
        cwd: tempDir,
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@test.com',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@test.com',
        },
      },
    );

    const start = performance.now();
    await getFileSummary(tempDir, 'src/test.ts');
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
  });

  it('scanProject completes within 2s for 100 files', async () => {
    // Clean up the default tempDir since createPerfFixture makes its own
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

    const fixtureDir = createPerfFixture({ fileCount: 100 });
    tempDir = fixtureDir; // reassign so afterEach cleans it up

    const start = performance.now();
    await scanProject(fixtureDir);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(2000);
  });
});
