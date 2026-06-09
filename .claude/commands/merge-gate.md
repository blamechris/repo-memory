# Merge Gate Pattern

## Purpose

Short-circuit token-expensive diagnostic reasoning when `gh pr merge` fails due to branch protection. The most common blocker is unresolved review threads. When the workflow has permission, the installed skills (`/check-pr`, `/merge`, `/batch-merge`) resolve those threads automatically via the GraphQL `resolveReviewThread` mutation; this handoff pattern is the fallback for when automated resolution is unavailable or has already run and a human still needs to resolve remaining threads via the GitHub UI. This pattern turns a multi-step investigation into a 2-line handoff.

## The Problem

Without this pattern, when merge fails the agent:
1. Reads the error message
2. Reasons about possible causes
3. Runs `gh pr checks` to investigate
4. Composes a thoughtful diagnostic message
5. Asks the user what to do

All of that is wasted tokens — the answer is almost always "go resolve threads."

## CLAUDE.md Snippet

Add this to your repo's CLAUDE.md in the PR Workflow / merge section:

```markdown
**Merge Gate — MANDATORY short-circuit when merge is blocked:**

When `gh pr merge` fails with "base branch policy prohibits the merge":
1. **Do NOT investigate, reason about, or run diagnostic commands.** The cause is almost always unresolved review threads.
2. **Immediately respond with exactly this** (filling in the PR number):
   > Merge blocked — unresolved review threads. Please resolve them here:
   > https://github.com/blamechris/repo-memory/pull/{N}/files
   >
   > Say "done" when resolved.
3. **Wait for user confirmation**, then retry `gh pr merge --squash`.
4. If it fails a second time, THEN check `gh pr checks` for CI failures.
```

## Why This Works

- **Set once, forget forever** — lives in CLAUDE.md, loaded every session
- **Zero wasted tokens** — skips all diagnostic reasoning on first failure
- **Human intervention point** — the fallback for threads the workflow cannot resolve automatically (no permission, or already attempted); a human resolves the remainder via the GitHub UI
- **Graceful fallback** — second failure triggers real investigation

## Repos Using This Pattern

| Repo | Branch Protection | Comment Resolution Required |
|------|------------------|----------------------------|
| repo-memory | Yes | Yes |
<!-- skill-templates: merge-gate 85269c8 2026-06-08 -->
