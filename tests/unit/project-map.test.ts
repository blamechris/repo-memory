import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildProjectMap } from '../../src/indexer/project-map.js';
import { closeDatabase } from '../../src/persistence/db.js';

function createTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-memory-test-'));

  mkdirSync(join(dir, 'src', 'utils'), { recursive: true });
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });

  writeFileSync(join(dir, 'package.json'), '{ "name": "test" }');
  writeFileSync(join(dir, 'README.md'), '# Test Project');

  writeFileSync(
    join(dir, 'src', 'index.ts'),
    'export function main(): void { console.log("hi"); }\n',
  );
  writeFileSync(
    join(dir, 'src', 'app.ts'),
    'import { helper } from "./utils/helper.js";\nexport const app = helper();\n',
  );
  writeFileSync(
    join(dir, 'src', 'utils', 'helper.ts'),
    'export function helper(): string { return "help"; }\n',
  );
  writeFileSync(
    join(dir, 'src', 'lib', 'index.ts'),
    'export { default } from "./core.js";\n',
  );
  writeFileSync(
    join(dir, 'src', 'lib', 'core.ts'),
    'export default class Core {}\n',
  );

  writeFileSync(join(dir, 'docs', 'guide.md'), '# Guide\nSome docs.');
  writeFileSync(join(dir, 'src', 'styles.css'), 'body { margin: 0; }');

  return dir;
}

describe('buildProjectMap', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempProject();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should count total files correctly', async () => {
    const map = await buildProjectMap(tempDir);
    expect(map.totalFiles).toBe(9);
  });

  it('should build directory tree with correct structure', async () => {
    const map = await buildProjectMap(tempDir);

    expect(map.tree.path).toBe('.');
    const childNames = map.tree.children.map((c) => c.name).sort();
    expect(childNames).toContain('docs');
    expect(childNames).toContain('src');
  });

  it('should identify entry points', async () => {
    const map = await buildProjectMap(tempDir);
    expect(map.entryPoints).toContain('src/index.ts');
    expect(map.entryPoints).toContain('src/lib/index.ts');
  });

  it('should compute language breakdown', async () => {
    const map = await buildProjectMap(tempDir);
    expect(map.languageBreakdown['.ts']).toBeGreaterThanOrEqual(5);
    expect(map.languageBreakdown['.json']).toBe(1);
    expect(map.languageBreakdown['.md']).toBeGreaterThanOrEqual(1);
    expect(map.languageBreakdown['.css']).toBe(1);
  });

  it('should respect depth parameter', async () => {
    const map = await buildProjectMap(tempDir, { depth: 1 });

    const srcNode = map.tree.children.find((c) => c.name === 'src');
    expect(srcNode).toBeDefined();
    // At depth 1, src's children (utils, lib) should not appear
    expect(srcNode!.children).toHaveLength(0);
  });

  it('should have accurate file counts in tree nodes', async () => {
    const map = await buildProjectMap(tempDir);
    expect(map.tree.fileCount).toBe(9);
  });

  it('should include size, lastModified, and confidence on file entries', async () => {
    const map = await buildProjectMap(tempDir);

    // Collect all file entries from the tree
    function collectFiles(node: typeof map.tree): typeof map.tree.files {
      let files = [...node.files];
      for (const child of node.children) {
        files = files.concat(collectFiles(child));
      }
      return files;
    }

    const allFiles = collectFiles(map.tree);
    expect(allFiles.length).toBeGreaterThan(0);

    for (const file of allFiles) {
      // size should be a positive number
      expect(file.size).toBeGreaterThan(0);
      // lastModified should be a valid epoch timestamp (after 2020-01-01)
      expect(file.lastModified).toBeGreaterThan(1577836800000);
      // confidence should be one of the known values
      expect(['high', 'medium', 'low']).toContain(file.confidence);
    }
  });

  it('should reuse cached summaries on repeated calls', async () => {
    const map1 = await buildProjectMap(tempDir);
    const map2 = await buildProjectMap(tempDir);
    expect(map1.totalFiles).toBe(map2.totalFiles);
    expect(map1.entryPoints).toEqual(map2.entryPoints);
  });
});
