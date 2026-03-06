import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getDatabase, closeDatabase } from '../../src/persistence/db.js';

describe('persistence layer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'repo-memory-test-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
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
});
