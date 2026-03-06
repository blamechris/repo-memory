import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TaskMemory } from '../../src/memory/task.js';
import { CacheStore } from '../../src/cache/store.js';
import { closeDatabase } from '../../src/persistence/db.js';

describe('cross-turn state preservation', () => {
  let tempDir: string;

  afterEach(() => {
    closeDatabase();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('task state persists across database close/reopen (simulated server restart)', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cross-turn-'));

    // Turn 1: create task and explore files
    const memory1 = new TaskMemory(tempDir);
    const task = memory1.createTask('Bug investigation', { priority: 'high' }, 'session-1');
    memory1.markExplored(task.id, 'src/index.ts', 'explored', 'Entry point reviewed');
    memory1.markExplored(task.id, 'src/utils.ts', 'skipped', 'Not relevant');

    // Simulate server restart
    closeDatabase();

    // Turn 2: retrieve task state — should be fully preserved
    const memory2 = new TaskMemory(tempDir);
    const restored = memory2.getTask(task.id);
    expect(restored).not.toBeNull();
    expect(restored!.name).toBe('Bug investigation');
    expect(restored!.state).toBe('active'); // Auto-activated by markExplored
    expect(restored!.sessionId).toBe('session-1');
    expect(restored!.metadata).toEqual({ priority: 'high' });

    const files = memory2.getExploredFiles(task.id);
    expect(files).toHaveLength(2);
    expect(files.find((f) => f.filePath === 'src/index.ts')?.notes).toBe('Entry point reviewed');
    expect(files.find((f) => f.filePath === 'src/utils.ts')?.status).toBe('skipped');
  });

  it('cache entries persist across database close/reopen', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cross-turn-'));

    // Turn 1: store cache entries
    const store1 = new CacheStore(tempDir);
    store1.setEntry('src/a.ts', 'hash-a', {
      purpose: 'source',
      exports: ['foo'],
      imports: [],
      lineCount: 10,
      topLevelDeclarations: ['function foo'],
    });

    closeDatabase();

    // Turn 2: retrieve entries
    const store2 = new CacheStore(tempDir);
    const entry = store2.getEntry('src/a.ts');
    expect(entry).not.toBeNull();
    expect(entry!.hash).toBe('hash-a');
    expect(entry!.summary!.exports).toEqual(['foo']);
  });

  it('multiple tasks with different sessions persist correctly', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cross-turn-'));

    // Session 1
    const mem1 = new TaskMemory(tempDir);
    const t1 = mem1.createTask('Session 1 task', undefined, 'sess-1');
    mem1.markExplored(t1.id, 'file1.ts');

    closeDatabase();

    // Session 2
    const mem2 = new TaskMemory(tempDir);
    const t2 = mem2.createTask('Session 2 task', undefined, 'sess-2');
    mem2.markExplored(t2.id, 'file2.ts');

    // Both tasks visible
    const all = mem2.listTasks();
    expect(all).toHaveLength(2);

    // Session 1 task data intact
    const restored1 = mem2.getTask(t1.id);
    expect(restored1!.sessionId).toBe('sess-1');
    const files1 = mem2.getExploredFiles(t1.id);
    expect(files1).toHaveLength(1);
    expect(files1[0].filePath).toBe('file1.ts');
  });

  it('task state survives multiple close/reopen cycles', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cross-turn-'));

    const mem1 = new TaskMemory(tempDir);
    const task = mem1.createTask('Multi-turn task');
    closeDatabase();

    // Turn 2
    const mem2 = new TaskMemory(tempDir);
    mem2.markExplored(task.id, 'a.ts');
    closeDatabase();

    // Turn 3
    const mem3 = new TaskMemory(tempDir);
    mem3.markExplored(task.id, 'b.ts');
    mem3.updateTask(task.id, { state: 'completed' });
    closeDatabase();

    // Turn 4: verify full history
    const mem4 = new TaskMemory(tempDir);
    const final = mem4.getTask(task.id);
    expect(final!.state).toBe('completed');

    const files = mem4.getExploredFiles(task.id);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.filePath).sort()).toEqual(['a.ts', 'b.ts']);
  });
});
