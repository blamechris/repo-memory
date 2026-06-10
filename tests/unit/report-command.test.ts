import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runReport, formatReport } from '../../src/cli/report-command.js';
import { TelemetryTracker } from '../../src/telemetry/tracker.js';
import { clearConfigCache } from '../../src/config.js';
import { clearSummaryGenerationCache } from '../../src/indexer/summarize.js';
import { closeDatabase } from '../../src/persistence/db.js';
import { getFileSummary } from '../../src/tools/get-file-summary.js';

describe('runReport', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'report-command-test-'));
    mkdirSync(join(tempDir, 'src'));
    const body = Array.from(
      { length: 40 },
      (_, i) => `export function greet${i}(name: string): string {\n  return \`hi \${name} from ${i}\`;\n}`,
    ).join('\n');
    writeFileSync(join(tempDir, 'src', 'greet.ts'), body + '\n');
    clearConfigCache();
    clearSummaryGenerationCache();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    clearConfigCache();
    clearSummaryGenerationCache();
  });

  it('reports cache hits and misses from recorded agent traffic', async () => {
    await getFileSummary(tempDir, 'src/greet.ts'); // miss
    await getFileSummary(tempDir, 'src/greet.ts'); // hit

    const report = runReport(tempDir);
    expect(report.period).toBe('all');
    expect(report.cacheMisses).toBe(1);
    expect(report.cacheHits).toBe(1);
    expect(report.cacheHitRatio).toBe(0.5);
    expect(report.estimatedTokensSaved).toBeGreaterThan(0);
    expect(report.topFiles[0].path).toBe('src/greet.ts');
    expect(report.diagnostics).toBeUndefined();
  });

  it('reports zero events for a project with no telemetry', () => {
    const report = runReport(tempDir);
    expect(report.totalEvents).toBe(0);
    expect(report.estimatedTokensSaved).toBe(0);
  });

  it('restricts the window with hours', async () => {
    // An event recorded well before the window must be excluded; backdate it
    // directly in the table.
    const tracker = new TelemetryTracker(tempDir);
    tracker.trackEvent('cache_hit', 'src/old.ts', 100);
    const { getDatabase } = await import('../../src/persistence/db.js');
    getDatabase(tempDir)
      .prepare('UPDATE telemetry SET timestamp = ?')
      .run(Date.now() - 10 * 3600000);

    tracker.trackEvent('cache_hit', 'src/new.ts', 50);

    const recent = runReport(tempDir, { hours: 1 });
    expect(recent.period).toBe('last_n_hours');
    expect(recent.totalEvents).toBe(1);
    expect(recent.topFiles[0].path).toBe('src/new.ts');

    const all = runReport(tempDir);
    expect(all.totalEvents).toBe(2);
  });

  it('includes diagnostics on request', async () => {
    await getFileSummary(tempDir, 'src/greet.ts');
    const report = runReport(tempDir, { diagnostics: true });
    expect(report.diagnostics).toBeDefined();
    expect(report.diagnostics!.cacheEntryCount).toBe(1);
    expect(report.diagnostics!.dbFileSizeBytes).toBeGreaterThan(0);
  });

  it('rejects a project root that does not exist', () => {
    expect(() => runReport(join(tempDir, 'no-such-dir'))).toThrow(/does not exist/);
  });

  it('rejects a project root that is a file', () => {
    expect(() => runReport(join(tempDir, 'src', 'greet.ts'))).toThrow(/not a directory/);
  });
});

describe('formatReport', () => {
  it('renders counts, ratio, and top files', () => {
    const text = formatReport(
      '/proj',
      {
        period: 'all',
        totalEvents: 3,
        cacheHits: 2,
        cacheMisses: 1,
        cacheHitRatio: 0.667,
        estimatedTokensSaved: 1234,
        topFiles: [{ path: 'src/a.ts', accessCount: 2, tokensEstimated: 1000 }],
        eventBreakdown: { cache_hit: 2, cache_miss: 1 },
      },
      undefined,
    );
    expect(text).toContain('2 hits / 1 misses');
    expect(text).toContain('66.7% hit ratio');
    expect(text).toContain('~1,234');
    expect(text).toContain('2x src/a.ts');
    expect(text).toContain('all recorded events');
  });

  it('renders an empty-telemetry hint and n/a ratio', () => {
    const text = formatReport(
      '/proj',
      {
        period: 'last_n_hours',
        totalEvents: 0,
        cacheHits: 0,
        cacheMisses: 0,
        cacheHitRatio: 0,
        estimatedTokensSaved: 0,
        topFiles: [],
        eventBreakdown: {},
      },
      4,
    );
    expect(text).toContain('last 4h');
    expect(text).toContain('n/a hit ratio');
    expect(text).toContain('no telemetry recorded yet');
  });
});
