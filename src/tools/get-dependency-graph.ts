import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DependencyGraph } from '../graph/dependency-graph.js';
import { scanProject } from '../indexer/scanner.js';
import { validatePath } from '../utils/validate-path.js';

export interface DependencyGraphResult {
  nodes: string[];
  edges: Array<{ from: string; to: string }>;
  stats: {
    totalFiles: number;
    totalEdges: number;
    mostConnected: Array<{ path: string; connections: number }>;
  };
}

export async function getDependencyGraphTool(
  projectRoot: string,
  path?: string,
  direction?: 'dependencies' | 'dependents' | 'both',
  depth?: number,
  symbol?: string,
): Promise<DependencyGraphResult> {
  if (path) {
    path = validatePath(projectRoot, path);
  }
  const graph = new DependencyGraph(projectRoot);

  // Index all files to build the graph
  const files = await scanProject(projectRoot);
  for (const file of files) {
    if (!file.endsWith('.ts') && !file.endsWith('.js') && !file.endsWith('.tsx') &&
        !file.endsWith('.jsx') && !file.endsWith('.mjs') && !file.endsWith('.cjs')) {
      continue;
    }
    try {
      const contents = await readFile(join(projectRoot, file), 'utf-8');
      graph.updateFile(file, contents);
    } catch {
      // Skip unreadable files
    }
  }

  if (symbol) {
    return getSymbolEdges(graph, symbol, path);
  }

  if (path) {
    return getNeighborhood(graph, path, direction ?? 'both', depth);
  }

  return getFullSummary(graph);
}

function getNeighborhood(
  graph: DependencyGraph,
  path: string,
  direction: 'dependencies' | 'dependents' | 'both',
  depth?: number,
): DependencyGraphResult {
  const nodes = new Set<string>();
  const edges: Array<{ from: string; to: string }> = [];
  nodes.add(path);

  if (direction === 'dependencies' || direction === 'both') {
    const deps = depth !== undefined
      ? graph.getTransitiveDependencies(path, depth)
      : graph.getDependencies(path);
    for (const dep of deps) {
      nodes.add(dep);
      edges.push({ from: path, to: dep });
    }
  }

  if (direction === 'dependents' || direction === 'both') {
    const deps = depth !== undefined
      ? graph.getTransitiveDependents(path, depth)
      : graph.getDependents(path);
    for (const dep of deps) {
      nodes.add(dep);
      edges.push({ from: dep, to: path });
    }
  }

  return {
    nodes: [...nodes].sort(),
    edges,
    stats: {
      totalFiles: nodes.size,
      totalEdges: edges.length,
      mostConnected: graph.getMostConnected(5),
    },
  };
}

function getSymbolEdges(
  graph: DependencyGraph,
  symbol: string,
  path?: string,
): DependencyGraphResult {
  const matchingEdges = graph.getEdgesBySymbol(symbol, path);
  const nodes = new Set<string>();
  const edges: Array<{ from: string; to: string }> = [];

  for (const edge of matchingEdges) {
    nodes.add(edge.source);
    nodes.add(edge.target);
    edges.push({ from: edge.source, to: edge.target });
  }

  return {
    nodes: [...nodes].sort(),
    edges,
    stats: {
      totalFiles: nodes.size,
      totalEdges: edges.length,
      mostConnected: graph.getMostConnected(5),
    },
  };
}

function getFullSummary(graph: DependencyGraph): DependencyGraphResult {
  const mostConnected = graph.getMostConnected(10);
  const allNodes = new Set<string>();
  const edges: Array<{ from: string; to: string }> = [];

  for (const entry of mostConnected) {
    allNodes.add(entry.path);
    for (const dep of graph.getDependencies(entry.path)) {
      allNodes.add(dep);
      edges.push({ from: entry.path, to: dep });
    }
    for (const dep of graph.getDependents(entry.path)) {
      allNodes.add(dep);
      edges.push({ from: dep, to: entry.path });
    }
  }

  return {
    nodes: [...allNodes].sort(),
    edges,
    stats: {
      totalFiles: allNodes.size,
      totalEdges: edges.length,
      mostConnected,
    },
  };
}
