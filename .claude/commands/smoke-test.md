# /smoke-test

Run an automated smoke test of the repo-memory MCP server. repo-memory is a HEADLESS MCP server over stdio — there is NO browser/UI. This skill builds the server, spawns `node dist/server.js`, performs an MCP `initialize` handshake over stdio, asserts the `serverInfo` response (name `repo-memory`), then lists the registered tools, and reports pass/fail results.

## Arguments

- `$ARGUMENTS` - Optional flags:
  - `--list-only` — Run the `initialize` handshake plus `tools/list` and print the registered tool names without further assertions
  - If empty, runs the full headless stdio handshake and all checks

## Instructions

### 0. Prerequisites

Verify the server is built and dependencies are installed:

```bash
# Build the server (compiles src → dist) and ensure deps are present
npm install
npm run build
# Confirm the stdio entry point exists
test -f dist/server.js && echo "dist/server.js present" || { echo "MISSING dist/server.js — run 'npm run build'"; exit 1; }
```

### 1. Ensure Application is Running

The MCP server is a short-lived stdio process — the smoke test spawns its own instance per run rather than connecting to a long-running one. No detection or pre-start step is needed:

```bash
# Sanity-check that the entry point launches without crashing on startup.
# The server reads JSON-RPC from stdin and exits when stdin closes (</dev/null).
node dist/server.js </dev/null >/dev/null 2>&1; echo "exit: $?"
```

### 2. Run the Smoke Test

```bash
# Send an MCP `initialize` request over stdio and assert serverInfo.name === "repo-memory",
# then request tools/list. Pipes three JSON-RPC messages (initialize, the
# notifications/initialized notification, and tools/list) into the server's stdin
# and inspects the response lines on stdout.
node dist/server.js <<'JSONRPC' | node scripts/check-smoke.mjs
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
JSONRPC
```

