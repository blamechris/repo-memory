#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getProjectMap } from './tools/get-project-map.js';

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
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          path,
          hash: null,
          summary: null,
          fromCache: false,
          status: 'not_implemented',
          message: 'get_file_summary is not yet implemented. See issue #16.',
        }),
      },
    ],
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
    project_root: z.string().describe('Absolute path to the project root'),
    depth: z.number().optional().describe('Max directory depth to include'),
  },
}, async ({ project_root, depth }) => {
  const projectMap = await getProjectMap(project_root, depth);
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(projectMap),
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
