import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const REPO_MEMORY_DIR = '.repo-memory';
const DB_FILENAME = 'cache.db';

let instance: Database.Database | null = null;
let instancePath: string | null = null;

const MIGRATIONS: Array<{ version: number; up: (db: Database.Database) => void }> = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS files (
          path TEXT PRIMARY KEY,
          hash TEXT NOT NULL,
          last_checked INTEGER NOT NULL,
          summary_json TEXT
        );
      `);
    },
  },
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'created',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          session_id TEXT,
          metadata_json TEXT
        );

        CREATE TABLE IF NOT EXISTS task_files (
          task_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'explored',
          notes TEXT,
          explored_at INTEGER NOT NULL,
          PRIMARY KEY (task_id, file_path),
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
      `);
    },
  },
  {
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS imports (
          source TEXT NOT NULL,
          target TEXT NOT NULL,
          specifiers TEXT NOT NULL,
          import_type TEXT NOT NULL,
          PRIMARY KEY (source, target, import_type)
        );
        CREATE INDEX IF NOT EXISTS idx_imports_target ON imports (target);
      `);
    },
  },
  {
    version: 4,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS telemetry (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          file_path TEXT,
          tokens_estimated INTEGER,
          metadata_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_telemetry_type ON telemetry (event_type);
        CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry (timestamp);
      `);
    },
  },
  {
    version: 5,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          metadata_json TEXT
        );
      `);
    },
  },
  {
    version: 6,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
];

function latestMigrationVersion(): number {
  return Math.max(...MIGRATIONS.map((m) => m.version));
}

function appliedSchemaVersion(db: Database.Database): number {
  const applied = db
    .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
    .get() as { version: number } | undefined;
  return applied?.version ?? 0;
}

/**
 * Concurrent-safe migrations (Guardian I9). Two processes opening a fresh
 * database at the same time (MCP server start + post-merge hook prewarm) must
 * both succeed:
 *
 * - The whole sequence runs under BEGIN IMMEDIATE, so competing processes
 *   serialize: the loser waits on the write lock (up to busy_timeout) instead
 *   of interleaving.
 * - `schema_version` is read *inside* the transaction, so the loser sees the
 *   winner's rows once it gets the lock and applies nothing.
 * - If the transaction still fails (busy_timeout exceeded, or a constraint
 *   from a writer not using this protocol), the failure is tolerated when
 *   another process has already completed the migrations.
 */
function runMigrations(db: Database.Database): void {
  const applyMigrations = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);

    const currentVersion = appliedSchemaVersion(db);
    const sortedMigrations = [...MIGRATIONS].sort((a, b) => a.version - b.version);
    const insertVersion = db.prepare(
      'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)',
    );

    for (const migration of sortedMigrations) {
      if (migration.version > currentVersion) {
        migration.up(db);
        insertVersion.run(migration.version, Date.now());
      }
    }
  });

  try {
    applyMigrations.immediate();
  } catch (err) {
    if (migrationsAlreadyApplied(db)) {
      return; // lost the race; another process migrated the database
    }
    throw err;
  }
}

function migrationsAlreadyApplied(db: Database.Database): boolean {
  try {
    return appliedSchemaVersion(db) >= latestMigrationVersion();
  } catch {
    return false; // schema_version table itself is missing or unreadable
  }
}

/**
 * Switching a fresh database into WAL takes a brief exclusive lock, and SQLite
 * returns SQLITE_BUSY from a journal-mode change *without invoking the busy
 * handler* when another connection holds a conflicting lock — so the
 * connection's busy_timeout does not cover this one statement. Two processes
 * opening a brand-new database together (MCP server start + post-merge hook
 * prewarm) hit exactly that, so retry briefly. Once the database is in WAL
 * the pragma is a no-op and never contends again.
 */
function enableWalMode(db: Database.Database): void {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== 'SQLITE_BUSY' || Date.now() >= deadline) {
        throw err;
      }
      sleepSync(10);
    }
  }
}

/** Synchronous sleep without blocking-spin (better-sqlite3 is a sync API). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Absolute path of the cache database for a project (whether or not it exists yet). */
export function getDatabasePath(projectRoot: string): string {
  return join(projectRoot, REPO_MEMORY_DIR, DB_FILENAME);
}

export function getDatabase(projectRoot: string): Database.Database {
  const dbDir = join(projectRoot, REPO_MEMORY_DIR);
  const dbPath = getDatabasePath(projectRoot);

  if (instance && instancePath === dbPath) {
    return instance;
  }

  if (instance && instancePath !== dbPath) {
    instance.close();
    instance = null;
    instancePath = null;
  }

  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath, { timeout: 5000 });
  enableWalMode(db);
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  instance = db;
  instancePath = dbPath;

  return db;
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
    instancePath = null;
  }
}
