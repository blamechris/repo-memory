import { getDatabase } from '../persistence/db.js';

export type TelemetryEvent =
  | 'cache_hit'
  | 'cache_miss'
  | 'invalidation'
  | 'force_reread'
  | 'summary_served';

export interface TelemetryEntry {
  id: number;
  timestamp: number;
  eventType: TelemetryEvent;
  filePath: string | null;
  tokensEstimated: number | null;
  metadata: Record<string, unknown> | null;
}

interface TelemetryRow {
  id: number;
  timestamp: number;
  event_type: string;
  file_path: string | null;
  tokens_estimated: number | null;
  metadata_json: string | null;
}

export class TelemetryTracker {
  private readonly projectRoot: string;
  private enabled: boolean;

  constructor(projectRoot: string, enabled: boolean = true) {
    this.projectRoot = projectRoot;
    this.enabled = enabled;
  }

  trackEvent(
    eventType: TelemetryEvent,
    filePath?: string,
    tokensEstimated?: number,
    metadata?: Record<string, unknown>,
  ): void {
    if (!this.enabled) return;

    const db = getDatabase(this.projectRoot);
    db.prepare(
      'INSERT INTO telemetry (timestamp, event_type, file_path, tokens_estimated, metadata_json) VALUES (?, ?, ?, ?, ?)',
    ).run(
      Date.now(),
      eventType,
      filePath ?? null,
      tokensEstimated ?? null,
      metadata ? JSON.stringify(metadata) : null,
    );
  }

  getEvents(filter?: {
    eventType?: TelemetryEvent;
    since?: number;
    limit?: number;
  }): TelemetryEntry[] {
    const db = getDatabase(this.projectRoot);
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.eventType) {
      conditions.push('event_type = ?');
      params.push(filter.eventType);
    }
    if (filter?.since) {
      conditions.push('timestamp >= ?');
      params.push(filter.since);
    }

    let sql = 'SELECT * FROM telemetry';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY timestamp DESC';
    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }

    const rows = db.prepare(sql).all(...params) as TelemetryRow[];
    return rows.map(this.rowToEntry);
  }

  getStats(since?: number): {
    totalEvents: number;
    cacheHits: number;
    cacheMisses: number;
    hitRatio: number;
    totalTokensSaved: number;
    eventsByType: Record<string, number>;
  } {
    const db = getDatabase(this.projectRoot);
    const whereClause = since ? ' WHERE timestamp >= ?' : '';
    const params = since ? [since] : [];

    const countRows = db
      .prepare(
        `SELECT event_type, COUNT(*) as cnt FROM telemetry${whereClause} GROUP BY event_type`,
      )
      .all(...params) as Array<{ event_type: string; cnt: number }>;

    const eventsByType: Record<string, number> = {};
    let totalEvents = 0;
    let cacheHits = 0;
    let cacheMisses = 0;

    for (const row of countRows) {
      eventsByType[row.event_type] = row.cnt;
      totalEvents += row.cnt;
      if (row.event_type === 'cache_hit') cacheHits = row.cnt;
      if (row.event_type === 'cache_miss') cacheMisses = row.cnt;
    }

    const hitTotal = cacheHits + cacheMisses;
    const hitRatio = hitTotal > 0 ? cacheHits / hitTotal : 0;

    const tokenRow = db
      .prepare(
        `SELECT COALESCE(SUM(tokens_estimated), 0) as total FROM telemetry WHERE event_type = 'cache_hit'${since ? ' AND timestamp >= ?' : ''}`,
      )
      .get(...params) as { total: number };

    return {
      totalEvents,
      cacheHits,
      cacheMisses,
      hitRatio,
      totalTokensSaved: tokenRow.total,
      eventsByType,
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  private rowToEntry(row: TelemetryRow): TelemetryEntry {
    return {
      id: row.id,
      timestamp: row.timestamp,
      eventType: row.event_type as TelemetryEvent,
      filePath: row.file_path,
      tokensEstimated: row.tokens_estimated,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
    };
  }
}
