import { dirname } from 'node:path';
import { loadFreshGraph } from '../graph/refresh.js';
import { scanProject } from '../indexer/scanner.js';
import { validatePath } from '../utils/validate-path.js';
import { rankFiles } from '../cache/ranking.js';
import { getTaskContext, type TaskContextResult } from '../tools/task-context.js';

export interface RelatedFilesResult {
  path: string;
  relatedFiles: Array<{
    path: string;
    score: number;
    relationship: string; // "imports", "imported-by", "same-directory", "similar-purpose"
  }>;
}

export async function getRelatedFiles(
  projectRoot: string,
  relativePath: string,
  options?: { limit?: number; taskId?: string },
): Promise<RelatedFilesResult> {
  const validated = validatePath(projectRoot, relativePath);
  const limit = options?.limit ?? 10;

  // Load the persisted dependency graph, refreshing only stale files.
  const files = await scanProject(projectRoot);
  const graph = await loadFreshGraph(projectRoot, files);

  // Import targets are resolved to real file paths at extraction time, so the
  // graph can be queried with the validated path directly.
  const dependencies = new Set<string>(graph.getDependencies(validated));
  const dependents = new Set<string>(graph.getDependents(validated));

  // Get transitive dependencies (depth 2) for "transitive-dependency" classification
  const transitiveDeps = new Set<string>(graph.getTransitiveDependencies(validated, 2));
  const transitiveDependents = new Set<string>(graph.getTransitiveDependents(validated, 2));

  // Determine same-directory files
  const fileDir = dirname(validated);
  const sameDirFiles = new Set(
    files.filter((f) => f !== validated && dirname(f) === fileDir),
  );

  // Collect all candidate related files (excluding the file itself)
  const candidates = new Set<string>();
  for (const d of dependencies) candidates.add(d);
  for (const d of dependents) candidates.add(d);
  for (const d of transitiveDeps) candidates.add(d);
  for (const d of transitiveDependents) candidates.add(d);
  for (const d of sameDirFiles) candidates.add(d);

  // Remove the file itself
  candidates.delete(validated);

  if (candidates.size === 0) {
    return { path: validated, relatedFiles: [] };
  }

  // Classify relationships
  const relationshipMap = new Map<string, string>();
  for (const c of candidates) {
    if (dependencies.has(c)) {
      relationshipMap.set(c, 'imports');
    } else if (dependents.has(c)) {
      relationshipMap.set(c, 'imported-by');
    } else if (transitiveDeps.has(c) || transitiveDependents.has(c)) {
      relationshipMap.set(c, 'transitive-dependency');
    } else if (sameDirFiles.has(c)) {
      relationshipMap.set(c, 'same-directory');
    }
  }

  // Get task context for ranking if taskId provided
  let exploredFiles: string[] = [];
  let flaggedFiles: string[] = [];

  if (options?.taskId) {
    try {
      const ctx = getTaskContext(projectRoot, options.taskId) as TaskContextResult;
      exploredFiles = ctx.exploredFiles.map((f) => f.filePath);
      flaggedFiles = ctx.exploredFiles
        .filter((f) => f.status === 'flagged')
        .map((f) => f.filePath);
    } catch {
      // Task not found — proceed without context
    }
  }

  // Rank candidates
  const candidateArray = [...candidates];
  const ranked = rankFiles(candidateArray, {
    projectRoot,
    exploredFiles,
    flaggedFiles,
    graph,
    limit,
  });

  const relatedFiles = ranked.map((r) => ({
    path: r.path,
    score: r.score,
    relationship: relationshipMap.get(r.path) ?? 'same-directory',
  }));

  return { path: validated, relatedFiles };
}
