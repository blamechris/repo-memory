import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DependencyGraph } from '../../src/graph/dependency-graph.js';
import { getDatabase, closeDatabase } from '../../src/persistence/db.js';

describe('DependencyGraph', () => {
  let tempDir: string;
  let graph: DependencyGraph;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dep-graph-test-'));
    mkdirSync(join(tempDir, '.repo-memory'), { recursive: true });
    // Initialize the database so migrations run
    getDatabase(tempDir);
    graph = new DependencyGraph(tempDir);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('builds graph from import data', () => {
    const contents = `import { Foo } from './bar';`;
    graph.updateFile('src/index.ts', contents);

    expect(graph.getDependencies('src/index.ts')).toEqual(['src/bar']);
    expect(graph.getDependents('src/bar')).toEqual(['src/index.ts']);
  });

  it('getDependencies returns correct files', () => {
    graph.updateFile('src/app.ts', [
      `import { A } from './a';`,
      `import { B } from './b';`,
      `import { C } from './c';`,
    ].join('\n'));

    const deps = graph.getDependencies('src/app.ts');
    expect(deps).toHaveLength(3);
    expect(deps).toContain('src/a');
    expect(deps).toContain('src/b');
    expect(deps).toContain('src/c');
  });

  it('getDependents returns correct files', () => {
    graph.updateFile('src/a.ts', `import { Util } from './util';`);
    graph.updateFile('src/b.ts', `import { Util } from './util';`);
    graph.updateFile('src/c.ts', `import { Util } from './util';`);

    const dependents = graph.getDependents('src/util');
    expect(dependents).toHaveLength(3);
    expect(dependents).toContain('src/a.ts');
    expect(dependents).toContain('src/b.ts');
    expect(dependents).toContain('src/c.ts');
  });

  it('getTransitiveDependencies works with depth limiting', () => {
    // a.ts -> b (target) -- b.ts -> c (target) -- c.ts -> d (target)
    // Note: extractImports resolves targets without extension,
    // so the chain is: src/a.ts -> src/b -> (no outgoing from src/b)
    // To create a proper chain we use filePath keys matching resolved targets
    graph.updateFile('src/a.ts', `import { B } from './b';`);
    graph.updateFile('src/b', `import { C } from './c';`);
    graph.updateFile('src/c', `import { D } from './d';`);

    // No depth limit: should get all
    const all = graph.getTransitiveDependencies('src/a.ts');
    expect(all).toContain('src/b');
    expect(all).toContain('src/c');
    expect(all).toContain('src/d');

    // Depth limit of 1: only direct dependency
    const depth1 = graph.getTransitiveDependencies('src/a.ts', 1);
    expect(depth1).toEqual(['src/b']);

    // Depth limit of 2: b and c
    const depth2 = graph.getTransitiveDependencies('src/a.ts', 2);
    expect(depth2).toContain('src/b');
    expect(depth2).toContain('src/c');
    expect(depth2).not.toContain('src/d');
  });

  it('getTransitiveDependents works', () => {
    // a -> b, c -> b, d -> c
    // Use filePath keys matching resolved targets for proper chaining
    graph.updateFile('src/a', `import { B } from './b';`);
    graph.updateFile('src/c', `import { B } from './b';`);
    graph.updateFile('src/d', `import { C } from './c';`);

    const dependents = graph.getTransitiveDependents('src/b');
    expect(dependents).toContain('src/a');
    expect(dependents).toContain('src/c');
    expect(dependents).toContain('src/d');
  });

  it('getMostConnected returns hub files', () => {
    // hub imports a, b, c; x imports hub; y imports hub
    // Use 'src/hub' as filePath so it matches what other files resolve to
    graph.updateFile('src/hub', [
      `import { A } from './a';`,
      `import { B } from './b';`,
      `import { C } from './c';`,
    ].join('\n'));
    graph.updateFile('src/x', `import { Hub } from './hub';`);
    graph.updateFile('src/y', `import { Hub } from './hub';`);

    const top = graph.getMostConnected(3);
    // hub has 3 out + 2 in = 5 connections
    expect(top[0].path).toBe('src/hub');
    expect(top[0].connections).toBe(5);
  });

  it('incremental update works — change a file, edges update', () => {
    graph.updateFile('src/app.ts', `import { A } from './a';`);
    expect(graph.getDependencies('src/app.ts')).toEqual(['src/a']);

    // Update to import b instead of a
    graph.updateFile('src/app.ts', `import { B } from './b';`);
    expect(graph.getDependencies('src/app.ts')).toEqual(['src/b']);
    expect(graph.getDependents('src/a')).toEqual([]);
    expect(graph.getDependents('src/b')).toEqual(['src/app.ts']);
  });

  it('handles circular dependencies without infinite loop', () => {
    // a -> b -> c -> a (cycle)
    // Use consistent keys matching resolved targets
    graph.updateFile('src/a', `import { B } from './b';`);
    graph.updateFile('src/b', `import { C } from './c';`);
    graph.updateFile('src/c', `import { A } from './a';`);

    // Should terminate and return all nodes in the cycle (except start)
    const deps = graph.getTransitiveDependencies('src/a');
    expect(deps).toContain('src/b');
    expect(deps).toContain('src/c');

    const dependents = graph.getTransitiveDependents('src/a');
    expect(dependents).toContain('src/c');
    expect(dependents).toContain('src/b');
  });

  it('load restores graph from database', () => {
    graph.updateFile('src/a.ts', `import { B } from './b';`);
    graph.updateFile('src/b.ts', `import { C } from './c';`);

    // Create a new graph instance and load from DB
    const graph2 = new DependencyGraph(tempDir);
    graph2.load();

    expect(graph2.getDependencies('src/a.ts')).toEqual(['src/b']);
    expect(graph2.getDependencies('src/b.ts')).toEqual(['src/c']);
    expect(graph2.getDependents('src/b')).toEqual(['src/a.ts']);
  });

  it('returns empty arrays for unknown paths', () => {
    expect(graph.getDependencies('nonexistent.ts')).toEqual([]);
    expect(graph.getDependents('nonexistent.ts')).toEqual([]);
    expect(graph.getTransitiveDependencies('nonexistent.ts')).toEqual([]);
    expect(graph.getTransitiveDependents('nonexistent.ts')).toEqual([]);
  });

  it('getMostConnected with limit', () => {
    graph.updateFile('src/a.ts', `import { X } from './x';`);
    graph.updateFile('src/b.ts', `import { X } from './x';`);
    graph.updateFile('src/c.ts', `import { X } from './x';`);

    const top1 = graph.getMostConnected(1);
    expect(top1).toHaveLength(1);
    // x has 3 incoming = 3 connections, highest
    expect(top1[0].path).toBe('src/x');
  });
});
