import { describe, bench, beforeAll, afterAll } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getFileSummary } from '../../src/tools/get-file-summary.js';
import { buildProjectMap } from '../../src/indexer/project-map.js';
import { createTaskTool, markExploredTool } from '../../src/tools/task-context.js';
import { closeDatabase } from '../../src/persistence/db.js';
import { invalidateCache } from '../../src/tools/invalidate.js';
import { scanProject } from '../../src/indexer/scanner.js';
import { createBenchmarkFixture } from './benchmark-utils.js';

// ---------------------------------------------------------------------------
// Fixture management
// ---------------------------------------------------------------------------

const fixtures: Record<string, string> = {};

function getRawBytes(projectRoot: string, files: string[]): number {
  let total = 0;
  for (const f of files) {
    try {
      total += readFileSync(join(projectRoot, f)).length;
    } catch {
      // skip
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Small project benchmarks (10 files)
// ---------------------------------------------------------------------------

describe('token savings — small project (10 files)', () => {
  beforeAll(() => {
    fixtures['small'] = createBenchmarkFixture(10);
  });

  afterAll(() => {
    closeDatabase();
    if (fixtures['small']) {
      rmSync(fixtures['small'], { recursive: true, force: true });
    }
  });

  bench('explore project', async () => {
    const dir = fixtures['small'];
    await invalidateCache(dir);
    const files = await scanProject(dir);
    await buildProjectMap(dir);
    for (const f of files) {
      await getFileSummary(dir, f);
    }
  });

  bench('investigate bug', async () => {
    const dir = fixtures['small'];
    await invalidateCache(dir);
    const files = await scanProject(dir);
    const task = createTaskTool(dir, 'bench-bug');
    const count = Math.ceil(files.length * 0.6);
    for (let i = 0; i < count; i++) {
      await getFileSummary(dir, files[i]);
      markExploredTool(dir, task.id, files[i]);
    }
    // Revisit first few
    for (let i = 0; i < Math.min(3, count); i++) {
      await getFileSummary(dir, files[i]);
    }
  });

  bench('incremental change', async () => {
    const dir = fixtures['small'];
    await invalidateCache(dir);
    const files = await scanProject(dir);
    // Warm cache
    for (const f of files) {
      await getFileSummary(dir, f);
    }
    // Re-read all (should hit cache)
    for (const f of files) {
      await getFileSummary(dir, f);
    }
  });
});

// ---------------------------------------------------------------------------
// Medium project benchmarks (50 files)
// ---------------------------------------------------------------------------

describe('token savings — medium project (50 files)', () => {
  beforeAll(() => {
    fixtures['medium'] = createBenchmarkFixture(50);
  });

  afterAll(() => {
    closeDatabase();
    if (fixtures['medium']) {
      rmSync(fixtures['medium'], { recursive: true, force: true });
    }
  });

  bench('explore project', async () => {
    const dir = fixtures['medium'];
    await invalidateCache(dir);
    const files = await scanProject(dir);
    await buildProjectMap(dir);
    for (const f of files) {
      await getFileSummary(dir, f);
    }
  });

  bench('investigate bug', async () => {
    const dir = fixtures['medium'];
    await invalidateCache(dir);
    const files = await scanProject(dir);
    const task = createTaskTool(dir, 'bench-bug');
    const count = Math.ceil(files.length * 0.6);
    for (let i = 0; i < count; i++) {
      await getFileSummary(dir, files[i]);
      markExploredTool(dir, task.id, files[i]);
    }
    for (let i = 0; i < Math.min(5, count); i++) {
      await getFileSummary(dir, files[i]);
    }
  });

  bench('incremental change', async () => {
    const dir = fixtures['medium'];
    await invalidateCache(dir);
    const files = await scanProject(dir);
    for (const f of files) {
      await getFileSummary(dir, f);
    }
    for (const f of files) {
      await getFileSummary(dir, f);
    }
  });
});
