import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { closeDatabase } from '../../src/persistence/db.js';

/**
 * Guardian I9: two processes opening a fresh database concurrently must both
 * run the migrations safely and exit 0. Before the BEGIN IMMEDIATE +
 * in-transaction version re-read fix, the loser of the race crashed on the
 * schema_version PRIMARY KEY constraint — exactly the documented workflow of
 * an MCP server starting while a post-merge hook prewarms the cache.
 *
 * The persistence module is compiled standalone into node_modules/.cache so
 * the children run real `node` processes without needing a full dist/ build.
 */

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const harnessDir = join(projectRoot, 'node_modules', '.cache', 'repo-memory-migration-race');
const childScript = join(harnessDir, 'child.mjs');

const CHILD_SOURCE = `import { getDatabase, closeDatabase } from './db.js';

const projectDir = process.argv[2];
getDatabase(projectDir);
closeDatabase();
`;

function runChild(projectDir: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childScript, projectDir], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('concurrent first-run migrations (multi-process)', () => {
  beforeAll(() => {
    closeDatabase();
    rmSync(harnessDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    mkdirSync(harnessDir, { recursive: true });
    execFileSync(
      process.execPath,
      [
        join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
        'src/persistence/db.ts',
        '--outDir',
        harnessDir,
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        '--target',
        'es2022',
        '--skipLibCheck',
      ],
      { cwd: projectRoot },
    );
    // Pin the harness to ESM regardless of what else lives under .cache.
    writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(childScript, CHILD_SOURCE);
  });

  afterAll(() => {
    closeDatabase();
    rmSync(harnessDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('multiple processes racing on a fresh database all exit 0 and migrations apply once', async () => {
    // A few rounds to give the processes a real chance to collide.
    for (let round = 0; round < 3; round++) {
      const projectDir = mkdtempSync(join(tmpdir(), 'migration-race-'));
      try {
        const results = await Promise.all(
          Array.from({ length: 4 }, () => runChild(projectDir)),
        );
        for (const result of results) {
          expect(result.code, result.stderr).toBe(0);
        }

        const db = new Database(join(projectDir, '.repo-memory', 'cache.db'), {
          readonly: true,
        });
        const versions = (
          db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{
            version: number;
          }>
        ).map((r) => r.version);
        db.close();

        // Applied exactly once each, contiguous from 1.
        expect(versions).toEqual(Array.from({ length: versions.length }, (_, i) => i + 1));
        expect(versions.length).toBeGreaterThanOrEqual(6);
      } finally {
        closeDatabase();
        rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  });
});
