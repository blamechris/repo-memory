import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { DependencyGraph } from '../graph/dependency-graph.js';
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

  // Build the dependency graph
  const graph = new DependencyGraph(projectRoot);
  const files = await scanProject(projectRoot);

  for (const file of files) {
    if (
      !file.endsWith('.ts') &&
      !file.endsWith('.js') &&
      !file.endsWith('.tsx') &&
      !file.endsWith('.jsx') &&
      !file.endsWith('.mjs') &&
      !file.endsWith('.cjs')
    ) {
      continue;
    }
    try {
      const contents = await readFile(join(projectRoot, file), 'utf-8');
      graph.updateFile(file, contents);
    } catch {
      // Skip unreadable files
    }
  }

  // The graph may store paths with .js extension (from import specifiers) while
  // actual files have .ts extension. Query both variants to get complete results.
  const variants = getPathVariants(validated);

  // Get direct dependencies and dependents across all path variants
  const dependencies = new Set<string>();
  const dependents = new Set<string>();
  for (const v of variants) {
    for (const d of graph.getDependencies(v)) dependencies.add(d);
    for (const d of graph.getDependents(v)) dependents.add(d);
  }

  // Get transitive dependencies (depth 2) for "transitive-dependency" classification
  const transitiveDeps = new Set<string>();
  const transitiveDependents = new Set<string>();
  for (const v of variants) {
    for (const d of graph.getTransitiveDependencies(v, 2)) transitiveDeps.add(d);
    for (const d of graph.getTransitiveDependents(v, 2)) transitiveDependents.add(d);
  }

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

  // Remove the file itself (all variants)
  for (const v of variants) candidates.delete(v);

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

/** Get path variants to handle .ts/.js extension mismatch in the dependency graph. */
function getPathVariants(filePath: string): string[] {
  const variants = [filePath];
  if (filePath.endsWith('.ts')) {
    variants.push(filePath.replace(/\.ts$/, '.js'));
  } else if (filePath.endsWith('.tsx')) {
    variants.push(filePath.replace(/\.tsx$/, '.js'));
    variants.push(filePath.replace(/\.tsx$/, '.jsx'));
  } else if (filePath.endsWith('.js')) {
    variants.push(filePath.replace(/\.js$/, '.ts'));
    variants.push(filePath.replace(/\.js$/, '.tsx'));
  } else if (filePath.endsWith('.jsx')) {
    variants.push(filePath.replace(/\.jsx$/, '.tsx'));
  }
  return variants;
}
