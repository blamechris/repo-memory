import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTokenReport, type TokenReport } from '../tools/get-token-report.js';

export interface ReportOptions {
  /** Restrict the report to the last N hours (default: all recorded events). */
  hours?: number;
  /** Include cache health diagnostics (entry counts, stale entries, db size). */
  diagnostics?: boolean;
}

/**
 * Read-only telemetry report for a project, sharing getTokenReport with the
 * MCP tool. The point of the CLI form: telemetry *events* are always recorded
 * by the cache paths, but the `get_token_report` MCP tool belongs to the
 * `telemetry` tool group (off by default, ~100 tokens/turn of system prompt
 * when on) — this reads the same data from the shell at zero token cost.
 */
export function runReport(projectRoot: string, options: ReportOptions = {}): TokenReport {
  const root = resolve(projectRoot);
  if (!existsSync(root)) {
    throw new Error(`project root does not exist: ${root}`);
  }
  if (!statSync(root).isDirectory()) {
    throw new Error(`project root is not a directory: ${root}`);
  }
  return getTokenReport(
    root,
    options.hours != null ? 'last_n_hours' : 'all',
    options.hours,
    undefined,
    options.diagnostics,
  );
}

function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatReport(projectRoot: string, report: TokenReport, hours?: number): string {
  const window = hours != null ? `last ${hours}h` : 'all recorded events';
  const ratio =
    report.cacheHits + report.cacheMisses > 0
      ? `${(report.cacheHitRatio * 100).toFixed(1)}%`
      : 'n/a';
  const lines = [
    `Token report for ${resolve(projectRoot)} (${window})`,
    `  events:        ${report.totalEvents} (${report.cacheHits} hits / ${report.cacheMisses} misses, ${ratio} hit ratio)`,
    `  tokens saved:  ~${formatTokens(report.estimatedTokensSaved)}`,
  ];

  const breakdown = Object.entries(report.eventBreakdown)
    .map(([type, count]) => `${type} ${count}`)
    .join(', ');
  if (breakdown) {
    lines.push(`  breakdown:     ${breakdown}`);
  }

  if (report.topFiles.length > 0) {
    lines.push('  top files:');
    for (const file of report.topFiles.slice(0, 5)) {
      lines.push(
        `    ${file.accessCount}x ${file.path} (~${formatTokens(file.tokensEstimated)} tokens)`,
      );
    }
  }

  if (report.diagnostics) {
    const d = report.diagnostics;
    const ages = Object.entries(d.cacheAgeDistribution)
      .filter(([, count]) => count > 0)
      .map(([bucket, count]) => `${bucket}: ${count}`)
      .join(', ');
    lines.push(
      `  cache:         ${d.cacheEntryCount} entries (${d.staleEntryCount} stale >30d), db ${(d.dbFileSizeBytes / 1024 / 1024).toFixed(1)} MB`,
    );
    if (ages) {
      lines.push(`  entry age:     ${ages}`);
    }
  }

  if (report.totalEvents === 0) {
    lines.push('  (no telemetry recorded yet — agent traffic through the MCP server populates this)');
  }

  return lines.join('\n') + '\n';
}

/**
 * Thin argv wrapper for `repo-memory report [projectRoot] [--hours N] [--json] [--diagnostics]`.
 * Exits 0 on success, 1 on error (message to stderr).
 */
export async function runReportCli(argv: string[]): Promise<never> {
  const usage =
    'Usage: repo-memory report [projectRoot] [--hours N] [--json] [--diagnostics]\n';
  let projectRoot: string | undefined;
  let hours: number | undefined;
  let json = false;
  let diagnostics = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--diagnostics') {
      diagnostics = true;
    } else if (arg === '--hours') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        process.stderr.write(`repo-memory report: --hours expects a positive number\n${usage}`);
        process.exit(1);
      }
      hours = value;
    } else if (arg.startsWith('-')) {
      process.stderr.write(`repo-memory report: unknown option '${arg}'\n${usage}`);
      process.exit(1);
    } else if (projectRoot === undefined) {
      projectRoot = arg;
    } else {
      process.stderr.write(`repo-memory report: unexpected argument '${arg}'\n${usage}`);
      process.exit(1);
    }
  }

  try {
    const root = projectRoot ?? process.cwd();
    const report = runReport(root, { hours, diagnostics });
    // stdout is safe here — like `index`, the report command never runs while
    // the MCP stdio transport is active.
    process.stdout.write(
      json ? JSON.stringify(report, null, 2) + '\n' : formatReport(root, report, hours),
    );
    process.exit(0);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`repo-memory report: ${message}\n`);
    process.exit(1);
  }
}
