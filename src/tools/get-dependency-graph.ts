import { DependencyGraph } from '../graph/dependency-graph.js';
import { loadFreshGraph } from '../graph/refresh.js';
import { validatePath } from '../utils/validate-path.js';

/** Default number of files included in the no-path whole-repo summary. */
const DEFAULT_SUMMARY_LIMIT = 50;

export interface DependencyGraphResult {
  /** Adjacency map: file -> files it imports (present when direction includes dependencies). */
  deps?: Record<string, string[]>;
  /** Adjacency map: file -> files that import it (present when direction includes dependents). */
  dependents?: Record<string, string[]>;
  stats: {
    totalFiles: number;
    totalEdges: number;
    /** Only present in the no-path whole-repo summary mode. */
    mostConnected?: Array<{ path: string; connections: number }>;
  };
  /** True when the no-path summary was capped by `limit`; stats carry whole-graph totals. */
  truncated?: boolean;
}

export async function getDependencyGraphTool(
  projectRoot: string,
  path?: string,
  direction?: 'dependencies' | 'dependents' | 'both',
  depth?: number,
  symbol?: string,
  limit?: number,
): Promise<DependencyGraphResult> {
  if (path) {
    path = validatePath(projectRoot, path);
  }
  // Load the persisted dependency graph, refreshing only stale files.
  const graph = await loadFreshGraph(projectRoot);

  if (symbol) {
    return getSymbolEdges(graph, symbol, path);
  }

  if (path) {
    return getNeighborhood(graph, path, direction ?? 'both', depth);
  }

  return getFullSummary(graph, limit ?? DEFAULT_SUMMARY_LIMIT);
}

function getNeighborhood(
  graph: DependencyGraph,
  path: string,
  direction: 'dependencies' | 'dependents' | 'both',
  depth?: number,
): DependencyGraphResult {
  const files = new Set<string>([path]);
  let totalEdges = 0;
  const result: DependencyGraphResult = { stats: { totalFiles: 0, totalEdges: 0 } };

  if (direction === 'dependencies' || direction === 'both') {
    const targets = depth !== undefined
      ? graph.getTransitiveDependencies(path, depth)
      : graph.getDependencies(path);
    for (const target of targets) files.add(target);
    totalEdges += targets.length;
    result.deps = { [path]: [...targets].sort() };
  }

  if (direction === 'dependents' || direction === 'both') {
    const sources = depth !== undefined
      ? graph.getTransitiveDependents(path, depth)
      : graph.getDependents(path);
    for (const source of sources) files.add(source);
    totalEdges += sources.length;
    result.dependents = { [path]: [...sources].sort() };
  }

  result.stats = { totalFiles: files.size, totalEdges };
  return result;
}

function getSymbolEdges(
  graph: DependencyGraph,
  symbol: string,
  path?: string,
): DependencyGraphResult {
  const matchingEdges = graph.getEdgesBySymbol(symbol, path);
  const files = new Set<string>();
  const deps: Record<string, string[]> = {};

  for (const edge of matchingEdges) {
    files.add(edge.source);
    files.add(edge.target);
    (deps[edge.source] ??= []).push(edge.target);
  }
  for (const source of Object.keys(deps)) {
    deps[source].sort();
  }

  return {
    deps,
    stats: {
      totalFiles: files.size,
      totalEdges: matchingEdges.length,
    },
  };
}

function getFullSummary(graph: DependencyGraph, limit: number): DependencyGraphResult {
  // Rank every node by connectivity; the summary covers the top `limit`.
  const ranked = graph.getMostConnected(Number.MAX_SAFE_INTEGER);
  const totalFiles = ranked.length;
  let totalEdges = 0;
  for (const { path } of ranked) {
    totalEdges += graph.getDependencies(path).length;
  }

  const included = ranked.slice(0, Math.max(0, limit));
  const deps: Record<string, string[]> = {};
  for (const { path } of included) {
    deps[path] = graph.getDependencies(path).sort();
  }

  const truncated = totalFiles > included.length;
  return {
    deps,
    stats: {
      totalFiles,
      totalEdges,
      mostConnected: graph.getMostConnected(10),
    },
    ...(truncated ? { truncated: true } : {}),
  };
}
