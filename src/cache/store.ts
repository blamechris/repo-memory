import { getDatabase } from '../persistence/db.js';
import type { CacheEntry, FileSummary } from '../types.js';

interface FileRow {
  path: string;
  hash: string;
  last_checked: number;
  summary_json: string | null;
}

function rowToEntry(row: FileRow): CacheEntry {
  return {
    path: row.path,
    hash: row.hash,
    lastChecked: row.last_checked,
    summary: row.summary_json ? (JSON.parse(row.summary_json) as FileSummary) : null,
  };
}

export class CacheStore {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  getEntry(path: string): CacheEntry | null {
    const db = getDatabase(this.projectRoot);
    const row = db
      .prepare('SELECT path, hash, last_checked, summary_json FROM files WHERE path = ?')
      .get(path) as FileRow | undefined;

    return row ? rowToEntry(row) : null;
  }

  setEntry(path: string, hash: string, summary: FileSummary | null): void {
    const db = getDatabase(this.projectRoot);
    const summaryJson = summary ? JSON.stringify(summary) : null;
    const now = Date.now();

    db.prepare(
      `INSERT INTO files (path, hash, last_checked, summary_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         hash = excluded.hash,
         last_checked = excluded.last_checked,
         summary_json = excluded.summary_json`,
    ).run(path, hash, now, summaryJson);
  }

  getAllEntries(): CacheEntry[] {
    const db = getDatabase(this.projectRoot);
    const rows = db
      .prepare('SELECT path, hash, last_checked, summary_json FROM files')
      .all() as FileRow[];

    return rows.map(rowToEntry);
  }

  deleteEntry(path: string): void {
    const db = getDatabase(this.projectRoot);
    db.prepare('DELETE FROM files WHERE path = ?').run(path);
  }

  getStaleEntries(maxAge: number): CacheEntry[] {
    const db = getDatabase(this.projectRoot);
    const cutoff = Date.now() - maxAge;
    const rows = db
      .prepare(
        'SELECT path, hash, last_checked, summary_json FROM files WHERE last_checked < ?',
      )
      .all(cutoff) as FileRow[];

    return rows.map(rowToEntry);
  }
}
