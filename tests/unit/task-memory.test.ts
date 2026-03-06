import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TaskMemory } from '../../src/memory/task.js';
import { closeDatabase } from '../../src/persistence/db.js';

describe('TaskMemory', () => {
  let tempDir: string;
  let taskMemory: TaskMemory;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'task-memory-test-'));
    taskMemory = new TaskMemory(tempDir);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('createTask', () => {
    it('returns a valid task with generated id', () => {
      const task = taskMemory.createTask('investigate auth bug');

      expect(task.id).toBeDefined();
      expect(task.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(task.name).toBe('investigate auth bug');
      expect(task.state).toBe('created');
      expect(task.createdAt).toBeGreaterThan(0);
      expect(task.updatedAt).toBe(task.createdAt);
      expect(task.sessionId).toBeNull();
      expect(task.metadata).toBeNull();
    });

    it('stores metadata when provided', () => {
      const meta = { priority: 'high', tags: ['auth'] };
      const task = taskMemory.createTask('auth task', meta);

      expect(task.metadata).toEqual(meta);

      const retrieved = taskMemory.getTask(task.id);
      expect(retrieved?.metadata).toEqual(meta);
    });
  });

  describe('getTask', () => {
    it('retrieves a task by id', () => {
      const created = taskMemory.createTask('my task');
      const retrieved = taskMemory.getTask(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.name).toBe('my task');
      expect(retrieved!.state).toBe('created');
    });

    it('returns null for non-existent id', () => {
      const result = taskMemory.getTask('non-existent-id');
      expect(result).toBeNull();
    });
  });

  describe('listTasks', () => {
    it('returns all tasks', () => {
      taskMemory.createTask('task 1');
      taskMemory.createTask('task 2');
      taskMemory.createTask('task 3');

      const tasks = taskMemory.listTasks();
      expect(tasks).toHaveLength(3);
    });

    it('filters by state', () => {
      const t1 = taskMemory.createTask('task 1');
      taskMemory.createTask('task 2');
      taskMemory.updateTask(t1.id, { state: 'active' });

      const activeTasks = taskMemory.listTasks({ state: 'active' });
      expect(activeTasks).toHaveLength(1);
      expect(activeTasks[0].name).toBe('task 1');

      const createdTasks = taskMemory.listTasks({ state: 'created' });
      expect(createdTasks).toHaveLength(1);
      expect(createdTasks[0].name).toBe('task 2');
    });
  });

  describe('updateTask', () => {
    it('changes fields and bumps updated_at', () => {
      const task = taskMemory.createTask('original name');
      const originalUpdatedAt = task.updatedAt;

      // Small delay to ensure timestamp changes
      const updated = taskMemory.updateTask(task.id, {
        name: 'new name',
        state: 'active',
      });

      expect(updated.name).toBe('new name');
      expect(updated.state).toBe('active');
      expect(updated.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
    });

    it('throws for non-existent task', () => {
      expect(() =>
        taskMemory.updateTask('non-existent', { name: 'fail' }),
      ).toThrow('Task not found');
    });

    it('updates metadata', () => {
      const task = taskMemory.createTask('task', { old: true });
      const updated = taskMemory.updateTask(task.id, {
        metadata: { new: true },
      });

      expect(updated.metadata).toEqual({ new: true });
    });
  });

  describe('deleteTask', () => {
    it('removes task and associated files via CASCADE', () => {
      const task = taskMemory.createTask('doomed task');
      taskMemory.markExplored(task.id, 'src/index.ts');
      taskMemory.markExplored(task.id, 'src/utils.ts');

      expect(taskMemory.getExploredFiles(task.id)).toHaveLength(2);

      taskMemory.deleteTask(task.id);

      expect(taskMemory.getTask(task.id)).toBeNull();
      expect(taskMemory.getExploredFiles(task.id)).toHaveLength(0);
    });
  });

  describe('markExplored', () => {
    it('adds file entries', () => {
      const task = taskMemory.createTask('explore task');
      taskMemory.markExplored(task.id, 'src/foo.ts');
      taskMemory.markExplored(task.id, 'src/bar.ts', 'skipped');

      const files = taskMemory.getExploredFiles(task.id);
      expect(files).toHaveLength(2);

      const fileMap = new Map(files.map((f) => [f.filePath, f]));
      expect(fileMap.get('src/foo.ts')?.status).toBe('explored');
      expect(fileMap.get('src/bar.ts')?.status).toBe('skipped');
    });

    it('auto-activates task from created state', () => {
      const task = taskMemory.createTask('new task');
      expect(task.state).toBe('created');

      taskMemory.markExplored(task.id, 'src/file.ts');

      const updated = taskMemory.getTask(task.id);
      expect(updated!.state).toBe('active');
    });

    it('does not change state if already active', () => {
      const task = taskMemory.createTask('task');
      taskMemory.updateTask(task.id, { state: 'completed' });

      taskMemory.markExplored(task.id, 'src/file.ts');

      const retrieved = taskMemory.getTask(task.id);
      expect(retrieved!.state).toBe('completed');
    });

    it('supports notes', () => {
      const task = taskMemory.createTask('noted task');
      taskMemory.markExplored(task.id, 'src/main.ts', 'flagged', 'needs review');

      const files = taskMemory.getExploredFiles(task.id);
      expect(files[0].notes).toBe('needs review');
      expect(files[0].status).toBe('flagged');
    });
  });

  describe('getExploredFiles', () => {
    it('returns tracked files for a task', () => {
      const task = taskMemory.createTask('task');
      taskMemory.markExplored(task.id, 'a.ts');
      taskMemory.markExplored(task.id, 'b.ts');

      const files = taskMemory.getExploredFiles(task.id);
      expect(files).toHaveLength(2);
      expect(files.every((f) => f.taskId === task.id)).toBe(true);
    });

    it('returns empty array for task with no files', () => {
      const task = taskMemory.createTask('empty task');
      expect(taskMemory.getExploredFiles(task.id)).toHaveLength(0);
    });
  });

  describe('getUnexploredFrontier', () => {
    it('returns allProjectFiles minus explored files', () => {
      const task = taskMemory.createTask('frontier task');
      taskMemory.markExplored(task.id, 'src/a.ts');
      taskMemory.markExplored(task.id, 'src/b.ts');

      const allFiles = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
      const frontier = taskMemory.getUnexploredFrontier(task.id, allFiles);

      expect(frontier).toEqual(['src/c.ts', 'src/d.ts']);
    });

    it('returns all files when nothing explored', () => {
      const task = taskMemory.createTask('fresh task');
      const allFiles = ['src/x.ts', 'src/y.ts'];
      const frontier = taskMemory.getUnexploredFrontier(task.id, allFiles);

      expect(frontier).toEqual(allFiles);
    });
  });
});
