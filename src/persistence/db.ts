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
