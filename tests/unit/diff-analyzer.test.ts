import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { analyzeDiff } from '../../src/indexer/diff-analyzer.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

describe('analyzeDiff', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'diff-analyzer-'));
    git(['init'], tmpDir);
    git(['config', 'user.email', 'test@test.com'], tmpDir);
    git(['config', 'user.name', 'Test'], tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects structural change when export is added', () => {
    const filePath = 'src/utils.ts';
    const fullPath = join(tmpDir, filePath);
    execFileSync('mkdir', ['-p', join(tmpDir, 'src')]);

    writeFileSync(fullPath, 'export const foo = 1;\n');
    git(['add', '.'], tmpDir);
    git(['commit', '-m', 'initial'], tmpDir);

    writeFileSync(
      fullPath,
      'export const foo = 1;\nexport const bar = 2;\n',
    );

    const result = analyzeDiff(filePath, tmpDir);
    expect(result.structural).toBe(true);
    expect(result.affectedExports).toContain('bar');
    expect(result.lineCountChanged).toBe(true);
  });

  it('detects structural change when import is added', () => {
    const filePath = 'src/app.ts';
    const fullPath = join(tmpDir, filePath);
    execFileSync('mkdir', ['-p', join(tmpDir, 'src')]);

    writeFileSync(fullPath, 'const x = 1;\n');
    git(['add', '.'], tmpDir);
    git(['commit', '-m', 'initial'], tmpDir);

    writeFileSync(
      fullPath,
      "import { foo } from './foo';\nconst x = 1;\n",
    );

    const result = analyzeDiff(filePath, tmpDir);
    expect(result.structural).toBe(true);
    expect(result.affectedImports).toContain('./foo');
  });

  it('detects non-structural change for body-only edit', () => {
    const filePath = 'src/utils.ts';
    const fullPath = join(tmpDir, filePath);
    execFileSync('mkdir', ['-p', join(tmpDir, 'src')]);

    writeFileSync(
      fullPath,
      'export function doStuff() {\n  return 1;\n}\n',
    );
    git(['add', '.'], tmpDir);
    git(['commit', '-m', 'initial'], tmpDir);

    writeFileSync(
      fullPath,
      'export function doStuff() {\n  return 42;\n}\n',
    );

    const result = analyzeDiff(filePath, tmpDir);
    expect(result.structural).toBe(false);
    expect(result.lineCountChanged).toBe(false);
  });

  it('returns structural true for empty diff', () => {
    const filePath = 'src/nothing.ts';
    const fullPath = join(tmpDir, filePath);
    execFileSync('mkdir', ['-p', join(tmpDir, 'src')]);

    writeFileSync(fullPath, 'const x = 1;\n');
    git(['add', '.'], tmpDir);
    git(['commit', '-m', 'initial'], tmpDir);

    // No changes made, diff is empty
    const result = analyzeDiff(filePath, tmpDir);
    expect(result.structural).toBe(true);
    expect(result.lineCountChanged).toBe(true);
  });

  it('detects structural change when declaration is added', () => {
    const filePath = 'src/lib.ts';
    const fullPath = join(tmpDir, filePath);
    execFileSync('mkdir', ['-p', join(tmpDir, 'src')]);

    writeFileSync(fullPath, 'const x = 1;\n');
    git(['add', '.'], tmpDir);
    git(['commit', '-m', 'initial'], tmpDir);

    writeFileSync(
      fullPath,
      'const x = 1;\nfunction helper() { return 2; }\n',
    );

    const result = analyzeDiff(filePath, tmpDir);
    expect(result.structural).toBe(true);
  });
});
