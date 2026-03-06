import { dirname } from 'path';
import type { DependencyGraph } from '../graph/dependency-graph.js';
import type { CacheStore } from './store.js';

export interface RankingSignals {
  dependencyProximity: number;  // 0-1, how close in dependency graph
  recency: number;              // 0-1, how recently accessed/modified
  fileTypeRelevance: number;    // 0-1, source > config > test
  taskContextRelevance: number; // 0-1, related to task's explored set
  changeFrequency: number;      // 0-1, how often the file changes
}

export interface RankingWeights {
  dependencyProximity: number;
  recency: number;
  fileTypeRelevance: number;
  taskContextRelevance: number;
  changeFrequency: number;
}

export interface RankedFile {
  path: string;
  score: number;
  signals: RankingSignals;
}

export interface RankingOptions {
  projectRoot: string;
  weights?: Partial<RankingWeights>;
  exploredFiles?: string[];
  flaggedFiles?: string[];
  graph?: DependencyGraph;
  cacheStore?: CacheStore;
  limit?: number;
}

export const DEFAULT_WEIGHTS: RankingWeights = {
  dependencyProximity: 0.3,
  recency: 0.2,
  fileTypeRelevance: 0.15,
  taskContextRelevance: 0.25,
  changeFrequency: 0.1,
};

const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.tsx', '.jsx']);
const CONFIG_BASENAMES = new Set([
  'package.json',
  'tsconfig.json',
  'tsconfig.base.json',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.js',
  '.prettierrc',
  '.prettierrc.json',
  'jest.config.js',
  'jest.config.ts',
  'vitest.config.ts',
  'vitest.config.js',
  'webpack.config.js',
  'webpack.config.ts',
  'rollup.config.js',
  'rollup.config.ts',
  'vite.config.ts',
  'vite.config.js',
  'eslint.config.mjs',
  'eslint.config.js',
]);

const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\/__tests__\//,
  /\/tests?\//,
];

/** Score file type relevance: source=1.0, config=0.5, test=0.3, other=0.2 */
export function computeFileTypeRelevance(filePath: string): number {
  const basename = filePath.split('/').pop() ?? filePath;
  const ext = getExtension(basename);

  // Check test patterns first (test files may also be .ts/.js)
  if (TEST_PATTERNS.some((p) => p.test(filePath))) {
    return 0.3;
  }

  // Config files
  if (CONFIG_BASENAMES.has(basename)) {
    return 0.5;
  }

  // Source files
  if (SOURCE_EXTENSIONS.has(ext)) {
    return 1.0;
  }

  return 0.2;
}

/**
 * Exponential decay based on how recently the file was checked.
 * Files checked in the last hour get ~1.0, files checked days ago get ~0.0.
 * Uses a half-life of 4 hours.
 */
export function computeRecency(lastChecked: number, now?: number): number {
  const currentTime = now ?? Date.now();
  const ageMs = currentTime - lastChecked;

  if (ageMs <= 0) return 1.0;

  const HALF_LIFE_MS = 4 * 60 * 60 * 1000; // 4 hours
  return Math.pow(2, -ageMs / HALF_LIFE_MS);
}

/**
 * Score based on distance in the dependency graph from explored files.
 * 1.0 if directly connected, 0.5 if 2 hops away, decaying by 1/2^(distance-1).
 * Returns 0 if no graph or no explored files.
 */
