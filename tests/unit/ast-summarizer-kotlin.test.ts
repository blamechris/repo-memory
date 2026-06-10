import { describe, it, expect } from 'vitest';
import { summarizeFileAst, isAstSupported } from '../../src/indexer/ast-summarizer.js';
import { summarizeFile } from '../../src/indexer/summarizer.js';

describe('summarizeFileAst — Kotlin', () => {
  it('reports .kt and .kts files as AST-supported', () => {
    expect(isAstSupported('app/src/main/kotlin/com/example/Scoring.kt')).toBe(true);
    expect(isAstSupported('scripts/deploy.kts')).toBe(true);
  });

  describe('exports', () => {
    it('exports public top-level declarations and excludes private/internal ones', async () => {
      const contents = [
        'package com.example.game',
        '',
        'class Visible {',
        '    fun show() {',
        '    }',
        '}',
        '',
        'private class Hidden',
        '',
        'internal class AlsoHidden',
        '',
        'fun computeScore(): Int = 0',
        '',
        'private fun helper() {',
        '}',
        '',
        'internal fun internalHelper() {',
        '}',
        '',
        'val MAX_ARROWS = 6',
        '',
        'private val secretVal = 1',
        '',
        'var counter = 0',
        '',
        'typealias ArrowList = List<Int>',
        '',
        'private typealias Secret = Int',
      ].join('\n');
      const summary = await summarizeFileAst('src/main/kotlin/Scoring.kt', contents);
      expect(summary.exports).toEqual(
        expect.arrayContaining(['Visible', 'computeScore', 'MAX_ARROWS', 'counter', 'ArrowList']),
      );
      expect(summary.exports).not.toContain('Hidden');
      expect(summary.exports).not.toContain('AlsoHidden');
      expect(summary.exports).not.toContain('helper');
      expect(summary.exports).not.toContain('internalHelper');
      expect(summary.exports).not.toContain('secretVal');
      expect(summary.exports).not.toContain('Secret');
    });

    it('exports objects, interfaces and enum classes', async () => {
      const contents = [
        'package com.example',
        '',
        'object Registry {',
        '    fun lookup(name: String): Int = 0',
        '}',
        '',
        'interface Scorer {',
        '    fun score(value: Int): Int',
        '}',
        '',
        'enum class Color { RED, GOLD }',
        '',
        'private object SecretRegistry',
      ].join('\n');
      const summary = await summarizeFileAst('src/main/kotlin/Registry.kt', contents);
      expect(summary.exports).toEqual(expect.arrayContaining(['Registry', 'Scorer', 'Color']));
      expect(summary.exports).not.toContain('SecretRegistry');
    });
  });

  describe('imports', () => {
    it('extracts dotted import paths, stripping wildcards and aliases', async () => {
      const contents = [
        'package com.example.app',
        '',
        'import kotlin.math.max',
        'import com.example.util.*',
        'import com.example.io.Reader as R',
        '',
        'fun run() {',
        '}',
      ].join('\n');
      const summary = await summarizeFileAst('src/main/kotlin/App.kt', contents);
      expect(summary.imports).toEqual(
        expect.arrayContaining(['kotlin.math.max', 'com.example.util', 'com.example.io.Reader']),
      );
    });
  });

  describe('declarations', () => {
    it('records classes, objects, functions, properties and typealiases with their kinds', async () => {
      const contents = [
        'package com.example.decls',
        '',
        'data class Arrow(val x: Int, val y: Int)',
        '',
        'class Plain',
        '',
        'interface Scorer',
        '',
        'enum class Color { RED }',
        '',
        'object Registry',
        '',
        'fun run() {',
        '}',
        '',
        'val limit = 5',
        '',
        'var count = 0',
        '',
        'typealias Ids = List<Int>',
      ].join('\n');
      const summary = await summarizeFileAst('src/main/kotlin/Decls.kt', contents);
      expect(summary.topLevelDeclarations).toEqual(
        expect.arrayContaining([
          'data class Arrow',
          'class Plain',
          'interface Scorer',
          'enum class Color',
          'object Registry',
          'fun run',
          'val limit',
          'var count',
          'typealias Ids',
        ]),
      );
    });
  });

  describe('purpose generation', () => {
    it('describes a data class with methods using its KDoc first sentence', async () => {
      const contents = [
        'package com.example.game',
        '',
        'import kotlin.math.max',
        '',
        '/**',
        ' * An arrow fired at a target. Tracks position.',
        ' */',
        'data class Arrow(val x: Int, val y: Int) {',
        '    fun distance(): Double = 0.0',
        '    fun ring(): Int = 1',
        '    fun score(): Int = max(0, ring())',
        '}',
      ].join('\n');
      const summary = await summarizeFileAst('src/main/kotlin/Arrow.kt', contents);
      expect(summary.purpose).toBe('data class Arrow (3 methods): An arrow fired at a target.');
      expect(summary.confidence).toBe('high');
    });

    it('counts companion-object functions as methods', async () => {
      const contents = [
        'package com.example.game',
        '',
        'class Arrow {',
        '    fun distance(): Double = 0.0',
        '    companion object {',
        '        fun fromString(s: String): Arrow = Arrow()',
        '    }',
        '}',
      ].join('\n');
      const summary = await summarizeFileAst('src/main/kotlin/Arrow.kt', contents);
      expect(summary.purpose).toBe('class Arrow (2 methods)');
    });

    it('describes function files with names and KDoc first sentence', async () => {
      const contents = [
        'package com.example.game',
        '',
        '/** Computes the score of an end. Higher is better. */',
        'fun computeScore(arrows: List<Int>): Int = arrows.size',
        '',
        '/** Formats an end for display. */',
        'fun formatEnd(arrows: List<Int>): String = ""',
      ].join('\n');
      const summary = await summarizeFileAst('src/main/kotlin/Score.kt', contents);
      expect(summary.purpose).toBe(
        'functions: computeScore, formatEnd — Computes the score of an end.',
      );
    });

    it('marks test files and main entry points', async () => {
      const test = await summarizeFileAst(
        'app/src/test/kotlin/com/example/ScoringTest.kt',
        'package com.example\n\nclass ScoringTest {\n    fun testScore() {\n    }\n}\n',
      );
      expect(test.purpose.startsWith('test')).toBe(true);

      const main = await summarizeFileAst(
        'app/src/main/kotlin/com/example/App.kt',
        'package com.example\n\nfun main() {\n}\n',
      );
      expect(main.purpose.startsWith('entry point')).toBe(true);
    });

    it('classifies Gradle Kotlin scripts as config', async () => {
      const summary = await summarizeFileAst(
        'build.gradle.kts',
        'plugins {\n    kotlin("jvm")\n}\n',
      );
      expect(summary.purpose.startsWith('config')).toBe(true);
    });
  });

  describe('fallback behavior', () => {
    it('falls back to the regex summarizer on parse errors', async () => {
      const broken = 'package x\n\nfun broken( {{{\n';
      const astResult = await summarizeFileAst('src/main/kotlin/Broken.kt', broken);
      const regexResult = summarizeFile('src/main/kotlin/Broken.kt', broken);
      expect(astResult).toEqual(regexResult);
    });

    it('delegates empty files to the regex summarizer', async () => {
      const summary = await summarizeFileAst('src/main/kotlin/Empty.kt', '');
      expect(summary.lineCount).toBe(0);
      expect(summary.confidence).toBe('low');
    });
  });
});
