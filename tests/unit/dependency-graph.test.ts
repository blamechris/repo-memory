import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { DependencyGraph } from '../../src/graph/dependency-graph.js';
import { getDatabase, closeDatabase } from '../../src/persistence/db.js';

describe('DependencyGraph', () => {
  let tempDir: string;
  let graph: DependencyGraph;

  /** Write a real file to disk and index it in the graph. */
  function addFile(relPath: string, contents: string): void {
    const abs = join(tempDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
    graph.updateFile(relPath, contents);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dep-graph-test-'));
    mkdirSync(join(tempDir, '.repo-memory'), { recursive: true });
    getDatabase(tempDir);
    graph = new DependencyGraph(tempDir);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('builds graph from import data with real file targets', () => {
    addFile('src/bar.ts', `export const Foo = 1;`);
    addFile('src/index.ts', `import { Foo } from './bar';`);

    expect(graph.getDependencies('src/index.ts')).toEqual(['src/bar.ts']);
    expect(graph.getDependents('src/bar.ts')).toEqual(['src/index.ts']);
  });

  it('resolves .js specifiers to the real .ts file', () => {
    addFile('src/cache/store.ts', `export const store = {};`);
    addFile('src/index.ts', `import { store } from './cache/store.js';`);

    expect(graph.getDependencies('src/index.ts')).toEqual(['src/cache/store.ts']);
    expect(graph.getDependents('src/cache/store.ts')).toEqual(['src/index.ts']);
  });

  it('getDependencies returns correct files', () => {
    addFile('src/a.ts', `export const A = 1;`);
    addFile('src/b.ts', `export const B = 1;`);
    addFile('src/c.ts', `export const C = 1;`);
    addFile('src/app.ts', [
      `import { A } from './a';`,
      `import { B } from './b';`,
      `import { C } from './c';`,
    ].join('\n'));

    const deps = graph.getDependencies('src/app.ts');
    expect(deps).toHaveLength(3);
    expect(deps).toContain('src/a.ts');
    expect(deps).toContain('src/b.ts');
    expect(deps).toContain('src/c.ts');
  });

  it('getDependents returns correct files', () => {
    addFile('src/util.ts', `export const Util = 1;`);
    addFile('src/a.ts', `import { Util } from './util';`);
    addFile('src/b.ts', `import { Util } from './util';`);
    addFile('src/c.ts', `import { Util } from './util';`);

    const dependents = graph.getDependents('src/util.ts');
    expect(dependents).toHaveLength(3);
    expect(dependents).toContain('src/a.ts');
    expect(dependents).toContain('src/b.ts');
    expect(dependents).toContain('src/c.ts');
  });

  it('transitive traversal follows real files: A → B → C reachable at depth 2', () => {
    addFile('src/d.ts', `export const D = 1;`);
    addFile('src/c.ts', `import { D } from './d.js';\nexport const C = 1;`);
    addFile('src/b.ts', `import { C } from './c.js';\nexport const B = 1;`);
    addFile('src/a.ts', `import { B } from './b.js';\nexport const A = 1;`);

    const all = graph.getTransitiveDependencies('src/a.ts');
    expect(all).toContain('src/b.ts');
    expect(all).toContain('src/c.ts');
    expect(all).toContain('src/d.ts');

    const depth1 = graph.getTransitiveDependencies('src/a.ts', 1);
    expect(depth1).toEqual(['src/b.ts']);

    const depth2 = graph.getTransitiveDependencies('src/a.ts', 2);
    expect(depth2).toContain('src/b.ts');
    expect(depth2).toContain('src/c.ts');
    expect(depth2).not.toContain('src/d.ts');
  });

  it('getTransitiveDependents works', () => {
    addFile('src/b.ts', `export const B = 1;`);
    addFile('src/a.ts', `import { B } from './b';`);
    addFile('src/c.ts', `import { B } from './b';\nexport const C = 1;`);
    addFile('src/d.ts', `import { C } from './c';`);

    const dependents = graph.getTransitiveDependents('src/b.ts');
    expect(dependents).toContain('src/a.ts');
    expect(dependents).toContain('src/c.ts');
    expect(dependents).toContain('src/d.ts');
  });

  it('getMostConnected returns hub files', () => {
    addFile('src/a.ts', `export const A = 1;`);
    addFile('src/b.ts', `export const B = 1;`);
    addFile('src/c.ts', `export const C = 1;`);
    addFile('src/hub.ts', [
      `import { A } from './a';`,
      `import { B } from './b';`,
      `import { C } from './c';`,
      `export const Hub = 1;`,
    ].join('\n'));
    addFile('src/x.ts', `import { Hub } from './hub';`);
    addFile('src/y.ts', `import { Hub } from './hub';`);

    const top = graph.getMostConnected(3);
    expect(top[0].path).toBe('src/hub.ts');
    expect(top[0].connections).toBe(5);
  });

  it('external imports do not become graph nodes', () => {
    addFile('src/util.ts', `export const util = 1;`);
    addFile('src/app.ts', [
      `import { describe } from 'vitest';`,
      `import { readFileSync } from 'node:fs';`,
      `import { join } from 'path';`,
      `import { util } from './util.js';`,
      `import { ghost } from './does-not-exist.js';`,
    ].join('\n'));

    expect(graph.getDependencies('src/app.ts')).toEqual(['src/util.ts']);
    expect(graph.getDependents('vitest')).toEqual([]);
    expect(graph.getDependents('node:fs')).toEqual([]);
    expect(graph.getDependents('path')).toEqual([]);
    expect(graph.getDependents('src/does-not-exist.js')).toEqual([]);

    const nodes = graph.getMostConnected(100).map((n) => n.path);
    expect(nodes).toContain('src/app.ts');
    expect(nodes).toContain('src/util.ts');
    expect(nodes).not.toContain('vitest');
    expect(nodes).not.toContain('node:fs');
    expect(nodes).not.toContain('path');
    expect(nodes).not.toContain('src/does-not-exist.js');
  });

  it('incremental update works — change a file, edges update', () => {
    addFile('src/a.ts', `export const A = 1;`);
    addFile('src/b.ts', `export const B = 1;`);
    addFile('src/app.ts', `import { A } from './a';`);
    expect(graph.getDependencies('src/app.ts')).toEqual(['src/a.ts']);

    graph.updateFile('src/app.ts', `import { B } from './b';`);
    expect(graph.getDependencies('src/app.ts')).toEqual(['src/b.ts']);
    expect(graph.getDependents('src/a.ts')).toEqual([]);
    expect(graph.getDependents('src/b.ts')).toEqual(['src/app.ts']);
  });

  it('handles circular dependencies without infinite loop', () => {
    addFile('src/a.ts', '');
    addFile('src/b.ts', '');
    addFile('src/c.ts', '');
    graph.updateFile('src/a.ts', `import { B } from './b';`);
    graph.updateFile('src/b.ts', `import { C } from './c';`);
    graph.updateFile('src/c.ts', `import { A } from './a';`);

    const deps = graph.getTransitiveDependencies('src/a.ts');
    expect(deps).toContain('src/b.ts');
    expect(deps).toContain('src/c.ts');

    const dependents = graph.getTransitiveDependents('src/a.ts');
    expect(dependents).toContain('src/c.ts');
    expect(dependents).toContain('src/b.ts');
  });

  it('load restores graph from database', () => {
    addFile('src/c.ts', `export const C = 1;`);
    addFile('src/b.ts', `import { C } from './c';\nexport const B = 1;`);
    addFile('src/a.ts', `import { B } from './b';`);

    const graph2 = new DependencyGraph(tempDir);
    graph2.load();

    expect(graph2.getDependencies('src/a.ts')).toEqual(['src/b.ts']);
    expect(graph2.getDependencies('src/b.ts')).toEqual(['src/c.ts']);
    expect(graph2.getDependents('src/b.ts')).toEqual(['src/a.ts']);
  });

  it('removeFile deletes persisted and in-memory edges in both directions', () => {
    addFile('src/c.ts', `export const C = 1;`);
    addFile('src/b.ts', `import { C } from './c';\nexport const B = 1;`);
    addFile('src/a.ts', `import { B } from './b';`);

    graph.removeFile('src/b.ts');

    expect(graph.getDependencies('src/a.ts')).toEqual([]);
    expect(graph.getDependents('src/c.ts')).toEqual([]);
    expect(graph.getDependencies('src/b.ts')).toEqual([]);

    const rows = getDatabase(tempDir)
      .prepare('SELECT source FROM imports WHERE source = ? OR target = ?')
      .all('src/b.ts', 'src/b.ts');
    expect(rows).toEqual([]);

    // A reloaded graph must agree with the in-memory one.
    const graph2 = new DependencyGraph(tempDir);
    graph2.load();
    expect(graph2.getDependencies('src/a.ts')).toEqual([]);
    expect(graph2.getDependents('src/c.ts')).toEqual([]);
  });

  it('prune removes every node missing from the existing-file set', () => {
    addFile('src/util.ts', `export const util = 1;`);
    addFile('src/a.ts', `import { util } from './util';`);
    addFile('src/b.ts', `import { util } from './util';`);

    graph.prune(new Set(['src/util.ts', 'src/a.ts']));

    expect(graph.getDependents('src/util.ts')).toEqual(['src/a.ts']);
    expect(graph.getDependencies('src/b.ts')).toEqual([]);

    const rows = getDatabase(tempDir)
      .prepare('SELECT source FROM imports')
      .all() as Array<{ source: string }>;
    expect(rows).toEqual([{ source: 'src/a.ts' }]);
  });

  it('returns empty arrays for unknown paths', () => {
    expect(graph.getDependencies('nonexistent.ts')).toEqual([]);
    expect(graph.getDependents('nonexistent.ts')).toEqual([]);
    expect(graph.getTransitiveDependencies('nonexistent.ts')).toEqual([]);
    expect(graph.getTransitiveDependents('nonexistent.ts')).toEqual([]);
  });

  it('getMostConnected with limit', () => {
    addFile('src/x.ts', `export const X = 1;`);
    addFile('src/a.ts', `import { X } from './x';`);
    addFile('src/b.ts', `import { X } from './x';`);
    addFile('src/c.ts', `import { X } from './x';`);

    const top1 = graph.getMostConnected(1);
    expect(top1).toHaveLength(1);
    expect(top1[0].path).toBe('src/x.ts');
  });
});
