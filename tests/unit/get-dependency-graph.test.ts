import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
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
    expect(result.nodes).toContain('src/helper.js');
    expect(result.edges.some((e) => e.from === 'src/index.ts' && e.to === 'src/helper.js')).toBe(true);
  });

  it('returns dependents for a single file', async () => {
    const result = await getDependencyGraphTool(tempDir, 'src/helper.js', 'dependents');
    expect(result.nodes).toContain('src/index.ts');
  });

  it('returns full summary when no path given', async () => {
    const result = await getDependencyGraphTool(tempDir);
    expect(result.stats.mostConnected.length).toBeGreaterThan(0);
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  it('respects depth parameter', async () => {
    const result = await getDependencyGraphTool(tempDir, 'src/index.ts', 'dependencies', 1);
    expect(result.nodes).toContain('src/helper.js');
    // At depth 1, should not include transitive deps of helper
  });

  describe('symbol filter', () => {
    it('filters by symbol when path is given', async () => {
      const result = await getDependencyGraphTool(tempDir, 'src/index.ts', undefined, undefined, 'helper');
      expect(result.edges).toEqual([{ from: 'src/index.ts', to: 'src/helper.js' }]);
      expect(result.nodes).toContain('src/index.ts');
      expect(result.nodes).toContain('src/helper.js');
    });

    it('filters by symbol when path is NOT given (search all edges)', async () => {
      const result = await getDependencyGraphTool(tempDir, undefined, undefined, undefined, 'util');
      expect(result.edges.some((e) => e.from === 'src/helper.ts' && e.to === 'src/util.js')).toBe(true);
      expect(result.nodes).toContain('src/helper.ts');
      expect(result.nodes).toContain('src/util.js');
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
