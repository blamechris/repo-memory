import { rmSync } from 'fs';
import { afterAll, bench, beforeAll, describe } from 'vitest';
import { CacheStore } from '../../src/cache/store.js';
import { rankFiles } from '../../src/cache/ranking.js';
import { scanProject } from '../../src/indexer/scanner.js';
import { buildProjectMap } from '../../src/indexer/project-map.js';
import { getFileSummary } from '../../src/tools/get-file-summary.js';
import { getChangedFiles } from '../../src/tools/get-changed-files.js';
import { getDependencyGraphTool } from '../../src/tools/get-dependency-graph.js';
import { closeDatabase } from '../../src/persistence/db.js';
import { createPerfFixture } from './perf-utils.js';

describe('performance benchmarks', () => {
  let fixtureDir: string;
  let scannedFiles: string[];

  beforeAll(async () => {
    fixtureDir = createPerfFixture({
      fileCount: 50,
      avgLinesPerFile: 30,
      importDensity: 0.5,
    });
    scannedFiles = await scanProject(fixtureDir);
  });

  afterAll(() => {
    closeDatabase();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  bench('scanProject - 50 files', async () => {
    await scanProject(fixtureDir);
  });

  bench('getFileSummary - cold cache', async () => {
    // Delete cache entry to force cold path
    const store = new CacheStore(fixtureDir);
    const targetFile = scannedFiles.find((f) => f.endsWith('.ts')) ?? scannedFiles[0];
    store.deleteEntry(targetFile);
    await getFileSummary(fixtureDir, targetFile);
  });

  bench('getFileSummary - warm cache', async () => {
    const targetFile = scannedFiles.find((f) => f.endsWith('.ts')) ?? scannedFiles[0];
    await getFileSummary(fixtureDir, targetFile);
  });

  bench('buildProjectMap - 50 files', async () => {
    await buildProjectMap(fixtureDir);
  });

  bench('getDependencyGraphTool - 50 files', async () => {
    await getDependencyGraphTool(fixtureDir);
  });

  bench('getChangedFiles - 50 files', async () => {
    await getChangedFiles(fixtureDir);
  });

  bench('rankFiles - 50 files', () => {
    rankFiles(scannedFiles, {
      projectRoot: fixtureDir,
      exploredFiles: scannedFiles.slice(0, 5),
      flaggedFiles: scannedFiles.slice(0, 2),
    });
  });
});
