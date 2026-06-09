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

### 3. Bump the version

Bump per the resolved type from step 1.

Run `npm version <patch|minor|major> --no-git-tag-version` — this updates `package.json` (and the lockfile) **without** creating a commit or a git tag. Direct pushes to `main` are forbidden (branch protection) and the repo squash-merges PRs, so the bump must land via PR: commit it on a branch, open a PR, and wait for it to **merge** before publishing. Do **not** create a local tag at bump time — a tag created now would point at a commit the squash merge will replace. The tag is created on the merged bump commit in step 7.

State the resolved next version before continuing.

### 4. Update release notes / changelog

Generate the release notes for the changes since `--from` (default: previous release tag). **Prefer the `/changelog` skill** — invoke it for the range (`/changelog --from=<prev tag> --version=<new version>`) and use its rendered section as the release notes. If `/changelog` is not installed, fall back to generating notes directly from merged PR titles / commit subjects in range.

repo-memory has `/changelog` installed: invoke `/changelog --from=<prev tag> --version=<new version> --output=release` and use its rendered section as the GitHub release body. The project keeps **no `CHANGELOG.md` file** — release notes live only as GitHub releases.

### 5. Build the release artifacts

Produce the exact artifacts that will be published — never publish from a stale build.

`npm run build` (tsc → `dist/`). Then run `npm pack` and inspect the resulting tarball before publishing to confirm `dist/` and the `bin` entry (`dist/server.js`) are included.

### 6. Publish

If `--dry-run` or `--no-publish`, skip this step and say so.

Publish **only after** the version-bump PR from step 3 has been **merged** into `main`, and you have `git checkout main && git pull` + rebuilt (step 5) from the updated branch — the published artifact must carry the bumped version, never a stale local tree. Do not publish before the bump lands.

Publish command: `npm publish --access public` (package `@blamechris/repo-memory`). Footguns specific to this project:

- **Run `npm run lint` independently before publishing** — do not trust a "typecheck passes" claim as a proxy for lint. Past releases shipped with unused-variable lint failures that typecheck did not catch.
- Publishing requires an **interactive OTP via browser auth**. Always show the **FULL** publish output (never `tail -N`) so the OTP auth URL is visible and clickable for the user.
- After the browser OTP auth, the publish **usually SUCCEEDS ON THE FIRST ATTEMPT**. Do **NOT** retry — a retry fails with "already published".

Show the publish output in full — do not truncate it, so any auth URL, OTP prompt, or warning is visible to the user.

### 7. Tag and push

If `--dry-run`, skip. Otherwise tag the exact released commit:

The version bump already landed via the merged PR (step 3), so the bumped version is in `main`'s history. From an up-to-date `main`, create the annotated tag on that merged bump commit and push **only the tag** to `origin main`:

```bash
git tag -a v<new version> -m "v<new version>"
git push origin v<new version>
```

Do **not** push commits to `main` directly (branch protection forbids it — the bump already arrived via PR), and do not double-tag. Do not force-push.

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

<!-- skill-templates: release 3254376 2026-06-09 -->
