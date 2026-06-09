/**
 * Normalize a path to use POSIX (forward-slash) separators.
 *
 * Stored cache paths, dependency-graph edges, and validated relative paths are
 * all kept in POSIX form so that lookups, prefix scoping (search_by_purpose
 * `pathPrefix`), and segment splits behave identically across platforms. On
 * Windows, `path.relative()` yields backslash separators; this converts them at
 * the boundary so the rest of the codebase never has to special-case `\`.
 *
 * @param p - A path that may contain backslash separators.
 * @returns The same path with all backslashes replaced by forward slashes.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
