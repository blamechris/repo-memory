import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CacheStore } from '../../src/cache/store.js';
import { runIndex } from '../../src/cli/index-command.js';
import { TelemetryTracker } from '../../src/telemetry/tracker.js';
import { clearConfigCache } from '../../src/config.js';
import { clearSummaryGenerationCache } from '../../src/indexer/summarize.js';
import { closeDatabase, getDatabasePath } from '../../src/persistence/db.js';

describe('runIndex', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'index-command-test-'));
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(
      join(tempDir, 'src', 'greet.ts'),
      'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n',
    );
    writeFileSync(join(tempDir, 'src', 'answer.ts'), 'export const answer = 42;\n');
    clearConfigCache();
    clearSummaryGenerationCache();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    clearConfigCache();
    clearSummaryGenerationCache();
  });

  it('populates the cache on a fresh index', async () => {
    const report = await runIndex(tempDir, { quiet: true });

    expect(report.projectRoot).toBe(tempDir);
    expect(report.cacheDbPath).toBe(getDatabasePath(tempDir));
    expect(report.scanned).toBe(2);
    expect(report.summarized).toBe(2);
    expect(report.fresh).toBe(0);
    expect(report.skipped).toBe(0);
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);

    const store = new CacheStore(tempDir);
    const entry = store.getEntry('src/greet.ts');
    expect(entry).not.toBeNull();
    expect(entry!.hash.length).toBe(64); // SHA-256 hex
    expect(entry!.summary).not.toBeNull();
    expect(entry!.summary!.exports).toContain('greet');
  });

  it('reports all files as fresh on a second run', async () => {
    const first = await runIndex(tempDir, { quiet: true });
    expect(first.summarized).toBe(2);

    const second = await runIndex(tempDir, { quiet: true });
    expect(second.scanned).toBe(2);
    expect(second.summarized).toBe(0);
    expect(second.fresh).toBe(2);
  });

  it('re-summarizes only changed files', async () => {
    await runIndex(tempDir, { quiet: true });
    writeFileSync(join(tempDir, 'src', 'answer.ts'), 'export const answer = 43;\n');

    const report = await runIndex(tempDir, { quiet: true });
    expect(report.summarized).toBe(1);
    expect(report.fresh).toBe(1);
  });

  it('respects ignore patterns from .repo-memory.json', async () => {
    mkdirSync(join(tempDir, 'generated'));
    writeFileSync(join(tempDir, 'generated', 'out.ts'), 'export const out = true;\n');
    writeFileSync(join(tempDir, '.repo-memory.json'), JSON.stringify({ ignore: ['generated/'] }));

    const report = await runIndex(tempDir, { quiet: true });

    // src/greet.ts, src/answer.ts, and .repo-memory.json — but not generated/out.ts
    expect(report.scanned).toBe(3);

    const store = new CacheStore(tempDir);
    expect(store.getEntry('generated/out.ts')).toBeNull();
    expect(store.getEntry('src/greet.ts')).not.toBeNull();
  });

  it('indexes the sample-project fixture', async () => {
    // Copy the fixture so the cache db lands in a temp dir, not the repo.
    const fixture = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'fixtures',
      'sample-project',
    );
    const projectDir = join(tempDir, 'sample-project');
    cpSync(fixture, projectDir, { recursive: true });

    const report = await runIndex(projectDir, { quiet: true });
    // .gitignore, package.json, README.md, src/index.ts, src/utils.ts
    expect(report.scanned).toBe(5);
    expect(report.summarized).toBe(5);

    const store = new CacheStore(projectDir);
    expect(store.getEntry('src/index.ts')!.summary).not.toBeNull();
    expect(store.getEntry('src/utils.ts')!.summary).not.toBeNull();
  });

  it('records no telemetry events', async () => {
    await runIndex(tempDir, { quiet: true });
    await runIndex(tempDir, { quiet: true }); // second run hits the cache

    const tracker = new TelemetryTracker(tempDir);
    expect(tracker.getEvents()).toHaveLength(0);
  });

  it('rejects a project root that does not exist', async () => {
    const missing = join(tempDir, 'no-such-dir');
    await expect(runIndex(missing, { quiet: true })).rejects.toThrow(/does not exist/);
  });

  it('rejects a project root that is a file', async () => {
    const file = join(tempDir, 'src', 'greet.ts');
    await expect(runIndex(file, { quiet: true })).rejects.toThrow(/not a directory/);
  });
});
