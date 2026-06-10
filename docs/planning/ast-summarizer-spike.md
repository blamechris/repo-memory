# Spike: AST-based file summarization (TS/JS via tree-sitter WASM)

**Status:** complete — recommendation at the bottom.
**Scope:** TypeScript/JavaScript (`.ts/.tsx/.js/.jsx/.mjs/.cjs`). Python/Go/Rust stay on the regex summarizer.
**Code:** `src/indexer/ast-summarizer.ts` (engine), `src/indexer/summarize.ts` (config dispatch + cache generation), `summarizer: 'regex' | 'ast'` in `.repo-memory.json` (default `'regex'`).

## Hypothesis

AST-derived summaries give (a) accurate exports/declarations and (b) a semantic
one-line `purpose`, making `search_by_purpose` genuinely useful. The regex
summarizer classifies almost every implementation file as `purpose: "source"`,
which carries no search signal.

## Dependency chosen

| Option | Verdict |
| --- | --- |
| `web-tree-sitter` + `tree-sitter-wasms` | **Chosen.** Pure WASM, no native compilation, prebuilt grammars for 36 languages including typescript/tsx/javascript (and python/go/rust for later). |
| `@vscode/tree-sitter-wasm` | Viable alternative (21 MB unpacked, bundles its own runtime + 16 grammars). Less standard API surface; grammars updated on VS Code's schedule. |
| `tree-sitter-typescript` (native) | Rejected: `node-gyp-build` dependency — exactly the prebuild/Node-version pain we already have with better-sqlite3. |
| TypeScript compiler API | Not needed — the WASM route works. Would add `typescript` (~23 MB unpacked) as a runtime dep and covers only TS/JS, no path to other languages. |

Added to `dependencies`:

- `web-tree-sitter@^0.25.10` — 1.7 MB tarball / 5.8 MB unpacked
- `tree-sitter-wasms@^0.1.13` — 4.5 MB tarball / 51.8 MB unpacked (all 36 grammars)

**Version pinning caveat:** `web-tree-sitter@0.26.x` rejects the grammar
binaries in `tree-sitter-wasms@0.1.13` (Emscripten dylink-metadata mismatch at
`Language.load`). The caret range `^0.25.10` resolves to `<0.26.0`, which is
the compatible pairing — do not bump web-tree-sitter without re-testing grammar
loading.

### Package size impact

- Download (npx cold install): **+6.2 MB** compressed.
- `node_modules`: **+55 MB** unpacked. Of `tree-sitter-wasms`' 49 MB, we use
  three files totaling **5.4 MB** (`tree-sitter-typescript.wasm` 2.3 MB,
  `tree-sitter-tsx.wasm` 2.4 MB, `tree-sitter-javascript.wasm` 0.6 MB).
- For full adoption, copy the needed `.wasm` files into `dist/` at build time
  and move `tree-sitter-wasms` to `devDependencies`: runtime cost drops to
  ~11 MB unpacked (~3.5 MB compressed) and grammar availability stops depending
  on install-time resolution. The spike resolves them from `node_modules` via
  `createRequire` for simplicity.

## Measurements

Benchmark: `npx tsx tests/benchmarks/ast-vs-regex.ts` — 35 files under `src/`
(4,809 lines), median of 5 warm runs per file, Node 26 / Apple Silicon.

### Startup and speed

| Metric | regex | AST |
| --- | --- | --- |
| One-time WASM startup (init + grammar load + first parse) | — | **12–14 ms** |
| Avg per file | 0.017 ms | **0.52 ms** (~30x regex) |
| Total, all 35 files | 0.6 ms | 18.2 ms |
| Slowest file (`src/indexer/imports.ts`, 477 lines) | — | 1.9 ms |

Both are noise next to file I/O and SQLite writes; a full re-index of this repo
costs ~18 ms extra in AST mode. Parse failures requiring regex fallback: **0/35**.

### Summary size

JSON chars per summary: 360 (regex) → 406 (AST), **+12.6%**. The growth is the
richer `purpose` line — exports/imports/declarations are byte-identical shapes.

### Accuracy spot-check

- **Files where AST found exports the regex missed: 15/35** (43%).
- Files where regex found exports the AST missed: 0.
- Files where `topLevelDeclarations` differ: 0.

