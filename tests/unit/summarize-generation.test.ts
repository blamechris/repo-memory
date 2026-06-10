import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ensureSummaryGeneration,
  clearSummaryGenerationCache,
} from '../../src/indexer/summarize.js';
import {
  GENERATION_META_KEY,
  setSummarizerGenerationForTests,
  parseGenerationTag,
  isStoredGenerationNewer,
} from '../../src/cache/generation.js';
import { CacheStore } from '../../src/cache/store.js';
import { closeDatabase } from '../../src/persistence/db.js';
import { clearConfigCache } from '../../src/config.js';
import type { FileSummary } from '../../src/types.js';

function summaryFor(generation: number): FileSummary {
  return {
    purpose: `gen${generation}`,
    exports: [],
    imports: [],
    lineCount: 1,
    topLevelDeclarations: [],
    confidence: 'high',
  };
}

describe('summarizer generation monotonicity (Guardian I3)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'summarize-gen-test-'));
    clearConfigCache();
    clearSummaryGenerationCache();
    setSummarizerGenerationForTests(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setSummarizerGenerationForTests(null);
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    clearConfigCache();
    clearSummaryGenerationCache();
  });

  it('interleaved gen-N and gen-N+1 processes leave only gen-N+1 summaries and clear exactly once', () => {
    const clearSpy = vi.spyOn(CacheStore.prototype, 'clearAllSummariesAndSetMeta');

    // "Process A" (generation 3) boots and tags the fresh database.
    setSummarizerGenerationForTests(3);
    ensureSummaryGeneration(tempDir);
    const storeA = new CacheStore(tempDir);
    storeA.setEntry('a.ts', 'hash-a', summaryFor(3));
    expect(storeA.getEntry('a.ts')?.summary?.purpose).toBe('gen3');
    expect(storeA.getMeta(GENERATION_META_KEY)).toBe('ast:3');
    const clearsAfterBootstrap = clearSpy.mock.calls.length;

    // "Process B" (generation 4) starts — fresh memoization — and upgrades.
    setSummarizerGenerationForTests(4);
    clearSummaryGenerationCache();
    ensureSummaryGeneration(tempDir);
    const storeB = new CacheStore(tempDir);
    expect(storeB.getMeta(GENERATION_META_KEY)).toBe('ast:4');
    expect(storeB.getEntry('a.ts')?.summary).toBeNull(); // gen-3 summary cleared
    expect(clearSpy.mock.calls.length).toBe(clearsAfterBootstrap + 1); // the upgrade clear
    storeB.setEntry('b.ts', 'hash-b', summaryFor(4));

    // Process A again, still memoized at generation 3: its summary writes
    // must not persist (read-through) but hashes must, so change detection
    // keeps working.
    setSummarizerGenerationForTests(3);
    storeA.setEntry('c.ts', 'hash-c', summaryFor(3));
    expect(storeA.getEntry('c.ts')?.hash).toBe('hash-c');
    expect(storeA.getEntry('c.ts')?.summary).toBeNull();

    // A re-writes b.ts at the same hash: B's newer summary is preserved, not
    // overwritten and not nulled.
    storeA.setEntry('b.ts', 'hash-b', summaryFor(3));
    expect(storeA.getEntry('b.ts')?.summary?.purpose).toBe('gen4');

    // A re-runs its generation check (memo no longer matches): it must not
    // clear and must not regress the tag.
    clearSummaryGenerationCache();
    ensureSummaryGeneration(tempDir);
    expect(storeA.getMeta(GENERATION_META_KEY)).toBe('ast:4');
    expect(clearSpy.mock.calls.length).toBe(clearsAfterBootstrap + 1);

    // B re-checks: tag already current, nothing to do.
    setSummarizerGenerationForTests(4);
    clearSummaryGenerationCache();
    ensureSummaryGeneration(tempDir);
    expect(clearSpy.mock.calls.length).toBe(clearsAfterBootstrap + 1);

    // Final state: exactly one clear for the upgrade, only gen-4 summaries.
    const persisted = new CacheStore(tempDir).getAllEntries().filter((e) => e.summary !== null);
    expect(persisted.map((e) => `${e.path}:${e.summary?.purpose}`)).toEqual(['b.ts:gen4']);
  });

  it('strips summaries (but keeps hashes) from lower-generation batch writes', () => {
    setSummarizerGenerationForTests(4);
    ensureSummaryGeneration(tempDir);

    setSummarizerGenerationForTests(3);
    const store = new CacheStore(tempDir);
    store.setEntries([
      { path: 'x.ts', hash: 'hash-x', summary: summaryFor(3) },
      { path: 'y.ts', hash: 'hash-y' },
    ]);

    expect(store.getEntry('x.ts')?.hash).toBe('hash-x');
    expect(store.getEntry('x.ts')?.summary).toBeNull();
    expect(store.getEntry('y.ts')?.hash).toBe('hash-y');
    expect(store.getEntry('y.ts')?.summary).toBeNull();
  });

  it('compares generations numerically, not lexicographically', () => {
    setSummarizerGenerationForTests(10);
    ensureSummaryGeneration(tempDir);
    const store = new CacheStore(tempDir);
    expect(store.getMeta(GENERATION_META_KEY)).toBe('ast:10');

    // '9' > '10' as strings; numerically 9 < 10, so gen 9 must stand down.
    setSummarizerGenerationForTests(9);
    clearSummaryGenerationCache();
    ensureSummaryGeneration(tempDir);
    expect(store.getMeta(GENERATION_META_KEY)).toBe('ast:10');
    store.setEntry('z.ts', 'hash-z', summaryFor(9));
    expect(store.getEntry('z.ts')?.summary).toBeNull();

    // And gen 11 may upgrade.
    setSummarizerGenerationForTests(11);
    clearSummaryGenerationCache();
    ensureSummaryGeneration(tempDir);
    expect(store.getMeta(GENERATION_META_KEY)).toBe('ast:11');
  });

  it('treats an unparseable stored tag as upgradeable, never as newer', () => {
    const store = new CacheStore(tempDir);
    store.setMeta(GENERATION_META_KEY, 'not-a-tag');

    setSummarizerGenerationForTests(3);
    store.setEntry('a.ts', 'hash-a', summaryFor(3));
    expect(store.getEntry('a.ts')?.summary?.purpose).toBe('gen3'); // writes allowed

    ensureSummaryGeneration(tempDir);
    expect(store.getMeta(GENERATION_META_KEY)).toBe('ast:3'); // re-tagged
  });

  it('parses tags strictly', () => {
    expect(parseGenerationTag('ast:3')).toEqual({ mode: 'ast', generation: 3 });
    expect(parseGenerationTag('regex:12')).toEqual({ mode: 'regex', generation: 12 });
    expect(parseGenerationTag(null)).toBeNull();
    expect(parseGenerationTag('ast')).toBeNull();
    expect(parseGenerationTag('ast:')).toBeNull();
    expect(parseGenerationTag(':3')).toBeNull();
    expect(parseGenerationTag('ast:3:4')).toBeNull();
  });

  it('mode differences at the same generation are not "newer" (last-writer-wins)', () => {
    setSummarizerGenerationForTests(3);
    expect(isStoredGenerationNewer('regex:3')).toBe(false);
    expect(isStoredGenerationNewer('ast:3')).toBe(false);
    expect(isStoredGenerationNewer('regex:4')).toBe(true);
  });
});
