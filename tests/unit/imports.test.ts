import { describe, it, expect } from 'vitest';
import { extractImports } from '../../src/indexer/imports.js';

describe('extractImports', () => {
  const projectRoot = '/project';

  it('extracts static named imports', () => {
    const contents = `import { Foo, Bar } from './module';`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/index.ts',
        target: 'src/module',
        specifiers: ['Foo', 'Bar'],
        type: 'static',
      },
    ]);
  });

  it('extracts default imports', () => {
    const contents = `import Foo from './module';`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/index.ts',
        target: 'src/module',
        specifiers: ['Foo'],
        type: 'static',
      },
    ]);
  });

  it('extracts namespace imports', () => {
    const contents = `import * as Utils from './utils';`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/index.ts',
        target: 'src/utils',
        specifiers: ['* as Utils'],
        type: 'static',
      },
    ]);
  });

  it('extracts side-effect imports', () => {
    const contents = `import './polyfill';`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/index.ts',
        target: 'src/polyfill',
        specifiers: [],
        type: 'static',
      },
    ]);
  });

  it('extracts type-only imports', () => {
    const contents = `import type { Foo } from './types';`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/index.ts',
        target: 'src/types',
        specifiers: ['Foo'],
        type: 'static',
      },
    ]);
  });

  it('extracts dynamic imports', () => {
    const contents = `const mod = await import('./lazy');`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/index.ts',
        target: 'src/lazy',
        specifiers: [],
        type: 'dynamic',
      },
    ]);
  });

  it('extracts named re-exports', () => {
    const contents = `export { Foo } from './module';`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/index.ts',
        target: 'src/module',
        specifiers: ['Foo'],
        type: 're-export',
      },
    ]);
  });

  it('extracts wildcard re-exports', () => {
    const contents = `export * from './module';`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/index.ts',
        target: 'src/module',
        specifiers: ['*'],
        type: 're-export',
      },
    ]);
  });

  it('keeps package imports as-is', () => {
    const contents = `import { z } from 'zod';\nimport sdk from '@modelcontextprotocol/sdk';`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result).toContainEqual({
      source: 'src/index.ts',
      target: 'zod',
      specifiers: ['z'],
      type: 'static',
    });
    expect(result).toContainEqual({
      source: 'src/index.ts',
      target: '@modelcontextprotocol/sdk',
      specifiers: ['sdk'],
      type: 'static',
    });
  });

  it('resolves relative imports to project-relative paths', () => {
    const contents = `import { helper } from '../utils/helper';`;
    const result = extractImports('src/lib/index.ts', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/lib/index.ts',
        target: 'src/utils/helper',
        specifiers: ['helper'],
        type: 'static',
      },
    ]);
  });

  it('handles multiple imports from same file', () => {
    const contents = [
      `import { Foo } from './module';`,
      `import { Bar } from './module';`,
    ].join('\n');
    const result = extractImports('src/index.ts', contents, projectRoot);
    const moduleImports = result.filter((r) => r.target === 'src/module');
    expect(moduleImports).toHaveLength(2);
    expect(moduleImports[0].specifiers).toEqual(['Foo']);
    expect(moduleImports[1].specifiers).toEqual(['Bar']);
  });

  it('extracts require() calls', () => {
    const contents = `const fs = require('fs');\nconst lib = require('./lib');`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result).toContainEqual({
      source: 'src/index.ts',
      target: 'fs',
      specifiers: [],
      type: 'static',
    });
    expect(result).toContainEqual({
      source: 'src/index.ts',
      target: 'src/lib',
      specifiers: [],
      type: 'static',
    });
  });

  it('handles aliased imports', () => {
    const contents = `import { Foo as MyFoo } from './module';`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result[0].specifiers).toEqual(['Foo']);
  });
});
