import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionManager } from '../../src/memory/session.js';
import { closeDatabase, getDatabase } from '../../src/persistence/db.js';

describe('SessionManager', () => {
  let tempDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-test-'));
    manager = new SessionManager(tempDir);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('startSession and endSession', () => {
    it('starts a session with generated id and timestamps', () => {
      const session = manager.startSession();

      expect(session.id).toBeDefined();
      expect(session.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(session.startedAt).toBeGreaterThan(0);
      expect(session.endedAt).toBeNull();
      expect(session.metadata).toBeNull();
    });

    it('starts a session with metadata', () => {
      const meta = { agent: 'claude', version: '4.0' };
      const session = manager.startSession(meta);

      expect(session.metadata).toEqual(meta);

      const retrieved = manager.getSession(session.id);
      expect(retrieved?.metadata).toEqual(meta);
    });

    it('ends a session by setting ended_at', () => {
      const session = manager.startSession();
      manager.endSession(session.id);

      const ended = manager.getSession(session.id);
      expect(ended).not.toBeNull();
      expect(ended!.endedAt).not.toBeNull();
      expect(ended!.endedAt).toBeGreaterThanOrEqual(ended!.startedAt);
    });
  });

  describe('getCurrentSession', () => {
    it('returns null when no session started', () => {
      expect(manager.getCurrentSession()).toBeNull();
    });

    it('returns the active session', () => {
      const session = manager.startSession();
      const current = manager.getCurrentSession();

      expect(current).not.toBeNull();
      expect(current!.id).toBe(session.id);
    });

    it('returns null after session ends', () => {
      const session = manager.startSession();
      manager.endSession(session.id);

      expect(manager.getCurrentSession()).toBeNull();
    });

    it('tracks the most recently started session', () => {
      const s1 = manager.startSession();
      manager.endSession(s1.id);

      const s2 = manager.startSession();
      const current = manager.getCurrentSession();

      expect(current!.id).toBe(s2.id);
    });
  });

  describe('listSessions', () => {
    it('returns sessions in reverse chronological order', () => {
      const db = getDatabase(tempDir);
      const now = Date.now();

      const ids = ['aaa', 'bbb', 'ccc'];
      db.prepare(
        'INSERT INTO sessions (id, started_at, ended_at, metadata_json) VALUES (?, ?, NULL, NULL)',
      ).run(ids[0], now - 2000);
      db.prepare(
        'INSERT INTO sessions (id, started_at, ended_at, metadata_json) VALUES (?, ?, NULL, NULL)',
      ).run(ids[1], now - 1000);
      db.prepare(
        'INSERT INTO sessions (id, started_at, ended_at, metadata_json) VALUES (?, ?, NULL, NULL)',
      ).run(ids[2], now);

      const sessions = manager.listSessions();

      expect(sessions).toHaveLength(3);
      expect(sessions[0].id).toBe('ccc');
      expect(sessions[1].id).toBe('bbb');
      expect(sessions[2].id).toBe('aaa');
    });

    it('respects limit parameter', () => {
      manager.startSession();
      manager.startSession();
      manager.startSession();

      const sessions = manager.listSessions(2);
      expect(sessions).toHaveLength(2);
    });

    it('returns empty array when no sessions exist', () => {
      expect(manager.listSessions()).toHaveLength(0);
    });
  });

  describe('getSession', () => {
    it('returns null for non-existent id', () => {
      expect(manager.getSession('non-existent')).toBeNull();
    });

    it('retrieves a session by id', () => {
      const created = manager.startSession({ key: 'value' });
      const retrieved = manager.getSession(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.startedAt).toBe(created.startedAt);
      expect(retrieved!.metadata).toEqual({ key: 'value' });
    });
  });

  describe('getStaleFiles', () => {
    it('detects files checked before session start', () => {
      const db = getDatabase(tempDir);

      const pastTime = Date.now() - 60_000;
      db.prepare(
        'INSERT INTO files (path, hash, last_checked) VALUES (?, ?, ?)',
      ).run('src/old.ts', 'abc123', pastTime);
      db.prepare(
        'INSERT INTO files (path, hash, last_checked) VALUES (?, ?, ?)',
      ).run('src/ancient.ts', 'def456', pastTime - 10_000);

      const session = manager.startSession();

      const stale = manager.getStaleFiles(session.id);
      expect(stale).toContain('src/old.ts');
      expect(stale).toContain('src/ancient.ts');
      expect(stale).toHaveLength(2);
    });

    it('does not include files checked after session start', () => {
      const session = manager.startSession();

      const db = getDatabase(tempDir);
      const futureTime = Date.now() + 60_000;
      db.prepare(
        'INSERT INTO files (path, hash, last_checked) VALUES (?, ?, ?)',
      ).run('src/fresh.ts', 'xyz789', futureTime);

      const stale = manager.getStaleFiles(session.id);
      expect(stale).not.toContain('src/fresh.ts');
    });

    it('returns empty array for non-existent session', () => {
      expect(manager.getStaleFiles('non-existent')).toHaveLength(0);
    });
  });

  describe('multiple sessions', () => {
    it('tracks sessions independently', () => {
      const s1 = manager.startSession({ name: 'session-1' });
      manager.endSession(s1.id);

      const s2 = manager.startSession({ name: 'session-2' });

      const retrieved1 = manager.getSession(s1.id);
      const retrieved2 = manager.getSession(s2.id);

      expect(retrieved1).not.toBeNull();
      expect(retrieved2).not.toBeNull();
      expect(retrieved1!.endedAt).not.toBeNull();
      expect(retrieved2!.endedAt).toBeNull();
      expect(retrieved1!.metadata).toEqual({ name: 'session-1' });
      expect(retrieved2!.metadata).toEqual({ name: 'session-2' });
    });
  });
});
