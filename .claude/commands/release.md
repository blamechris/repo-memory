# /release

Ship a new version of this project end to end: run the release gates, bump the version, build the artifacts, publish, tag, and verify. One command that encodes the project's release checklist so a release never skips a step or ships a broken build.

Use this **after** changes are merged and the working tree is clean. For diagnosing a *failed* publish or a broken local setup, use `/doctor`. For dependency upkeep before a release, use `/deps`.

## Arguments

- `$ARGUMENTS` — release configuration. Space-separated tokens:
  - First positional: version bump — `patch` | `minor` | `major` | an explicit version like `1.4.0` (default: `patch`).
  - `--dry-run` — run every gate and show what *would* happen, but do not bump, publish, tag, or push.
  - `--no-publish` — bump, build, tag locally, but skip the publish step (for a build-only or manual-publish release).
  - `--from=REF` — base ref for changelog/notes (default: the previous release tag).

Examples:
```
/release                  # patch release, full pipeline
/release minor
/release 2.0.0 --dry-run  # rehearse a major release
/release patch --no-publish
```

## Instructions

### 1. Preflight (stop on any failure)

Confirm the release can safely proceed. Abort with a clear message if any check fails:

- **Clean working tree** — no uncommitted or staged changes (`git status --porcelain` is empty). A release must build from committed state.
- **Correct branch** — on the release branch `main` and up to date with the remote (`git fetch` then compare).
- **Authenticated** — the publish credentials/registry login are present: `npm whoami` succeeds. Publishing additionally requires an interactive OTP via browser auth (handled in the publish step).

State the resolved bump type and the current → next version before doing anything mutating.

### 2. Run the release gates

Run the project's full verification suite. **Every gate must pass** before the version is touched — a release must never ship red.

Run these in order, fastest/cheapest first:

```
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run lint` must be run independently — do not treat a passing `npm run typecheck` as a proxy for lint. Past releases had unused-variable lint failures that a "typecheck passes" claim missed.

If any gate fails, stop and report which one — do not continue to the bump.

### 3. Bump the version (on a release branch)

Direct pushes to `main` are forbidden (branch protection) and the repo squash-merges PRs (see `/merge`), so a locally-created bump commit and tag would **not** survive onto `main`. Bump on a dedicated release branch and land it via PR:

```bash
git switch -c release/v<next>
npm version <patch|minor|major> --no-git-tag-version
git commit -am "chore(release): v<next>"
git push -u origin release/v<next>
gh pr create --fill
```

`--no-git-tag-version` is required here: it updates `package.json` (and the lockfile) **without** creating a git commit or tag. We commit explicitly and tag later (step 6) against the squash-merged commit on `main`, so the tag points at the commit that actually ships. Do **not** run a bare `npm version` — that auto-creates a local commit *and* tag that the squash merge discards, leaving a dangling tag and a `main` whose `package.json` may not match the tag.

State the resolved next version and the release branch/PR before continuing.

### 4. Update release notes / changelog

Collect the changes since `--from` (default: previous release tag) and summarize them for the release. If this project has a `/changelog` skill, invoke it; otherwise generate notes from merged PR titles / commit subjects in range.

### 5. Build the release artifacts

Produce the exact artifacts that will be published — never publish from a stale build.

`npm run build` (tsc → `dist/`). Then run `npm pack` and inspect the resulting tarball before publishing to confirm `dist/` and the `bin` entry (`dist/server.js`, which carries the `#!/usr/bin/env node` shebang) are included.

This step only builds and inspects — it does **not** publish. Publishing happens in step 7, after the bump PR is merged and the tag is created.

### 6. Merge the bump PR and tag the merged commit

If `--dry-run`, skip. Otherwise:

- Merge the step 3 release PR via the repo's standard squash flow (`/merge` or `gh pr merge --squash`), then `git switch main && git pull` so the bump is on `main` locally.
- Create an annotated tag for the new version **on the squash-merged commit** and push only the tag:

```bash
git tag -a v<next> -m "v<next>"
git push origin v<next>
```

The tag points at the merged commit that actually ships, not at a discarded local bump commit. Pushing a single tag does not violate branch protection (which governs branch refs, not tag refs); the version-bump commit itself reached `main` via the merged PR, never a direct push. There is no separate commit to push here — that already happened through the PR. Do not force-push.

### 7. Publish

If `--dry-run` or `--no-publish`, skip this step and say so.

Publish **only after** the gates (step 2) pass, the bump PR is merged, and the tag exists (step 6) — never immediately after the build. Building succeeds long before the release is actually ready to ship. Re-run `npm run build` from the freshly-pulled `main` (the tagged commit) so the published artifact matches the tag, not the pre-merge release branch.

Publish command: `npm publish --access public` (package `@blamechris/repo-memory`). Footguns specific to this project:

- **Run `npm run lint` independently before publishing** — do not trust a "typecheck passes" claim as a proxy for lint. Past releases shipped with unused-variable lint failures that typecheck did not catch.
- Publishing requires an **interactive OTP via browser auth**. Always show the **FULL** publish output (never `tail -N`) so the OTP auth URL is visible and clickable for the user.
- After the browser OTP auth, the publish **usually SUCCEEDS ON THE FIRST ATTEMPT**. Do **NOT** retry — a retry fails with "already published".

Show the publish output in full — do not truncate it, so any auth URL, OTP prompt, or warning is visible to the user.

### 8. Post-publish verification

Confirm the release is actually live and usable — a publish that "succeeded" can still be unconsumable.

Run a fresh `npx -y @blamechris/repo-memory` and confirm it starts and completes an MCP `initialize` handshake over stdio, returning `serverInfo {name:"repo-memory"}`. The cold first run installs deps including the native `better-sqlite3` — allow time for it.

### 9. Report

Summarize concisely:

```markdown
## Released: <name> <new version>

- **Gates:** <pass/fail per gate>
- **Published:** <target> (or "skipped — --no-publish/--dry-run")
- **Tag:** <tag> pushed to <remote>
- **Verified:** <post-publish check result>
- **Notes:** <link or summary of changes shipped>
```

If `--dry-run`, make clear that nothing was bumped, published, tagged, or pushed.

<!-- skill-templates: release 04d63e7 2026-06-08 -->
