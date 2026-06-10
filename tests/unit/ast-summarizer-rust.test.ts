import { describe, it, expect } from 'vitest';
import { summarizeFileAst, isAstSupported } from '../../src/indexer/ast-summarizer.js';
import { summarizeFile } from '../../src/indexer/summarizer.js';

describe('summarizeFileAst — Rust', () => {
  it('reports .rs files as AST-supported', () => {
    expect(isAstSupported('src/lib.rs')).toBe(true);
  });

  describe('exports', () => {
    it('exports pub items of all kinds, including pub async fn', async () => {
      const contents = [
        'pub fn parse(input: &str) -> u32 { 0 }',
        'pub async fn fetch() {}',
        'fn private_helper() {}',
        'pub struct Config;',
        'pub enum Mode { A, B }',
        'pub trait Render { fn render(&self) -> String; }',
        'pub type Alias = u32;',
        'pub const MAX: u32 = 10;',
        'pub static GLOBAL: u32 = 0;',
        'pub mod api {}',
        'struct Internal;',
      ].join('\n');
      const summary = await summarizeFileAst('src/items.rs', contents);
      expect(summary.exports).toEqual(
        expect.arrayContaining([
          'parse',
          'fetch',
          'Config',
          'Mode',
          'Render',
          'Alias',
          'MAX',
          'GLOBAL',
          'api',
        ]),
      );
      expect(summary.exports).not.toContain('private_helper');
      expect(summary.exports).not.toContain('Internal');
    });

    it('handles modified functions like pub const fn (regex weakness)', async () => {
      const contents = ['pub const fn double(x: u32) -> u32 { x * 2 }'].join('\n');
      const summary = await summarizeFileAst('src/util.rs', contents);
      expect(summary.exports).toEqual(['double']);
      expect(summary.exports).not.toContain('fn');
    });

    it('does not export pub(crate) items', async () => {
      const contents = [
        'pub(crate) fn internal() {}',
        'pub fn external() {}',
      ].join('\n');
      const summary = await summarizeFileAst('src/vis.rs', contents);
      expect(summary.exports).toEqual(['external']);
    });

    it('treats pub use re-exports as exports', async () => {
      const contents = [
        'pub use crate::widget::Widget;',
        'pub use crate::engine::{Engine, Result as EngineResult};',
      ].join('\n');
      const summary = await summarizeFileAst('src/re.rs', contents);
      expect(summary.exports).toEqual(
        expect.arrayContaining(['Widget', 'Engine', 'EngineResult']),
      );
    });
  });

  describe('imports', () => {
    it('extracts use paths, grouped-use base paths and mod declarations', async () => {
      const contents = [
        'use std::collections::HashMap;',
        'use crate::engine::{Engine, Result};',
        'use foo::bar as baz;',
        'use std::io::*;',
        '',
        'mod helpers;',
        'mod inline { }',
        '',
        'pub fn run() -> HashMap<String, Engine> { todo!() }',
      ].join('\n');
      const summary = await summarizeFileAst('src/app.rs', contents);
      expect(summary.imports).toEqual(
        expect.arrayContaining([
          'std::collections::HashMap',
          'crate::engine',
          'foo::bar',
          'std::io',
          'helpers',
        ]),
      );
      // `mod inline { }` defines a module in place; it is not an import.
      expect(summary.imports).not.toContain('inline');
    });
  });

  describe('declarations', () => {
    it('records top-level items with their kinds', async () => {
      const contents = [
        'pub fn run() {}',
        'pub struct Config;',
        'enum Mode { A }',
        'trait Render {}',
        'impl Render for Config {}',
        'type Alias = u32;',
        'const MAX: u32 = 1;',
        'static GLOBAL: u32 = 0;',
        'mod helpers;',
      ].join('\n');
      const summary = await summarizeFileAst('src/decls.rs', contents);
      expect(summary.topLevelDeclarations).toEqual(
        expect.arrayContaining([
          'fn run',
          'struct Config',
          'enum Mode',
          'trait Render',
          'impl Config',
          'type Alias',
          'const MAX',
          'static GLOBAL',
          'mod helpers',
        ]),
      );
    });
  });

  describe('purpose generation', () => {
    it('describes functions with /// doc-comment first sentences', async () => {
      const contents = [
        '/// Parses input into tokens. Returns an empty vec on failure.',
        'pub fn parse(input: &str) -> Vec<String> { vec![] }',
        '',
        'pub fn write(tokens: &[String]) -> String { String::new() }',
      ].join('\n');
      const summary = await summarizeFileAst('src/parse.rs', contents);
      expect(summary.purpose).toBe('functions: parse, write — Parses input into tokens.');
      expect(summary.confidence).toBe('high');
    });

    it('describes a struct with impl methods using its doc comment', async () => {
      const contents = [
        '/// A widget configuration.',
        '#[derive(Debug)]',
        'pub struct Config {',
        '    pub name: String,',
        '}',
        '',
        'impl Config {',
        '    pub fn new() -> Self { todo!() }',
        '    pub fn name(&self) -> &str { &self.name }',
        '}',
      ].join('\n');
      const summary = await summarizeFileAst('src/config.rs', contents);
      expect(summary.purpose).toBe('struct Config (2 methods): A widget configuration.');
    });

    it('uses //! inner doc comments as the file description', async () => {
      const contents = [
        '//! Token stream utilities.',
        '',
        'pub type TokenId = u32;',
      ].join('\n');
      const summary = await summarizeFileAst('src/tokens.rs', contents);
      expect(summary.purpose).toContain('TokenId');
      expect(summary.purpose).toContain('Token stream utilities.');
    });

    it('marks entry points and tests', async () => {
      const main = await summarizeFileAst('src/main.rs', 'fn main() {}\n');
      expect(main.purpose.startsWith('entry point')).toBe(true);

      const test = await summarizeFileAst(
        'tests/integration.rs',
        '#[test]\nfn it_works() { assert!(true); }\n',
      );
      expect(test.purpose.startsWith('test')).toBe(true);
    });
  });

  describe('fallback behavior', () => {
    it('falls back to the regex summarizer on parse errors', async () => {
      const broken = 'pub fn broken( {{{ not rust ((((\n';
      const astResult = await summarizeFileAst('src/broken.rs', broken);
      const regexResult = summarizeFile('src/broken.rs', broken);
      expect(astResult).toEqual(regexResult);
    });

    it('delegates empty files to the regex summarizer', async () => {
      const summary = await summarizeFileAst('src/empty.rs', '');
      expect(summary.lineCount).toBe(0);
      expect(summary.confidence).toBe('low');
    });
  });
});
