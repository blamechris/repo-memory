#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { z } from 'zod';
import { getFileSummary } from './tools/get-file-summary.js';
import { getChangedFiles } from './tools/get-changed-files.js';
import { getProjectMap } from './tools/get-project-map.js';
import { forceReread } from './tools/force-reread.js';
import { invalidateCache } from './tools/invalidate.js';
import { getDependencyGraphTool } from './tools/get-dependency-graph.js';
import { createTaskTool, getTaskContext, markExploredTool } from './tools/task-context.js';
import { getTokenReport } from './tools/get-token-report.js';
import { getRelatedFiles } from './tools/get-related-files.js';
import { batchFileSummaries } from './tools/batch-file-summaries.js';
import { searchByPurpose } from './tools/search-by-purpose.js';
import { runGC } from './cache/gc.js';
import { SessionManager } from './memory/session.js';
import { loadConfig, type RepoMemoryConfig } from './config.js';

// Read the version from package.json so the MCP serverInfo never drifts from the
// published version. dist/server.js -> ../package.json; src/server.ts -> ../package.json.
const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8'),
) as { version: string };

const server = new McpServer({
  name: 'repo-memory',
  version: pkg.version,
});

function registerTools(server: McpServer, config: RepoMemoryConfig): void {
  // === NAVIGATION GROUP (always on) ===

  server.registerTool('get_project_map', {
    title: 'Get Project Map',
    description:
      'Returns a structural overview of the project including directory tree, entry points, and key modules. Depth defaults to 2; pass a larger depth only when you need deeper structure.',
    inputSchema: {
      project_root: z
        .string()
        .optional()
        .describe('Absolute path to the project root (default: current working directory)'),
      depth: z.number().optional().describe('Max directory depth to include (default: 2)'),
    },
  }, async ({ project_root, depth }) => {
    const projectMap = await getProjectMap(project_root ?? process.cwd(), depth);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(projectMap) }],
    };
  });

  server.registerTool('get_related_files', {
    title: 'Get Related Files',
    description:
      'Returns files related to the given file, ranked by dependency proximity and relevance. One call replaces grepping for imports and grepping for usages separately.',
    inputSchema: {
      path: z.string().describe('File path relative to project root'),
      limit: z.number().optional().describe('Max results (default: 10)'),
      task_id: z.string().optional().describe('Task ID for context-aware ranking'),
    },
  }, async ({ path, limit, task_id }) => {
    const projectRoot = process.cwd();
    const result = await getRelatedFiles(projectRoot, path, { limit, taskId: task_id });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    };
  });

  server.registerTool('get_dependency_graph', {
    title: 'Get Dependency Graph',
    description:
      'Returns dependency graph information as adjacency maps. If a path is given, returns its dependencies/dependents. Calling without a path returns a large whole-repo summary of the most connected files — prefer passing a path.',
    inputSchema: {
      path: z.string().optional().describe('File path to query; omit only when you want a whole-repo summary'),
      direction: z
        .enum(['dependencies', 'dependents', 'both'])
        .optional()
        .describe('Query direction (default: both)'),
      depth: z.number().optional().describe('Max traversal depth'),
      symbol: z.string().optional().describe('Filter edges by import specifier (e.g., "UserService")'),
      limit: z
        .number()
        .optional()
        .describe('No-path summary mode only: max files included (default: 50)'),
    },
  }, async ({ path, direction, depth, symbol, limit }) => {
    const projectRoot = process.cwd();
    const result = await getDependencyGraphTool(projectRoot, path, direction, depth, symbol, limit);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    };
  });

  server.registerTool('get_changed_files', {
    title: 'Get Changed Files',
    description:
      'Returns files that have changed since the last check. Compares current file hashes against cached hashes.',
    inputSchema: {
      since: z.string().optional().describe('ISO timestamp or "last_check"'),
    },
  }, async ({ since }) => {
    const projectRoot = process.cwd();
    const result = await getChangedFiles(projectRoot, since);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    };
  });

  // === SUMMARIES GROUP (on by default — the core feature; disable with "tools": { "summaries": false }) ===
  if (config.tools?.summaries !== false) {
    server.registerTool('get_file_summary', {
      title: 'Get File Summary',
      description:
        'Returns a cached summary of a file. If the file has not changed since last read, returns the cached summary without re-reading. Use this instead of reading files directly to save tokens.',
      inputSchema: {
        path: z.string().describe('File path relative to project root'),
      },
    }, async ({ path }) => {
      try {
        const projectRoot = process.cwd();
        const result = await getFileSummary(projectRoot, path);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const isNotFound =
          error instanceof Error && 'code' in error && error.code === 'ENOENT';
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: isNotFound ? 'file_not_found' : 'internal_error',
                message,
                path,
              }),
            },
          ],
          isError: true,
        };
      }
    });

    server.registerTool('batch_file_summaries', {
      title: 'Batch File Summaries',
      description: 'Get cached summaries for multiple files in one call. More efficient than calling get_file_summary repeatedly.',
      inputSchema: {
        paths: z.array(z.string()).describe('Array of file paths relative to project root'),
      },
    }, async ({ paths }) => {
      const projectRoot = process.cwd();
      const result = await batchFileSummaries(projectRoot, paths);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    });

    server.registerTool('force_reread', {
      title: 'Force Re-read',
      description:
        'Re-reads a file from disk, generates a fresh summary, and updates the cache. Use when you know a file has changed or want guaranteed-fresh data.',
      inputSchema: {
        path: z.string().describe('File path relative to project root'),
      },
    }, async ({ path }) => {
      const projectRoot = process.cwd();
      const result = await forceReread(projectRoot, path);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    });

    server.registerTool('search_by_purpose', {
      title: 'Search By Purpose',
      description: 'Find files by what they do when you don\'t know filenames — prefer this over grep for concept searches ("where is auth handled"). Matches whole words in file purpose, exports, declarations, and path segments (camelCase/snake_case split, so "store" finds CacheStore). Check totalCached > 0 in the response; if 0, warm the cache with `repo-memory index` first. Optionally scope to a directory with pathPrefix.',
      inputSchema: {
        query: z.string().describe('Search keywords (e.g., "database", "auth middleware", "validation")'),
        limit: z.number().optional().describe('Max results (default: 20)'),
        pathPrefix: z.string().optional().describe('Restrict results to files at or under this path (e.g., "src/cache")'),
      },
    }, async ({ query, limit, pathPrefix }) => {
      const projectRoot = process.cwd();
      const result = await searchByPurpose(projectRoot, query, limit, pathPrefix);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    });

    server.registerTool('invalidate', {
      title: 'Invalidate Cache',
      description:
        'Invalidates cached entries. If a path is provided, only that entry is removed. If no path is provided, all entries are removed.',
      inputSchema: {
        path: z.string().optional().describe('File path to invalidate, or omit to invalidate all'),
      },
    }, async ({ path }) => {
      const projectRoot = process.cwd();
      const result = await invalidateCache(projectRoot, path);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    });
  }

  // === TASKS GROUP (off by default) ===
  if (config.tools?.tasks) {
    server.registerTool('create_task', {
      title: 'Create Task',
      description: 'Creates a new investigation task for tracking file exploration.',
      inputSchema: {
        name: z.string().describe('Human-readable task name'),
      },
    }, async ({ name }) => {
      const projectRoot = process.cwd();
      const task = createTaskTool(projectRoot, name);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(task) }],
      };
    });

    server.registerTool('get_task_context', {
      title: 'Get Task Context',
      description:
        'Returns task state, explored files, and frontier. If no task_id, returns list of all tasks.',
      inputSchema: {
        task_id: z.string().optional().describe('Task ID to query, or omit to list all tasks'),
      },
    }, async ({ task_id }) => {
      const projectRoot = process.cwd();
      const result = getTaskContext(projectRoot, task_id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    });

    server.registerTool('mark_explored', {
      title: 'Mark Explored',
      description: 'Marks a file as explored for a task, with optional status and notes.',
      inputSchema: {
        task_id: z.string().describe('Task ID'),
        path: z.string().describe('File path relative to project root'),
        status: z
          .enum(['explored', 'skipped', 'flagged'])
          .optional()
          .describe('Exploration status (default: explored)'),
        notes: z.string().optional().describe('Optional notes about the file'),
      },
    }, async ({ task_id, path, status, notes }) => {
      const projectRoot = process.cwd();
      const result = markExploredTool(projectRoot, task_id, path, status, notes);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    });
  }

  // === TELEMETRY GROUP (off by default) ===
  if (config.tools?.telemetry) {
    server.registerTool('get_token_report', {
      title: 'Get Token Report',
      description:
        'Get aggregated token usage telemetry report showing cache efficiency and token savings',
      inputSchema: {
        period: z
          .enum(['session', 'all', 'last_n_hours'])
          .optional()
          .describe('Time period for the report'),
        hours: z
          .number()
          .optional()
          .describe('Number of hours to look back (only for last_n_hours period)'),
        session_id: z
          .string()
          .optional()
          .describe('Session ID (only for session period)'),
        include_diagnostics: z
          .boolean()
          .optional()
          .describe('Include cache health diagnostics'),
      },
    }, async ({ period, hours, session_id, include_diagnostics }) => {
      const projectRoot = process.cwd();
      const report = getTokenReport(projectRoot, period, hours, session_id, include_diagnostics);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
      };
    });
  }
}

