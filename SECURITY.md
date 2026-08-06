# Security Policy

## Why this matters here

repo-memory is an MCP server that reads, hashes, and summarizes arbitrary files in a project on a coding agent's behalf, and stores the results in a local SQLite database (`.repo-memory/cache.db`). That file-read/summarize surface — path handling, what gets indexed, what a summary can leak into an agent's context — is exactly the kind of thing a vulnerability report should reach the maintainer privately first.

## Supported versions

repo-memory is pre-1.0. Security fixes land on the latest release only.

| Version | Supported |
|---------|-----------|
| 0.17.x (latest) | Yes |
| < 0.17 | No |

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/blamechris/repo-memory/security/advisories/new) (Security tab → Report a vulnerability). Do not open a public issue for a security problem.

Include what you can of:
- Steps to reproduce, or a proof of concept
- The affected version (`npm ls @blamechris/repo-memory` or the release tag)
- Impact as you understand it (e.g. path traversal, cache poisoning, data exposure through summaries)

You should receive an acknowledgement within a few days. Once a fix ships, the advisory is published and credited unless you prefer otherwise.
