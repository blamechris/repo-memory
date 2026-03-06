import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildProjectMap } from '../../src/indexer/project-map.js';
import { closeDatabase } from '../../src/persistence/db.js';

function createTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-memory-test-'));

  // Create directory structure
  mkdirSync(join(dir, 'src', 'utils'), { recursive: true });
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });

  // Root files
  writeFileSync(join(dir, 'package.json'), '{ "name": "test" }');
  writeFileSync(join(dir, 'README.md'), '# Test Project');

  // Source files
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

  // Docs
  writeFileSync(join(dir, 'docs', 'guide.md'), '# Guide\nSome docs.');

  // CSS file
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
    // package.json, README.md, src/index.ts, src/app.ts,
    // src/utils/helper.ts, src/lib/index.ts, src/lib/core.ts,
    // docs/guide.md, src/styles.css = 9
    expect(map.totalFiles).toBe(9);
  });

  it('should build a directory tree', async () => {
    const map = await buildProjectMap(tempDir);
    const tree = map.tree;

    expect(tree.path).toBe('.');
    expect(tree.fileCount).toBe(9);

    const srcNode = tree.children.find((c) => c.name === 'src');
    expect(srcNode).toBeDefined();
    expect(srcNode!.children.length).toBe(2); // utils, lib

    const docsNode = tree.children.find((c) => c.name === 'docs');
    expect(docsNode).toBeDefined();
    expect(docsNode!.files).toEqual([{ name: 'guide.md', purpose: 'documentation' }]);
  });

  it('should identify entry points', async () => {
    const map = await buildProjectMap(tempDir);
    // src/index.ts and src/lib/index.ts should be entry points
    expect(map.entryPoints).toContain('src/index.ts');
    expect(map.entryPoints).toContain('src/lib/index.ts');
  });

  it('should compute language breakdown by extension', async () => {
    const map = await buildProjectMap(tempDir);
    expect(map.languageBreakdown['.ts']).toBe(5);
    expect(map.languageBreakdown['.json']).toBe(1);
    expect(map.languageBreakdown['.md']).toBe(2);
    expect(map.languageBreakdown['.css']).toBe(1);
  });

  it('should respect depth parameter', async () => {
    const map = await buildProjectMap(tempDir, { depth: 1 });
    const tree = map.tree;

    // depth 0 = root, depth 1 = src, docs
    const srcNode = tree.children.find((c) => c.name === 'src');
    expect(srcNode).toBeDefined();
    // At depth 1, src should have no children (utils/lib would be depth 2)
    expect(srcNode!.children.length).toBe(0);
    // But root-level files and src direct files should still be present
    expect(tree.files.length).toBeGreaterThan(0);
  });

  it('should use cached summaries on second call', async () => {
    // First call populates the cache
    const map1 = await buildProjectMap(tempDir);
    // Second call should use cache
    const map2 = await buildProjectMap(tempDir);

    expect(map1.totalFiles).toBe(map2.totalFiles);
    expect(map1.entryPoints).toEqual(map2.entryPoints);
    expect(map1.languageBreakdown).toEqual(map2.languageBreakdown);
  });

  it('should work with the sample-project fixture', async () => {
    const fixtureDir = join(__dirname, '..', 'fixtures', 'sample-project');
    const map = await buildProjectMap(fixtureDir);

    // sample-project has: .gitignore, package.json, README.md, src/index.ts, src/utils.ts
    expect(map.totalFiles).toBeGreaterThanOrEqual(4);
    expect(map.entryPoints).toContain('src/index.ts');
    expect(map.languageBreakdown['.ts']).toBe(2);
  });
});
