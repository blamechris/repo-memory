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

  /**
   * Remove a cache entry and the dependency-graph edges extracted from it, in
   * one transaction. Edges derive from the file's contents, so they share the
   * entry's lifetime — leaving them behind would serve stale graph data until
   * the next GC pass. (Incoming edges from other files are left alone: those
   * files' contents still declare the import.)
   */
  deleteEntry(path: string): void {
    const db = getDatabase(this.projectRoot);
    const remove = db.transaction((p: string) => {
      db.prepare('DELETE FROM imports WHERE source = ?').run(p);
      db.prepare('DELETE FROM files WHERE path = ?').run(p);
    });
    remove(path);
  }

  /** Refresh last_checked for an entry without altering its hash or summary. */
  touchEntry(path: string): void {
    const db = getDatabase(this.projectRoot);
    db.prepare('UPDATE files SET last_checked = ? WHERE path = ?').run(Date.now(), path);
  }

  setEntries(entries: Array<{ path: string; hash: string; summary?: FileSummary | null }>): void {
    const db = getDatabase(this.projectRoot);
    const now = Date.now();
    const stmt = db.prepare(
      `INSERT INTO files (path, hash, last_checked, summary_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         hash = excluded.hash,
         last_checked = excluded.last_checked,
         summary_json = excluded.summary_json`,
    );

    const runBatch = db.transaction(() => {
      for (const entry of entries) {
        const summaryJson = entry.summary ? JSON.stringify(entry.summary) : null;
        stmt.run(entry.path, entry.hash, now, summaryJson);
      }
    });

    runBatch();
  }

  /** Read a value from the meta key/value table. */
  getMeta(key: string): string | null {
    const db = getDatabase(this.projectRoot);
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /** Write a value to the meta key/value table. */
  setMeta(key: string, value: string): void {
    const db = getDatabase(this.projectRoot);
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }

  /**
   * Drop all cached summaries while keeping hashes and timestamps. Used when
   * the summarizer implementation changes: change detection stays intact and
   * summaries regenerate lazily on next access.
   */
  clearAllSummaries(): void {
    const db = getDatabase(this.projectRoot);
    db.prepare('UPDATE files SET summary_json = NULL').run();
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
