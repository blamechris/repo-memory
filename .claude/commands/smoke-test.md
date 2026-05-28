# /smoke-test

Run an automated visual smoke test of the application using Playwright. Launches a headless browser, navigates through key UI flows, takes screenshots, and reports pass/fail results.

## Arguments

- `$ARGUMENTS` - Optional flags:
  - `--headed` — Show the browser window (useful for debugging)
  - `--keep-screenshots` — Don't clean up screenshots after the run
  - If empty, runs headless and cleans up screenshots

## Instructions

### 0. Prerequisites

Verify Playwright is installed and the test script exists:

```bash
# Check Playwright is available
node -e "require('playwright')" 2>/dev/null || {
  echo "Installing Playwright..."
  npm install --save-dev playwright
  npx playwright install chromium
}

# Check smoke test script exists
test -f scripts/smoke-test.ts || {
  echo "Smoke test script not found at scripts/smoke-test.ts"
  exit 1
}
```

### 1. Ensure Application is Running

The smoke test connects to a running MCP server instance. Check if one is already running, or start one:

```bash
# Check if MCP server is running on default port (3000)
curl -s http://localhost:3000/health >/dev/null 2>&1 || {
  echo "Starting MCP server..."
  npm run dev &
  sleep 3
}
```

### 2. Run the Smoke Test

```bash
npx ts-node scripts/smoke-test.ts $ARGUMENTS
```

The test script should:
- Connect to the running MCP server
- Navigate through key UI flows (if applicable) or verify MCP tool endpoints
- Take screenshots at each step (saved to a gitignored directory)
- Output PASS/FAIL for each check
- Exit 0 (all pass) or 1 (failures)

### 3. Read Screenshots

After the test runs, read each screenshot to visually verify the UI:

```bash
# Screenshots are saved to .smoke-test-screenshots/
ls -la .smoke-test-screenshots/
```

Use the Read tool to view each screenshot image. For each screenshot:
- Verify the UI looks correct (layout, colors, text, element positions)
- Check for visual regressions (missing elements, broken layouts, overlapping content)
- Note any issues that the automated checks might have missed

### 4. Report Results

Output a summary table:

```markdown
## Smoke Test Results

| # | Check | Status | Notes |
|---|-------|--------|-------|
| 1 | MCP server responds | PASS | HTTP 200 on /health |
| 2 | get_file_summary tool available | PASS | — |
| 3 | Cache invalidation works | PASS | File hash updates detected |

**Screenshots reviewed:** N
**Visual issues found:** M (describe any issues)
```

### 5. Cleanup

```bash
# Remove screenshots unless --keep-screenshots was passed
rm -rf .smoke-test-screenshots/
```

If the application was started by this skill (not already running), stop it.

## Writing the Smoke Test Script

If the test script doesn't exist yet, create it following these patterns:

### Script Structure

```javascript
/**
 * Smoke Test — Playwright-based visual verification
 *
 * Prerequisites: MCP server must be running.
 * Screenshots saved to .smoke-test-screenshots/ (gitignored).
 */

import { chromium } from 'playwright'
// ... setup

async function run() {
  // 1. Find running MCP server
  // 2. Launch browser (if UI testing) or use HTTP client
  // 3. Connect to server URL (with auth if needed)
  // 4. Wait for server to be ready (health check, tool availability)
  // 5. Run checks — each one:
  //    a. Call MCP tool or navigate UI
  //    b. Take screenshot (if UI)
  //    c. Assert response/element exists / is visible / has correct content
  //    d. Log PASS or FAIL
  // 6. Output summary
  // 7. Exit with appropriate code
}
```

### Check Patterns

Each check should:
1. **Act** — Call MCP tool, navigate, click, type
2. **Screenshot** — Capture current state (if UI)
3. **Assert** — Verify expected response/elements/content
4. **Report** — Log PASS/FAIL with details

```javascript
// Example: Check MCP tool responds
const response = await fetch('http://localhost:3000/tools/get_file_summary', {
  method: 'POST',
  body: JSON.stringify({ file: 'src/index.ts' })
})
await screenshot(page, '02-tool-response')

if (response.ok) {
  pass('get_file_summary tool available')
} else {
  fail('get_file_summary tool available', `HTTP ${response.status}`)
}
```

### Selector Strategy

Prefer stable selectors in this order:
1. `aria-label`, `role`, `data-testid` attributes
2. Class names matching component names
3. Semantic HTML elements (`header`, `main`, `nav`)
4. Text content (last resort — fragile)

### Connection Handling

The MCP server needs to be fully initialized before tests run. Always wait for the "ready" state:

```javascript
// Wait for MCP server to be fully loaded and ready
await page.waitForFunction(() => {
  // Check server health endpoint
  return fetch('http://localhost:3000/health').then(r => r.ok)
}, { timeout: 10000 })
```

## Test Categories

Organize checks into logical groups:

- **Server Health** — MCP server responds, health endpoint works
- **Tool Availability** — get_file_summary, get_changed_files, get_project_map tools are registered
- **Cache Correctness** — File hash tracking, summary storage, invalidation on file changes
- **Protocol Compliance** — MCP protocol responses match spec, proper error handling
- **Performance** — Summary generation completes within acceptable time, no memory leaks

## Critical Rules

1. **Never send real messages** — Smoke tests verify functionality, not backend processing. Don't submit forms that trigger expensive operations.
2. **Screenshots are temporary** — Always clean up unless `--keep-screenshots`. Add `.smoke-test-screenshots/` to `.gitignore`.
3. **Fail fast on no connection** — If the server isn't running or can't connect, report immediately instead of running checks that will all fail.
4. **Stable selectors** — Use aria labels and roles, not brittle CSS class names that change with refactors.
5. **Visual verification is the point** — The automated checks catch DOM presence. Reading screenshots catches visual regressions (z-index, color, spacing).
6. **Idempotent** — Safe to run repeatedly. Don't create persistent state (sessions, data, etc.) that would affect the next run.
<!-- skill-templates: smoke-test 9652481 2026-05-27 -->
