# repo-memory skill profile

## Project Context
- Tech: TypeScript (strict, ES2022, NodeNext ESM), Node.js 20+ (dev machine on Node 26), MCP SDK (`@modelcontextprotocol/sdk`), SQLite via `better-sqlite3`, `zod`.
- Build system: `tsc` → `dist/` (ESM only); npm with `package-lock.json`.
- Repo: blamechris/repo-memory
- Main branch: main
- CI: GitHub Actions (`.github/workflows/ci.yml`), single required job **`ci`** — runs typecheck + lint + test + build on Node 20.x.
- Status: headless MCP server published to npm as `@blamechris/repo-memory`. A `.repo-memory/cache.db` (SQLite) lives in each target project root.
- Hard requirements (never regress): cache correctness over performance — **never return stale data**; deterministic SHA-256 file hashing; ESM only; no `console.log` in production (structured logging via MCP); **zero attribution** — no AI/Claude mentions in commits, PRs, issues, or files (the user is the sole author).

## Build / Test Commands
- Build (the gate): `npm run build` (`tsc` → `dist/`)
- Test: `npm test` (vitest); integration `npm run test:integration`; coverage `npm run test:coverage`
- Lint / typecheck: `npm run typecheck` (`tsc --noEmit`) and `npm run lint` (ESLint). **Run lint independently — typecheck passing has repeatedly masked lint failures (unused vars).**
- Full pre-merge/pre-release gate: `npm run typecheck && npm run lint && npm test && npm run build`

## Conventions
- Branch naming: `auto/<number>-<slug>` for automated work; otherwise `feat|fix|chore|refactor|test|docs/<slug>`.
- Commit style: conventional commits `type(scope): description`. Types: feat, fix, refactor, test, docs, chore. Scopes: `server, cache, indexer, memory, graph, telemetry, infra`.
- Flow: PR-based on `main`, branch protection, **squash merges**, **conversation resolution required**; no direct pushes or force-pushes to main.
- Source patterns: `src/**/*.ts`; tests `tests/unit/*.test.ts` + `tests/integration/*.test.ts`; fixtures `tests/fixtures/`; benchmarks `tests/benchmarks/`. Git worktrees under `.claude/worktrees/`.
- Labels: `epic:{infra,cache-engine,mcp-server,indexer,task-memory,graph,persistence,telemetry,dx}`, `complexity:{low,medium,high}`, `testing:{low,medium,high}`, plus `bug`, `enhancement`, `good first issue`, `help wanted`, `wontfix`, `design-spike`, `from-review`.
- Design ethos: prefer enhancing existing MCP tools (optional params) over adding new tools — each tool costs ~100 tokens/turn in the system prompt.

## release Customizations
- Publish: `npm publish --access public` (package `@blamechris/repo-memory`). Auth: `npm whoami`; publish needs an **interactive OTP via browser**.
- Footguns (hard-won): after OTP the publish **usually succeeds on the first attempt — do NOT retry** (retry fails "already published"). Always show the **FULL** publish output (never `tail`) so the OTP URL is visible. Run `npm run lint` **independently** before publishing.
- Version bump: `npm version <type> --no-git-tag-version` (no local tag — PR-based, no direct push). Bump lands via PR; after merge, tag the merged commit and push **only the tag**.
- Release notes: invoke `/changelog --output=release` — repo keeps **no `CHANGELOG.md`**; notes live only as GitHub releases.
- Post-publish verify: `npx -y @blamechris/repo-memory` completes an MCP `initialize` handshake returning `serverInfo {name:"repo-memory", version:<new>}`.
- Note: tagging began at `v0.7.0`; earlier published versions (0.1.0–0.6.0) have no git tags, and npm `0.6.0` predates the tool-group feature.

