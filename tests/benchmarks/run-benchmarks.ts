#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Standalone benchmark script for measuring token savings.
 * Run with: npx tsx tests/benchmarks/run-benchmarks.ts
 */

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getFileSummary } from '../../src/tools/get-file-summary.js';
import { getChangedFiles } from '../../src/tools/get-changed-files.js';
import { buildProjectMap } from '../../src/indexer/project-map.js';
import { createTaskTool, markExploredTool } from '../../src/tools/task-context.js';
import { closeDatabase } from '../../src/persistence/db.js';
import { invalidateCache } from '../../src/tools/invalidate.js';
import { scanProject } from '../../src/indexer/scanner.js';
import {
  createBenchmarkFixture,
  generateReport,
  type BenchmarkReport,
} from './benchmark-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getProjectFiles(projectRoot: string): Promise<string[]> {
  return scanProject(projectRoot);
}

function getRawBytes(projectRoot: string, files: string[]): number {
  let total = 0;
  for (const f of files) {
    try {
      const content = readFileSync(join(projectRoot, f));
      total += content.length;
    } catch {
      // skip unreadable files
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Scenario 1: Explore project
// ---------------------------------------------------------------------------

async function scenarioExploreProject(
  projectRoot: string,
  fileCount: number,
): Promise<BenchmarkReport> {
  // Clear any prior cache
  await invalidateCache(projectRoot);

  const files = await getProjectFiles(projectRoot);
  const rawBytes = getRawBytes(projectRoot, files);

  // Build project map (populates cache)
  await buildProjectMap(projectRoot);

  // Then get summary for every file
  let summaryBytes = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const f of files) {
    try {
      const result = await getFileSummary(projectRoot, f);
      summaryBytes += JSON.stringify(result.summary).length;
      if (result.fromCache) {
        cacheHits++;
      } else {
        cacheMisses++;
      }
    } catch {
      // skip
    }
  }

  const saved = rawBytes - summaryBytes;

  return {
    scenario: 'Explore project',
    fileCount,
    rawBytes,
    summaryBytes,
    compressionRatio: summaryBytes > 0 ? rawBytes / summaryBytes : 0,
    cacheHits,
    cacheMisses,
    hitRatio: cacheHits + cacheMisses > 0 ? cacheHits / (cacheHits + cacheMisses) : 0,
    estimatedTokensSaved: Math.floor(saved / 4),
  };
}

// ---------------------------------------------------------------------------
// Scenario 2: Investigate bug — task-based exploration
// ---------------------------------------------------------------------------

async function scenarioInvestigateBug(
  projectRoot: string,
  fileCount: number,
): Promise<BenchmarkReport> {
  await invalidateCache(projectRoot);

  const files = await getProjectFiles(projectRoot);
  void getRawBytes(projectRoot, files);

  // Create a task
  const task = createTaskTool(projectRoot, 'Investigate bug #42');

  let summaryBytes = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  // Explore files following a simulated dependency chain
  // Walk through ~60% of files, requesting summaries and marking explored
  const explorationCount = Math.ceil(files.length * 0.6);
  for (let i = 0; i < explorationCount; i++) {
    const f = files[i];
    try {
      const result = await getFileSummary(projectRoot, f);
      summaryBytes += JSON.stringify(result.summary).length;
      if (result.fromCache) {
        cacheHits++;
      } else {
        cacheMisses++;
      }
      markExploredTool(projectRoot, task.id, f, 'explored', 'checked for bug');
    } catch {
      // skip
    }
  }

  // Re-visit some files (simulates going back to check suspects) — these should be cache hits
  const revisitCount = Math.min(5, explorationCount);
  for (let i = 0; i < revisitCount; i++) {
    const f = files[i];
    try {
      const result = await getFileSummary(projectRoot, f);
      summaryBytes += JSON.stringify(result.summary).length;
      if (result.fromCache) {
        cacheHits++;
      } else {
        cacheMisses++;
      }
    } catch {
      // skip
    }
  }

  const totalSummaryRequests = explorationCount + revisitCount;
  const rawBytesForExplored = getRawBytes(
    projectRoot,
    files.slice(0, explorationCount),
  );
  // Raw bytes includes revisits: the agent would re-read those files without cache
  const rawBytesWithRevisits =
    rawBytesForExplored + getRawBytes(projectRoot, files.slice(0, revisitCount));

  const saved = rawBytesWithRevisits - summaryBytes;

  return {
    scenario: 'Investigate bug',
    fileCount,
    rawBytes: rawBytesWithRevisits,
    summaryBytes,
    compressionRatio: summaryBytes > 0 ? rawBytesWithRevisits / summaryBytes : 0,
    cacheHits,
    cacheMisses,
    hitRatio:
      totalSummaryRequests > 0 ? cacheHits / totalSummaryRequests : 0,
    estimatedTokensSaved: Math.floor(saved / 4),
  };
}

// ---------------------------------------------------------------------------
// Scenario 3: Incremental change
// ---------------------------------------------------------------------------

async function scenarioIncrementalChange(
  projectRoot: string,
  fileCount: number,
): Promise<BenchmarkReport> {
  await invalidateCache(projectRoot);

  const files = await getProjectFiles(projectRoot);
  const rawBytes = getRawBytes(projectRoot, files);

  // Build cache for all files first
  for (const f of files) {
    try {
      await getFileSummary(projectRoot, f);
    } catch {
      // skip
    }
  }

  // Modify one file to simulate a change
  const targetFile = files[0];
  const targetPath = join(projectRoot, targetFile);
  const original = readFileSync(targetPath, 'utf-8');
  const modified = original + '\n// Modified for benchmark\nexport const BENCHMARK_FLAG = true;\n';
  const { writeFileSync } = await import('node:fs');
  writeFileSync(targetPath, modified, 'utf-8');

  // Now detect changes
  await getChangedFiles(projectRoot);

  // Get summaries — most should be cache hits except the changed file
  let summaryBytes = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const f of files) {
    try {
      const result = await getFileSummary(projectRoot, f);
      summaryBytes += JSON.stringify(result.summary).length;
      if (result.fromCache) {
        cacheHits++;
      } else {
        cacheMisses++;
      }
    } catch {
      // skip
    }
  }

  const saved = rawBytes - summaryBytes;

  return {
    scenario: 'Incremental change',
    fileCount,
    rawBytes,
    summaryBytes,
    compressionRatio: summaryBytes > 0 ? rawBytes / summaryBytes : 0,
    cacheHits,
    cacheMisses,
    hitRatio: cacheHits + cacheMisses > 0 ? cacheHits / (cacheHits + cacheMisses) : 0,
    estimatedTokensSaved: Math.floor(saved / 4),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const sizes = [
    { label: 'small', count: 10 },
    { label: 'medium', count: 50 },
    { label: 'large', count: 100 },
    { label: 'xlarge', count: 200 },
  ];

  const reports: BenchmarkReport[] = [];
  const fixtures: string[] = [];

  console.log('repo-memory benchmark: measuring token savings vs baseline\n');

  for (const size of sizes) {
    console.log(`--- ${size.label} project (${size.count} files) ---`);

    const fixtureDir = createBenchmarkFixture(size.count);
    fixtures.push(fixtureDir);

    console.log(`  Fixture created at: ${fixtureDir}`);

    // Run scenarios
    console.log('  Running: Explore project...');
    {
      const start = performance.now();
      const report = await scenarioExploreProject(fixtureDir, size.count);
      report.durationMs = Math.round(performance.now() - start);
      reports.push(report);
    }
    closeDatabase();

    console.log('  Running: Investigate bug...');
    {
      const start = performance.now();
      const report = await scenarioInvestigateBug(fixtureDir, size.count);
      report.durationMs = Math.round(performance.now() - start);
      reports.push(report);
    }
    closeDatabase();

    console.log('  Running: Incremental change...');
    {
      const start = performance.now();
      const report = await scenarioIncrementalChange(fixtureDir, size.count);
      report.durationMs = Math.round(performance.now() - start);
      reports.push(report);
    }
    closeDatabase();

    console.log('');
  }

  // Print results
  const report = generateReport(reports);
  console.log(report);

  // Cleanup
  for (const dir of fixtures) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      console.warn(`Warning: could not clean up ${dir}`);
    }
  }
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  closeDatabase();
  process.exit(1);
});
