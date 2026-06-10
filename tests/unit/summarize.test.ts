import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  summarizeForProject,
  getSummarizerMode,
  ensureSummaryGeneration,
  clearSummaryGenerationCache,
} from '../../src/indexer/summarize.js';
import { clearConfigCache } from '../../src/config.js';
import { CacheStore } from '../../src/cache/store.js';
import { closeDatabase } from '../../src/persistence/db.js';
import { getFileSummary } from '../../src/tools/get-file-summary.js';

const SAMPLE = [
  '/** Greets people. */',
  'export async function greet(name: string): Promise<string> {',
  '  return `hi ${name}`;',
  '}',
  '',
].join('\n');

describe('summarizeForProject', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'summarize-test-'));
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(join(tempDir, 'src', 'greet.ts'), SAMPLE);
    clearConfigCache();
    clearSummaryGenerationCache();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    clearConfigCache();
    clearSummaryGenerationCache();
  });

  it('defaults to the AST summarizer', async () => {
    expect(getSummarizerMode(tempDir)).toBe('ast');
    const summary = await summarizeForProject(tempDir, 'src/greet.ts', SAMPLE);
    expect(summary.purpose).toBe('function greet — Greets people.');
  });

  it('uses the regex summarizer when configured', async () => {
    writeFileSync(join(tempDir, '.repo-memory.json'), JSON.stringify({ summarizer: 'regex' }));
    expect(getSummarizerMode(tempDir)).toBe('regex');
    const summary = await summarizeForProject(tempDir, 'src/greet.ts', SAMPLE);
    expect(summary.purpose).toBe('source');
  });

  it('uses the AST summarizer when configured', async () => {
    writeFileSync(join(tempDir, '.repo-memory.json'), JSON.stringify({ summarizer: 'ast' }));
    expect(getSummarizerMode(tempDir)).toBe('ast');
    const summary = await summarizeForProject(tempDir, 'src/greet.ts', SAMPLE);
    expect(summary.purpose).toBe('function greet — Greets people.');
    expect(summary.exports).toEqual(['greet']);
  });

  it('drops cached summaries when the summarizer mode changes', async () => {
    // Populate the cache under the default AST mode.
    const first = await getFileSummary(tempDir, 'src/greet.ts');
    expect(first.fromCache).toBe(false);
    const second = await getFileSummary(tempDir, 'src/greet.ts');
    expect(second.fromCache).toBe(true);
    expect(second.summary.purpose).toBe('function greet — Greets people.');

    // Switch to the regex summarizer.
    writeFileSync(join(tempDir, '.repo-memory.json'), JSON.stringify({ summarizer: 'regex' }));
    clearConfigCache();
    clearSummaryGenerationCache();

    const third = await getFileSummary(tempDir, 'src/greet.ts');
    expect(third.fromCache).toBe(false); // stale AST summary was invalidated
    expect(third.summary.purpose).toBe('source');

    // Hashes were preserved, only summaries were dropped.
    const store = new CacheStore(tempDir);
    expect(store.getMeta('summarizer_generation')).toBe('regex:3');
  });

  it('does not wipe summaries when the mode is unchanged', async () => {
    await getFileSummary(tempDir, 'src/greet.ts');
    clearSummaryGenerationCache();
    ensureSummaryGeneration(tempDir);
    const result = await getFileSummary(tempDir, 'src/greet.ts');
    expect(result.fromCache).toBe(true);
  });
});
