import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getFileSummary } from '../../src/tools/get-file-summary.js';

describe('getFileSummary', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'repo-memory-test-'));
    await mkdir(join(tempDir, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns a fresh summary for a valid file (cache miss)', async () => {
    const filePath = 'src/example.ts';
    const fileContent = 'export function hello(): string {\n  return "hi";\n}\n';
    await writeFile(join(tempDir, filePath), fileContent, 'utf-8');

    const result = await getFileSummary(tempDir, filePath);

    expect(result.fromCache).toBe(false);
    expect(result.path).toBe(filePath);
    expect(result.hash).toBeTypeOf('string');
    expect(result.hash.length).toBe(64); // SHA-256 hex
    expect(result.summary.purpose).toBe('source');
    expect(result.summary.exports).toContain('hello');
    expect(result.summary.lineCount).toBe(4);
  });

  it('returns cached summary on second call', async () => {
    const filePath = 'src/example.ts';
    const fileContent = 'export const foo = 42;\n';
    await writeFile(join(tempDir, filePath), fileContent, 'utf-8');

    const first = await getFileSummary(tempDir, filePath);
    expect(first.fromCache).toBe(false);

    const second = await getFileSummary(tempDir, filePath);
    expect(second.fromCache).toBe(true);
    expect(second.hash).toBe(first.hash);
    expect(second.summary).toEqual(first.summary);
  });

  it('generates a fresh summary when file content changes', async () => {
    const filePath = 'src/example.ts';
    await writeFile(join(tempDir, filePath), 'export const a = 1;\n', {
      recursive: true,
    } as never);

    const first = await getFileSummary(tempDir, filePath);
    expect(first.fromCache).toBe(false);
    expect(first.summary.exports).toContain('a');

    // Modify the file
    await writeFile(join(tempDir, filePath), 'export const b = 2;\nexport const c = 3;\n');

    const second = await getFileSummary(tempDir, filePath);
    expect(second.fromCache).toBe(false);
    expect(second.hash).not.toBe(first.hash);
    expect(second.summary.exports).toContain('b');
    expect(second.summary.exports).toContain('c');
    expect(second.summary.exports).not.toContain('a');
  });

  it('throws when the file does not exist', async () => {
    await expect(getFileSummary(tempDir, 'nonexistent.ts')).rejects.toThrow();
  });
});
