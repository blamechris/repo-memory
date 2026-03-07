import { describe, it, expect } from 'vitest';
import { extractImports } from '../../src/indexer/imports.js';

describe('extractImports — Rust', () => {
  const projectRoot = '/project';

  it('extracts "use crate::foo::bar"', () => {
    const contents = `use crate::foo::bar;`;
    const result = extractImports('src/main.rs', contents, projectRoot);
    expect(result).toContainEqual({
      source: 'src/main.rs',
      target: 'foo/bar',
      specifiers: [],
      type: 'static',
    });
  });

  it('extracts "use super::foo"', () => {
    const contents = `use super::foo;`;
    const result = extractImports('src/sub/mod.rs', contents, projectRoot);
    expect(result).toContainEqual({
      source: 'src/sub/mod.rs',
      target: 'src/foo',
      specifiers: [],
      type: 'static',
    });
  });

  it('extracts "use self::foo"', () => {
    const contents = `use self::foo;`;
    const result = extractImports('src/lib.rs', contents, projectRoot);
    expect(result).toContainEqual({
      source: 'src/lib.rs',
      target: 'src/foo',
      specifiers: [],
      type: 'static',
    });
  });

  it('extracts grouped imports "use foo::{bar, baz}"', () => {
    const contents = `use std::collections::{HashMap, HashSet};`;
    const result = extractImports('src/main.rs', contents, projectRoot);
    expect(result).toContainEqual({
      source: 'src/main.rs',
      target: 'std/collections',
      specifiers: ['HashMap', 'HashSet'],
      type: 'static',
    });
  });

  it('extracts "mod foo;" as submodule declaration', () => {
    const contents = `mod utils;`;
    const result = extractImports('src/main.rs', contents, projectRoot);
    expect(result).toContainEqual({
      source: 'src/main.rs',
      target: 'src/utils',
      specifiers: [],
      type: 'static',
    });
  });

  it('extracts "pub use" re-exports', () => {
    const contents = `pub use crate::models::User;`;
    const result = extractImports('src/lib.rs', contents, projectRoot);
    expect(result).toContainEqual({
      source: 'src/lib.rs',
      target: 'models/User',
      specifiers: [],
      type: 'static',
    });
  });

  it('skips imports inside line comments', () => {
    const contents = `// use std::io;
use std::fmt;`;
    const result = extractImports('src/main.rs', contents, projectRoot);
    expect(result).toHaveLength(1);
    const useImport = result.find((r) => r.target === 'std/fmt');
    expect(useImport).toBeDefined();
    // The commented one should not appear
    const ioImport = result.find((r) => r.target === 'std/io');
    expect(ioImport).toBeUndefined();
  });

  it('skips imports inside block comments', () => {
    const contents = `/*
use std::io;
*/
use std::fmt;`;
    const result = extractImports('src/main.rs', contents, projectRoot);
    const ioImport = result.find((r) => r.target === 'std/io');
    expect(ioImport).toBeUndefined();
    const fmtImport = result.find((r) => r.target === 'std/fmt');
    expect(fmtImport).toBeDefined();
  });

  it('handles external crate imports', () => {
    const contents = `use serde::{Serialize, Deserialize};`;
    const result = extractImports('src/main.rs', contents, projectRoot);
    expect(result).toContainEqual({
      source: 'src/main.rs',
      target: 'serde',
      specifiers: ['Serialize', 'Deserialize'],
      type: 'static',
    });
  });

  it('handles mod at root level', () => {
    const contents = `mod handlers;`;
    const result = extractImports('src/main.rs', contents, projectRoot);
    expect(result).toContainEqual({
      source: 'src/main.rs',
      target: 'src/handlers',
      specifiers: [],
      type: 'static',
    });
  });

  it('handles multiple use statements', () => {
    const contents = `use std::io;
use std::fs::File;
use crate::config::Settings;
mod db;`;
    const result = extractImports('src/main.rs', contents, projectRoot);
    expect(result.length).toBeGreaterThanOrEqual(4);
    expect(result.map((r) => r.target)).toContain('std/io');
    expect(result.map((r) => r.target)).toContain('std/fs/File');
    expect(result.map((r) => r.target)).toContain('config/Settings');
    expect(result.map((r) => r.target)).toContain('src/db');
  });

  it('extracts "use super::super::foo" (double super)', () => {
    const contents = `use super::super::foo;`;
    const result = extractImports('src/a/b/mod.rs', contents, projectRoot);
    expect(result).toContainEqual({
      source: 'src/a/b/mod.rs',
      target: 'src/foo',
      specifiers: [],
      type: 'static',
    });
  });
});
