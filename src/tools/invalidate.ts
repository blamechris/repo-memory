import { CacheStore } from '../cache/store.js';
import { validatePath } from '../utils/validate-path.js';

export async function invalidateCache(
  projectRoot: string,
  path?: string,
): Promise<{ invalidated: string | 'all'; entriesRemoved: number }> {
  if (path) {
    path = validatePath(projectRoot, path);
  }
  const store = new CacheStore(projectRoot);

  if (path) {
    store.deleteEntry(path);
    return { invalidated: path, entriesRemoved: 1 };
  }

  const entries = store.getAllEntries();
  const count = entries.length;
  for (const entry of entries) {
    store.deleteEntry(entry.path);
  }

  return { invalidated: 'all', entriesRemoved: count };
}
