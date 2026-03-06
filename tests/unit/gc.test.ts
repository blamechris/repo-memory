import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGC } from '../../src/cache/gc.js';
import { CacheStore } from '../../src/cache/store.js';
import { closeDatabase, getDatabase } from '../../src/persistence/db.js';
import type Database from 'better-sqlite3';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('runGC', () => {
  let tempDir: string;
  let store: CacheStore;
  let db: Database.Database;

  function initGitRepo(dir: string): void {
    execSync('git init', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  }

  function createFile(name: string, content = 'export {};\n'): void {
    const filePath = join(tempDir, name);
    const dir = join(filePath, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content);
    execSync(`git add "${name}"`, { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m "add file" --allow-empty', { cwd: tempDir, stdio: 'ignore' });
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'repo-memory-gc-test-'));
    initGitRepo(tempDir);
    // Create at least one file so git repo is valid
    createFile('src/keep.ts');
    store = new CacheStore(tempDir);
    db = getDatabase(tempDir);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('removes cache entries for files that no longer exist on disk', async () => {
    // Add entries for existing and non-existing files
    store.setEntry('src/keep.ts', 'hash1', null);
    store.setEntry('src/deleted.ts', 'hash2', null);

    const result = await runGC(tempDir);

    expect(result.removedCacheEntries).toContain('src/deleted.ts');
    expect(result.removedCacheEntries).not.toContain('src/keep.ts');
    expect(store.getEntry('src/deleted.ts')).toBeNull();
    expect(store.getEntry('src/keep.ts')).not.toBeNull();
  });

  it('removes cache entries older than threshold', async () => {
    store.setEntry('src/keep.ts', 'hash1', null);
    // Make entry old
    const oldTimestamp = Date.now() - 31 * MS_PER_DAY;
    db.prepare('UPDATE files SET last_checked = ? WHERE path = ?').run(
      oldTimestamp,
      'src/keep.ts',
    );

    const result = await runGC(tempDir, { cacheMaxAgeDays: 30 });

    expect(result.removedCacheEntries).toContain('src/keep.ts');
    expect(store.getEntry('src/keep.ts')).toBeNull();
  });

  it('keeps recent cache entries', async () => {
    store.setEntry('src/keep.ts', 'hash1', null);

    const result = await runGC(tempDir, { cacheMaxAgeDays: 30 });

    expect(result.removedCacheEntries).not.toContain('src/keep.ts');
    expect(store.getEntry('src/keep.ts')).not.toBeNull();
  });

  it('removes completed tasks older than threshold', async () => {
    const oldTimestamp = Date.now() - 31 * MS_PER_DAY;
    db.prepare(
      `INSERT INTO tasks (id, name, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('task-old-completed', 'Old completed task', 'completed', oldTimestamp, oldTimestamp);

    db.prepare(
      `INSERT INTO tasks (id, name, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('task-old-archived', 'Old archived task', 'archived', oldTimestamp, oldTimestamp);

    const result = await runGC(tempDir, { taskMaxAgeDays: 30 });

    expect(result.removedTasks).toContain('task-old-completed');
    expect(result.removedTasks).toContain('task-old-archived');

    const remaining = db.prepare('SELECT id FROM tasks').all();
    expect(remaining).toHaveLength(0);
  });

  it('does NOT remove active tasks regardless of age', async () => {
    const oldTimestamp = Date.now() - 365 * MS_PER_DAY;
    db.prepare(
      `INSERT INTO tasks (id, name, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('task-active', 'Active task', 'active', oldTimestamp, oldTimestamp);

    db.prepare(
      `INSERT INTO tasks (id, name, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('task-created', 'Created task', 'created', oldTimestamp, oldTimestamp);

    const result = await runGC(tempDir, { taskMaxAgeDays: 1 });

    expect(result.removedTasks).not.toContain('task-active');
    expect(result.removedTasks).not.toContain('task-created');

    const remaining = db.prepare('SELECT id FROM tasks').all() as Array<{ id: string }>;
    expect(remaining).toHaveLength(2);
  });

  it('removes old telemetry events', async () => {
    const oldTimestamp = Date.now() - 91 * MS_PER_DAY;
    const recentTimestamp = Date.now();

    db.prepare(
      `INSERT INTO telemetry (timestamp, event_type, file_path, tokens_estimated)
       VALUES (?, ?, ?, ?)`,
    ).run(oldTimestamp, 'summarize', 'src/old.ts', 100);

    db.prepare(
      `INSERT INTO telemetry (timestamp, event_type, file_path, tokens_estimated)
       VALUES (?, ?, ?, ?)`,
    ).run(recentTimestamp, 'summarize', 'src/new.ts', 200);

    const result = await runGC(tempDir, { telemetryMaxAgeDays: 90 });

    expect(result.removedTelemetryCount).toBe(1);

    const remaining = db.prepare('SELECT * FROM telemetry').all();
    expect(remaining).toHaveLength(1);
  });

  it('removes orphan import records', async () => {
    // Add a file entry and an import from it
    store.setEntry('src/keep.ts', 'hash1', null);
    db.prepare(
      `INSERT INTO imports (source, target, specifiers, import_type)
       VALUES (?, ?, ?, ?)`,
    ).run('src/keep.ts', 'src/other.ts', 'foo', 'static');

    // Add an orphan import (source not in files table)
    db.prepare(
      `INSERT INTO imports (source, target, specifiers, import_type)
       VALUES (?, ?, ?, ?)`,
    ).run('src/deleted.ts', 'src/other.ts', 'bar', 'static');

    const result = await runGC(tempDir);

    expect(result.removedOrphanImports).toBe(1);

    const remaining = db
      .prepare('SELECT source FROM imports')
      .all() as Array<{ source: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].source).toBe('src/keep.ts');
  });

  it('dry run returns results without deleting', async () => {
    store.setEntry('src/keep.ts', 'hash1', null);
    store.setEntry('src/deleted.ts', 'hash2', null);

    const oldTimestamp = Date.now() - 91 * MS_PER_DAY;
    db.prepare(
      `INSERT INTO telemetry (timestamp, event_type) VALUES (?, ?)`,
    ).run(oldTimestamp, 'summarize');

    db.prepare(
      `INSERT INTO tasks (id, name, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('task-old', 'Old task', 'completed', oldTimestamp, oldTimestamp);

    const result = await runGC(tempDir, { dryRun: true });

    expect(result.removedCacheEntries).toContain('src/deleted.ts');
    expect(result.removedTasks).toContain('task-old');
    expect(result.removedTelemetryCount).toBe(1);

    // Nothing actually deleted
    expect(store.getEntry('src/deleted.ts')).not.toBeNull();
    expect(db.prepare('SELECT * FROM telemetry').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM tasks').all()).toHaveLength(1);
  });

  it('default thresholds work correctly', async () => {
    // Entry at 29 days should be kept with default 30-day threshold
    const recentOldTimestamp = Date.now() - 29 * MS_PER_DAY;
    store.setEntry('src/keep.ts', 'hash1', null);
    db.prepare('UPDATE files SET last_checked = ? WHERE path = ?').run(
      recentOldTimestamp,
      'src/keep.ts',
    );

    const result = await runGC(tempDir);

    expect(result.removedCacheEntries).not.toContain('src/keep.ts');
  });

  it('custom thresholds work', async () => {
    // Entry at 3 days old, with 2-day threshold should be removed
    const timestamp = Date.now() - 3 * MS_PER_DAY;
    store.setEntry('src/keep.ts', 'hash1', null);
    db.prepare('UPDATE files SET last_checked = ? WHERE path = ?').run(
      timestamp,
      'src/keep.ts',
    );

    db.prepare(
      `INSERT INTO tasks (id, name, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('task-1', 'Task', 'completed', timestamp, timestamp);

    db.prepare(
      `INSERT INTO telemetry (timestamp, event_type) VALUES (?, ?)`,
    ).run(timestamp, 'summarize');

    const result = await runGC(tempDir, {
      cacheMaxAgeDays: 2,
      taskMaxAgeDays: 2,
      telemetryMaxAgeDays: 2,
    });

    expect(result.removedCacheEntries).toContain('src/keep.ts');
    expect(result.removedTasks).toContain('task-1');
    expect(result.removedTelemetryCount).toBe(1);
  });
});
