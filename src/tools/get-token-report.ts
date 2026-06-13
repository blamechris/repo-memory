import { statSync } from 'fs';
import { join } from 'path';
import { TelemetryTracker } from '../telemetry/tracker.js';
import { SessionManager } from '../memory/session.js';
import { CacheStore } from '../cache/store.js';

export interface CacheDiagnostics {
  cacheEntryCount: number;
  staleEntryCount: number;
  dbFileSizeBytes: number;
  cacheAgeDistribution: Record<string, number>;
}

export interface TokenReport {
  period: string;
  totalEvents: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRatio: number;
  estimatedTokensSaved: number;
  topFiles: Array<{ path: string; accessCount: number; tokensEstimated: number }>;
  /**
   * `search_by_purpose` queries that matched nothing against a non-empty
   * corpus, aggregated by query and ranked by frequency (top 10). This is the
   * "bad-ranking query" signal the FTS5 decision waits on (#192): a reviewable
   * list of what agents searched for and the lexical ranking couldn't satisfy.
   * Always present; empty when there were no such misses.
   */
  topMissedQueries: Array<{ query: string; count: number }>;
  eventBreakdown: Record<string, number>;
  diagnostics?: CacheDiagnostics;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STALE_THRESHOLD_DAYS = 30;

function buildCacheDiagnostics(projectRoot: string): CacheDiagnostics {
  const store = new CacheStore(projectRoot);
  const allEntries = store.getAllEntries();
  const staleEntries = store.getStaleEntries(STALE_THRESHOLD_DAYS * MS_PER_DAY);

  let dbFileSizeBytes = 0;
  try {
    const dbPath = join(projectRoot, '.repo-memory', 'cache.db');
    dbFileSizeBytes = statSync(dbPath).size;
  } catch {
    // DB file may not exist yet
  }

  const now = Date.now();
  const distribution: Record<string, number> = {
    '< 1 day': 0,
    '1-7 days': 0,
    '7-30 days': 0,
    '> 30 days': 0,
  };

  for (const entry of allEntries) {
    const ageDays = (now - entry.lastChecked) / MS_PER_DAY;
    if (ageDays < 1) {
      distribution['< 1 day']++;
    } else if (ageDays < 7) {
      distribution['1-7 days']++;
    } else if (ageDays < 30) {
      distribution['7-30 days']++;
    } else {
      distribution['> 30 days']++;
    }
  }

  return {
    cacheEntryCount: allEntries.length,
    staleEntryCount: staleEntries.length,
    dbFileSizeBytes,
    cacheAgeDistribution: distribution,
  };
}

export function getTokenReport(
  projectRoot: string,
  period?: 'session' | 'all' | 'last_n_hours',
  hours?: number,
  sessionId?: string,
  includeDiagnostics?: boolean,
): TokenReport {
  const tracker = new TelemetryTracker(projectRoot);
  const effectivePeriod = period ?? 'all';

  let since: number | undefined;

  if (effectivePeriod === 'session' && sessionId) {
    const sessionManager = new SessionManager(projectRoot);
    const session = sessionManager.getSession(sessionId);
    if (session) {
      since = session.startedAt;
    }
  } else if (effectivePeriod === 'last_n_hours' && hours != null) {
    since = Date.now() - hours * 3600000;
  }

  const events = tracker.getEvents({ since });
  const stats = tracker.getStats(since);

  // Aggregate top files by access count and tokens
  const fileMap = new Map<string, { accessCount: number; tokensEstimated: number }>();
  for (const event of events) {
    if (!event.filePath) continue;
    const entry = fileMap.get(event.filePath) ?? { accessCount: 0, tokensEstimated: 0 };
    entry.accessCount++;
    entry.tokensEstimated += event.tokensEstimated ?? 0;
    fileMap.set(event.filePath, entry);
  }

  const topFiles = [...fileMap.entries()]
    .map(([path, data]) => ({ path, ...data }))
    .sort((a, b) => b.accessCount - a.accessCount)
    .slice(0, 10);

  // Aggregate failed searches by their query text (search_miss carries the
  // query in metadata) so the FTS5 signal is a reviewable list, not raw rows.
  const missMap = new Map<string, number>();
  for (const event of events) {
    if (event.eventType !== 'search_miss') continue;
    const query = (event.metadata as { query?: unknown } | null)?.query;
    if (typeof query !== 'string') continue;
    missMap.set(query, (missMap.get(query) ?? 0) + 1);
  }
  const topMissedQueries = [...missMap.entries()]
    .map(([query, count]) => ({ query, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const report: TokenReport = {
    period: effectivePeriod,
    totalEvents: stats.totalEvents,
    cacheHits: stats.cacheHits,
    cacheMisses: stats.cacheMisses,
    cacheHitRatio: stats.hitRatio,
    estimatedTokensSaved: stats.totalTokensSaved,
    topFiles,
    topMissedQueries,
    eventBreakdown: stats.eventsByType,
  };

  if (includeDiagnostics) {
    report.diagnostics = buildCacheDiagnostics(projectRoot);
  }

  return report;
}
