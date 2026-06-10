import { describe, it, expect } from 'vitest';
import { summarizeFileAst, isAstSupported } from '../../src/indexer/ast-summarizer.js';
import { summarizeFile } from '../../src/indexer/summarizer.js';

describe('summarizeFileAst', () => {
  describe('exports', () => {
    it('extracts named exports of all declaration kinds', async () => {
      const contents = [
        'export const X = 1, Y = 2;',
        'export let mut = 3;',
        'export function run() {}',
        'export async function go() {}',
        'export function* gen() {}',
        'export class Widget {}',
        'export abstract class Base {}',
        'export interface Shape {}',
        'export type Alias = string;',
        'export enum Color { Red }',
      ].join('\n');
      const summary = await summarizeFileAst('src/all-exports.ts', contents);
      expect(summary.exports).toEqual(
        expect.arrayContaining([
          'X',
          'Y',
          'mut',
          'run',
          'go',
          'gen',
          'Widget',
          'Base',
          'Shape',
          'Alias',
          'Color',
        ]),
      );
      expect(summary.confidence).toBe('high');
    });

    it('extracts default exports (expression and named declaration)', async () => {
      const expr = await summarizeFileAst('src/a.ts', 'const a = 1;\nexport default a;\n');
      expect(expr.exports).toContain('default');

      const named = await summarizeFileAst(
        'src/b.ts',
        'export default function main() { return 1; }\n',
      );
      expect(named.exports).toContain('default');
      expect(named.exports).toContain('main');
    });

    it('extracts export clauses with aliases', async () => {
      const contents = 'const a = 1;\nconst b = 2;\nexport { a, b as renamed };\n';
      const summary = await summarizeFileAst('src/clause.ts', contents);
      expect(summary.exports).toContain('a');
      expect(summary.exports).toContain('renamed');
      expect(summary.exports).not.toContain('b');
    });

    it('extracts re-exports and records their source as an import', async () => {
      const contents = [
        "export { one, two as three } from './nums.js';",
        "export * from './star.js';",
        "export * as ns from './ns.js';",
      ].join('\n');
      const summary = await summarizeFileAst('src/re.ts', contents);
      expect(summary.exports).toEqual(expect.arrayContaining(['one', 'three', 'ns']));
      expect(summary.imports).toEqual(
        expect.arrayContaining(['./nums.js', './star.js', './ns.js']),
      );
    });

    it('does not invent exports from strings or comments (regex weakness)', async () => {
      const contents = [
        'const sql = `',
        'export const FAKE = 1;',
        '`;',
        '// export function alsoFake() {}',
        'export const real = sql;',
      ].join('\n');
      const summary = await summarizeFileAst('src/tricky.ts', contents);
      expect(summary.exports).toEqual(['real']);
    });
  });

  describe('imports', () => {
    it('extracts static, namespace, type-only and side-effect imports', async () => {
      const contents = [
        "import { join } from 'node:path';",
        "import Database from 'better-sqlite3';",
        "import * as fs from 'fs';",
        "import type { Foo } from './foo.js';",
        "import './side-effect.js';",
        'export const x = join;',
      ].join('\n');
      const summary = await summarizeFileAst('src/imports.ts', contents);
      expect(summary.imports).toEqual(
        expect.arrayContaining([
          'node:path',
          'better-sqlite3',
          'fs',
          './foo.js',
          './side-effect.js',
        ]),
      );
    });
  });

  describe('top-level declarations', () => {
    it('records kind and name for classes, functions and consts', async () => {
      const contents = [
        'const limit = 10;',
        'let counter = 0;',
        'function helper() {}',
        'class Engine { start() {} stop() {} }',
        'interface Options {}',
        'type Mode = string;',
        'enum Level { Low }',
      ].join('\n');
      const summary = await summarizeFileAst('src/decls.ts', contents);
      expect(summary.topLevelDeclarations).toEqual(
        expect.arrayContaining([
          'const limit',
          'let counter',
          'function helper',
          'class Engine',
          'interface Options',
          'type Mode',
          'enum Level',
        ]),
      );
    });

    it('does not report nested declarations as top-level', async () => {
      const contents = [
        'export function outer() {',
        '  const inner = 1;',
        '  function nested() {}',
        '  return inner + nested();',
        '}',
      ].join('\n');
      const summary = await summarizeFileAst('src/nested.ts', contents);
      expect(summary.topLevelDeclarations).toEqual(['function outer']);
    });
  });

  describe('purpose generation', () => {
    it('describes a class file with method count and JSDoc first line', async () => {
      const contents = [
        '/** SQLite-backed cache entry CRUD. */',
        'export class CacheStore {',
        '  constructor() {}',
        '  getEntry() {}',
        '  setEntry() {}',
        '  deleteEntry() {}',
        '}',
      ].join('\n');
      const summary = await summarizeFileAst('src/cache/store.ts', contents);
      expect(summary.purpose).toBe('class CacheStore (3 methods): SQLite-backed cache entry CRUD.');
    });

    it('describes a function module using the file header comment', async () => {
      const contents = [
        '/**',
        ' * Compute deterministic hashes for cache keys.',
        ' */',
        'export function hashFile() {}',
        'export function hashContents() {}',
      ].join('\n');
      const summary = await summarizeFileAst('src/cache/hash.ts', contents);
      expect(summary.purpose).toContain('functions: hashFile, hashContents');
      expect(summary.purpose).toContain('Compute deterministic hashes for cache keys.');
    });

    it('describes a types-only file by its type names', async () => {
      const contents = [
        'export interface CacheEntry { path: string }',
        'export interface FileSummary { purpose: string }',
        'export type Confidence = "high" | "low";',
      ].join('\n');
      const summary = await summarizeFileAst('src/types.ts', contents);
      expect(summary.purpose).toContain('types');
      expect(summary.purpose).toContain('CacheEntry');
    });

    it('keeps the entry point category recognizable', async () => {
      const summary = await summarizeFileAst('src/index.ts', "export * from './lib.js';\n");
      expect(summary.purpose.startsWith('entry point')).toBe(true);
    });

    it('prefixes test files with the test category', async () => {
      const contents = "import { describe } from 'vitest';\nconst x = 1;\n";
      const summary = await summarizeFileAst('tests/unit/foo.test.ts', contents);
      expect(summary.purpose.startsWith('test')).toBe(true);
    });
  });

  describe('fallback behavior', () => {
    it('falls back to the regex summarizer on parse errors', async () => {
      const broken = 'export class {{{ not valid typescript ((((\nconst = ;\n';
      const astResult = await summarizeFileAst('src/broken.ts', broken);
      const regexResult = summarizeFile('src/broken.ts', broken);
      expect(astResult).toEqual(regexResult);
    });

    it('delegates unsupported extensions to the regex summarizer', async () => {
      const contents = 'def main\n  puts "hi"\nend\n';
      const astResult = await summarizeFileAst('src/script.rb', contents);
      const regexResult = summarizeFile('src/script.rb', contents);
      expect(astResult).toEqual(regexResult);
      expect(isAstSupported('src/script.rb')).toBe(false);
    });

    it('delegates empty files to the regex summarizer', async () => {
      const summary = await summarizeFileAst('src/empty.ts', '');
      expect(summary.lineCount).toBe(0);
      expect(summary.confidence).toBe('low');
    });
  });

  describe('tsx support', () => {
    it('parses .tsx files with JSX syntax', async () => {
      const contents = [
        "import React from 'react';",
        '',
        '/** Top navigation bar. */',
        'export function NavBar({ title }: { title: string }) {',
        '  return <nav className="bar"><h1>{title}</h1></nav>;',
        '}',
        '',
        'export default NavBar;',
      ].join('\n');
      const summary = await summarizeFileAst('src/components/NavBar.tsx', contents);
      expect(summary.confidence).toBe('high');
      expect(summary.exports).toEqual(expect.arrayContaining(['NavBar', 'default']));
      expect(summary.imports).toContain('react');
      expect(summary.topLevelDeclarations).toContain('function NavBar');
      expect(summary.purpose).toContain('NavBar');
      expect(summary.purpose).toContain('Top navigation bar.');
      expect(isAstSupported('src/components/NavBar.tsx')).toBe(true);
    });
  });

  it('reports an accurate line count', async () => {
    const contents = 'const a = 1;\nconst b = 2;\nexport { a, b };\n';
    const summary = await summarizeFileAst('src/lines.ts', contents);
    expect(summary.lineCount).toBe(contents.split('\n').length);
  });
});
