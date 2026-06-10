import { describe, it, expect } from 'vitest';
import { summarizeFileAst, isAstSupported } from '../../src/indexer/ast-summarizer.js';
import { summarizeFile } from '../../src/indexer/summarizer.js';

describe('summarizeFileAst — Python', () => {
  it('reports .py files as AST-supported', () => {
    expect(isAstSupported('src/app.py')).toBe(true);
  });

  describe('exports', () => {
    it('uses __all__ as the export list when present', async () => {
      const contents = [
        '__all__ = ["public_fn", "Widget"]',
        '',
        'def public_fn():',
        '    pass',
        '',
        'def also_public():',
        '    pass',
        '',
        'class Widget:',
        '    pass',
      ].join('\n');
      const summary = await summarizeFileAst('src/api.py', contents);
      expect(summary.exports).toEqual(['public_fn', 'Widget']);
    });

    it('falls back to top-level non-underscore names without __all__', async () => {
      const contents = [
        'MAX_SIZE = 10',
        '_internal = 1',
        '',
        'async def fetch():',
        '    pass',
        '',
        'def _private():',
        '    pass',
        '',
        'class Engine:',
        '    pass',
        '',
        'class _Hidden:',
        '    pass',
      ].join('\n');
      const summary = await summarizeFileAst('src/engine.py', contents);
      expect(summary.exports).toEqual(expect.arrayContaining(['MAX_SIZE', 'fetch', 'Engine']));
      expect(summary.exports).not.toContain('_internal');
      expect(summary.exports).not.toContain('_private');
      expect(summary.exports).not.toContain('_Hidden');
    });

    it('includes decorated and async definitions', async () => {
      const contents = [
        'import functools',
        '',
        '@functools.cache',
        'def cached():',
        '    pass',
        '',
        '@decorator',
        'class Service:',
        '    pass',
        '',
        'async def run():',
        '    pass',
      ].join('\n');
      const summary = await summarizeFileAst('src/svc.py', contents);
      expect(summary.exports).toEqual(expect.arrayContaining(['cached', 'Service', 'run']));
      expect(summary.topLevelDeclarations).toEqual(
        expect.arrayContaining(['def cached', 'class Service', 'def run']),
      );
    });
  });

  describe('imports', () => {
    it('extracts import, dotted, aliased and from-imports', async () => {
      const contents = [
        'import os',
        'import os.path as osp',
        'from typing import List, Optional',
        'from . import sibling',
        'from ..pkg import helper',
        '',
        'x = os.getcwd()',
      ].join('\n');
      const summary = await summarizeFileAst('src/app.py', contents);
      expect(summary.imports).toEqual(
        expect.arrayContaining(['os', 'os.path', 'typing', '.', '..pkg']),
      );
    });

    it('does not match imports inside docstrings (regex weakness)', async () => {
      const contents = [
        'def helper():',
        '    """Usage:',
        'import fake_module',
        '    """',
        '    return 1',
      ].join('\n');
      const summary = await summarizeFileAst('src/doc.py', contents);
      expect(summary.imports).toEqual([]);
    });
  });

  describe('declarations', () => {
    it('records top-level defs and classes only', async () => {
      const contents = [
        'def outer():',
        '    def nested():',
        '        pass',
        '    return nested',
        '',
        'class Box:',
        '    def method(self):',
        '        pass',
      ].join('\n');
      const summary = await summarizeFileAst('src/decls.py', contents);
      expect(summary.topLevelDeclarations).toEqual(['def outer', 'class Box']);
    });
  });

  describe('purpose generation', () => {
    it('describes a class with method count and docstring first line', async () => {
      const contents = [
        'class Store:',
        '    """SQLite-backed cache entry CRUD."""',
        '',
        '    def __init__(self):',
        '        pass',
        '',
        '    def get(self):',
        '        pass',
        '',
        '    def put(self):',
        '        pass',
      ].join('\n');
      const summary = await summarizeFileAst('src/store.py', contents);
      expect(summary.purpose).toBe('class Store (2 methods): SQLite-backed cache entry CRUD.');
      expect(summary.confidence).toBe('high');
    });

    it('describes a function module using the module docstring', async () => {
      const contents = [
        '"""Compute deterministic hashes for cache keys."""',
        '',
        'def hash_file(path):',
        '    pass',
        '',
        'def hash_contents(data):',
        '    pass',
      ].join('\n');
      const summary = await summarizeFileAst('src/hash.py', contents);
      expect(summary.purpose).toContain('functions: hash_file, hash_contents');
      expect(summary.purpose).toContain('Compute deterministic hashes for cache keys.');
    });

    it('prefixes test files with the test category', async () => {
      const contents = 'def test_thing():\n    assert True\n';
      const summary = await summarizeFileAst('test_thing.py', contents);
      expect(summary.purpose.startsWith('test')).toBe(true);
    });

    it('recognizes __main__ guards as entry points', async () => {
      const contents = [
        'def main():',
        '    pass',
        '',
        "if __name__ == '__main__':",
        '    main()',
      ].join('\n');
      const summary = await summarizeFileAst('src/cli.py', contents);
      expect(summary.purpose.startsWith('entry point')).toBe(true);
    });
  });

  describe('fallback behavior', () => {
    it('falls back to the regex summarizer on parse errors', async () => {
      const broken = 'def broken(:\n    ((( pass\n';
      const astResult = await summarizeFileAst('src/broken.py', broken);
      const regexResult = summarizeFile('src/broken.py', broken);
      expect(astResult).toEqual(regexResult);
    });

    it('delegates empty files to the regex summarizer', async () => {
      const summary = await summarizeFileAst('src/empty.py', '');
      expect(summary.lineCount).toBe(0);
      expect(summary.confidence).toBe('low');
    });
  });
});
