import type { Database } from 'better-sqlite3';
import { getDatabase } from '../persistence/db.js';
import { GENERATION_META_KEY, isStoredGenerationNewer } from './generation.js';
import type { CacheEntry, FileSummary } from '../types.js';

interface FileRow {
  path: string;
  hash: string;
  last_checked: number;
  summary_json: string | null;
}

const UPSERT_ENTRY = `INSERT INTO files (path, hash, last_checked, summary_json)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(path) DO UPDATE SET
     hash = excluded.hash,
     last_checked = excluded.last_checked,
     summary_json = excluded.summary_json`;

/**
 * Upsert used when a lower-generation process tried to write a summary
 * (read-through mode): the hash and timestamp are persisted so change
 * detection stays correct, but the summary is not — and a newer-generation
 * summary already stored for the *same hash* is preserved rather than nulled.
 * (`files.hash` in the CASE refers to the pre-update row value.)
 */
const UPSERT_ENTRY_WITHOUT_SUMMARY = `INSERT INTO files (path, hash, last_checked, summary_json)
   VALUES (?, ?, ?, NULL)
   ON CONFLICT(path) DO UPDATE SET
     summary_json = CASE WHEN files.hash = excluded.hash THEN files.summary_json ELSE NULL END,
     hash = excluded.hash,
     last_checked = excluded.last_checked`;

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
    const now = Date.now();

    if (summary === null) {
      // A single statement is already atomic, and a null summary is safe to
      // write at any generation — no guard needed.
      db.prepare(UPSERT_ENTRY).run(path, hash, now, null);
      return;
    }

    // Summary writes re-check the stored generation tag every time (cheap
    // single-row read) instead of trusting the per-process memoization in
    // ensureSummaryGeneration: an external writer (e.g. a newer package
    // version run by a post-merge hook) may have bumped the generation since
    // this process last looked. BEGIN IMMEDIATE holds the write lock across
    // the check and the write so the tag cannot change in between.
    db.transaction(() => {
      if (this.summaryWritesBlocked(db)) {
        db.prepare(UPSERT_ENTRY_WITHOUT_SUMMARY).run(path, hash, now);
      } else {
        db.prepare(UPSERT_ENTRY).run(path, hash, now, JSON.stringify(summary));
      }
    }).immediate();
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
    const upsert = db.prepare(UPSERT_ENTRY);
    const upsertWithoutSummary = db.prepare(UPSERT_ENTRY_WITHOUT_SUMMARY);

    // IMMEDIATE so the generation check and the batch write happen under one
    // uninterrupted write lock (see setEntry).
    db.transaction(() => {
      const blocked = this.summaryWritesBlocked(db);
      for (const entry of entries) {
        if (entry.summary && blocked) {
          upsertWithoutSummary.run(entry.path, entry.hash, now);
        } else {
          const summaryJson = entry.summary ? JSON.stringify(entry.summary) : null;
          upsert.run(entry.path, entry.hash, now, summaryJson);
        }
      }
    }).immediate();
  }

  /**
   * Whether the stored generation tag belongs to a strictly newer package
   * generation than this process, in which case summary writes from this
   * process must not be persisted (Guardian I3). Must be called while the
   * write lock is held so the answer cannot change before the write lands.
   */
  private summaryWritesBlocked(db: Database): boolean {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(GENERATION_META_KEY) as
      | { value: string }
      | undefined;
    return isStoredGenerationNewer(row?.value ?? null);
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

  /**
   * Atomically drop all summaries and write a meta value in one IMMEDIATE
   * transaction (Guardian I4). Used for generation bumps: no other process
   * can insert an old-generation summary between the clear and the tag write,
   * and a crash between the two is unobservable.
   */
  clearAllSummariesAndSetMeta(key: string, value: string): void {
    const db = getDatabase(this.projectRoot);
    db.transaction(() => {
      db.prepare('UPDATE files SET summary_json = NULL').run();
      db.prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(key, value);
    }).immediate();
  }

  /**
   * Run `fn` while holding the database write lock (BEGIN IMMEDIATE). Use for
   * read-decide-write sequences that must not interleave with writes from
   * other processes. Nested store calls that open their own transactions
   * collapse into savepoints inside this one.
   */
  withWriteLock<T>(fn: () => T): T {
    const db = getDatabase(this.projectRoot);
    return db.transaction(fn).immediate();
  }

  /** Delete every cache entry in a single atomic statement. */
  deleteAllEntries(): void {
    const db = getDatabase(this.projectRoot);
    db.prepare('DELETE FROM files').run();
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
