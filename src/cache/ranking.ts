import { dirname } from 'path';
import type { DependencyGraph } from '../graph/dependency-graph.js';
import type { CacheStore } from './store.js';

export interface RankingSignals {
  relationship: number;         // 0-1, how the candidate relates to the query file
  dependencyProximity: number;  // 0-1, how close in dependency graph
  recency: number;              // 0-1, how recently accessed/modified
  fileTypeRelevance: number;    // 0-1, source > config > test
  taskContextRelevance: number; // 0-1, related to task's explored set
  centrality: number;           // 0-1, degree centrality (hub files score higher)
}

export interface RankingWeights {
  relationship: number;
  dependencyProximity: number;
  recency: number;
  fileTypeRelevance: number;
  taskContextRelevance: number;
  centrality: number;
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
  /**
   * The file the caller asked about. Used as a proximity anchor so
   * dependencyProximity works even without task-explored files.
   */
  queryFile?: string;
  /**
   * Pre-classified relationship of each candidate to the query file
   * (e.g. 'imports', 'imported-by', 'transitive-dependency', 'same-directory').
   * Candidates absent from the map get a relationship score of 0.
   */
  relationships?: ReadonlyMap<string, string>;
  limit?: number;
}

/**
 * Default signal weights (sum to 1.0 so composite scores stay in [0, 1]).
 *
 * Rationale:
 * - relationship (0.30): the strongest evidence available — *why* the
 *   candidate is in the result set. Direct imports/dependents beat
 *   transitive links beat same-directory bystanders.
 * - dependencyProximity (0.25): hop distance in the import graph from the
 *   query file (and from task-explored files when a task is active).
 *   Reinforces relationship and differentiates within the transitive bucket.
 * - recency (0.15): files indexed/seen recently in this session are more
 *   likely part of the current working set (4-hour half-life decay).
 * - taskContextRelevance (0.15): directory adjacency to the active task's
 *   explored/flagged files; constant when no task is active.
 * - fileTypeRelevance (0.10): mild prior for source over config over tests.
 * - centrality (0.05): log-scaled degree centrality — a deliberate
 *   tiebreaker so hub files edge out leaf files when structural signals
 *   tie, without importance ever outranking a direct relationship.
 */
export const DEFAULT_WEIGHTS: RankingWeights = {
  relationship: 0.3,
  dependencyProximity: 0.25,
  recency: 0.15,
  fileTypeRelevance: 0.1,
  taskContextRelevance: 0.15,
  centrality: 0.05,
};

/**
 * Relationship-type ordering: direct edges (imports/imported-by) are the
 * strongest relevance evidence, transitive links weaker, directory
 * neighbors weakest. Unknown/unclassified relationships score 0.
 */
const RELATIONSHIP_SCORES: Record<string, number> = {
  'imports': 1.0,
  'imported-by': 1.0,
  'transitive-dependency': 0.5,
  'same-directory': 0.25,
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
 * Uses a half-life of 4 hours. Age is quantized to whole minutes so scores
 * are deterministic across back-to-back calls (sub-minute age differences
 * are noise at a 4-hour half-life).
 */
export function computeRecency(lastChecked: number, now?: number): number {
  const currentTime = now ?? Date.now();
  const ageMs = currentTime - lastChecked;

  if (ageMs <= 0) return 1.0;

  const MINUTE_MS = 60 * 1000;
  const HALF_LIFE_MS = 4 * 60 * 60 * 1000; // 4 hours
  const quantizedAgeMs = Math.floor(ageMs / MINUTE_MS) * MINUTE_MS;
  return Math.pow(2, -quantizedAgeMs / HALF_LIFE_MS);
}

/** Score the candidate's classified relationship to the query file. */
export function computeRelationshipScore(relationship: string | undefined): number {
  if (!relationship) return 0;
  return RELATIONSHIP_SCORES[relationship] ?? 0;
}

/**
 * Log-scaled degree centrality relative to the most-connected candidate.
 * Returns 0 when the file has no connections or no maximum is known, 1.0
 * for the best-connected candidate. Log scaling compresses the range so a
 * 50-edge hub does not score 50x a 1-edge leaf — it is a tiebreaker prior,
 * not a dominator.
 */
export function computeCentrality(degree: number, maxDegree: number): number {
  if (degree <= 0 || maxDegree <= 0) return 0;
  return Math.log1p(degree) / Math.log1p(maxDegree);
}

/**
 * Score based on distance in the dependency graph from anchor files (the
 * query file and/or task-explored files).
 * 1.0 if directly connected, 0.5 if 2 hops away, decaying by 1/2^(distance-1).
 * Returns 0 if no graph or no anchor files.
 */
export function computeDependencyProximity(
  filePath: string,
  anchorFiles: string[],
  graph: DependencyGraph,
): number {
  if (anchorFiles.length === 0) return 0;

  let bestScore = 0;

  for (const explored of anchorFiles) {
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

  // Proximity anchors: the query file (so the signal works without a task)
  // plus any task-explored files.
  const anchorFiles = options.queryFile
    ? [options.queryFile, ...exploredFiles]
    : exploredFiles;

  // Degree centrality, normalized against the best-connected candidate so
  // the signal is relative to the result set being ranked.
  const degrees = new Map<string, number>();
  let maxDegree = 0;
  if (options.graph) {
    for (const filePath of files) {
      const degree =
        options.graph.getDependencies(filePath).length +
        options.graph.getDependents(filePath).length;
      degrees.set(filePath, degree);
      if (degree > maxDegree) maxDegree = degree;
    }
  }

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
      dependencyProximity = computeDependencyProximity(filePath, anchorFiles, options.graph);
    }

    const taskContextRelevance = computeTaskContextRelevance(
      filePath,
      exploredFiles,
      flaggedFiles,
    );

    const relationship = computeRelationshipScore(options.relationships?.get(filePath));
    const centrality = computeCentrality(degrees.get(filePath) ?? 0, maxDegree);

    const signals: RankingSignals = {
      relationship,
      dependencyProximity,
      recency,
      fileTypeRelevance,
      taskContextRelevance,
      centrality,
    };

    const score =
      signals.relationship * weights.relationship +
      signals.dependencyProximity * weights.dependencyProximity +
      signals.recency * weights.recency +
      signals.fileTypeRelevance * weights.fileTypeRelevance +
      signals.taskContextRelevance * weights.taskContextRelevance +
      signals.centrality * weights.centrality;

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