All 15 misses are the same regex bug: `EXPORT_PATTERN` has no `async`
alternative, so every `export async function` in the codebase is invisible to
the regex summarizer (and therefore to `search_by_purpose`'s exports matching).
Three concrete examples:

1. `src/cache/gc.ts` — AST-only export: `runGC`
2. `src/indexer/scanner.ts` — AST-only export: `scanProject`
3. `src/tools/get-file-summary.ts` — AST-only export: `getFileSummary`

The AST is also immune to false positives the regex is structurally prone to —
`export` statements inside template literals or comments (covered by a unit
test; this repo's src happens not to trigger it).

> Side finding worth fixing regardless of this spike's outcome: adding
> `(?:async\s+)?` to `EXPORT_PATTERN` in `summarizer.ts` repairs the regex
> summarizer's biggest accuracy hole in one line.

### Purpose quality — before/after

| File | regex | AST |
| --- | --- | --- |
| `src/cache/store.ts` | `source` | `class CacheStore (9 methods)` |
| `src/cache/hash.ts` | `source` | `functions: hashFile, hashContents — Compute a SHA-256 hex digest of a file at the given absolute path.` |
| `src/utils/validate-path.ts` | `source` | `function validatePath — Validates that a file path is safe and resolves within the project root.` |

Other categories keep their searchable prefix while gaining detail, e.g.
`src/server.ts`: `entry point` → `entry point: functions: registerTools, main`;
`src/types.ts`: `types` → `types: CacheEntry, FileSummary, ImportRef`.
For this repo, 30 of 35 files go from the bare word `source` to a line naming
the dominant symbols — that is the entire search corpus `search_by_purpose`
operates on.

## Cache invalidation on summarizer change (implemented)

Switching summarizers must regenerate stale summaries. Implemented via a
generation tag rather than a hash salt (salting content hashes would have
broken `get_changed_files`, which compares stored hashes against fresh file
hashes):

- Migration 6 adds a `meta` key/value table.
- `ensureSummaryGeneration(projectRoot)` (called before any cache read in
  `get_file_summary`, `force_reread`, and project-map indexing) compares the
  stored `summarizer_generation` tag (`<mode>:<generation>`, e.g. `ast:1`)
  against the configured mode. On mismatch it nulls all `summary_json` columns
  — hashes and timestamps survive, so change detection is unaffected and
  summaries regenerate lazily — then records the new tag. Pre-existing
  databases without a tag are treated as `regex:1` (what produced them) and are
  not wiped.
- `SUMMARIZER_GENERATION` in `summarize.ts` should be bumped whenever summary
  output changes materially within a mode.

## Recommendation: GO

Adopt the AST summarizer for TS/JS. The accuracy delta is not marginal — 43% of
this repo's files have wrong exports under the regex engine, and the purpose
line goes from contentless (`source`) to a usable semantic index for the cost
of ~0.5 ms/file and a one-time ~13 ms startup. Failure handling is total: any
parse error or WASM load failure falls back to the regex engine, so AST mode
can never do worse than today.

Suggested rollout:

1. **Done.** Ship behind `summarizer: 'ast'` (this spike) — opt-in, default
   `regex`.
2. **Done.** Vendor the three grammar `.wasm` files into `dist/` at build time
   (`scripts/copy-grammars.mjs`, wired into `npm run build`); demote
   `tree-sitter-wasms` to a dev dependency. Grammar resolution prefers the
   vendored `dist/grammars/` copies and falls back to the `tree-sitter-wasms`
   devDependency when running from `src/` (dev/vitest). Cuts the runtime
   footprint from ~55 MB to ~11 MB unpacked; the tarball grows from ~72 kB to
   ~573 kB compressed (~5.7 MB unpacked).
3. Flip the default to `ast` for TS/JS after a release of soak time; the
   generation tag handles the cache migration automatically.
4. Extend to Python/Go/Rust: grammars are already in `tree-sitter-wasms`; each
   language needs an extraction visitor (~100 lines) and purpose templates.
   Regex stays as the universal fallback.
5. Fix the `async` export bug in the regex summarizer independently — it
   benefits the fallback path and non-TS languages' sibling patterns.

Caveats:

- `web-tree-sitter` must stay on 0.25.x until `tree-sitter-wasms` publishes
  grammars built for the 0.26 runtime (see pinning caveat above).
- The AST engine summarizes only top-level statements; symbols produced by
  metaprogramming (e.g. `Object.assign(exports, ...)`) are invisible to both
  engines.
- `purpose` is no longer a closed vocabulary in AST mode. The one consumer that
  matched exact strings (`findEntryPoints` in `project-map.ts`) now matches the
  `entry point` prefix; anything else that grows assumptions about purpose
  values should do the same.
- web-tree-sitter allocates WASM-heap memory per tree; the summarizer calls
  `tree.delete()` after each file to keep long-lived MCP server processes flat.
