import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scanProject } from '../../src/indexer/scanner.js';

describe('scanProject', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scanner-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createFile(relativePath: string, content = ''): void {
    const fullPath = join(tempDir, relativePath);
    const dir = fullPath.slice(0, fullPath.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
  }

  it('finds all source files in a project', async () => {
    createFile('src/index.ts', 'export {}');
    createFile('src/utils.ts', 'export {}');
    createFile('package.json', '{}');

    const files = await scanProject(tempDir);
    expect(files).toContain('src/index.ts');
    expect(files).toContain('src/utils.ts');
    expect(files).toContain('package.json');
  });

  it('returns paths relative to rootDir', async () => {
    createFile('src/deep/nested/file.ts', 'export {}');

    const files = await scanProject(tempDir);
    expect(files).toContain('src/deep/nested/file.ts');
    expect(files.every((f) => !f.startsWith('/'))).toBe(true);
    expect(files.every((f) => !f.includes(tempDir))).toBe(true);
  });

  it('results are sorted alphabetically', async () => {
    createFile('z.ts', '');
    createFile('a.ts', '');
    createFile('m/b.ts', '');

    const files = await scanProject(tempDir);
    const sorted = [...files].sort((a, b) => a.localeCompare(b));
    expect(files).toEqual(sorted);
  });

  it('skips binary files by extension', async () => {
    createFile('image.png', '');
    createFile('font.woff', '');
    createFile('archive.zip', '');
    createFile('code.ts', 'export {}');

    const files = await scanProject(tempDir);
    expect(files).toContain('code.ts');
    expect(files).not.toContain('image.png');
    expect(files).not.toContain('font.woff');
    expect(files).not.toContain('archive.zip');
  });

  it('always skips .git, .repo-memory, and node_modules', async () => {
    createFile('.git/config', '');
    createFile('.repo-memory/cache.db', '');
    createFile('node_modules/pkg/index.js', '');
    createFile('src/app.ts', 'export {}');

    const files = await scanProject(tempDir);
    expect(files).toEqual(['src/app.ts']);
  });

  it('applies custom exclude patterns', async () => {
    createFile('src/index.ts', '');
    createFile('src/index.test.ts', '');
    createFile('docs/guide.md', '');

    const files = await scanProject(tempDir, { exclude: ['*.test.ts', 'docs/'] });
    expect(files).toContain('src/index.ts');
    expect(files).not.toContain('src/index.test.ts');
    expect(files).not.toContain('docs/guide.md');
  });

  it('applies custom include patterns', async () => {
    createFile('src/index.ts', '');
    createFile('src/utils.ts', '');
    createFile('README.md', '');

    const files = await scanProject(tempDir, { include: ['*.ts'] });
    expect(files).toContain('src/index.ts');
    expect(files).toContain('src/utils.ts');
    expect(files).not.toContain('README.md');
  });

  it('respects maxFiles option', async () => {
    createFile('a.ts', '');
    createFile('b.ts', '');
    createFile('c.ts', '');
    createFile('d.ts', '');

    const files = await scanProject(tempDir, { maxFiles: 2 });
    expect(files).toHaveLength(2);
    expect(files).toEqual(['a.ts', 'b.ts']);
  });

  it('handles empty directories gracefully', async () => {
    mkdirSync(join(tempDir, 'empty-dir'), { recursive: true });

    const files = await scanProject(tempDir);
    expect(files).toEqual([]);
  });

  it('handles non-existent directory gracefully', async () => {
    const nonExistent = join(tempDir, 'does-not-exist');
    const files = await scanProject(nonExistent);
    expect(files).toEqual([]);
  });
});
