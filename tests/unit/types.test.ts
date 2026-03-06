import { describe, it, expect } from 'vitest';
import type { CacheEntry, FileSummary, ImportRef } from '../../src/types.js';

describe('types', () => {
  it('CacheEntry has required fields', () => {
    const entry: CacheEntry = {
      path: '/test/file.ts',
      hash: 'abc123',
      lastChecked: Date.now(),
      summary: null,
    };
    expect(entry.path).toBe('/test/file.ts');
    expect(entry.hash).toBe('abc123');
    expect(entry.summary).toBeNull();
  });

  it('FileSummary has required fields', () => {
    const summary: FileSummary = {
      purpose: 'source',
      exports: ['foo', 'bar'],
      imports: ['./baz'],
      lineCount: 42,
      topLevelDeclarations: ['function foo', 'class Bar'],
      confidence: 'high',
    };
    expect(summary.purpose).toBe('source');
    expect(summary.exports).toHaveLength(2);
  });

  it('ImportRef has required fields', () => {
    const ref: ImportRef = {
      source: 'a.ts',
      target: 'b.ts',
      specifiers: ['default'],
      type: 'static',
    };
    expect(ref.type).toBe('static');
  });
});
