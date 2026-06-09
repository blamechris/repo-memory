# /doctor

Diagnose a broken local setup and propose the fix. Works through the layers that make a project runnable — runtime version, installed dependencies, native modules, build state, and the entrypoint actually starting — finds the first thing that's wrong, and explains the remedy before touching anything.

Use this when something won't start, a build fails mysteriously, or the environment drifted after a runtime upgrade or a fresh clone. For diagnosing a failed *CI* run, use `/fix-ci`. For dependency upkeep specifically, use `/deps`.

## Arguments

- `$ARGUMENTS` — optional. A symptom or area to focus on (e.g. "server won't start", "build", "tests"). With no argument, run the full top-to-bottom health sweep.

Examples:
```
/doctor
/doctor "the server exits immediately on launch"
/doctor build
```

## Instructions

Run the checks in order, **cheapest and most foundational first** — a failure low in the stack explains failures above it, so stop drilling once you find the root cause. Each check: state what you're verifying, run a read-only probe, report ✓ / ✗ with the evidence.

### 1. Runtime & toolchain

Confirm the runtime and tools are present and at versions this project supports.

Requires Node 20+ — check with `node --version` (the dev machine currently runs Node 26). A Node major-version change is the most common source of native-module breakage (see step 3).

### 2. Dependency installation integrity

Confirm dependencies are installed and consistent with the manifest/lockfile.

`node_modules` is present and consistent with `package-lock.json` — verify with `npm ls` (or a clean `npm ci` matching the lockfile). Core deps: `@modelcontextprotocol/sdk`, `better-sqlite3`, `zod`. A stale install shows up as missing/extraneous packages or version mismatches in `npm ls`.

### 3. Native modules load

Native/compiled dependencies are pinned to the runtime ABI and are the most common cause of "it installed but won't run" — especially after a runtime major-version change. Verify each native module actually loads under the current runtime, not just that it's present on disk.

`better-sqlite3` is the native dependency. Probe that it loads under the current Node: `node -e "const D=require('better-sqlite3'); new D(':memory:'); console.log('ok')"`. The ABI-mismatch failure mode prints "compiled against a different Node.js version (NODE_MODULE_VERSION ...)". Safe fix: `npm install better-sqlite3` (fetches a matching prebuilt binary). NEVER `npm rebuild` — on Node 26 `better-sqlite3` cannot compile from source (the required V8 API was removed), so a rebuild both fails AND deletes the working binary.

### 4. Build state

Confirm the project builds (or that a prior build artifact is current with its sources).

Build with `npm run build` (tsc → `dist/`). The MCP entrypoint runs the build output `dist/server.js`, not `src/` — so `dist/` must be current with `src/`. A stale or missing `dist/` breaks startup.

### 5. Entrypoint / service starts

The decisive check: does the thing actually start and respond? Launch the entrypoint and confirm it reaches a ready state rather than crashing on boot.

Pipe an MCP `initialize` request to `node dist/server.js` over stdio and confirm a JSON response containing `serverInfo` with name `"repo-memory"`. Example request:
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}
```

### 6. Integration / configuration

Check the config and external wiring the project depends on to run in context.

An MCP client config (e.g. `.mcp.json`) should launch the server via `node <abs path>/dist/server.js`; verify `dist/server.js` exists and is built. Storage lives at `.repo-memory/cache.db` in the target project.

### 7. Diagnose & fix

From the first failing check, state the **root cause** (not just the symptom) and the remedy.

- For safe, read-only or clearly-reversible fixes (reinstall a dependency, rebuild), propose the exact command.
- Before any command that **deletes files, modifies global config, or changes the installation**, show what it does and get confirmation — do not run it unprompted.
- If a "fix" looks wrong for this setup (e.g. a from-source rebuild that's known to fail on the current runtime), say so and offer the correct alternative instead of running the obvious-but-wrong one.

### 8. Report

```markdown
## Doctor: <project>

| Check | Status |
|---|---|
| Runtime & toolchain | ✓ / ✗ <detail> |
| Dependencies installed | ✓ / ✗ |
| Native modules load | ✓ / ✗ |
| Build state | ✓ / ✗ |
| Entrypoint starts | ✓ / ✗ |
| Integration/config | ✓ / ✗ |

**Root cause:** <the first failure that explains the rest, or "none — environment healthy">
**Fix:** <exact remedy, or the command awaiting your confirmation>
```

If every check passes, say so plainly and note the most likely place to look next if the user is still seeing a problem.

<!-- skill-templates: doctor 04d63e7 2026-06-08 -->
