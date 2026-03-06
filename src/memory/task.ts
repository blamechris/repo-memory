import { randomUUID } from 'node:crypto';
import { getDatabase } from '../persistence/db.js';

export interface Task {
  id: string;
  name: string;
  state: 'created' | 'active' | 'completed' | 'archived';
  createdAt: number;
  updatedAt: number;
  sessionId: string | null;
  metadata: Record<string, unknown> | null;
}

export interface TaskFile {
  taskId: string;
  filePath: string;
  status: 'explored' | 'skipped' | 'flagged';
  notes: string | null;
  exploredAt: number;
}

interface TaskRow {
  id: string;
  name: string;
  state: string;
  created_at: number;
  updated_at: number;
  session_id: string | null;
  metadata_json: string | null;
}

interface TaskFileRow {
  task_id: string;
  file_path: string;
  status: string;
  notes: string | null;
  explored_at: number;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    name: row.name,
    state: row.state as Task['state'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sessionId: row.session_id,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
      : null,
  };
}

function rowToTaskFile(row: TaskFileRow): TaskFile {
  return {
    taskId: row.task_id,
    filePath: row.file_path,
    status: row.status as TaskFile['status'],
    notes: row.notes,
    exploredAt: row.explored_at,
  };
}

export class TaskMemory {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  createTask(name: string, metadata?: Record<string, unknown>): Task {
    const db = getDatabase(this.projectRoot);
    const id = randomUUID();
    const now = Date.now();
    const metadataJson = metadata ? JSON.stringify(metadata) : null;

    db.prepare(
      `INSERT INTO tasks (id, name, state, created_at, updated_at, session_id, metadata_json)
       VALUES (?, ?, 'created', ?, ?, NULL, ?)`,
    ).run(id, name, now, now, metadataJson);

    return {
      id,
      name,
      state: 'created',
      createdAt: now,
      updatedAt: now,
      sessionId: null,
      metadata: metadata ?? null,
    };
  }

  getTask(id: string): Task | null {
    const db = getDatabase(this.projectRoot);
    const row = db
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(id) as TaskRow | undefined;

    return row ? rowToTask(row) : null;
  }

  listTasks(filter?: { state?: string }): Task[] {
    const db = getDatabase(this.projectRoot);

    if (filter?.state) {
      const rows = db
        .prepare('SELECT * FROM tasks WHERE state = ? ORDER BY updated_at DESC')
        .all(filter.state) as TaskRow[];
      return rows.map(rowToTask);
    }

    const rows = db
      .prepare('SELECT * FROM tasks ORDER BY updated_at DESC')
      .all() as TaskRow[];
    return rows.map(rowToTask);
  }

  updateTask(
    id: string,
    updates: { name?: string; state?: string; metadata?: Record<string, unknown> },
  ): Task {
    const db = getDatabase(this.projectRoot);
    const existing = this.getTask(id);
    if (!existing) {
      throw new Error(`Task not found: ${id}`);
    }

    const now = Date.now();
    const name = updates.name ?? existing.name;
    const state = updates.state ?? existing.state;
    const metadataJson =
      updates.metadata !== undefined
        ? JSON.stringify(updates.metadata)
        : existing.metadata
          ? JSON.stringify(existing.metadata)
          : null;

    db.prepare(
      `UPDATE tasks SET name = ?, state = ?, metadata_json = ?, updated_at = ? WHERE id = ?`,
    ).run(name, state, metadataJson, now, id);

    return {
      id,
      name,
      state: state as Task['state'],
      createdAt: existing.createdAt,
      updatedAt: now,
      sessionId: existing.sessionId,
      metadata: updates.metadata !== undefined ? updates.metadata : existing.metadata,
    };
  }

  deleteTask(id: string): void {
    const db = getDatabase(this.projectRoot);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  markExplored(
    taskId: string,
    filePath: string,
    status: 'explored' | 'skipped' | 'flagged' = 'explored',
    notes?: string,
  ): void {
    const db = getDatabase(this.projectRoot);
    const now = Date.now();

    db.prepare(
      `INSERT OR REPLACE INTO task_files (task_id, file_path, status, notes, explored_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(taskId, filePath, status, notes ?? null, now);

    // Auto-activate task if currently in 'created' state
    db.prepare(
      `UPDATE tasks SET state = 'active', updated_at = ? WHERE id = ? AND state = 'created'`,
    ).run(now, taskId);
  }

  getExploredFiles(taskId: string): TaskFile[] {
    const db = getDatabase(this.projectRoot);
    const rows = db
      .prepare('SELECT * FROM task_files WHERE task_id = ? ORDER BY explored_at')
      .all(taskId) as TaskFileRow[];

    return rows.map(rowToTaskFile);
  }

  getUnexploredFrontier(taskId: string, allProjectFiles: string[]): string[] {
    const db = getDatabase(this.projectRoot);
    const rows = db
      .prepare('SELECT file_path FROM task_files WHERE task_id = ?')
      .all(taskId) as Array<{ file_path: string }>;

    const exploredSet = new Set(rows.map((r) => r.file_path));
    return allProjectFiles.filter((f) => !exploredSet.has(f));
  }
}
