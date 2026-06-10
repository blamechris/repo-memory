import { describe, it, expect } from 'vitest';
import { summarizeFileAst, isAstSupported } from '../../src/indexer/ast-summarizer.js';
import { summarizeFile } from '../../src/indexer/summarizer.js';

describe('summarizeFileAst — Go', () => {
  it('reports .go files as AST-supported', () => {
    expect(isAstSupported('pkg/widgets/widgets.go')).toBe(true);
  });

  describe('exports', () => {
    it('exports capitalized top-level func/type/var/const names only', async () => {
      const contents = [
        'package widgets',
        '',
        'func ParseFoo(s string) error { return nil }',
        '',
        'func helper() {}',
        '',
        'type Widget struct{ Name string }',
        '',
        'type internal struct{}',
        '',
        'var Registry = map[string]int{}',
        '',
        'const MaxSize = 10',
        '',
        'const minSize = 1',
      ].join('\n');
      const summary = await summarizeFileAst('pkg/widgets/widgets.go', contents);
      expect(summary.exports).toEqual(
        expect.arrayContaining(['ParseFoo', 'Widget', 'Registry', 'MaxSize']),
      );
      expect(summary.exports).not.toContain('helper');
      expect(summary.exports).not.toContain('internal');
      expect(summary.exports).not.toContain('minSize');
    });

    it('exports capitalized names inside grouped var/const blocks (regex weakness)', async () => {
      const contents = [
        'package config',
        '',
        'var (',
        '\tGroupedVar = 1',
        '\tprivateVar = 2',
        ')',
        '',
        'const (',
        '\tGroupedConst = 1',
        ')',
      ].join('\n');
      const summary = await summarizeFileAst('pkg/config/config.go', contents);
      expect(summary.exports).toEqual(expect.arrayContaining(['GroupedVar', 'GroupedConst']));
      expect(summary.exports).not.toContain('privateVar');
    });

    it('includes exported method names', async () => {
      const contents = [
        'package widgets',
        '',
        'type Widget struct{}',
        '',
        'func (w *Widget) Render() string { return "" }',
        '',
        'func (w *Widget) reset() {}',
      ].join('\n');
      const summary = await summarizeFileAst('pkg/widgets/render.go', contents);
      expect(summary.exports).toContain('Render');
      expect(summary.exports).not.toContain('reset');
    });
  });

  describe('imports', () => {
    it('extracts single, aliased and grouped imports', async () => {
      const contents = [
        'package app',
        '',
        'import "os"',
        '',
        'import (',
        '\t"fmt"',
        '\tstr "strings"',
        '\t"github.com/example/pkg"',
        ')',
      ].join('\n');
      const summary = await summarizeFileAst('cmd/app/imports.go', contents);
      expect(summary.imports).toEqual(
        expect.arrayContaining(['os', 'fmt', 'strings', 'github.com/example/pkg']),
      );
    });
  });

  describe('declarations', () => {
    it('records funcs, types, vars and consts with their kinds', async () => {
      const contents = [
        'package decls',
        '',
        'func Run() {}',
        '',
        'type Widget struct{}',
        '',
        'type Reader interface{}',
        '',
        'type ID int',
        '',
        'var count = 0',
        '',
        'const limit = 5',
      ].join('\n');
      const summary = await summarizeFileAst('pkg/decls/decls.go', contents);
      expect(summary.topLevelDeclarations).toEqual(
        expect.arrayContaining([
          'func Run',
          'type Widget struct',
          'type Reader interface',
          'type ID',
          'var count',
          'const limit',
        ]),
      );
    });
  });

  describe('purpose generation', () => {
    it('describes function files with names and doc-comment first sentence', async () => {
      const contents = [
        'package parse',
        '',
        '// ParseFoo parses foo values. It returns an error on bad input.',
        'func ParseFoo(s string) error { return nil }',
        '',
        '// WriteBar writes bar values.',
        'func WriteBar(s string) error { return nil }',
      ].join('\n');
      const summary = await summarizeFileAst('pkg/parse/parse.go', contents);
      expect(summary.purpose).toBe(
        'functions: ParseFoo, WriteBar — ParseFoo parses foo values.',
      );
      expect(summary.confidence).toBe('high');
    });

    it('describes a struct with methods using its doc comment', async () => {
      const contents = [
        'package widgets',
        '',
        '// Widget is a renderable thing.',
        'type Widget struct{ Name string }',
        '',
        'func (w *Widget) Render() string { return "" }',
        '',
        'func (w *Widget) Reset() {}',
      ].join('\n');
      const summary = await summarizeFileAst('pkg/widgets/widget.go', contents);
      expect(summary.purpose).toBe('struct Widget (2 methods): Widget is a renderable thing.');
    });

    it('falls back to the package doc comment when symbols lack docs', async () => {
      const contents = [
        '// Package mathy provides arithmetic helpers.',
        'package mathy',
        '',
        'func Add(a, b int) int { return a + b }',
      ].join('\n');
      const summary = await summarizeFileAst('pkg/mathy/mathy.go', contents);
      expect(summary.purpose).toBe('function Add — Package mathy provides arithmetic helpers.');
    });

    it('marks main packages and test files', async () => {
      const main = await summarizeFileAst(
        'cmd/app/main.go',
        'package main\n\nfunc main() {}\n',
      );
      expect(main.purpose.startsWith('entry point')).toBe(true);

      const test = await summarizeFileAst(
        'pkg/widgets/widget_test.go',
        'package widgets\n\nfunc TestRender(t *testing.T) {}\n',
      );
      expect(test.purpose.startsWith('test')).toBe(true);
    });
  });

  describe('fallback behavior', () => {
    it('falls back to the regex summarizer on parse errors', async () => {
      const broken = 'package x\nfunc broken( {{{\n';
      const astResult = await summarizeFileAst('pkg/x/broken.go', broken);
      const regexResult = summarizeFile('pkg/x/broken.go', broken);
      expect(astResult).toEqual(regexResult);
    });

    it('delegates empty files to the regex summarizer', async () => {
      const summary = await summarizeFileAst('pkg/x/empty.go', '');
      expect(summary.lineCount).toBe(0);
      expect(summary.confidence).toBe('low');
    });
  });
});
