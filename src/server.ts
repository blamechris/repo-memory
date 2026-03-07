#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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

const server = new McpServer({
  name: 'repo-memory',
  version: '0.2.0',
});

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

server.registerTool('get_project_map', {
  title: 'Get Project Map',
  description:
    'Returns a structural overview of the project including directory tree, entry points, and key modules.',
  inputSchema: {
    project_root: z.string().describe('Absolute path to the project root'),
    depth: z.number().optional().describe('Max directory depth to include'),
  },
}, async ({ project_root, depth }) => {
  const projectMap = await getProjectMap(project_root, depth);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(projectMap) }],
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

server.registerTool('get_dependency_graph', {
  title: 'Get Dependency Graph',
  description:
    'Returns dependency graph information. If a path is given, returns its dependencies/dependents. If no path, returns a summary of the most connected files.',
  inputSchema: {
    path: z.string().optional().describe('File path to query, or omit for full graph summary'),
    direction: z
      .enum(['dependencies', 'dependents', 'both'])
      .optional()
      .describe('Query direction (default: both)'),
    depth: z.number().optional().describe('Max traversal depth'),
    symbol: z.string().optional().describe('Filter edges by import specifier (e.g., "UserService")'),
  },
}, async ({ path, direction, depth, symbol }) => {
  const projectRoot = process.cwd();
  const result = await getDependencyGraphTool(projectRoot, path, direction, depth, symbol);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
  };
});

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
  },
}, async ({ period, hours, session_id }) => {
  const projectRoot = process.cwd();
  const report = getTokenReport(projectRoot, period, hours, session_id);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
  };
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

server.registerTool('get_related_files', {
  title: 'Get Related Files',
  description:
    'Returns files related to the given file, ranked by dependency proximity and relevance. Useful for finding what else to look at when exploring a file.',
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

server.registerTool('search_by_purpose', {
  title: 'Search By Purpose',
  description: 'Search cached file summaries by keyword. Matches against file purpose, exports, and declarations. Requires files to have been previously summarized.',
  inputSchema: {
    query: z.string().describe('Search keywords (e.g., "database", "auth middleware", "validation")'),
    limit: z.number().optional().describe('Max results (default: 20)'),
  },
}, async ({ query, limit }) => {
  const projectRoot = process.cwd();
  const result = searchByPurpose(projectRoot, query, limit);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const projectRoot = process.cwd();

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
  runGC(projectRoot).catch((err) => {
    process.stderr.write(`GC warning: ${err instanceof Error ? err.message : String(err)}\n`);
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Fatal error: ${message}\n`);
  process.exit(1);
});