In the pipeline above, `node dist/server.js` is started by the shell and the
heredoc feeds it stdin; `scripts/check-smoke.mjs` consumes the server's stdout.
So the checker script should:
- Read JSON-RPC response lines from stdin (the server's stdout, piped in)
- Parse each line and match responses to request `id`s (the `initialize` result, then the `tools/list` result)
- Assert the expected fields for each check
- Output PASS/FAIL for each check
- Exit 0 (all pass) or 1 (failures)

### 3. Inspect the JSON-RPC Responses

This is a headless stdio server: there is no visual surface to inspect, only the JSON-RPC stream. Read each captured JSON-RPC response line from stdout and verify it semantically:

- Confirm the `initialize` result reports `serverInfo.name === "repo-memory"` and a `protocolVersion`
- Confirm `tools/list` returns a non-empty `tools` array with the expected tool names (e.g. `get_project_map`, `get_file_summary`, `get_changed_files`)
- Note any JSON-RPC `error` objects or missing fields the automated checks might have missed

### 4. Report Results

Output a summary table:

```markdown
## Smoke Test Results

| # | Check | Status | Notes |
|---|-------|--------|-------|
| 1 | Process starts | PASS | `node dist/server.js` boots, no crash |
| 2 | `initialize` handshake | PASS | `serverInfo.name === "repo-memory"` |
| 3 | `tools/list` | FAIL | empty `tools` array |

**JSON-RPC responses inspected:** N
**Protocol issues found:** M (describe any `error` objects or missing fields)
```

If the smoke test is currently scaffolding (no `scripts/check-smoke.mjs` yet), create the checker script per the patterns below. Run `mkdir -p scripts` first, since the repo has no `scripts/` directory yet. No extra cleanup is needed: `dist/` is already gitignored and the spawned server exits when stdin closes.

### 5. Cleanup

```bash
# The spawned `node dist/server.js` exits when stdin closes, so there is no long-lived
# process and no artifacts to clean up. Nothing to remove.
true
```

The server process terminates on its own when the heredoc/stdin closes, so there is nothing to stop.

## Writing the Smoke Test Script

If the test script doesn't exist yet, create it following these patterns:

### Script Structure

```javascript
/**
 * Smoke Test — MCP stdio handshake verification for the repo-memory server.
 *
 * Prerequisites: server built to dist/server.js (npm run build).
 * Reads JSON-RPC response lines from the server's stdout (headless stdio — no visual surface).
 */

import { spawn } from 'node:child_process'
// ... setup

async function run() {
  // 1. Spawn `node dist/server.js` with piped stdin/stdout
  // 2. Write the MCP `initialize` request as a JSON-RPC line to stdin
  // 3. Write the `notifications/initialized` notification, then `tools/list`
  // 4. Wait for the server to emit the matching JSON-RPC response lines
  // 5. Run checks — each one:
  //    a. Parse the next JSON-RPC response line from stdout (match by request id)
  //    b. Assert result fields (serverInfo.name === "repo-memory", tools[] non-empty)
  //    c. Log PASS or FAIL
  // 6. Output summary
  // 7. Exit with appropriate code
}
```

### Check Patterns

Each check should:
1. **Send** — Write a JSON-RPC request line to the server's stdin
2. **Receive** — Read the matching JSON-RPC response line from stdout (match by request `id`)
3. **Assert** — Verify the expected `result` fields (no `error` object)
4. **Report** — Log PASS/FAIL with details

```javascript
// Example: Check the MCP initialize handshake returns the expected serverInfo
child.stdin.write(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-test', version: '0.0.0' } },
}) + '\n')

const res = await nextResponse(child) // parse next JSON-RPC line from stdout
if (res?.result?.serverInfo?.name === 'repo-memory') {
  pass('initialize handshake')
} else {
  fail('initialize handshake', `unexpected serverInfo: ${JSON.stringify(res?.result?.serverInfo)}`)
}
```

### Assertion Strategy

Prefer stable assertions in this order:
1. JSON-RPC `result` fields by name (`serverInfo.name`, `protocolVersion`, `tools[].name`)
2. Presence of a `result` (not an `error`) for a given request `id`
3. Tool names matching registered handlers (`get_project_map`, `get_file_summary`, …)
4. Raw stdout substring match (last resort — fragile)

### Connection Handling

The MCP server is ready as soon as it responds to `initialize` — there is no separate backend connection. Always wait for the `initialize` result before issuing further requests:

```javascript
// Wait for the server to answer the initialize request before sending tools/list
await waitForResponse(child, (msg) => msg.id === 1 && msg.result?.serverInfo)
```

## Test Categories

Organize checks into logical groups:

- **Process startup** — `node dist/server.js` launches and stays alive on stdin, no crash on boot.
- **MCP handshake** — `initialize` returns a `result` with `protocolVersion` and `serverInfo.name === "repo-memory"`.
- **Tool registration** — `tools/list` returns a non-empty `tools` array including core navigation tools (`get_project_map`, `get_file_summary`, `get_changed_files`).
- **Error hygiene** — no JSON-RPC `error` objects for valid requests; clean shutdown when stdin closes.

## Critical Rules

1. **Side-effect free** — The smoke test only performs the read-only `initialize` and `tools/list` handshake. Never invoke tools that mutate the cache DB or touch the filesystem of the project under test.
2. **No persistent artifacts** — The spawned server exits when stdin closes; there is nothing to clean up. Don't write logs, caches, or temp files that would survive the run.
3. **Fail fast on a bad handshake** — If `initialize` returns an `error` or the server crashes on boot, report immediately instead of running checks that will all fail.
4. **Stable assertions** — Assert on JSON-RPC `result` fields by name (`serverInfo.name`, `tools[].name`), not on raw stdout substrings that shift with formatting.
5. **Reject non-JSON stdout** — A clean stdio MCP server emits only JSON-RPC lines on stdout. Any non-JSON line (stray log, debug print) is a failure: the protocol stream must stay parseable.
6. **Idempotent** — Safe to run repeatedly. Each run spawns a fresh server instance and creates no persistent state that would affect the next run.

## Customization Notes

repo-memory has no `deploy.sh`. The "application" under test is the MCP server entry point `dist/server.js` (built from `src/server.ts` via `npm run build`); it speaks JSON-RPC over stdio with no HTTP/URL/browser surface. The smoke flow is build → spawn → `initialize` → `tools/list`. The repo's Zero Attribution Policy applies: never add co-author trailers, AI-generation footers, or any mention of AI assistance to commits, PRs, scaffolded scripts, or this file — the user is the sole author.

<!-- skill-templates: smoke-test 21fa678 2026-06-08 -->
