import { describe, it, expect } from 'vitest';
import { summarizeFile } from '../../src/indexer/summarizer.js';

describe('summarizeFile', () => {
  it('extracts exports from TypeScript file', () => {
    const contents = `
export const FOO = 'bar';
export function doStuff() {}
export class MyClass {}
export interface MyInterface {}
export type MyType = string;
export enum Status { A, B }
`;
    const result = summarizeFile('src/utils.ts', contents);
    expect(result.exports).toContain('FOO');
    expect(result.exports).toContain('doStuff');
    expect(result.exports).toContain('MyClass');
    expect(result.exports).toContain('MyInterface');
    expect(result.exports).toContain('MyType');
    expect(result.exports).toContain('Status');
  });

  it('extracts default exports', () => {
    const contents = `
export default function main() {}
`;
    const result = summarizeFile('src/main.ts', contents);
    expect(result.exports).toContain('main');

    const contents2 = `
const x = 42;
export default x;
`;
    const result2 = summarizeFile('src/value.ts', contents2);
    expect(result2.exports).toContain('default');
  });

  it('extracts imports', () => {
    const contents = `
import { foo } from './foo';
import type { Bar } from '../types';
import * as path from 'node:path';
import 'reflect-metadata';
`;
    const result = summarizeFile('src/app.ts', contents);
    expect(result.imports).toContain('./foo');
    expect(result.imports).toContain('../types');
    expect(result.imports).toContain('node:path');
    expect(result.imports).toContain('reflect-metadata');
  });

  it('extracts top-level declarations', () => {
    const contents = `
const API_URL = 'https://example.com';
let counter = 0;
function helper() {}
class Service {}
interface Config {}
type ID = string;
enum Color { Red, Green }
export async function main() {}
`;
    const result = summarizeFile('src/lib.ts', contents);
    expect(result.topLevelDeclarations).toContain('const API_URL');
    expect(result.topLevelDeclarations).toContain('let counter');
    expect(result.topLevelDeclarations).toContain('function helper');
    expect(result.topLevelDeclarations).toContain('class Service');
    expect(result.topLevelDeclarations).toContain('interface Config');
    expect(result.topLevelDeclarations).toContain('type ID');
    expect(result.topLevelDeclarations).toContain('enum Color');
    expect(result.topLevelDeclarations).toContain('function main');
  });

  it('classifies test files correctly', () => {
    expect(summarizeFile('src/app.test.ts', '').purpose).toBe('test');
    expect(summarizeFile('src/app.spec.ts', '').purpose).toBe('test');
    expect(summarizeFile('tests/unit/foo.test.tsx', '').purpose).toBe('test');
  });

  it('classifies config files correctly', () => {
    expect(summarizeFile('vitest.config.ts', '').purpose).toBe('config');
    expect(summarizeFile('eslint.config.js', '').purpose).toBe('config');
    expect(summarizeFile('rollup.config.mjs', '').purpose).toBe('config');
  });

  it('classifies type definition files correctly', () => {
    expect(summarizeFile('src/global.d.ts', '').purpose).toBe('types');
    expect(summarizeFile('src/types.ts', '').purpose).toBe('types');
    expect(summarizeFile('src/interfaces.ts', '').purpose).toBe('types');
  });

  it('handles non-TS files gracefully', () => {
    const json = summarizeFile('package.json', '{\n  "name": "test"\n}');
    expect(json.purpose).toBe('config');
    expect(json.exports).toEqual([]);
    expect(json.imports).toEqual([]);
    expect(json.lineCount).toBe(3);

    const md = summarizeFile('README.md', '# Title\n\nSome text.');
    expect(md.purpose).toBe('documentation');
    expect(md.exports).toEqual([]);
    expect(md.lineCount).toBe(3);
  });

  it('counts lines correctly', () => {
    expect(summarizeFile('src/a.ts', 'line1\nline2\nline3').lineCount).toBe(3);
    expect(summarizeFile('src/b.ts', 'single').lineCount).toBe(1);
  });

  it('handles empty file', () => {
    const result = summarizeFile('src/empty.ts', '');
    expect(result.lineCount).toBe(0);
    expect(result.exports).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.topLevelDeclarations).toEqual([]);
    expect(result.purpose).toBe('source');
  });

  describe('confidence scoring', () => {
    it('returns high confidence for TypeScript file with exports', () => {
      const result = summarizeFile(
        'src/utils.ts',
        'export function doStuff() {}\n',
      );
      expect(result.confidence).toBe('high');
    });

    it('returns medium confidence for config file (package.json)', () => {
      const result = summarizeFile(
        'package.json',
        '{\n  "name": "test"\n}\n',
      );
      expect(result.confidence).toBe('medium');
    });

    it('returns low confidence for markdown file', () => {
      const result = summarizeFile('README.md', '# Hello\n');
      expect(result.confidence).toBe('low');
    });

    it('returns low confidence for empty file', () => {
      const result = summarizeFile('src/empty.ts', '');
      expect(result.confidence).toBe('low');
    });
  });
});
