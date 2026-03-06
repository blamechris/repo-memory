import { describe, expect, it } from 'vitest';
import {
  computeFileTypeRelevance,
  computeRecency,
  computeDependencyProximity,
  computeTaskContextRelevance,
  rankFiles,
  DEFAULT_WEIGHTS,
} from '../../src/cache/ranking.js';
import type { DependencyGraph } from '../../src/graph/dependency-graph.js';

/** Create a minimal mock DependencyGraph for testing. */
function createMockGraph(edges: Array<[string, string]>): DependencyGraph {
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();

  for (const [source, target] of edges) {
    if (!outgoing.has(source)) outgoing.set(source, new Set());
    outgoing.get(source)!.add(target);
    if (!incoming.has(target)) incoming.set(target, new Set());
    incoming.get(target)!.add(source);
  }

  return {
    getDependencies(path: string): string[] {
      return [...(outgoing.get(path) ?? [])];
    },
    getDependents(path: string): string[] {
      return [...(incoming.get(path) ?? [])];
    },
    getTransitiveDependencies(path: string, maxDepth?: number): string[] {
      const visited = new Set<string>();
      const queue: Array<{ node: string; depth: number }> = [];
      const neighbors = outgoing.get(path);
      if (!neighbors) return [];
      for (const n of neighbors) queue.push({ node: n, depth: 1 });
      while (queue.length > 0) {
        const { node, depth } = queue.shift()!;
        if (visited.has(node) || node === path) continue;
        visited.add(node);
        if (maxDepth !== undefined && depth >= maxDepth) continue;
        const next = outgoing.get(node);
        if (next) {
          for (const n of next) {
            if (!visited.has(n) && n !== path) queue.push({ node: n, depth: depth + 1 });
          }
        }
      }
      return [...visited];
    },
    getTransitiveDependents(path: string, maxDepth?: number): string[] {
      const visited = new Set<string>();
      const queue: Array<{ node: string; depth: number }> = [];
      const neighbors = incoming.get(path);
      if (!neighbors) return [];
      for (const n of neighbors) queue.push({ node: n, depth: 1 });
      while (queue.length > 0) {
        const { node, depth } = queue.shift()!;
        if (visited.has(node) || node === path) continue;
        visited.add(node);
        if (maxDepth !== undefined && depth >= maxDepth) continue;
        const next = incoming.get(node);
        if (next) {
          for (const n of next) {
            if (!visited.has(n) && n !== path) queue.push({ node: n, depth: depth + 1 });
          }
        }
      }
      return [...visited];
    },
  } as unknown as DependencyGraph;
}

describe('computeFileTypeRelevance', () => {
  it('should score source files as 1.0', () => {
    expect(computeFileTypeRelevance('src/index.ts')).toBe(1.0);
    expect(computeFileTypeRelevance('src/components/App.tsx')).toBe(1.0);
    expect(computeFileTypeRelevance('lib/utils.js')).toBe(1.0);
    expect(computeFileTypeRelevance('src/main.jsx')).toBe(1.0);
  });

  it('should score config files as 0.5', () => {
    expect(computeFileTypeRelevance('package.json')).toBe(0.5);
    expect(computeFileTypeRelevance('tsconfig.json')).toBe(0.5);
    expect(computeFileTypeRelevance('.prettierrc')).toBe(0.5);
    expect(computeFileTypeRelevance('vitest.config.ts')).toBe(0.5);
  });

  it('should score test files as 0.3', () => {
    expect(computeFileTypeRelevance('tests/unit/store.test.ts')).toBe(0.3);
    expect(computeFileTypeRelevance('src/__tests__/foo.ts')).toBe(0.3);
    expect(computeFileTypeRelevance('test/integration.spec.js')).toBe(0.3);
  });

  it('should score other files as 0.2', () => {
    expect(computeFileTypeRelevance('README.md')).toBe(0.2);
    expect(computeFileTypeRelevance('Dockerfile')).toBe(0.2);
    expect(computeFileTypeRelevance('.gitignore')).toBe(0.2);
  });
});

describe('computeRecency', () => {
  it('should return ~1.0 for files checked just now', () => {
    const now = Date.now();
    const score = computeRecency(now, now);
    expect(score).toBeCloseTo(1.0, 2);
  });

  it('should return ~0.5 after one half-life (4 hours)', () => {
    const now = Date.now();
    const fourHoursAgo = now - 4 * 60 * 60 * 1000;
    const score = computeRecency(fourHoursAgo, now);
    expect(score).toBeCloseTo(0.5, 2);
  });

  it('should return a low score for files checked days ago', () => {
    const now = Date.now();
    const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
    const score = computeRecency(twoDaysAgo, now);
    expect(score).toBeLessThan(0.01);
  });

  it('should score recent files higher than old files', () => {
    const now = Date.now();
    const recent = computeRecency(now - 30 * 60 * 1000, now); // 30 min ago
    const old = computeRecency(now - 24 * 60 * 60 * 1000, now); // 1 day ago
    expect(recent).toBeGreaterThan(old);
  });
});

