import { TaskMemory, type Task, type TaskFile } from '../memory/task.js';
import { validatePath } from '../utils/validate-path.js';

export interface TaskContextResult {
  task: Task;
  exploredFiles: TaskFile[];
  frontier: string[];
}

export interface TaskListResult {
  tasks: Task[];
}

export function createTaskTool(
  projectRoot: string,
  name: string,
  metadata?: Record<string, unknown>,
): Task {
  const memory = new TaskMemory(projectRoot);
  return memory.createTask(name, metadata);
}

export function getTaskContext(
  projectRoot: string,
  taskId?: string,
  allProjectFiles?: string[],
): TaskContextResult | TaskListResult {
  const memory = new TaskMemory(projectRoot);

  if (!taskId) {
    return { tasks: memory.listTasks() };
  }

  const task = memory.getTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const exploredFiles = memory.getExploredFiles(taskId);
  const frontier = allProjectFiles
    ? memory.getUnexploredFrontier(taskId, allProjectFiles)
    : [];

  return { task, exploredFiles, frontier };
}

export function markExploredTool(
  projectRoot: string,
  taskId: string,
  path: string,
  status?: 'explored' | 'skipped' | 'flagged',
  notes?: string,
): { marked: true; taskId: string; path: string; status: string } {
  path = validatePath(projectRoot, path);
  const memory = new TaskMemory(projectRoot);
  memory.markExplored(taskId, path, status, notes);
  return { marked: true, taskId, path, status: status ?? 'explored' };
}