## deps Customizations
- npm, single manifest. Outdated: `npm outdated`. Audit: `npm audit` (high+ must-fix before release).
- Native dependency **better-sqlite3** is ABI-pinned. On **Node 26 it is prebuilt-only** — it cannot compile from source (its C++ uses the V8 API `PropertyCallbackInfo::This`, removed in Node 26). Fix an ABI mismatch (`NODE_MODULE_VERSION` error) with `npm install better-sqlite3` (fetches a matching prebuilt) — **never `npm rebuild`** (forces the failing source compile and deletes the working binary). The `^` range floats to a Node-26-OK release.
- Apply + gate: `npm install`, then `npm test` + `npm run build`; commit `package-lock.json`.

## doctor Customizations
- Runtime: Node 20+ (dev Node 26). Probe better-sqlite3 loads: `node -e "new (require('better-sqlite3'))(':memory:')"`; fix ABI mismatch with `npm install` (not `npm rebuild`).
- Build state: `npm run build` (`tsc` → `dist/`); the entrypoint runs the **build output** `dist/server.js`, so `dist/` must be current with `src/`.
- Entrypoint startup (decisive check): pipe an MCP `initialize` request to `node dist/server.js` over stdio and confirm a `serverInfo` response with name `repo-memory`.
- Integration: an MCP client config (`.mcp.json`) should launch `node <abs path>/dist/server.js`.

## changelog Customizations
- Squash-merge enumeration: `gh pr list --state merged --base main`; previous release via `git describe --tags --abbrev=0` (root-commit fallback — tags only exist from v0.7.0 on).
- Categorize by conventional-commit type: feat→Added, fix→Fixed, refactor/perf→Changed, security→Security; omit chore/version-bump noise.
- Output: **GitHub release body** (`--output=release`) — repo keeps no `CHANGELOG.md` file.

## agent-review Customizations
- Persona: senior TypeScript/Node systems reviewer for a headless MCP server — thinks in cache correctness, deterministic hashing, SQLite integrity, and the per-tool token budget.
- Criteria emphasis: TS strict/ESM/no-`console.log`; cache correctness (never stale); prefer optional params over new MCP tools; DB changes via `src/persistence/` migrations.
- Issues: label `enhancement` + `from-review`; `type(scope)` titles with the scope list above.

## project-audit / swarm-audit / agentic-audit Customizations
- Add domain auditor/reviewer personas: **Cache Correctness** (stale-data, hash determinism, invalidation paths) and **MCP Protocol** (tool contracts, stdio transport, tool-count/token ROI). Sentinel security lens = filesystem + SQLite attack surface, not web vulns.
- Grading: treat cache correctness and SHA-256 determinism as gating/Critical.

## bug-hunt Customizations
- Bias hunters toward stale-cache/invalidation correctness in `src/cache`, `src/indexer`, `src/persistence` (the project's hard invariant). Labels: `bug` + the `epic:*`/`complexity:*`/`testing:*` families.

## create-issue / create-pr / decompose-issue / start-working / tackle-issues Customizations
- Use the real label taxonomy above (`epic:*`, `complexity:*`, `testing:*`, `from-review`). PR bodies auto-detect issue closures (`Closes #N`); zero attribution in bodies. Work sources: GitHub issues + open PRs; design docs under `docs/planning/`.

## merge / batch-merge / merge-gate / fix-ci Customizations
- Required CI check name: **`ci`** (the single job in `ci.yml`). Merge via **squash**; branch protection requires conversations resolved before merge.
- Never `npm publish` from a merge — publishing is a separate OTP-gated manual step (see release).
- fix-ci: typecheck-passes-while-lint-fails is a known failure mode (check lint separately); better-sqlite3 native ABI on a new Node major → reinstall for a matching prebuilt, not source rebuild.

## parallel-dev / autonomous-dev-flow Customizations
- Per-agent verification = the full gate `npm run typecheck && npm run lint && npm test && npm run build`. Worktrees live under `.claude/worktrees/`. Worktree agents commonly leave unused vars that pass typecheck but fail lint — always run lint independently.

## smoke-test Customizations
- This is a **headless MCP stdio server — no browser/UI**. A smoke test = build → spawn `node dist/server.js` → MCP `initialize` (assert `serverInfo.name === "repo-memory"`) → `tools/list`. No screenshots/aria/URLs.
