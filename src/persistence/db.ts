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
];

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = db
    .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
    .get() as { version: number } | undefined;

  const currentVersion = applied?.version ?? 0;

  const sortedMigrations = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  const insertVersion = db.prepare(
    'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)',
  );

  const applyMigrations = db.transaction(() => {
    for (const migration of sortedMigrations) {
      if (migration.version > currentVersion) {
        migration.up(db);
        insertVersion.run(migration.version, Date.now());
      }
    }
  });

  applyMigrations();
}

export function getDatabase(projectRoot: string): Database.Database {
  const dbDir = join(projectRoot, REPO_MEMORY_DIR);
  const dbPath = join(dbDir, DB_FILENAME);

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

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
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
