import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getFileSummary } from '../../src/tools/get-file-summary.js';
import { searchByPurpose } from '../../src/tools/search-by-purpose.js';
import { CacheStore } from '../../src/cache/store.js';

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

  it('matches on purpose field', () => {
    // index.ts has purpose "entry point"
    const result = searchByPurpose(tempDir, 'entry');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    const entryResult = result.results.find(r => r.path === 'src/index.ts');
    expect(entryResult).toBeDefined();
    expect(entryResult!.matchedOn).toContain('purpose');
  });

  it('matches on exports field', () => {
    const result = searchByPurpose(tempDir, 'authMiddleware');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    const matched = result.results.find(r => r.path === 'src/auth/middleware.ts');
    expect(matched).toBeDefined();
    expect(matched!.matchedOn).toContain('exports');
  });

  it('matches on declarations field', () => {
    const result = searchByPurpose(tempDir, 'DatabaseConnection');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    const matched = result.results.find(r => r.path === 'src/db/connection.ts');
    expect(matched).toBeDefined();
    expect(matched!.matchedOn).toContain('declarations');
  });

  it('returns matchedOn array correctly with multiple field matches', () => {
    // "validate" should match exports like validateToken, validateEmail, validatePassword
    // and declarations with the same names
    const result = searchByPurpose(tempDir, 'validate');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    for (const r of result.results) {
      expect(r.matchedOn.length).toBeGreaterThanOrEqual(1);
      // Each matchedOn entry should be one of the valid field names
      for (const field of r.matchedOn) {
        expect(['purpose', 'exports', 'declarations']).toContain(field);
      }
    }
  });

  it('respects limit', () => {
    // Search broadly to get multiple results
    const result = searchByPurpose(tempDir, 'source', 2);
    expect(result.results.length).toBeLessThanOrEqual(2);
  });

  it('returns empty results for no matches', () => {
    const result = searchByPurpose(tempDir, 'xyznonexistent');
    expect(result.results).toEqual([]);
    expect(result.query).toBe('xyznonexistent');
    expect(result.totalCached).toBeGreaterThan(0);
  });

  it('multiple query terms boost score', () => {
    // "validate" matches validation.ts and middleware.ts (validateToken)
    // "email" only matches validation.ts
    // So "validate email" should rank validation.ts higher
    const result = searchByPurpose(tempDir, 'validate email');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0].path).toBe('src/auth/validation.ts');
  });

  it('returns totalCached count', () => {
    const result = searchByPurpose(tempDir, 'source');
    expect(result.totalCached).toBe(5);
  });

  it('returns query in result', () => {
    const result = searchByPurpose(tempDir, 'database');
    expect(result.query).toBe('database');
  });

  it('uses default limit of 20', () => {
    const result = searchByPurpose(tempDir, 'source');
    // We only have 5 files, so all should be returned
    expect(result.results.length).toBeLessThanOrEqual(20);
  });

  it('scopes results to a pathPrefix directory', () => {
    // "validate" matches files in src/auth (validation.ts, middleware.ts) — scope to that dir.
    const result = searchByPurpose(tempDir, 'validate', undefined, 'src/auth');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.every(r => r.path.startsWith('src/auth/'))).toBe(true);
    expect(result.scope).toBe('src/auth');
    // totalCached reflects the scoped subset (auth has 2 files), not all 5.
    expect(result.totalCached).toBe(2);
  });

  it('normalizes the pathPrefix (trailing slash, ./, and leading /)', () => {
    const a = searchByPurpose(tempDir, 'database', undefined, 'src/db/');
    const b = searchByPurpose(tempDir, 'database', undefined, './src/db');
    const c = searchByPurpose(tempDir, 'database', undefined, '/src/db');
    expect(a.scope).toBe('src/db');
    expect(b.scope).toBe('src/db');
    expect(c.scope).toBe('src/db');
    expect(a.results.every(r => r.path.startsWith('src/db/'))).toBe(true);
  });

  it('matches on a path boundary (prefix does not catch sibling names)', () => {
    // "src/d" must NOT match "src/db/..." — only a full segment boundary counts.
    const result = searchByPurpose(tempDir, 'database', undefined, 'src/d');
    expect(result.results).toEqual([]);
    expect(result.totalCached).toBe(0);
  });

  it('omits scope when no pathPrefix is given', () => {
    const result = searchByPurpose(tempDir, 'database');
    expect(result.scope).toBeUndefined();
  });

  it('matches Windows-style (backslash) stored paths against a forward-slash pathPrefix', () => {
    // Simulate a cache populated on Windows, where path.relative() yields
    // backslash separators, by seeding an entry directly. A forward-slash
    // pathPrefix must still scope it.
    const store = new CacheStore(tempDir);
    store.setEntry('src\\win\\handler.ts', 'deadbeef', {
      purpose: 'windows request handler',
      exports: ['handleRequest'],
      imports: [],
      lineCount: 10,
      topLevelDeclarations: ['handleRequest'],
      confidence: 'high',
    });

    const result = searchByPurpose(tempDir, 'windows', undefined, 'src/win');
    expect(result.scope).toBe('src/win');
    expect(result.results.some(r => r.path === 'src\\win\\handler.ts')).toBe(true);
  });

  it('normalizes a Windows-style (backslash) pathPrefix to posix', () => {
    const a = searchByPurpose(tempDir, 'database', undefined, 'src\\db');
    expect(a.scope).toBe('src/db');
    expect(a.results.every(r => r.path.startsWith('src/db/'))).toBe(true);
  });
});
