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
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns dependencies for a single file as an adjacency map', async () => {
    const result = await getDependencyGraphTool(tempDir, 'src/index.ts', 'dependencies');
    expect(result.deps).toEqual({ 'src/index.ts': ['src/helper.ts'] });
    expect(result.dependents).toBeUndefined();
    expect(result).not.toHaveProperty('nodes');
    expect(result).not.toHaveProperty('edges');
  });

  it('returns dependents for a single file as an adjacency map', async () => {
    const result = await getDependencyGraphTool(tempDir, 'src/helper.ts', 'dependents');
    expect(result.dependents).toEqual({ 'src/helper.ts': ['src/index.ts'] });
    expect(result.deps).toBeUndefined();
  });

  it('returns both maps for direction=both (the default)', async () => {
    const result = await getDependencyGraphTool(tempDir, 'src/helper.ts');
    expect(result.deps).toEqual({ 'src/helper.ts': ['src/util.ts'] });
    expect(result.dependents).toEqual({ 'src/helper.ts': ['src/index.ts'] });
    expect(result.stats.totalFiles).toBe(3);
    expect(result.stats.totalEdges).toBe(2);
  });

  it('omits mostConnected for path-scoped queries', async () => {
    const result = await getDependencyGraphTool(tempDir, 'src/index.ts');
    expect(result.stats.mostConnected).toBeUndefined();
  });

  it('returns full summary when no path given', async () => {
    const result = await getDependencyGraphTool(tempDir);
    expect(result.stats.mostConnected!.length).toBeGreaterThan(0);
    expect(Object.keys(result.deps!).length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty('nodes');
    expect(result).not.toHaveProperty('edges');
    expect(result.truncated).toBeUndefined(); // 3 files fit well under the default limit
  });

  it('caps the no-path summary at limit and flags truncation with whole-graph totals', async () => {
    const result = await getDependencyGraphTool(
      tempDir,
      undefined,
      undefined,
      undefined,
      undefined,
      1,
    );
    expect(Object.keys(result.deps!)).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.stats.totalFiles).toBe(3); // whole-graph count, not the capped count
    expect(result.stats.totalEdges).toBe(2);
  });

  it('respects depth parameter', async () => {
    const result = await getDependencyGraphTool(tempDir, 'src/index.ts', 'dependencies', 1);
    expect(result.deps!['src/index.ts']).toContain('src/helper.ts');
    // At depth 1, should not include transitive deps of helper
    expect(result.deps!['src/index.ts']).not.toContain('src/util.ts');
  });

  it('mostConnected and adjacency maps contain only real repo files (no bare modules or phantoms)', async () => {
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
    expect(result.stats.mostConnected!.length).toBeGreaterThan(0);

    const allPaths = [
      ...Object.keys(result.deps!),
      ...Object.values(result.deps!).flat(),
      ...result.stats.mostConnected!.map((m) => m.path),
    ];
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
      expect(result.deps).toEqual({ 'src/index.ts': ['src/helper.ts'] });
      expect(result.stats.totalFiles).toBe(2);
      expect(result.stats.totalEdges).toBe(1);
    });

    it('omits mostConnected for symbol queries', async () => {
      const result = await getDependencyGraphTool(tempDir, undefined, undefined, undefined, 'helper');
      expect(result.stats.mostConnected).toBeUndefined();
    });

    it('filters by symbol when path is NOT given (search all edges)', async () => {
      const result = await getDependencyGraphTool(tempDir, undefined, undefined, undefined, 'util');
      expect(result.deps!['src/helper.ts']).toContain('src/util.ts');
    });

    it('returns empty results for non-existent symbol', async () => {
      const result = await getDependencyGraphTool(tempDir, undefined, undefined, undefined, 'NonExistent');
      expect(result.deps).toEqual({});
      expect(result.stats.totalFiles).toBe(0);
      expect(result.stats.totalEdges).toBe(0);
    });

    it('uses case-sensitive matching', async () => {
      const result = await getDependencyGraphTool(tempDir, undefined, undefined, undefined, 'Helper');
      expect(result.deps).toEqual({});

      const result2 = await getDependencyGraphTool(tempDir, undefined, undefined, undefined, 'helper');
      expect(Object.keys(result2.deps!).length).toBeGreaterThan(0);
    });
  });
});
