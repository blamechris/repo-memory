import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { closeDatabase } from '../../src/persistence/db.js';
import { TelemetryTracker } from '../../src/telemetry/tracker.js';

describe('TelemetryTracker', () => {
  let tempDir: string;
  let tracker: TelemetryTracker;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'repo-memory-telemetry-'));
    tracker = new TelemetryTracker(tempDir);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('tracks cache_hit event', () => {
    tracker.trackEvent('cache_hit', 'src/foo.ts', 200);
    const events = tracker.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('cache_hit');
    expect(events[0].filePath).toBe('src/foo.ts');
    expect(events[0].tokensEstimated).toBe(200);
  });

  it('tracks cache_miss event', () => {
    tracker.trackEvent('cache_miss', 'src/bar.ts', 150);
    const events = tracker.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('cache_miss');
    expect(events[0].filePath).toBe('src/bar.ts');
    expect(events[0].tokensEstimated).toBe(150);
  });

  it('getStats computes correct hit ratio', () => {
    tracker.trackEvent('cache_hit', 'a.ts', 100);
    tracker.trackEvent('cache_hit', 'b.ts', 100);
    tracker.trackEvent('cache_hit', 'c.ts', 100);
    tracker.trackEvent('cache_miss', 'd.ts', 100);

    const stats = tracker.getStats();
    expect(stats.cacheHits).toBe(3);
    expect(stats.cacheMisses).toBe(1);
    expect(stats.hitRatio).toBe(0.75);
  });

  it('getStats computes total tokens saved', () => {
    tracker.trackEvent('cache_hit', 'a.ts', 100);
    tracker.trackEvent('cache_hit', 'b.ts', 250);
    tracker.trackEvent('cache_miss', 'c.ts', 300);

    const stats = tracker.getStats();
    expect(stats.totalTokensSaved).toBe(350);
  });

  it('disabled tracker does not record events', () => {
    const disabledTracker = new TelemetryTracker(tempDir, false);
    disabledTracker.trackEvent('cache_hit', 'a.ts', 100);

    expect(disabledTracker.isEnabled()).toBe(false);
    const events = disabledTracker.getEvents();
    expect(events).toHaveLength(0);
  });

  it('filters by event type', () => {
    tracker.trackEvent('cache_hit', 'a.ts', 100);
    tracker.trackEvent('cache_miss', 'b.ts', 200);
    tracker.trackEvent('invalidation', 'c.ts');

    const hits = tracker.getEvents({ eventType: 'cache_hit' });
    expect(hits).toHaveLength(1);
    expect(hits[0].eventType).toBe('cache_hit');

    const misses = tracker.getEvents({ eventType: 'cache_miss' });
    expect(misses).toHaveLength(1);
    expect(misses[0].eventType).toBe('cache_miss');
  });

  it('filters by timestamp', () => {
    tracker.trackEvent('cache_hit', 'a.ts', 100);

    const futureTimestamp = Date.now() + 10000;
    const events = tracker.getEvents({ since: futureTimestamp });
    expect(events).toHaveLength(0);

    const pastEvents = tracker.getEvents({ since: 0 });
    expect(pastEvents).toHaveLength(1);
  });
});
