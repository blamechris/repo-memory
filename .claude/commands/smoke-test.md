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
test -f tests/smoke.spec.ts || {
  echo "Smoke test script not found at tests/smoke.spec.ts"
  exit 1
}
```

### 1. Ensure Application is Running

The smoke test connects to a running application instance. Check if one is already running, or start one:

```bash
# For repo-memory MCP server, verify it's running on the expected port
# (typically localhost:3000 or via stdio transport)
# If not running, start it:
npm run dev
```

### 2. Run the Smoke Test

**Do NOT forward `$ARGUMENTS` verbatim to `playwright test`.** Only `--headed` is a real
Playwright flag; `--keep-screenshots` is a skill-level flag handled by this skill's
cleanup step (5), not Playwright. Parse the two out separately:

```bash
PW_FLAGS=""
KEEP_SCREENSHOTS=false
for arg in $ARGUMENTS; do
  case "$arg" in
    --headed) PW_FLAGS="$PW_FLAGS --headed" ;;
    --keep-screenshots) KEEP_SCREENSHOTS=true ;;  # skill-level, NOT passed to Playwright
    *) ;;  # ignore unknown flags rather than forwarding them
  esac
done

# Run the smoke test script
npx playwright test tests/smoke.spec.ts $PW_FLAGS
```

The test script should:
- Connect to the running application
- Navigate through key UI flows
- Take screenshots at each step (saved to a gitignored directory)
- Output PASS/FAIL for each check
- Exit 0 (all pass) or 1 (failures)

### 3. Read Screenshots

After the test runs, read each screenshot to visually verify the UI:

```bash
# Screenshots are saved to tests/screenshots/
ls -la tests/screenshots/
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
| 1 | App loads | PASS | HTTP 200, no console errors |
| 2 | Feature X visible | PASS | — |
| 3 | Feature Y works | FAIL | Element not found |

**Screenshots reviewed:** N
**Visual issues found:** M (describe any issues)
```

### 5. Cleanup

```bash
# Remove screenshots unless --keep-screenshots was passed (parsed in step 2, NOT
# forwarded to Playwright). $KEEP_SCREENSHOTS is the skill's own flag.
if [ "$KEEP_SCREENSHOTS" != "true" ]; then
  rm -rf tests/screenshots/
fi
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
 * Screenshots saved to tests/screenshots/ (gitignored).
 */

import { chromium } from 'playwright'
// ... setup

async function run() {
  // 1. Find running MCP server
  // 2. Launch browser
  // 3. Navigate to app URL (with auth if needed)
  // 4. Wait for app to be ready (WebSocket, data loading, etc.)
  // 5. Run checks — each one:
  //    a. Interact with UI (click, type, navigate)
  //    b. Take screenshot
  //    c. Assert element exists / is visible / has correct content
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
// Example: Check a modal opens
await page.keyboard.press('Control+n')
await page.waitForTimeout(500)
await screenshot(page, '02-modal-open')

const modal = await page.$('.modal-overlay')
if (modal && await modal.isVisible()) {
  pass('Modal opens')
} else {
  fail('Modal opens', 'Not visible after Ctrl+N')
}
```

### Selector Strategy

Prefer stable selectors in this order:
1. `aria-label`, `role`, `data-testid` attributes
2. Class names matching component names
3. Semantic HTML elements (`header`, `main`, `nav`)
4. Text content (last resort — fragile)

### Connection Handling

Many apps need a backend connection before the full UI renders. Always wait for the "ready" state:

```javascript
// Wait for MCP server to be fully loaded and connected
await page.waitForFunction(() => {
  // Check for MCP protocol readiness (e.g., tools initialized, resources available)
  return window.__mcp_ready === true
}, { timeout: 10000 })
```

## Test Categories

Organize checks into logical groups:

- **MCP Server Initialization** — Server starts, tools are registered, resources are available
- **File Summary Retrieval** — get_file_summary tool works, returns correct structure
- **Changed Files Detection** — get_changed_files tool detects modifications
- **Project Map Generation** — get_project_map tool builds dependency graph
- **Cache Correctness** — Cached summaries match fresh scans, invalidation works
- **Error Handling** — Graceful failures on missing files, invalid repos, network issues

## Critical Rules

1. **Never send real messages** — Smoke tests verify UI, not backend processing. Don't submit forms that trigger expensive operations.
2. **Screenshots are temporary** — Always clean up unless `--keep-screenshots`. Add the directory to `.gitignore`.
3. **Fail fast on no connection** — If the app isn't running or can't connect, report immediately instead of running checks that will all fail.
4. **Stable selectors** — Use aria labels and roles, not brittle CSS class names that change with refactors.
5. **Visual verification is the point** — The automated checks catch DOM presence. Reading screenshots catches visual regressions (z-index, color, spacing).
6. **Idempotent** — Safe to run repeatedly. Don't create persistent state (sessions, data, etc.) that would affect the next run.
<!-- skill-templates: smoke-test 21fa678 2026-06-03 -->
