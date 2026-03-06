import { join } from 'path';
import { CacheStore } from '../cache/store.js';
import { hashFile } from '../cache/hash.js';
import { scanProject } from '../indexer/scanner.js';

export interface ChangedFilesResult {
  changed: string[];
  added: string[];
  deleted: string[];
  checkedAt: string;
}

export async function getChangedFiles(
  projectRoot: string,
  since?: string,
): Promise<ChangedFilesResult> {
  const store = new CacheStore(projectRoot);
  const scannedFiles = await scanProject(projectRoot);
  const allEntries = store.getAllEntries();

  const cachedByPath = new Map(allEntries.map((e) => [e.path, e]));
  const scannedSet = new Set(scannedFiles);

  const sinceTimestamp = parseSince(since);

  const changed: string[] = [];
  const added: string[] = [];

  await Promise.all(
    scannedFiles.map(async (relativePath) => {
      const absolutePath = join(projectRoot, relativePath);
      const currentHash = await hashFile(absolutePath);
      if (!currentHash) return;

      const cached = cachedByPath.get(relativePath);

      if (!cached) {
        added.push(relativePath);
      } else if (cached.hash !== currentHash) {
        if (sinceTimestamp === null || cached.lastChecked >= sinceTimestamp) {
          changed.push(relativePath);
        }
      }

      // Update the cache entry with current hash and timestamp
      store.setEntry(relativePath, currentHash, cached?.summary ?? null);
    }),
  );

  // Files in cache but not in scan are deleted
  const deleted: string[] = [];
  for (const [path, entry] of cachedByPath) {
    if (!scannedSet.has(path)) {
      if (sinceTimestamp === null || entry.lastChecked >= sinceTimestamp) {
        deleted.push(path);
      }
      store.deleteEntry(path);
    }
  }

  changed.sort();
  added.sort();
  deleted.sort();

  return {
    changed,
    added,
    deleted,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Parse the `since` parameter into a timestamp threshold.
 * - undefined or "last_check": return null (no filtering, report all differences)
 * - ISO timestamp string: return parsed timestamp (only report files checked after this time)
 */
function parseSince(since: string | undefined): number | null {
  if (!since || since === 'last_check') {
    return null;
  }

  const parsed = Date.parse(since);
  if (!isNaN(parsed)) {
    return parsed;
  }

  return null;
}
