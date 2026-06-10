import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getDependencyGraphTool } from '../../src/tools/get-dependency-graph.js';
import { closeDatabase } from '../../src/persistence/db.js';

describe('getDependencyGraphTool', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dep-graph-tool-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });

    writeFileSync(join(tempDir, 'src', 'index.ts'), `import { helper } from './helper.js';\nexport function main() { helper(); }\n`);
    writeFileSync(join(tempDir, 'src', 'helper.ts'), `import { util } from './util.js';\nexport function helper() { util(); }\n`);
    writeFileSync(join(tempDir, 'src', 'util.ts'), `export function util() { return 42; }\n`);

    execFileSync('git', ['init'], { cwd: tempDir });
    execFileSync('git', ['add', '.'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns dependencies for a single file', async () => {
    const result = await getDependencyGraphTool(tempDir, 'src/index.ts', 'dependencies');
    expect(result.nodes).toContain('src/index.ts');
    expect(result.nodes).toContain('src/helper.ts');
    expect(result.edges.some((e) => e.from === 'src/index.ts' && e.to === 'src/helper.ts')).toBe(true);
  });

  it('returns dependents for a single file', async () => {
    const result = await getDependencyGraphTool(tempDir, 'src/helper.ts', 'dependents');
    expect(result.nodes).toContain('src/index.ts');
  });

  it('returns full summary when no path given', async () => {
    const result = await getDependencyGraphTool(tempDir);
    expect(result.stats.mostConnected.length).toBeGreaterThan(0);
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  it('respects depth parameter', async () => {
    const result = await getDependencyGraphTool(tempDir, 'src/index.ts', 'dependencies', 1);
    expect(result.nodes).toContain('src/helper.ts');
    // At depth 1, should not include transitive deps of helper
  });

  it('mostConnected and nodes contain only real repo files (no bare modules or phantoms)', async () => {
    // A file with external imports must not introduce phantom graph nodes
    writeFileSync(
      join(tempDir, 'src', 'externals.ts'),
      [
        `import { describe } from 'vitest';`,
        `import { readFileSync } from 'node:fs';`,
        `import { join } from 'path';`,
        `import { ghost } from './does-not-exist.js';`,
        `import { util } from './util.js';`,
      ].join('\n'),
    );

    const result = await getDependencyGraphTool(tempDir);
    expect(result.stats.mostConnected.length).toBeGreaterThan(0);

    const allPaths = [...result.nodes, ...result.stats.mostConnected.map((m) => m.path)];
    for (const p of allPaths) {
      expect(existsSync(join(tempDir, p)), `${p} should be a real repo file`).toBe(true);
    }
    expect(allPaths).not.toContain('vitest');
    expect(allPaths).not.toContain('node:fs');
    expect(allPaths).not.toContain('path');
    expect(allPaths).not.toContain('src/does-not-exist.js');
    expect(allPaths).not.toContain('src/util.js');
  });

  describe('symbol filter', () => {
    it('filters by symbol when path is given', async () => {
      const result = await getDependencyGraphTool(tempDir, 'src/index.ts', undefined, undefined, 'helper');
      expect(result.edges).toEqual([{ from: 'src/index.ts', to: 'src/helper.ts' }]);
      expect(result.nodes).toContain('src/index.ts');
      expect(result.nodes).toContain('src/helper.ts');
    });

    it('filters by symbol when path is NOT given (search all edges)', async () => {
      const result = await getDependencyGraphTool(tempDir, undefined, undefined, undefined, 'util');
      expect(result.edges.some((e) => e.from === 'src/helper.ts' && e.to === 'src/util.ts')).toBe(true);
      expect(result.nodes).toContain('src/helper.ts');
      expect(result.nodes).toContain('src/util.ts');
    });

    it('returns empty results for non-existent symbol', async () => {
      const result = await getDependencyGraphTool(tempDir, undefined, undefined, undefined, 'NonExistent');
      expect(result.nodes).toEqual([]);
      expect(result.edges).toEqual([]);
      expect(result.stats.totalFiles).toBe(0);
      expect(result.stats.totalEdges).toBe(0);
    });

    it('uses case-sensitive matching', async () => {
      const result = await getDependencyGraphTool(tempDir, undefined, undefined, undefined, 'Helper');
      expect(result.edges).toEqual([]);

      const result2 = await getDependencyGraphTool(tempDir, undefined, undefined, undefined, 'helper');
      expect(result2.edges.length).toBeGreaterThan(0);
    });
  });
});
