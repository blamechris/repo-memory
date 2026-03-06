import { TelemetryTracker } from '../telemetry/tracker.js';
import { SessionManager } from '../memory/session.js';

export interface TokenReport {
  period: string;
  totalEvents: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRatio: number;
  estimatedTokensSaved: number;
  topFiles: Array<{ path: string; accessCount: number; tokensEstimated: number }>;
  eventBreakdown: Record<string, number>;
}

export function getTokenReport(
  projectRoot: string,
  period?: 'session' | 'all' | 'last_n_hours',
  hours?: number,
  sessionId?: string,
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

  return {
    period: effectivePeriod,
    totalEvents: stats.totalEvents,
    cacheHits: stats.cacheHits,
    cacheMisses: stats.cacheMisses,
    cacheHitRatio: stats.hitRatio,
    estimatedTokensSaved: stats.totalTokensSaved,
    topFiles,
    eventBreakdown: stats.eventsByType,
  };
}
