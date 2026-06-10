import { describe, it, expect } from 'vitest';
import { summarizeFileAst, isAstSupported } from '../../src/indexer/ast-summarizer.js';
import { summarizeFile } from '../../src/indexer/summarizer.js';

describe('summarizeFileAst — Java', () => {
  it('reports .java files as AST-supported', () => {
    expect(isAstSupported('src/main/java/com/example/Arrow.java')).toBe(true);
  });

  describe('exports', () => {
    it('exports public types and the public members of the public type', async () => {
      const contents = [
        'package com.example.game;',
        '',
        'public class Arrow {',
        '    public static final int MAX_ARROWS = 6;',
        '    private int x;',
        '    public int y;',
        '',
        '    public Arrow(int x) {',
        '        this.x = x;',
        '    }',
        '',
        '    public double distance() {',
        '        return 0.0;',
        '    }',
        '',
        '    private void secret() {',
        '    }',
        '',
        '    static int packageVisible() {',
        '        return 1;',
        '    }',
        '}',
        '',
        'class Helper {',
        '    public void help() {',
        '    }',
        '}',
      ].join('\n');
      const summary = await summarizeFileAst('src/main/java/Arrow.java', contents);
      expect(summary.exports).toEqual(
        expect.arrayContaining(['Arrow', 'MAX_ARROWS', 'y', 'distance']),
      );
      expect(summary.exports).not.toContain('x');
      expect(summary.exports).not.toContain('secret');
      expect(summary.exports).not.toContain('packageVisible');
      // Helper is package-private: neither the type nor its members are exported.
      expect(summary.exports).not.toContain('Helper');
      expect(summary.exports).not.toContain('help');
    });

    it('exports public interfaces, enums and records', async () => {
      const contents = [
        'package com.example;',
        '',
        'public interface Scorer {',
        '    int score(int value);',
        '}',
        '',
        'enum Color { RED, GOLD }',
      ].join('\n');
      const summary = await summarizeFileAst('src/main/java/Scorer.java', contents);
      // Interface members are implicitly public.
      expect(summary.exports).toEqual(expect.arrayContaining(['Scorer', 'score']));
      expect(summary.exports).not.toContain('Color'); // package-private

      const record = await summarizeFileAst(
        'src/main/java/Point.java',
        [
          'package com.example;',
          '',
          'public record Point(int x, int y) {',
          '    public double norm() {',
          '        return 0;',
          '    }',
          '}',
        ].join('\n'),
      );
      expect(record.exports).toEqual(expect.arrayContaining(['Point', 'norm']));
    });
  });

  describe('imports', () => {
    it('extracts plain, wildcard and static imports', async () => {
      const contents = [
        'package com.example.app;',
        '',
        'import java.util.List;',
        'import java.util.*;',
        'import static java.lang.Math.max;',
        '',
        'public class App {',
        '}',
      ].join('\n');
      const summary = await summarizeFileAst('src/main/java/App.java', contents);
      expect(summary.imports).toEqual(
        expect.arrayContaining(['java.util.List', 'java.util', 'java.lang.Math.max']),
      );
    });
  });

  describe('declarations', () => {
    it('records classes, interfaces, enums and records with their kinds', async () => {
      const contents = [
        'package com.example.decls;',
        '',
        'public class Widget {',
        '}',
        '',
        'interface Renderer {',
        '}',
        '',
        'enum Mode { ON, OFF }',
        '',
        'record Pair(int a, int b) {',
        '}',
      ].join('\n');
      const summary = await summarizeFileAst('src/main/java/Widget.java', contents);
      expect(summary.topLevelDeclarations).toEqual(
        expect.arrayContaining(['class Widget', 'interface Renderer', 'enum Mode', 'record Pair']),
      );
    });
  });

  describe('purpose generation', () => {
    it('describes a class with methods using its Javadoc first sentence', async () => {
      const contents = [
        'package com.example.game;',
        '',
        'import java.util.List;',
        '',
        '/**',
        ' * An arrow fired at a target. Tracks position.',
        ' */',
        'public class Arrow {',
        '    public double distance() {',
        '        return 0.0;',
        '    }',
        '',
        '    public int ring() {',
        '        return 1;',
        '    }',
        '',
        '    private void reset() {',
        '    }',
        '}',
      ].join('\n');
      const summary = await summarizeFileAst('src/main/java/Arrow.java', contents);
      expect(summary.purpose).toBe('class Arrow (3 methods): An arrow fired at a target.');
      expect(summary.confidence).toBe('high');
    });

    it('describes an interface with its Javadoc', async () => {
      const contents = [
        'package com.example;',
        '',
        '/** Scores a single end. */',
        'public interface Scorer {',
        '    int score(int value);',
        '}',
      ].join('\n');
      const summary = await summarizeFileAst('src/main/java/Scorer.java', contents);
      expect(summary.purpose).toBe('interface Scorer (1 method): Scores a single end.');
    });

    it('marks test files and static-main entry points', async () => {
      const test = await summarizeFileAst(
        'src/test/java/com/example/ArrowTest.java',
        'package com.example;\n\npublic class ArrowTest {\n}\n',
      );
      expect(test.purpose.startsWith('test')).toBe(true);

      const main = await summarizeFileAst(
        'src/main/java/com/example/Launcher.java',
        [
          'package com.example;',
          '',
          'public class Launcher {',
          '    public static void main(String[] args) {',
          '    }',
          '}',
        ].join('\n'),
      );
      expect(main.purpose.startsWith('entry point')).toBe(true);
    });
  });

  describe('fallback behavior', () => {
    it('falls back to the regex summarizer on parse errors', async () => {
      const broken = 'public class Broken {{{ void (\n';
      const astResult = await summarizeFileAst('src/main/java/Broken.java', broken);
      const regexResult = summarizeFile('src/main/java/Broken.java', broken);
      expect(astResult).toEqual(regexResult);
    });

    it('delegates empty files to the regex summarizer', async () => {
      const summary = await summarizeFileAst('src/main/java/Empty.java', '');
      expect(summary.lineCount).toBe(0);
      expect(summary.confidence).toBe('low');
    });
  });
});
