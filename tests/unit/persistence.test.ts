import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { getDatabase, closeDatabase } from '../../src/persistence/db.js';

describe('persistence layer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'repo-memory-test-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('creates database and .repo-memory directory on first access', () => {
    const db = getDatabase(tempDir);
    expect(db).toBeDefined();
    expect(existsSync(join(tempDir, '.repo-memory'))).toBe(true);
    expect(existsSync(join(tempDir, '.repo-memory', 'cache.db'))).toBe(true);
  });

  it('creates schema_version table', () => {
    const db = getDatabase(tempDir);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get() as { name: string } | undefined;
    expect(row?.name).toBe('schema_version');
  });

  it('creates files table with correct columns', () => {
    const db = getDatabase(tempDir);
    const columns = db.prepare("PRAGMA table_info('files')").all() as Array<{ name: string }>;
    const columnNames = columns.map(c => c.name);
    expect(columnNames).toContain('path');
    expect(columnNames).toContain('hash');
    expect(columnNames).toContain('last_checked');
    expect(columnNames).toContain('summary_json');
  });

  it('tracks schema version', () => {
    const db = getDatabase(tempDir);
    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number };
    expect(row.version).toBeGreaterThanOrEqual(1);
  });

  it('returns same instance on multiple calls', () => {
    const db1 = getDatabase(tempDir);
    const db2 = getDatabase(tempDir);
    expect(db1).toBe(db2);
  });

  it('can insert and query file entries', () => {
    const db = getDatabase(tempDir);
    db.prepare('INSERT INTO files (path, hash, last_checked, summary_json) VALUES (?, ?, ?, ?)').run(
      'src/test.ts',
      'abc123',
      Date.now(),
      JSON.stringify({ purpose: 'test' }),
    );
    const row = db.prepare('SELECT * FROM files WHERE path = ?').get('src/test.ts') as { path: string; hash: string };
    expect(row.path).toBe('src/test.ts');
    expect(row.hash).toBe('abc123');
  });

  it('sets an explicit busy_timeout', () => {
    const db = getDatabase(tempDir);
    const timeout = db.pragma('busy_timeout', { simple: true }) as number;
    expect(timeout).toBe(5000);
  });

  it('opens a database another connection already fully migrated (race loser path)', () => {
    // "Process 1" migrates the fresh database and closes.
    getDatabase(tempDir);
    closeDatabase();

    // "Process 2" opens it: the in-transaction version re-read must see the
    // applied migrations and apply nothing, without throwing.
    const db = getDatabase(tempDir);
    const count = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number };
    const max = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(count.n).toBe(max.v); // one row per version, no duplicates
  });

  it('completes a partially migrated database left by another process', () => {
    // Simulate an older package version that only knew migrations 1-3.
    const dbDir = join(tempDir, '.repo-memory');
    mkdirSync(dbDir, { recursive: true });
    const raw = new Database(join(dbDir, 'cache.db'));
    raw.pragma('journal_mode = WAL');
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, last_checked INTEGER NOT NULL, summary_json TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'created', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, session_id TEXT, metadata_json TEXT);
      CREATE TABLE task_files (task_id TEXT NOT NULL, file_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'explored', notes TEXT, explored_at INTEGER NOT NULL, PRIMARY KEY (task_id, file_path), FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE);
      CREATE TABLE imports (source TEXT NOT NULL, target TEXT NOT NULL, specifiers TEXT NOT NULL, import_type TEXT NOT NULL, PRIMARY KEY (source, target, import_type));
      CREATE INDEX idx_imports_target ON imports (target);
      INSERT INTO schema_version (version, applied_at) VALUES (1, 1), (2, 2), (3, 3);
    `);
    raw.close();

    const db = getDatabase(tempDir);
    const versions = (
      db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{
        version: number;
      }>
    ).map((r) => r.version);
    expect(versions.slice(0, 3)).toEqual([1, 2, 3]);
    expect(versions.length).toBeGreaterThanOrEqual(6);
    for (const table of ['telemetry', 'sessions', 'meta']) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table);
      expect(row, `table ${table} should exist`).toBeDefined();
    }
  });
});
