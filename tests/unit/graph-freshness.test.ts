import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readdirSync } from 'fs';
import { readFile } from 'node:fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { getRelatedFiles } from '../../src/tools/get-related-files.js';
import { getDependencyGraphTool } from '../../src/tools/get-dependency-graph.js';
import { closeDatabase, getDatabase } from '../../src/persistence/db.js';

// Pass-through spy so the tests can count which files get re-read from disk.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

describe('persisted graph freshness', () => {
  let tempDir: string;

  /** Absolute paths of files under the temp project that were read from disk. */
  function projectReads(): string[] {
    return vi
      .mocked(readFile)
      .mock.calls.map((call) => String(call[0]))
      .filter((p) => p.startsWith(tempDir));
  }

  /**
   * Age all project files past the refresh pass's mtime safety window, so an
   * unchanged file is deterministically skippable and a fresh write (new
   * mtime) is deterministically suspect — independent of filesystem timestamp
   * granularity and test speed.
   */
  function backdateMtimes(): void {
    const past = new Date(Date.now() - 60_000);
    for (const name of readdirSync(join(tempDir, 'src'))) {
      utimesSync(join(tempDir, 'src', name), past, past);
    }
  }

  function edgeCount(path: string): number {
    const row = getDatabase(tempDir)
      .prepare('SELECT COUNT(*) AS count FROM imports WHERE source = ? OR target = ?')
      .get(path, path) as { count: number };
    return row.count;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'graph-freshness-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });

    writeFileSync(
      join(tempDir, 'src', 'index.ts'),
      `import { helper } from './helper.js';\nexport function main() { helper(); }\n`,
    );
    writeFileSync(
      join(tempDir, 'src', 'helper.ts'),
      `import { util } from './util.js';\nexport function helper() { util(); }\n`,
    );
    writeFileSync(
      join(tempDir, 'src', 'util.ts'),
      `export function util() { return 42; }\n`,
    );

    execFileSync('git', ['init'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
    execFileSync('git', ['add', '.'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir });

    vi.mocked(readFile).mockClear();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('get_related_files does not re-read any file when nothing changed', async () => {
    const first = await getRelatedFiles(tempDir, 'src/index.ts');
    expect(first.relatedFiles.map((f) => f.path)).toContain('src/helper.ts');
    expect(projectReads().length).toBeGreaterThan(0); // first call builds the graph

    backdateMtimes();
    vi.mocked(readFile).mockClear();
    const second = await getRelatedFiles(tempDir, 'src/index.ts');

    expect(projectReads()).toEqual([]);
    expect(second).toEqual(first);
  });

  it('get_dependency_graph does not re-read any file when nothing changed', async () => {
    const first = await getDependencyGraphTool(tempDir);
    expect(first.stats.totalEdges).toBeGreaterThan(0);

    backdateMtimes();
    vi.mocked(readFile).mockClear();
    const second = await getDependencyGraphTool(tempDir);

    expect(projectReads()).toEqual([]);
    expect(second).toEqual(first);
  });

  it('editing one file re-reads and refreshes only that file', async () => {
    await getRelatedFiles(tempDir, 'src/util.ts');
    backdateMtimes();

    // index.ts now imports util.ts directly instead of helper.ts
    writeFileSync(
      join(tempDir, 'src', 'index.ts'),
      `import { util } from './util.js';\nexport function main() { util(); }\n`,
    );

    vi.mocked(readFile).mockClear();
    const result = await getRelatedFiles(tempDir, 'src/util.ts');

    expect(projectReads()).toEqual([join(tempDir, 'src/index.ts')]);

    const indexEntry = result.relatedFiles.find((f) => f.path === 'src/index.ts');
    expect(indexEntry).toBeDefined();
    expect(indexEntry!.relationship).toBe('imported-by');

    const rows = getDatabase(tempDir)
      .prepare('SELECT target FROM imports WHERE source = ?')
      .all('src/index.ts') as Array<{ target: string }>;
    expect(rows).toEqual([{ target: 'src/util.ts' }]);
  });

  it('deleting a tracked file removes its edges on the next graph query', async () => {
    await getDependencyGraphTool(tempDir);
    expect(edgeCount('src/util.ts')).toBeGreaterThan(0);

    // Still listed by `git ls-files`, but gone from disk.
    rmSync(join(tempDir, 'src', 'util.ts'));

    const result = await getDependencyGraphTool(tempDir, 'src/helper.ts', 'dependencies');
    expect(result.deps!['src/helper.ts']).not.toContain('src/util.ts');
    expect(edgeCount('src/util.ts')).toBe(0);
  });

  it('deleting an untracked file prunes its edges on the next graph query', async () => {
    writeFileSync(
      join(tempDir, 'src', 'extra.ts'),
      `import { util } from './util.js';\nexport const extra = 1;\n`,
    );
    await getDependencyGraphTool(tempDir);
    expect(edgeCount('src/extra.ts')).toBeGreaterThan(0);

    rmSync(join(tempDir, 'src', 'extra.ts'));

    const result = await getDependencyGraphTool(tempDir, 'src/util.ts', 'dependents');
    expect(result.dependents!['src/util.ts']).not.toContain('src/extra.ts');
    expect(edgeCount('src/extra.ts')).toBe(0);
  });
});
