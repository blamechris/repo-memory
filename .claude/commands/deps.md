# /deps

Keep this project's dependencies healthy: report what's outdated and vulnerable, flag native modules that can break across runtime upgrades, and apply the safe bumps with tests as the gate. A periodic checkup that catches dependency rot before it becomes a broken build or a security advisory.

Use this before a `/release`, after a runtime (Node/Python/etc.) upgrade, or on a regular cadence. For diagnosing an *already* broken install, use `/doctor`.

## Arguments

- `$ARGUMENTS` — configuration. Space-separated tokens:
  - `--audit-only` — report health, propose nothing, change nothing (default is report + propose).
  - `--apply` — actually apply the safe (non-major) bumps and run the test gate after each batch.
  - `--include-major` — also surface and individually evaluate major (breaking) upgrades, not just safe ones.
  - First positional: optional scope filter (a package name or glob) to narrow the checkup.

Examples:
```
/deps                 # full checkup, propose safe bumps, change nothing
/deps --apply         # apply safe bumps, gated by tests
/deps --audit-only    # read-only health report
/deps --include-major # also evaluate breaking upgrades
```

## Instructions

### 1. Inventory outdated dependencies

List what has newer versions available and classify each by semver distance (patch / minor / major).

Run `npm outdated` (add `--json` for machine-readable output). This is a single `package.json` with no workspaces — one sweep covers the whole tree.

### 2. Security audit

Surface known vulnerabilities in the current dependency tree, with severity.

Run `npm audit` (add `--json` for machine-readable output). Policy: any **high or critical** severity advisory is a must-fix before a release.

### 3. Native / runtime-compatibility check

Native addons and compiled dependencies are pinned to the runtime's ABI and break when the runtime crosses a major version — a class of failure that a plain "outdated" check misses entirely. For each dependency with a native/compiled component:

- Identify whether a prebuilt binary exists for the **current** runtime version, or whether it must compile from source.
- Flag any that would fail to compile or load on the runtime in use (mismatched ABI / module version, missing prebuilt, dropped toolchain API).
- Note the safe remediation (reinstall to fetch a matching prebuilt, pin a runtime version, or upgrade the dependency to a release that ships prebuilts for the current runtime).

`better-sqlite3` is the one native/compiled dependency (a C++ addon pinned to Node's ABI / `NODE_MODULE_VERSION`); `@modelcontextprotocol/sdk` and `zod` are pure JS with no native concern.

- **Prebuilt-only on Node 26 (current dev machine):** `better-sqlite3` CANNOT compile from source on Node 26 — its C++ uses the V8 API `PropertyCallbackInfo::This`, which was removed in Node 26, so a source build fails with `error: no member named 'This'`. It works ONLY via a matching prebuilt binary.
- **ABI mismatch symptom:** an error like `compiled against a different Node.js version (NODE_MODULE_VERSION 141 vs 147)` means the installed binary is for the wrong Node ABI.
- **SAFE FIX:** run `npm install better-sqlite3`, which fetches a matching prebuilt for the current Node. NEVER run `npm rebuild better-sqlite3` — that forces a source compile (which fails on Node 26) and deletes the working binary in the process.
- **Remediation for a Node major bump:** reinstall to fetch the prebuilt for the new Node, or upgrade `better-sqlite3` to a version that ships prebuilts for the new Node major.

### 4. Categorize and decide

Group findings into:

- **Safe** — patch/minor bumps within semver, no advisory, no native concern. Candidates for `--apply`.
- **Breaking** — major bumps, or any bump that crosses a documented breaking change. Evaluate individually (only when `--include-major`); each needs its own read of the upstream changelog.
- **Security-driven** — bumps required to clear an advisory, regardless of semver distance. Prioritize these.

### 5. Apply (only with `--apply`)

For `--apply`, update the safe bumps in batches and gate each batch on the test suite — never apply a wave of bumps without verifying:

Run `npm install` to apply, then gate with `npm test` (vitest) and `npm run build` (the build catches type/compile breakage the tests can miss). Commit the updated `package-lock.json`.

If a batch fails the gate, bisect it: revert the batch, re-apply one dependency at a time, and isolate the offender. Report the offender rather than leaving the tree red.

Without `--apply`, change nothing — only propose the exact commands the user could run.

### 6. Report

```markdown
## Dependency Checkup: <project>

### Security  (N advisories)
| Package | Severity | Installed → Fixed | Action |
|---|---|---|---|

### Safe bumps  (N)
| Package | Current → Latest | Type |
|---|---|---|

### Breaking / needs review  (N)   ← only with --include-major
| Package | Current → Latest | Why it's breaking |
|---|---|---|

### Native / runtime compatibility
<findings from step 3, or "no native dependencies">

### Applied   ← only with --apply
<what was bumped, test result per batch, any offender isolated>
```

End with a one-line recommendation: the single highest-value next action (e.g. "Clear the 2 high-severity advisories before the next /release").
<!-- skill-templates: deps 04d63e7 2026-06-08 -->
