import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { closeDatabase, getDatabase } from '../../src/persistence/db.js';
import { TelemetryTracker } from '../../src/telemetry/tracker.js';
import { SessionManager } from '../../src/memory/session.js';
import { getTokenReport } from '../../src/tools/get-token-report.js';

describe('getTokenReport', () => {
  let tempDir: string;
  let tracker: TelemetryTracker;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'repo-memory-token-report-'));
    tracker = new TelemetryTracker(tempDir);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty/zero report when no telemetry data', () => {
    const report = getTokenReport(tempDir);
    expect(report.period).toBe('all');
    expect(report.totalEvents).toBe(0);
    expect(report.cacheHits).toBe(0);
    expect(report.cacheMisses).toBe(0);
    expect(report.cacheHitRatio).toBe(0);
    expect(report.estimatedTokensSaved).toBe(0);
    expect(report.topFiles).toEqual([]);
    expect(report.eventBreakdown).toEqual({});
  });

  it('correctly counts cache hits and misses', () => {
    tracker.trackEvent('cache_hit', 'a.ts', 100);
    tracker.trackEvent('cache_hit', 'b.ts', 200);
    tracker.trackEvent('cache_miss', 'c.ts', 300);

    const report = getTokenReport(tempDir);
    expect(report.cacheHits).toBe(2);
    expect(report.cacheMisses).toBe(1);
  });

  it('calculates cache hit ratio', () => {
    tracker.trackEvent('cache_hit', 'a.ts', 100);
    tracker.trackEvent('cache_hit', 'b.ts', 100);
    tracker.trackEvent('cache_hit', 'c.ts', 100);
    tracker.trackEvent('cache_miss', 'd.ts', 100);

    const report = getTokenReport(tempDir);
    expect(report.cacheHitRatio).toBe(0.75);
  });

  it('estimates tokens saved from cache hits', () => {
    tracker.trackEvent('cache_hit', 'a.ts', 100);
    tracker.trackEvent('cache_hit', 'b.ts', 250);
    tracker.trackEvent('cache_miss', 'c.ts', 300);

    const report = getTokenReport(tempDir);
    expect(report.estimatedTokensSaved).toBe(350);
  });

  it('lists top accessed files sorted by access count', () => {
    tracker.trackEvent('cache_hit', 'a.ts', 100);
    tracker.trackEvent('cache_hit', 'a.ts', 100);
    tracker.trackEvent('cache_hit', 'a.ts', 100);
    tracker.trackEvent('cache_hit', 'b.ts', 200);
    tracker.trackEvent('cache_miss', 'c.ts', 50);

    const report = getTokenReport(tempDir);
    expect(report.topFiles).toHaveLength(3);
    expect(report.topFiles[0].path).toBe('a.ts');
    expect(report.topFiles[0].accessCount).toBe(3);
    expect(report.topFiles[0].tokensEstimated).toBe(300);
    // b.ts and c.ts both have accessCount 1, so just check they are present
    const remainingPaths = report.topFiles.slice(1).map((f) => f.path);
    expect(remainingPaths).toContain('b.ts');
    expect(remainingPaths).toContain('c.ts');
    expect(report.topFiles[1].accessCount).toBe(1);
  });

  it('limits top files to 10', () => {
    for (let i = 0; i < 15; i++) {
      tracker.trackEvent('cache_hit', `file${i}.ts`, 100);
    }

    const report = getTokenReport(tempDir);
    expect(report.topFiles).toHaveLength(10);
  });

  it('filters by time period (last_n_hours)', () => {
    // Insert an event 2 hours in the past via raw SQL
    const db = getDatabase(tempDir);
    const twoHoursAgo = Date.now() - 2 * 3600000;
    db.prepare(
      'INSERT INTO telemetry (timestamp, event_type, file_path, tokens_estimated) VALUES (?, ?, ?, ?)',
    ).run(twoHoursAgo, 'cache_hit', 'old.ts', 100);

    // Record a recent event
    tracker.trackEvent('cache_hit', 'new.ts', 200);

    // Looking back 1 hour should only find the recent event
    const report = getTokenReport(tempDir, 'last_n_hours', 1);
    expect(report.period).toBe('last_n_hours');
    expect(report.totalEvents).toBe(1);
    expect(report.topFiles[0].path).toBe('new.ts');

    // Looking back 3 hours should find both events
    const fullReport = getTokenReport(tempDir, 'last_n_hours', 3);
    expect(fullReport.totalEvents).toBe(2);
  });

  it('session-scoped report works', () => {
    // Record an event well in the past
    const db = getDatabase(tempDir);
    const pastTimestamp = Date.now() - 60000;
    db.prepare(
      'INSERT INTO telemetry (timestamp, event_type, file_path, tokens_estimated) VALUES (?, ?, ?, ?)',
    ).run(pastTimestamp, 'cache_hit', 'before.ts', 100);

    const sessionManager = new SessionManager(tempDir);
    const session = sessionManager.startSession();

    // Record events after session starts
    tracker.trackEvent('cache_hit', 'after.ts', 200);
    tracker.trackEvent('cache_miss', 'after2.ts', 150);

    const report = getTokenReport(tempDir, 'session', undefined, session.id);
    expect(report.period).toBe('session');
    expect(report.totalEvents).toBe(2);
    expect(report.cacheHits).toBe(1);
    expect(report.cacheMisses).toBe(1);
    expect(report.estimatedTokensSaved).toBe(200);
  });

  it('event breakdown by type', () => {
    tracker.trackEvent('cache_hit', 'a.ts', 100);
    tracker.trackEvent('cache_hit', 'b.ts', 200);
    tracker.trackEvent('cache_miss', 'c.ts', 300);
    tracker.trackEvent('invalidation', 'd.ts');
    tracker.trackEvent('force_reread', 'e.ts', 500);

    const report = getTokenReport(tempDir);
    expect(report.eventBreakdown).toEqual({
      cache_hit: 2,
      cache_miss: 1,
      invalidation: 1,
      force_reread: 1,
    });
  });

  it('defaults to "all" period when none specified', () => {
    const report = getTokenReport(tempDir);
    expect(report.period).toBe('all');
  });
});
