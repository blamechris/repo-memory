import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanProject } from '../indexer/scanner.js';
import { ensureSummaryGeneration } from '../indexer/summarize.js';
import { getDatabasePath } from '../persistence/db.js';
import { getFileSummary } from '../tools/get-file-summary.js';

export interface IndexOptions {
  /** Suppress the human-readable report printed to stdout. */
  quiet?: boolean;
}

export interface IndexReport {
  projectRoot: string;
  cacheDbPath: string;
  scanned: number;
  summarized: number;
  fresh: number;
  skipped: number;
  skippedPaths: string[];
  elapsedMs: number;
}

/**
 * Prewarm the summary cache for a project: scan all indexable files and run
 * each one through the same hash/compare/summarize/store path the
 * `get_file_summary` tool uses, so a later MCP session starts with cache hits.
 *
 * Files whose hash already matches the cache are left untouched ("fresh");
 * files that cannot be read or summarized are counted as skipped rather than
 * aborting the run.
 */
export async function runIndex(
  projectRoot: string,
  options: IndexOptions = {},
): Promise<IndexReport> {
  const root = resolve(projectRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`project root does not exist or is not a directory: ${root}`);
  }

  const started = Date.now();

  // Verify cached summaries match the configured summarizer mode/generation
  // before any cache comparisons happen.
  ensureSummaryGeneration(root);

  const files = await scanProject(root);

  let summarized = 0;
  let fresh = 0;
  const skippedPaths: string[] = [];

  for (const file of files) {
    try {
      // Reuses the exact cache-read/write semantics of the get_file_summary
      // tool: hash, compare, regenerate only when missing/stale. Telemetry is
      // suppressed — prewarm traffic isn't agent traffic and would distort
      // hit-ratio stats.
      const result = await getFileSummary(root, file, { trackTelemetry: false });
      if (result.fromCache) {
        fresh += 1;
      } else {
        summarized += 1;
      }
    } catch {
      // Unreadable entries (deleted since scan, gitlinks, permission errors).
      skippedPaths.push(file);
    }
  }

  const report: IndexReport = {
    projectRoot: root,
    cacheDbPath: getDatabasePath(root),
    scanned: files.length,
    summarized,
    fresh,
    skipped: skippedPaths.length,
    skippedPaths,
    elapsedMs: Date.now() - started,
  };

  if (!options.quiet) {
    // stdout is safe here — the index command never runs while the MCP stdio
    // transport is active, so this cannot corrupt the protocol channel.
    process.stdout.write(formatReport(report));
  }

  return report;
}

function formatReport(report: IndexReport): string {
  const lines = [
    `Indexed ${report.projectRoot}`,
    `  scanned:       ${report.scanned}`,
    `  summarized:    ${report.summarized}`,
    `  already fresh: ${report.fresh}`,
    `  skipped:       ${report.skipped}`,
    `  elapsed:       ${(report.elapsedMs / 1000).toFixed(2)}s`,
    `  cache db:      ${report.cacheDbPath}`,
  ];
  return lines.join('\n') + '\n';
}

/**
 * Thin argv wrapper for `repo-memory index [projectRoot] [--quiet]`.
 * Exits 0 on success, 1 on error (message to stderr).
 */
export async function runIndexCli(argv: string[]): Promise<never> {
  let quiet = false;
  let projectRoot: string | undefined;

  for (const arg of argv) {
    if (arg === '--quiet' || arg === '-q') {
      quiet = true;
    } else if (arg.startsWith('-')) {
      process.stderr.write(`repo-memory index: unknown option '${arg}'\n`);
      process.stderr.write('Usage: repo-memory index [projectRoot] [--quiet]\n');
      process.exit(1);
    } else if (projectRoot === undefined) {
      projectRoot = arg;
    } else {
      process.stderr.write(`repo-memory index: unexpected argument '${arg}'\n`);
      process.stderr.write('Usage: repo-memory index [projectRoot] [--quiet]\n');
      process.exit(1);
    }
  }

  try {
    await runIndex(projectRoot ?? process.cwd(), { quiet });
    process.exit(0);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`repo-memory index: ${message}\n`);
    process.exit(1);
  }
}
