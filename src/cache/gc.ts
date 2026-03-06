import { getDatabase } from '../persistence/db.js';
import { CacheStore } from './store.js';
import { scanProject } from '../indexer/scanner.js';

export interface GCOptions {
  cacheMaxAgeDays?: number;
  taskMaxAgeDays?: number;
  telemetryMaxAgeDays?: number;
  dryRun?: boolean;
}

export interface GCResult {
  removedCacheEntries: string[];
  removedTasks: string[];
  removedTelemetryCount: number;
  removedOrphanImports: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function runGC(
  projectRoot: string,
  options?: GCOptions,
): Promise<GCResult> {
  const cacheMaxAgeDays = options?.cacheMaxAgeDays ?? 30;
  const taskMaxAgeDays = options?.taskMaxAgeDays ?? 30;
  const telemetryMaxAgeDays = options?.telemetryMaxAgeDays ?? 90;
  const dryRun = options?.dryRun ?? false;

  const db = getDatabase(projectRoot);
  const store = new CacheStore(projectRoot);

  const result: GCResult = {
    removedCacheEntries: [],
    removedTasks: [],
    removedTelemetryCount: 0,
    removedOrphanImports: 0,
  };

  // 1. Remove cache entries for deleted files
  const currentFiles = new Set(await scanProject(projectRoot));
  const allEntries = store.getAllEntries();
  const deletedFilePaths = allEntries
    .filter((entry) => !currentFiles.has(entry.path))
    .map((entry) => entry.path);

  result.removedCacheEntries.push(...deletedFilePaths);

  // 2. Remove old cache entries (by lastChecked age)
  const cacheCutoff = Date.now() - cacheMaxAgeDays * MS_PER_DAY;
  const staleEntries = store.getStaleEntries(cacheMaxAgeDays * MS_PER_DAY);
  const stalePaths = staleEntries
    .filter((entry) => !result.removedCacheEntries.includes(entry.path))
    .map((entry) => entry.path);

  result.removedCacheEntries.push(...stalePaths);

  if (!dryRun) {
    for (const path of result.removedCacheEntries) {
      store.deleteEntry(path);
    }
  }

  // 3. Remove old completed/archived tasks
  const taskCutoff = Date.now() - taskMaxAgeDays * MS_PER_DAY;
  const oldTasks = db
    .prepare(
      `SELECT id FROM tasks
       WHERE state IN ('completed', 'archived')
         AND updated_at < ?`,
    )
    .all(taskCutoff) as Array<{ id: string }>;

  result.removedTasks = oldTasks.map((t) => t.id);

  if (!dryRun && result.removedTasks.length > 0) {
    const deleteTaskFiles = db.prepare('DELETE FROM task_files WHERE task_id = ?');
    const deleteTask = db.prepare('DELETE FROM tasks WHERE id = ?');
    const deleteTasks = db.transaction(() => {
      for (const id of result.removedTasks) {
        deleteTaskFiles.run(id);
        deleteTask.run(id);
      }
    });
    deleteTasks();
  }

  // 4. Remove old telemetry events
  const telemetryCutoff = Date.now() - telemetryMaxAgeDays * MS_PER_DAY;
  const telemetryCount = db
    .prepare('SELECT COUNT(*) as count FROM telemetry WHERE timestamp < ?')
    .get(telemetryCutoff) as { count: number };

  result.removedTelemetryCount = telemetryCount.count;

  if (!dryRun && result.removedTelemetryCount > 0) {
    db.prepare('DELETE FROM telemetry WHERE timestamp < ?').run(telemetryCutoff);
  }

  // 5. Remove orphan import records (source not in files table)
  const orphanCount = db
    .prepare(
      `SELECT COUNT(*) as count FROM imports
       WHERE source NOT IN (SELECT path FROM files)`,
    )
    .get() as { count: number };

  result.removedOrphanImports = orphanCount.count;

  if (!dryRun && result.removedOrphanImports > 0) {
    db.prepare(
      'DELETE FROM imports WHERE source NOT IN (SELECT path FROM files)',
    ).run();
  }

  return result;
}
