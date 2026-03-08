import { CacheStore } from '../cache/store.js';
import { TelemetryTracker } from '../telemetry/tracker.js';
import { validatePath } from '../utils/validate-path.js';

export async function invalidateCache(
  projectRoot: string,
  path?: string,
): Promise<{ invalidated: string | 'all'; entriesRemoved: number }> {
  if (path) {
    path = validatePath(projectRoot, path);
  }
  const store = new CacheStore(projectRoot);
  const tracker = new TelemetryTracker(projectRoot);

  if (path) {
    store.deleteEntry(path);
    tracker.trackEvent('invalidation', path);
    return { invalidated: path, entriesRemoved: 1 };
  }

  const entries = store.getAllEntries();
  const count = entries.length;
  for (const entry of entries) {
    store.deleteEntry(entry.path);
    tracker.trackEvent('invalidation', entry.path);
  }

  return { invalidated: 'all', entriesRemoved: count };
}
