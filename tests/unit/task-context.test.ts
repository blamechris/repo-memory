import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createTaskTool,
  getTaskContext,
  markExploredTool,
  type TaskContextResult,
  type TaskListResult,
} from '../../src/tools/task-context.js';
import { closeDatabase } from '../../src/persistence/db.js';

describe('task context MCP tools', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'task-ctx-test-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('create_task returns a valid task', () => {
    const task = createTaskTool(tempDir, 'Investigate bug #42');
    expect(task.id).toBeTruthy();
    expect(task.name).toBe('Investigate bug #42');
    expect(task.state).toBe('created');
  });

  it('get_task_context returns task list when no id given', () => {
    createTaskTool(tempDir, 'Task A');
    createTaskTool(tempDir, 'Task B');

    const result = getTaskContext(tempDir) as TaskListResult;
    expect(result.tasks).toHaveLength(2);
  });

  it('get_task_context returns task details with id', () => {
    const task = createTaskTool(tempDir, 'My Task');
    const result = getTaskContext(tempDir, task.id) as TaskContextResult;
    expect(result.task.id).toBe(task.id);
    expect(result.exploredFiles).toHaveLength(0);
    expect(result.frontier).toEqual([]);
  });

  it('mark_explored marks a file and returns confirmation', () => {
    const task = createTaskTool(tempDir, 'Explore task');
    const result = markExploredTool(tempDir, task.id, 'src/index.ts', 'explored', 'Entry point');
    expect(result.marked).toBe(true);
    expect(result.path).toBe('src/index.ts');
    expect(result.status).toBe('explored');

    const ctx = getTaskContext(tempDir, task.id) as TaskContextResult;
    expect(ctx.exploredFiles).toHaveLength(1);
    expect(ctx.exploredFiles[0].filePath).toBe('src/index.ts');
    expect(ctx.exploredFiles[0].notes).toBe('Entry point');
  });

  it('get_task_context computes frontier from project files', () => {
    const task = createTaskTool(tempDir, 'Frontier task');
    markExploredTool(tempDir, task.id, 'src/a.ts');
    markExploredTool(tempDir, task.id, 'src/b.ts');

    const allFiles = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    const ctx = getTaskContext(tempDir, task.id, allFiles) as TaskContextResult;
    expect(ctx.frontier).toContain('src/c.ts');
    expect(ctx.frontier).toContain('src/d.ts');
    expect(ctx.frontier).not.toContain('src/a.ts');
  });

  it('mark_explored auto-activates task', () => {
    const task = createTaskTool(tempDir, 'Auto-activate');
    expect(task.state).toBe('created');

    markExploredTool(tempDir, task.id, 'src/index.ts');

    const ctx = getTaskContext(tempDir, task.id) as TaskContextResult;
    expect(ctx.task.state).toBe('active');
  });

  it('throws for unknown task id', () => {
    expect(() => getTaskContext(tempDir, 'nonexistent-id')).toThrow('Task not found');
  });
});
