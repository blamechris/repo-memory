import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getFileSummary } from '../../src/tools/get-file-summary.js';
import { getChangedFiles } from '../../src/tools/get-changed-files.js';
import { buildProjectMap } from '../../src/indexer/project-map.js';
import { forceReread } from '../../src/tools/force-reread.js';
import { invalidateCache } from '../../src/tools/invalidate.js';
import { CacheStore } from '../../src/cache/store.js';
import { closeDatabase } from '../../src/persistence/db.js';

function createFixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-memory-e2e-'));

  // Initialize git repo
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

  // Create project structure
  mkdirSync(join(dir, 'src', 'utils'), { recursive: true });

  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));

  writeFileSync(
    join(dir, 'src', 'index.ts'),
    [
      'import { greet } from "./utils/greet.js";',
      '',
      'export function main(): void {',
      '  greet("world");',
      '}',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(dir, 'src', 'utils', 'greet.ts'),
    [
      'export function greet(name: string): string {',
      '  return `Hello, ${name}!`;',
      '}',
      '',
    ].join('\n'),
  );

  writeFileSync(join(dir, 'README.md'), '# Fixture Project\n\nA test fixture.\n');

  // Commit everything
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir });

  return dir;
}

describe('V1 end-to-end flow', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createFixtureProject();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('full V1 tool flow: map → summary → cache hit → change → reread → invalidate', async () => {
    // Step 1: Get project map — verify structure
    const map = await buildProjectMap(projectDir);
    expect(map.totalFiles).toBe(4); // package.json, src/index.ts, src/utils/greet.ts, README.md
    expect(map.entryPoints).toContain('src/index.ts');
    expect(map.languageBreakdown['.ts']).toBe(2);

    // Step 2: Get file summary — cache hit (project map already cached it)
    const summary1 = await getFileSummary(projectDir, 'src/index.ts');
    expect(summary1.fromCache).toBe(true);
    expect(summary1.summary.purpose).toBe('entry point');
    expect(summary1.summary.exports).toContain('main');
    expect(summary1.summary.imports).toContain('./utils/greet.js');
    expect(summary1.hash).toHaveLength(64);

    // Step 3: Get same file summary again — cache hit
    const summary2 = await getFileSummary(projectDir, 'src/index.ts');
    expect(summary2.fromCache).toBe(true);
    expect(summary2.hash).toBe(summary1.hash);
    expect(summary2.summary).toEqual(summary1.summary);

    // Step 4: Modify a file
    writeFileSync(
      join(projectDir, 'src', 'utils', 'greet.ts'),
      [
        'export function greet(name: string): string {',
        '  return `Hi, ${name}!`;',
        '}',
        '',
        'export function farewell(name: string): string {',
        '  return `Goodbye, ${name}!`;',
        '}',
        '',
      ].join('\n'),
    );

    // Step 5: Invalidate the modified file so change detection works fresh
    await invalidateCache(projectDir, 'src/utils/greet.ts');

    // Step 6: Get changed files — verify modified file detected
    const changes = await getChangedFiles(projectDir);
    expect(changes.changed.length + changes.added.length).toBeGreaterThan(0);
    const greetChanged =
      changes.changed.includes('src/utils/greet.ts') ||
      changes.added.includes('src/utils/greet.ts');
    expect(greetChanged).toBe(true);

    // Step 7: Force reread — verify fresh data with new exports
    const reread = await forceReread(projectDir, 'src/utils/greet.ts');
    expect(reread.reread).toBe(true);
    expect(reread.summary.exports).toContain('greet');
    expect(reread.summary.exports).toContain('farewell');

    // Step 8: Invalidate single entry
    const store = new CacheStore(projectDir);
    expect(store.getEntry('src/utils/greet.ts')).not.toBeNull();

    const inv1 = await invalidateCache(projectDir, 'src/utils/greet.ts');
    expect(inv1.invalidated).toBe('src/utils/greet.ts');
    expect(inv1.entriesRemoved).toBe(1);
    expect(store.getEntry('src/utils/greet.ts')).toBeNull();

    // Step 9: Invalidate all — verify cache cleared
    const inv2 = await invalidateCache(projectDir);
    expect(inv2.invalidated).toBe('all');
    expect(store.getAllEntries()).toHaveLength(0);

    // Step 10: After invalidation, next get_file_summary regenerates
    const summary4 = await getFileSummary(projectDir, 'src/index.ts');
    expect(summary4.fromCache).toBe(false);
    expect(summary4.summary.purpose).toBe('entry point');
  });

  it('detects new and deleted files via get_changed_files', async () => {
    // Populate cache with initial scan
    await getChangedFiles(projectDir);

    // Add a new file
    writeFileSync(join(projectDir, 'src', 'new-file.ts'), 'export const x = 1;');
    execFileSync('git', ['add', '.'], { cwd: projectDir });
    execFileSync('git', ['commit', '-m', 'add new file'], { cwd: projectDir });

    const changes1 = await getChangedFiles(projectDir);
    expect(changes1.added).toContain('src/new-file.ts');

    // Delete a file
    rmSync(join(projectDir, 'src', 'new-file.ts'));
    execFileSync('git', ['add', '.'], { cwd: projectDir });
    execFileSync('git', ['commit', '-m', 'delete file'], { cwd: projectDir });

    const changes2 = await getChangedFiles(projectDir);
    expect(changes2.deleted).toContain('src/new-file.ts');
  });
});
