#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getFileSummary } from './tools/get-file-summary.js';

const server = new McpServer({
  name: 'repo-memory',
  version: '0.1.0',
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
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          changed: [],
          added: [],
          deleted: [],
          checkedAt: new Date().toISOString(),
          status: 'not_implemented',
          message: 'get_changed_files is not yet implemented. See issue #18.',
          since: since ?? 'last_check',
        }),
      },
    ],
  };
});

server.registerTool('get_project_map', {
  title: 'Get Project Map',
  description:
    'Returns a structural overview of the project including directory tree, entry points, and key modules.',
  inputSchema: {
    depth: z.number().optional().describe('Max directory depth to include'),
  },
}, async ({ depth }) => {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          tree: null,
          entryPoints: [],
          totalFiles: 0,
          status: 'not_implemented',
          message: 'get_project_map is not yet implemented. See issue #21.',
          depth: depth ?? null,
        }),
      },
    ],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Fatal error: ${message}\n`);
  process.exit(1);
});