async function main() {
  const projectRoot = process.cwd();

  // Load config before tool registration
  const config = loadConfig(projectRoot);

  // Register tools based on config
  registerTools(server, config);

  // Connect transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log enabled tool groups
  const enabledGroups = ['navigation'];
  if (config.tools?.summaries !== false) enabledGroups.push('summaries');
  if (config.tools?.tasks) enabledGroups.push('tasks');
  if (config.tools?.telemetry) enabledGroups.push('telemetry');
  process.stderr.write(`Tool groups: ${enabledGroups.join(', ')}\n`);

  // Auto-start session
  const sessionManager = new SessionManager(projectRoot);
  const session = sessionManager.startSession({ source: 'mcp-connect' });
  process.stderr.write(`Session started: ${session.id}\n`);

  // End session on exit
  const cleanup = () => {
    try {
      sessionManager.endSession(session.id);
    } catch {
      // ignore errors during cleanup
    }
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('beforeExit', cleanup);

  // Run GC in background on startup (non-blocking)
  runGC(projectRoot, config.gc).catch((err) => {
    process.stderr.write(`GC warning: ${err instanceof Error ? err.message : String(err)}\n`);
  });
}

// Subcommand dispatch: `repo-memory index [projectRoot]` prewarms the summary
// cache and exits; `repo-memory report [projectRoot]` prints the telemetry
// report and exits. Anything else starts the MCP server on stdio, where
// stdout is reserved for the protocol channel.
if (process.argv[2] === 'index') {
  const { runIndexCli } = await import('./cli/index-command.js');
  await runIndexCli(process.argv.slice(3));
} else if (process.argv[2] === 'report') {
  const { runReportCli } = await import('./cli/report-command.js');
  await runReportCli(process.argv.slice(3));
} else {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`Fatal error: ${message}\n`);
    process.exit(1);
  });
}
