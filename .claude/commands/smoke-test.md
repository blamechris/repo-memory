# /smoke-test

Run an automated smoke test of the repo-memory MCP server. repo-memory is a HEADLESS MCP server over stdio — there is NO browser/UI. This skill builds the server, spawns `node dist/server.js`, performs an MCP `initialize` handshake over stdio, asserts the `serverInfo` response (name `repo-memory`), then lists the registered tools, and reports pass/fail results.

## Arguments

- `$ARGUMENTS` - Optional flags:
  - `--keep-screenshots` — No effect (headless server emits no screenshots); accepted for compatibility
  - If empty, runs the headless stdio handshake

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
# then request tools/list. Pipes two JSON-RPC lines into the server's stdin and inspects stdout.
node dist/server.js <<'JSONRPC' | node scripts/check-smoke.mjs
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
JSONRPC
```

The test script should:
- Spawn the running application (`node dist/server.js`) and write JSON-RPC over stdin
- Perform the MCP `initialize` handshake and `tools/list` flow
- Capture each JSON-RPC response line from stdout
- Output PASS/FAIL for each check
- Exit 0 (all pass) or 1 (failures)

### 3. Read Screenshots

This is a headless stdio server: there are no screenshots and no visual surface to inspect. Instead, read each captured JSON-RPC response line from stdout and verify it semantically:

- Confirm the `initialize` result reports `serverInfo.name === "repo-memory"` and a `protocolVersion`
- Confirm `tools/list` returns a non-empty `tools` array with the expected tool names (e.g. `get_project_map`, `get_file_summary`, `get_changed_files`)
- Note any JSON-RPC `error` objects or missing fields the automated checks might have missed

### 4. Report Results

Output a summary table:

```markdown
## Smoke Test Results

| # | Check | Status | Notes |
|---|-------|--------|-------|
| 1 | App loads | PASS | HTTP 200, no console errors |
| 2 | Feature X visible | PASS | — |
| 3 | Feature Y works | FAIL | Element not found |

**Screenshots reviewed:** N
**Visual issues found:** M (describe any issues)

If the smoke test is currently scaffolding (no `scripts/check-smoke.mjs` yet), create it per the patterns below and add `dist/` is already gitignored — no extra cleanup needed.
```

### 5. Cleanup

```bash
# The spawned `node dist/server.js` exits when stdin closes, so there is no long-lived
# process or screenshot directory to clean up. Nothing to remove.
true
```

If the application was started by this skill (not already running), stop it.

## Writing the Smoke Test Script

If the test script doesn't exist yet, create it following these patterns:

### Script Structure

```javascript
/**
 * Smoke Test — MCP stdio handshake verification for the repo-memory server.
 *
 * Prerequisites: server built to dist/server.js (npm run build).
 * Reads JSON-RPC response lines from the server's stdout (no screenshots — headless stdio).
 */

import { spawn } from 'node:child_process'
// ... setup

async function run() {
  // 1. Spawn `node dist/server.js` with piped stdin/stdout
  // 2. Write the MCP `initialize` request as a JSON-RPC line to stdin
  // 3. Write the `notifications/initialized` notification, then `tools/list`
  // 4. Wait for the server to emit the matching JSON-RPC response lines
  // 5. Run checks — each one:
  //    a. Parse the next JSON-RPC response line from stdout
  //    b. (no screenshot — headless server)
  //    c. Assert result fields (serverInfo.name === "repo-memory", tools[] non-empty)
  //    d. Log PASS or FAIL
  // 6. Output summary
  // 7. Exit with appropriate code
}
```

### Check Patterns

Each check should:
1. **Act** — Navigate, click, type
2. **Screenshot** — Capture current state
3. **Assert** — Verify expected elements/content
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

### Selector Strategy

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

1. **Never send real messages** — Smoke tests verify UI, not backend processing. Don't submit forms that trigger expensive operations.
2. **Screenshots are temporary** — Always clean up unless `--keep-screenshots`. Add the directory to `.gitignore`.
3. **Fail fast on no connection** — If the app isn't running or can't connect, report immediately instead of running checks that will all fail.
4. **Stable selectors** — Use aria labels and roles, not brittle CSS class names that change with refactors.
5. **Visual verification is the point** — The automated checks catch DOM presence. Reading screenshots catches visual regressions (z-index, color, spacing).
6. **Idempotent** — Safe to run repeatedly. Don't create persistent state (sessions, data, etc.) that would affect the next run.

## Customization Notes

repo-memory has no `deploy.sh`. The "application" under test is the MCP server entry point `dist/server.js` (built from `src/server.ts` via `npm run build`); it speaks JSON-RPC over stdio with no HTTP/URL/browser surface. The smoke flow is build → spawn → `initialize` → `tools/list`. The repo's Zero Attribution Policy applies: never add co-author trailers, AI-generation footers, or any mention of AI assistance to commits, PRs, scaffolded scripts, or this file — the user is the sole author.

<!-- skill-templates: smoke-test 21fa678 2026-06-08 -->
