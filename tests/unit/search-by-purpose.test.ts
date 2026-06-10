import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { hashContents } from '../../src/cache/hash.js';
import { CacheStore } from '../../src/cache/store.js';
import { clearConfigCache } from '../../src/config.js';
import { clearSummaryGenerationCache } from '../../src/indexer/summarize.js';
import { TelemetryTracker } from '../../src/telemetry/tracker.js';
import { getFileSummary } from '../../src/tools/get-file-summary.js';
import { searchByPurpose } from '../../src/tools/search-by-purpose.js';

describe('searchByPurpose', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'repo-memory-search-'));
    await mkdir(join(tempDir, 'src'), { recursive: true });
    await mkdir(join(tempDir, 'src/auth'), { recursive: true });
    await mkdir(join(tempDir, 'src/db'), { recursive: true });

    // Create files with known content for cache population
    await writeFile(
      join(tempDir, 'src/auth/middleware.ts'),
      `export function authMiddleware() { return true; }\nexport function validateToken(token: string) { return !!token; }\n`,
    );
    await writeFile(
      join(tempDir, 'src/db/connection.ts'),
      `export class DatabaseConnection {\n  connect() {}\n  disconnect() {}\n}\nexport function createPool() {}\n`,
    );
    await writeFile(
      join(tempDir, 'src/db/queries.ts'),
      `export function findUserById(id: string) {}\nexport function insertRecord(table: string, data: unknown) {}\n`,
    );
    await writeFile(
      join(tempDir, 'src/auth/validation.ts'),
      `export function validateEmail(email: string) { return true; }\nexport function validatePassword(pw: string) { return true; }\n`,
    );
    await writeFile(
      join(tempDir, 'src/index.ts'),
      `export { authMiddleware } from './auth/middleware.js';\nexport { DatabaseConnection } from './db/connection.js';\n`,
    );

    // Populate cache by summarizing all files
    await getFileSummary(tempDir, 'src/auth/middleware.ts');
    await getFileSummary(tempDir, 'src/db/connection.ts');
    await getFileSummary(tempDir, 'src/db/queries.ts');
    await getFileSummary(tempDir, 'src/auth/validation.ts');
    await getFileSummary(tempDir, 'src/index.ts');
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('matches on purpose field', async () => {
    // index.ts has purpose "entry point"
    const result = await searchByPurpose(tempDir, 'entry');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    const entryResult = result.results.find(r => r.path === 'src/index.ts');
    expect(entryResult).toBeDefined();
    expect(entryResult!.matchedOn).toContain('purpose');
  });

  it('matches on exports field', async () => {
    const result = await searchByPurpose(tempDir, 'authMiddleware');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    const matched = result.results.find(r => r.path === 'src/auth/middleware.ts');
    expect(matched).toBeDefined();
    expect(matched!.matchedOn).toContain('exports');
  });

  it('matches on declarations field', async () => {
    const result = await searchByPurpose(tempDir, 'DatabaseConnection');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    const matched = result.results.find(r => r.path === 'src/db/connection.ts');
    expect(matched).toBeDefined();
    expect(matched!.matchedOn).toContain('declarations');
  });

  it('returns matchedOn array correctly with multiple field matches', async () => {
    // "validate" should match exports like validateToken, validateEmail, validatePassword
    // and declarations with the same names
    const result = await searchByPurpose(tempDir, 'validate');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    for (const r of result.results) {
      expect(r.matchedOn.length).toBeGreaterThanOrEqual(1);
      // Each matchedOn entry should be one of the valid field names
      for (const field of r.matchedOn) {
        expect(['purpose', 'exports', 'declarations']).toContain(field);
      }
    }
  });

  it('respects limit', async () => {
    // Search broadly to get multiple results
    const result = await searchByPurpose(tempDir, 'source', 2);
    expect(result.results.length).toBeLessThanOrEqual(2);
  });

  it('returns empty results for no matches', async () => {
    const result = await searchByPurpose(tempDir, 'xyznonexistent');
    expect(result.results).toEqual([]);
    expect(result.query).toBe('xyznonexistent');
    expect(result.totalCached).toBeGreaterThan(0);
  });

  it('multiple query terms boost score', async () => {
    // "validate" matches validation.ts and middleware.ts (validateToken)
    // "email" only matches validation.ts
    // So "validate email" should rank validation.ts higher
    const result = await searchByPurpose(tempDir, 'validate email');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0].path).toBe('src/auth/validation.ts');
  });

  it('returns totalCached count', async () => {
    const result = await searchByPurpose(tempDir, 'source');
    expect(result.totalCached).toBe(5);
  });

  it('returns query in result', async () => {
    const result = await searchByPurpose(tempDir, 'database');
    expect(result.query).toBe('database');
  });

  it('uses default limit of 20', async () => {
    const result = await searchByPurpose(tempDir, 'source');
    // We only have 5 files, so all should be returned
    expect(result.results.length).toBeLessThanOrEqual(20);
  });

  it('tracks ONE summary_served event per query, not per hit', async () => {
    const tracker = new TelemetryTracker(tempDir);
    const before = tracker.getEvents({ eventType: 'summary_served' }).length;

    const result = await searchByPurpose(tempDir, 'validate');
    expect(result.results.length).toBeGreaterThan(1);

    const after = tracker.getEvents({ eventType: 'summary_served' });
    expect(after.length).toBe(before + 1);

    // The single event books the estimated raw tokens of one average matched
    // file (the realistic counterfactual is reading ~1 file), not a sum over
    // every hit. (Pick by id: timestamp ordering can tie within a millisecond.)
    const event = after.reduce((a, b) => (b.id > a.id ? b : a));
    expect(event.tokensEstimated).toBeGreaterThan(0);
    expect(event.metadata).toMatchObject({ query: 'validate', resultCount: result.results.length });
  });

  it('tracks no summary_served event when nothing matched', async () => {
    const tracker = new TelemetryTracker(tempDir);
    const before = tracker.getEvents({ eventType: 'summary_served' }).length;

    const result = await searchByPurpose(tempDir, 'xyznonexistent');
    expect(result.results).toEqual([]);

    const after = tracker.getEvents({ eventType: 'summary_served' }).length;
    expect(after).toBe(before);
  });

  it('scopes results to a pathPrefix directory', async () => {
    // "validate" matches files in src/auth (validation.ts, middleware.ts) — scope to that dir.
    const result = await searchByPurpose(tempDir, 'validate', undefined, 'src/auth');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.every(r => r.path.startsWith('src/auth/'))).toBe(true);
    expect(result.scope).toBe('src/auth');
    // totalCached reflects the scoped subset (auth has 2 files), not all 5.
    expect(result.totalCached).toBe(2);
  });

  it('normalizes the pathPrefix (trailing slash, ./, and leading /)', async () => {
    const a = await searchByPurpose(tempDir, 'database', undefined, 'src/db/');
    const b = await searchByPurpose(tempDir, 'database', undefined, './src/db');
    const c = await searchByPurpose(tempDir, 'database', undefined, '/src/db');
    expect(a.scope).toBe('src/db');
    expect(b.scope).toBe('src/db');
    expect(c.scope).toBe('src/db');
    expect(a.results.every(r => r.path.startsWith('src/db/'))).toBe(true);
  });

  it('matches on a path boundary (prefix does not catch sibling names)', async () => {
    // "src/d" must NOT match "src/db/..." — only a full segment boundary counts.
    const result = await searchByPurpose(tempDir, 'database', undefined, 'src/d');
    expect(result.results).toEqual([]);
    expect(result.totalCached).toBe(0);
  });

  it('omits scope when no pathPrefix is given', async () => {
    const result = await searchByPurpose(tempDir, 'database');
    expect(result.scope).toBeUndefined();
  });

  it('matches Windows-style (backslash) stored paths against a forward-slash pathPrefix', async () => {
    // Simulate a cache populated on Windows, where path.relative() yields
    // backslash separators, by seeding an entry directly (the file exists with
    // its literal backslash name so freshness validation passes). A
    // forward-slash pathPrefix must still scope it.
    const winContents = 'export function handleRequest() {}\n';
    await writeFile(join(tempDir, 'src\\win\\handler.ts'), winContents);
    const store = new CacheStore(tempDir);
    store.setEntry('src\\win\\handler.ts', hashContents(winContents), {
      purpose: 'windows request handler',
      exports: ['handleRequest'],
      imports: [],
      lineCount: 10,
      topLevelDeclarations: ['handleRequest'],
      confidence: 'high',
    });

    const result = await searchByPurpose(tempDir, 'windows', undefined, 'src/win');
    expect(result.scope).toBe('src/win');
    expect(result.results.some(r => r.path === 'src\\win\\handler.ts')).toBe(true);
  });

  it('normalizes a Windows-style (backslash) pathPrefix to posix', async () => {
    const a = await searchByPurpose(tempDir, 'database', undefined, 'src\\db');
    expect(a.scope).toBe('src/db');
    expect(a.results.every(r => r.path.startsWith('src/db/'))).toBe(true);
  });
});

