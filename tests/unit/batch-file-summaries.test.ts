import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { batchFileSummaries } from '../../src/tools/batch-file-summaries.js';

describe('batchFileSummaries', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'repo-memory-batch-test-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });

    // Initialize a git repo so getFileSummary works
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'ignore' });

    // Write test files
    writeFileSync(
      join(tempDir, 'src/alpha.ts'),
      'export function alpha(): string {\n  return "a";\n}\n',
    );
    writeFileSync(
      join(tempDir, 'src/beta.ts'),
      'export const beta = 42;\n',
    );
    writeFileSync(
      join(tempDir, 'src/gamma.ts'),
      'export class Gamma {\n  value = 1;\n}\n',
    );
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns summaries for multiple files', async () => {
    const result = await batchFileSummaries(tempDir, [
      'src/alpha.ts',
      'src/beta.ts',
      'src/gamma.ts',
    ]);

    expect(result.results).toHaveLength(3);
    expect(result.results[0].path).toBe('src/alpha.ts');
    expect(result.results[1].path).toBe('src/beta.ts');
    expect(result.results[2].path).toBe('src/gamma.ts');
    expect(result.results[0].summary.exports).toContain('alpha');
    expect(result.results[1].summary.exports).toContain('beta');
    expect(result.results[2].summary.exports).toContain('Gamma');
  });

  it('returns correct totalFiles count', async () => {
    const result = await batchFileSummaries(tempDir, [
      'src/alpha.ts',
      'src/beta.ts',
    ]);

    expect(result.totalFiles).toBe(2);
  });

  it('reports cache hits vs misses', async () => {
    // First call: all misses
    const first = await batchFileSummaries(tempDir, [
      'src/alpha.ts',
      'src/beta.ts',
    ]);
    // These files may already be cached from the previous test,
    // so just verify the counts add up
    expect(first.cacheHits + first.cacheMisses).toBe(2);
    expect(first.results).toHaveLength(2);

    // Second call: should all be cache hits now
    const second = await batchFileSummaries(tempDir, [
      'src/alpha.ts',
      'src/beta.ts',
    ]);
    expect(second.cacheHits).toBe(2);
    expect(second.cacheMisses).toBe(0);
  });

  it('collects errors for invalid/missing files without failing the batch', async () => {
    const result = await batchFileSummaries(tempDir, [
      'src/alpha.ts',
      'nonexistent.ts',
      '../../../etc/passwd',
    ]);

    // The valid file should succeed
    expect(result.results).toHaveLength(1);
    expect(result.results[0].path).toBe('src/alpha.ts');

    // The invalid files should be in errors
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].path).toBe('nonexistent.ts');
    expect(result.errors[1].path).toBe('../../../etc/passwd');

    // totalFiles still reflects all requested paths
    expect(result.totalFiles).toBe(3);
  });
});