export function computeDependencyProximity(
  filePath: string,
  exploredFiles: string[],
  graph: DependencyGraph,
): number {
  if (exploredFiles.length === 0) return 0;

  let bestScore = 0;

  for (const explored of exploredFiles) {
    // Check direct connection (1 hop)
    const deps = graph.getDependencies(explored);
    const dependents = graph.getDependents(explored);
    const directNeighbors = new Set([...deps, ...dependents]);

    if (directNeighbors.has(filePath)) {
      return 1.0; // Can't get better than this
    }

    // Check 2 hops
    for (const neighbor of directNeighbors) {
      const neighborDeps = graph.getDependencies(neighbor);
      const neighborDependents = graph.getDependents(neighbor);
      const secondHop = new Set([...neighborDeps, ...neighborDependents]);

      if (secondHop.has(filePath)) {
        bestScore = Math.max(bestScore, 0.5);
        break; // Found at 2 hops from this explored file
      }
    }

    if (bestScore >= 0.5) {
      // Check 3 hops via transitive
      continue;
    }

    // Check 3 hops
    const transitiveDeps = new Set(graph.getTransitiveDependencies(explored, 3));
    const transitiveDependents = new Set(graph.getTransitiveDependents(explored, 3));

    if (transitiveDeps.has(filePath) || transitiveDependents.has(filePath)) {
      bestScore = Math.max(bestScore, 0.25);
    }
  }

  return bestScore;
}

/**
 * Score based on directory proximity to flagged and explored files.
 * 1.0 if in same directory as flagged files, 0.7 if in same directory as explored files,
 * 0.4 if in sibling directory of flagged/explored, 0.1 otherwise.
 */
export function computeTaskContextRelevance(
  filePath: string,
  exploredFiles: string[],
  flaggedFiles: string[],
): number {
  const fileDir = dirname(filePath);

  // Check flagged files first (higher priority)
  for (const flagged of flaggedFiles) {
    if (dirname(flagged) === fileDir) {
      return 1.0;
    }
  }

  // Check explored files
  for (const explored of exploredFiles) {
    if (dirname(explored) === fileDir) {
      return 0.7;
    }
  }

  // Check sibling directories (parent directory matches)
  const parentDir = dirname(fileDir);
  for (const flagged of flaggedFiles) {
    if (dirname(dirname(flagged)) === parentDir) {
      return 0.4;
    }
  }
  for (const explored of exploredFiles) {
    if (dirname(dirname(explored)) === parentDir) {
      return 0.4;
    }
  }

  return 0.1;
}

/**
 * Composite ranking: scores each file on all signals, combines with weights,
 * returns sorted results descending by score.
 */
export function rankFiles(files: string[], options: RankingOptions): RankedFile[] {
  const weights: RankingWeights = {
    ...DEFAULT_WEIGHTS,
    ...options.weights,
  };

  const exploredFiles = options.exploredFiles ?? [];
  const flaggedFiles = options.flaggedFiles ?? [];
  const now = Date.now();

  const results: RankedFile[] = files.map((filePath) => {
    const fileTypeRelevance = computeFileTypeRelevance(filePath);

    let recency = 0.5; // default if no cache store
    if (options.cacheStore) {
      const entry = options.cacheStore.getEntry(filePath);
      if (entry) {
        recency = computeRecency(entry.lastChecked, now);
      }
    }

    let dependencyProximity = 0;
    if (options.graph) {
      dependencyProximity = computeDependencyProximity(filePath, exploredFiles, options.graph);
    }

    const taskContextRelevance = computeTaskContextRelevance(
      filePath,
      exploredFiles,
      flaggedFiles,
    );

    // changeFrequency is a placeholder — would need git log data to compute properly
    const changeFrequency = 0.5;

    const signals: RankingSignals = {
      dependencyProximity,
      recency,
      fileTypeRelevance,
      taskContextRelevance,
      changeFrequency,
    };

    const score =
      signals.dependencyProximity * weights.dependencyProximity +
      signals.recency * weights.recency +
      signals.fileTypeRelevance * weights.fileTypeRelevance +
      signals.taskContextRelevance * weights.taskContextRelevance +
      signals.changeFrequency * weights.changeFrequency;

    return { path: filePath, score, signals };
  });

  results.sort((a, b) => b.score - a.score);

  if (options.limit !== undefined && options.limit > 0) {
    return results.slice(0, options.limit);
  }

  return results;
}

function getExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1) return '';
  return filename.slice(dotIndex);
}
