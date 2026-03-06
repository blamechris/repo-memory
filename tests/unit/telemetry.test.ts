import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { closeDatabase, getDatabase } from '../../src/persistence/db.js';
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

  describe('sampling', () => {
    it('records no events with sampling rate 0.0', () => {
      const sampledTracker = new TelemetryTracker(tempDir, true, 0.0);
      for (let i = 0; i < 20; i++) {
        sampledTracker.trackEvent('cache_hit', `file${i}.ts`, 100);
      }
      const events = sampledTracker.getEvents();
      expect(events).toHaveLength(0);
    });

    it('records all events with sampling rate 1.0', () => {
      const sampledTracker = new TelemetryTracker(tempDir, true, 1.0);
      for (let i = 0; i < 20; i++) {
        sampledTracker.trackEvent('cache_hit', `file${i}.ts`, 100);
      }
      const events = sampledTracker.getEvents();
      expect(events).toHaveLength(20);
    });

    it('records approximately half the events with sampling rate 0.5', () => {
      const sampledTracker = new TelemetryTracker(tempDir, true, 0.5);
      for (let i = 0; i < 100; i++) {
        sampledTracker.trackEvent('cache_hit', `file${i}.ts`, 100);
      }
      const events = sampledTracker.getEvents();
      expect(events.length).toBeGreaterThanOrEqual(20);
      expect(events.length).toBeLessThanOrEqual(80);
    });
  });

  describe('sampling rate getter/setter', () => {
    it('returns the configured sampling rate', () => {
      const sampledTracker = new TelemetryTracker(tempDir, true, 0.7);
      expect(sampledTracker.getSamplingRate()).toBe(0.7);
    });

    it('clamps rate below 0.0 to 0.0', () => {
      const sampledTracker = new TelemetryTracker(tempDir, true, -0.5);
      expect(sampledTracker.getSamplingRate()).toBe(0.0);

      tracker.setSamplingRate(-1.0);
      expect(tracker.getSamplingRate()).toBe(0.0);
    });

    it('clamps rate above 1.0 to 1.0', () => {
      const sampledTracker = new TelemetryTracker(tempDir, true, 2.0);
      expect(sampledTracker.getSamplingRate()).toBe(1.0);

      tracker.setSamplingRate(5.0);
      expect(tracker.getSamplingRate()).toBe(1.0);
    });
  });

  describe('JSONL export', () => {
    it('exports events as newline-delimited JSON', () => {
      tracker.trackEvent('cache_hit', 'a.ts', 100);
      tracker.trackEvent('cache_miss', 'b.ts', 200);
      tracker.trackEvent('invalidation', 'c.ts');

      const output = tracker.exportEvents();
      const lines = output.split('\n');
      expect(lines).toHaveLength(3);

      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed).toHaveProperty('timestamp');
        expect(parsed).toHaveProperty('eventType');
        expect(parsed).toHaveProperty('filePath');
        expect(parsed).toHaveProperty('tokensEstimated');
        expect(parsed).toHaveProperty('metadata');
      }

      expect(JSON.parse(lines[0]).eventType).toBe('cache_hit');
      expect(JSON.parse(lines[1]).eventType).toBe('cache_miss');
      expect(JSON.parse(lines[2]).eventType).toBe('invalidation');
    });

    it('exports filtered events by type', () => {
      tracker.trackEvent('cache_hit', 'a.ts', 100);
      tracker.trackEvent('cache_miss', 'b.ts', 200);
      tracker.trackEvent('cache_hit', 'c.ts', 300);

      const output = tracker.exportEvents({ eventType: 'cache_hit' });
      const lines = output.split('\n');
      expect(lines).toHaveLength(2);

      for (const line of lines) {
        expect(JSON.parse(line).eventType).toBe('cache_hit');
      }
    });

    it('returns empty string when no events match', () => {
      const output = tracker.exportEvents();
      expect(output).toBe('');
    });
  });

  describe('retention enforcement', () => {
    it('deletes old events and keeps recent ones', () => {
      const db = getDatabase(tempDir);

      // Insert an old event (90 days ago)
      const oldTimestamp = Date.now() - 90 * 24 * 60 * 60 * 1000;
      db.prepare(
        'INSERT INTO telemetry (timestamp, event_type, file_path, tokens_estimated, metadata_json) VALUES (?, ?, ?, ?, ?)',
      ).run(oldTimestamp, 'cache_hit', 'old.ts', 100, null);

      // Insert a recent event
      tracker.trackEvent('cache_hit', 'recent.ts', 200);

      const deleted = tracker.enforceRetention(30);
      expect(deleted).toBe(1);

      const events = tracker.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].filePath).toBe('recent.ts');
    });

    it('returns 0 when no events are old enough', () => {
      tracker.trackEvent('cache_hit', 'a.ts', 100);
      const deleted = tracker.enforceRetention(30);
      expect(deleted).toBe(0);
    });
  });
});
