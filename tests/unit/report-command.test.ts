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

  it('aggregates failed searches into topMissedQueries', () => {
    const tracker = new TelemetryTracker(tempDir);
    tracker.trackEvent('search_miss', undefined, 0, { query: 'websocket reconnect', totalCached: 5 });
    tracker.trackEvent('search_miss', undefined, 0, { query: 'websocket reconnect', totalCached: 5 });
    tracker.trackEvent('search_miss', undefined, 0, { query: 'oauth refresh', totalCached: 5 });

    const report = runReport(tempDir);
    expect(report.topMissedQueries).toEqual([
      { query: 'websocket reconnect', count: 2 },
      { query: 'oauth refresh', count: 1 },
    ]);
    // A miss books no tokens, so the savings sum stays clean.
    expect(report.estimatedTokensSaved).toBe(0);
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
        topMissedQueries: [{ query: 'websocket reconnect', count: 3 }],
        eventBreakdown: { cache_hit: 2, cache_miss: 1 },
      },
      undefined,
    );
    expect(text).toContain('2 hits / 1 misses');
    expect(text).toContain('66.7% hit ratio');
    expect(text).toContain('~1,234');
    expect(text).toContain('2x src/a.ts');
    expect(text).toContain('all recorded events');
    expect(text).toContain('failed searches: 3');
    expect(text).toContain('3x "websocket reconnect"');
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
        topMissedQueries: [],
        eventBreakdown: {},
      },
      4,
    );
    expect(text).toContain('last 4h');
    expect(text).toContain('n/a hit ratio');
    expect(text).toContain('no telemetry recorded yet');
    expect(text).not.toContain('failed searches');
  });
});

// The `report --json` output is a published contract: chroxy's Control Room
// Integrations tab parses it (RepoMemoryReportSchema in chroxy's
// packages/protocol). These tests pin the exact key set at each level so a
// rename or restructure fails here instead of silently breaking that consumer.
// If you intend to change the shape, update this test AND chroxy's schema
// together, and treat it as a breaking change to the CLI contract.
describe('report --json contract (consumed by chroxy Integrations)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'report-contract-test-'));
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(join(tempDir, 'src', 'a.ts'), 'export const a = 1;\n');
    clearConfigCache();
    clearSummaryGenerationCache();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    clearConfigCache();
    clearSummaryGenerationCache();
  });

  it('pins the top-level TokenReport keys', () => {
    const report = runReport(tempDir);
    expect(Object.keys(report).sort()).toEqual([
      'cacheHitRatio',
      'cacheHits',
      'cacheMisses',
      'estimatedTokensSaved',
      'eventBreakdown',
      'period',
      'topFiles',
      'topMissedQueries',
      'totalEvents',
    ]);
  });

  it('adds exactly a diagnostics block under --diagnostics, with a pinned key set', () => {
    const base = Object.keys(runReport(tempDir));
    const withDiag = runReport(tempDir, { diagnostics: true });

    expect(Object.keys(withDiag).sort()).toEqual([...base, 'diagnostics'].sort());
    expect(Object.keys(withDiag.diagnostics!).sort()).toEqual([
      'cacheAgeDistribution',
      'cacheEntryCount',
      'dbFileSizeBytes',
      'staleEntryCount',
    ]);
  });

  it('holds the field types chroxy validates as a JSON round-trip', async () => {
    await getFileSummary(tempDir, 'src/a.ts');
    // Exercise the actual serialization boundary the consumer reads.
    const report = JSON.parse(JSON.stringify(runReport(tempDir, { diagnostics: true })));

    expect(typeof report.totalEvents).toBe('number');
    expect(typeof report.cacheHits).toBe('number');
    expect(typeof report.cacheMisses).toBe('number');
    expect(report.cacheHitRatio).toBeGreaterThanOrEqual(0);
    expect(report.cacheHitRatio).toBeLessThanOrEqual(1);
    expect(report.estimatedTokensSaved).toBeGreaterThanOrEqual(0);
    // chroxy flattens these two out of diagnostics; they must stay int|null-able.
    expect(Number.isInteger(report.diagnostics.cacheEntryCount)).toBe(true);
    expect(Number.isInteger(report.diagnostics.staleEntryCount)).toBe(true);
  });
});