describe('searchByPurpose freshness validation (invariant I5)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'repo-memory-search-fresh-'));
    await mkdir(join(tempDir, 'src'), { recursive: true });
    clearConfigCache();
    clearSummaryGenerationCache();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    clearConfigCache();
    clearSummaryGenerationCache();
  });

  it('serves fresh exports/purpose after a file is edited post-cache, never stale', async () => {
    const path = 'src/users.ts';
    await writeFile(
      join(tempDir, path),
      `export function fetchUserData() {}\nexport function legacyHelper() {}\n`,
    );
    await getFileSummary(tempDir, path);

    // Edit the file behind the cache's back: the cached summary is now stale.
    await writeFile(join(tempDir, path), `export function fetchUserRecords() {}\n`);

    // "fetchuser" matches both the stale and the fresh exports, so the entry
    // must be regenerated and served fresh.
    const result = await searchByPurpose(tempDir, 'fetchUser');
    const match = result.results.find(r => r.path === path);
    expect(match).toBeDefined();
    expect(match!.exports).toContain('fetchUserRecords');
    expect(match!.exports).not.toContain('fetchUserData');
    expect(match!.exports).not.toContain('legacyHelper');

    // The cache entry was repaired through the standard path.
    const entry = new CacheStore(tempDir).getEntry(path);
    expect(entry!.hash).toBe(hashContents(`export function fetchUserRecords() {}\n`));
    expect(entry!.summary!.exports).toContain('fetchUserRecords');
  });

  it('drops a stale match whose regenerated summary no longer matches the query', async () => {
    const path = 'src/users.ts';
    await writeFile(join(tempDir, path), `export function legacyHelper() {}\n`);
    await getFileSummary(tempDir, path);

    // The new content no longer mentions "legacy" anywhere.
    await writeFile(join(tempDir, path), `export function fetchUserRecords() {}\n`);

    const result = await searchByPurpose(tempDir, 'legacyHelper');
    expect(result.results.find(r => r.path === path)).toBeUndefined();

    // The regenerated summary was still persisted for future lookups.
    const entry = new CacheStore(tempDir).getEntry(path);
    expect(entry!.summary!.exports).toContain('fetchUserRecords');
  });

  it('never returns a deleted file and evicts its cache entry', async () => {
    const path = 'src/ghost.ts';
    await writeFile(join(tempDir, path), `export function phantomFeature() {}\n`);
    await getFileSummary(tempDir, path);

    await rm(join(tempDir, path));

    const result = await searchByPurpose(tempDir, 'phantomFeature');
    expect(result.results.find(r => r.path === path)).toBeUndefined();
    expect(new CacheStore(tempDir).getEntry(path)).toBeNull();
  });

  it('backfills slots freed by dropped results so the caller still gets `limit` valid results', async () => {
    // gateway.ts outscores helper.ts on "payment refund" (matches both terms),
    // so it ranks first — then gets deleted. With limit 1, helper.ts must
    // backfill the freed slot.
    await writeFile(
      join(tempDir, 'src/gateway.ts'),
      `export function paymentGateway() {}\nexport function refundHandler() {}\n`,
    );
    await writeFile(join(tempDir, 'src/helper.ts'), `export function paymentHelper() {}\n`);
    await getFileSummary(tempDir, 'src/gateway.ts');
    await getFileSummary(tempDir, 'src/helper.ts');

    await rm(join(tempDir, 'src/gateway.ts'));

    const result = await searchByPurpose(tempDir, 'payment refund', 1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].path).toBe('src/helper.ts');
  });

  it('does not serve summaries from an invalidated generation after a summarizer mode switch', async () => {
    const path = 'src/auth.ts';
    await writeFile(join(tempDir, path), `export function validateToken() {}\n`);
    await getFileSummary(tempDir, path); // cached under the default (ast) generation

    const before = await searchByPurpose(tempDir, 'validateToken');
    expect(before.results).toHaveLength(1);

    // Switch summarizer mode: every stored summary belongs to a now-invalid
    // generation. (clearConfigCache mimics a fresh process seeing the file.)
    await writeFile(join(tempDir, '.repo-memory.json'), JSON.stringify({ summarizer: 'regex' }));
    clearConfigCache();

    // The search path must run the generation check itself: the old-generation
    // summary is invalidated (regenerates lazily) rather than served.
    const after = await searchByPurpose(tempDir, 'validateToken');
    expect(after.results).toEqual([]);
    expect(after.totalCached).toBe(0);
    const entry = new CacheStore(tempDir).getEntry(path);
    expect(entry).not.toBeNull();
    expect(entry!.summary).toBeNull(); // cleared, hash kept for lazy regeneration

    // And the standard summary path regenerates under the new generation.
    const regenerated = await getFileSummary(tempDir, path);
    expect(regenerated.fromCache).toBe(false);
  });
});