describe('computeDependencyProximity', () => {
  // Graph: A -> B -> C -> D
  const graph = createMockGraph([
    ['A', 'B'],
    ['B', 'C'],
    ['C', 'D'],
  ]);

  it('should return 1.0 for direct dependency', () => {
    const score = computeDependencyProximity('B', ['A'], graph);
    expect(score).toBe(1.0);
  });

  it('should return 1.0 for direct dependent', () => {
    const score = computeDependencyProximity('A', ['B'], graph);
    expect(score).toBe(1.0);
  });

  it('should return 0.5 for 2-hop connection', () => {
    const score = computeDependencyProximity('C', ['A'], graph);
    expect(score).toBe(0.5);
  });

  it('should return 0.25 for 3-hop connection', () => {
    const score = computeDependencyProximity('D', ['A'], graph);
    expect(score).toBe(0.25);
  });

  it('should return 0 for unconnected files', () => {
    const score = computeDependencyProximity('X', ['A'], graph);
    expect(score).toBe(0);
  });

  it('should return 0 with no explored files', () => {
    const score = computeDependencyProximity('A', [], graph);
    expect(score).toBe(0);
  });
});

describe('computeTaskContextRelevance', () => {
  it('should return 1.0 for files in same directory as flagged files', () => {
    const score = computeTaskContextRelevance(
      'src/cache/ranking.ts',
      [],
      ['src/cache/store.ts'],
    );
    expect(score).toBe(1.0);
  });

  it('should return 0.7 for files in same directory as explored files', () => {
    const score = computeTaskContextRelevance(
      'src/cache/ranking.ts',
      ['src/cache/store.ts'],
      [],
    );
    expect(score).toBe(0.7);
  });

  it('should prefer flagged over explored', () => {
    const score = computeTaskContextRelevance(
      'src/cache/ranking.ts',
      ['src/cache/store.ts'],
      ['src/cache/hash.ts'],
    );
    expect(score).toBe(1.0);
  });

  it('should return 0.4 for sibling directories', () => {
    const score = computeTaskContextRelevance(
      'src/graph/dependency-graph.ts',
      [],
      ['src/cache/store.ts'],
    );
    expect(score).toBe(0.4);
  });

  it('should return 0.1 for unrelated files', () => {
    const score = computeTaskContextRelevance(
      'lib/deep/nested/file.ts',
      ['src/cache/store.ts'],
      [],
    );
    expect(score).toBe(0.1);
  });
});

describe('rankFiles', () => {
  const files = [
    'src/cache/store.ts',
    'src/graph/dependency-graph.ts',
    'tests/unit/store.test.ts',
    'README.md',
    'package.json',
  ];

  it('should rank files with default weights', () => {
    const ranked = rankFiles(files, {
      projectRoot: '/project',
      exploredFiles: ['src/cache/hash.ts'],
      flaggedFiles: ['src/cache/invalidation.ts'],
    });

    expect(ranked).toHaveLength(5);
    // All scores should be between 0 and 1
    for (const r of ranked) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
    // Should be sorted descending
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
  });

  it('should rank source files near flagged files highest by default', () => {
    const ranked = rankFiles(files, {
      projectRoot: '/project',
      flaggedFiles: ['src/cache/invalidation.ts'],
    });

    // src/cache/store.ts should be first — it's a source file in same dir as flagged
    expect(ranked[0].path).toBe('src/cache/store.ts');
  });

  it('should apply custom weights', () => {
    // With fileTypeRelevance=1.0 and everything else=0, source files win
    const ranked = rankFiles(files, {
      projectRoot: '/project',
      weights: {
        dependencyProximity: 0,
        recency: 0,
        fileTypeRelevance: 1.0,
        taskContextRelevance: 0,
        changeFrequency: 0,
      },
    });

    // Source files should come first
    expect(ranked[0].signals.fileTypeRelevance).toBe(1.0);
    expect(ranked[1].signals.fileTypeRelevance).toBe(1.0);
  });

  it('should change ordering with different weights', () => {
    // Weight only taskContextRelevance
    const contextOnly = rankFiles(files, {
      projectRoot: '/project',
      weights: {
        dependencyProximity: 0,
        recency: 0,
        fileTypeRelevance: 0,
        taskContextRelevance: 1.0,
        changeFrequency: 0,
      },
      flaggedFiles: ['tests/unit/hash.test.ts'],
    });

    // Test file in same dir as flagged should be first
    expect(contextOnly[0].path).toBe('tests/unit/store.test.ts');
  });

  it('should respect limit parameter', () => {
    const ranked = rankFiles(files, {
      projectRoot: '/project',
      limit: 3,
    });

    expect(ranked).toHaveLength(3);
  });

  it('should return all files when limit is not set', () => {
    const ranked = rankFiles(files, {
      projectRoot: '/project',
    });

    expect(ranked).toHaveLength(files.length);
  });

  it('should include signals in each ranked file', () => {
    const ranked = rankFiles(files, {
      projectRoot: '/project',
    });

    for (const r of ranked) {
      expect(r.signals).toBeDefined();
      expect(typeof r.signals.dependencyProximity).toBe('number');
      expect(typeof r.signals.recency).toBe('number');
      expect(typeof r.signals.fileTypeRelevance).toBe('number');
      expect(typeof r.signals.taskContextRelevance).toBe('number');
      expect(typeof r.signals.changeFrequency).toBe('number');
    }
  });
});

describe('DEFAULT_WEIGHTS', () => {
  it('should sum to 1.0', () => {
    const sum =
      DEFAULT_WEIGHTS.dependencyProximity +
      DEFAULT_WEIGHTS.recency +
      DEFAULT_WEIGHTS.fileTypeRelevance +
      DEFAULT_WEIGHTS.taskContextRelevance +
      DEFAULT_WEIGHTS.changeFrequency;
    expect(sum).toBeCloseTo(1.0, 5);
  });
});
