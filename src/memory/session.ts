import { randomUUID } from 'node:crypto';
import { getDatabase } from '../persistence/db.js';

export interface Session {
  id: string;
  startedAt: number;
  endedAt: number | null;
  metadata: Record<string, unknown> | null;
}

interface SessionRow {
  id: string;
  started_at: number;
  ended_at: number | null;
  metadata_json: string | null;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
      : null,
  };
}

export class SessionManager {
  private readonly projectRoot: string;
  private currentSessionId: string | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  startSession(metadata?: Record<string, unknown>): Session {
    const db = getDatabase(this.projectRoot);
    const id = randomUUID();
    const now = Date.now();
    const metadataJson = metadata ? JSON.stringify(metadata) : null;

    db.prepare(
      `INSERT INTO sessions (id, started_at, ended_at, metadata_json)
       VALUES (?, ?, NULL, ?)`,
    ).run(id, now, metadataJson);

    this.currentSessionId = id;

    return {
      id,
      startedAt: now,
      endedAt: null,
      metadata: metadata ?? null,
    };
  }

  endSession(sessionId: string): void {
    const db = getDatabase(this.projectRoot);
    const now = Date.now();

    db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(now, sessionId);

    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }
  }

  getCurrentSession(): Session | null {
    if (!this.currentSessionId) {
      return null;
    }
    return this.getSession(this.currentSessionId);
  }

  getSession(id: string): Session | null {
    const db = getDatabase(this.projectRoot);
    const row = db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;

    return row ? rowToSession(row) : null;
  }

  listSessions(limit?: number): Session[] {
    const db = getDatabase(this.projectRoot);
    const effectiveLimit = limit ?? 100;

    const rows = db
      .prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?')
      .all(effectiveLimit) as SessionRow[];

    return rows.map(rowToSession);
  }

  getStaleFiles(sessionId: string): string[] {
    const db = getDatabase(this.projectRoot);
    const session = this.getSession(sessionId);
    if (!session) {
      return [];
    }

    const rows = db
      .prepare('SELECT path FROM files WHERE last_checked < ?')
      .all(session.startedAt) as Array<{ path: string }>;

    return rows.map((r) => r.path);
  }
}
