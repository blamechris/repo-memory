import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { extractImports } from '../../src/indexer/imports.js';

describe('extractImports', () => {
  let projectRoot: string;

  function addFile(relPath: string, contents = ''): void {
    const abs = join(projectRoot, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }

  beforeAll(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'imports-test-'));
    addFile('src/module.ts');
    addFile('src/utils.ts');
    addFile('src/polyfill.ts');
    addFile('src/types.ts');
    addFile('src/lazy.ts');
    addFile('src/lib.ts');
    addFile('src/utils/helper.ts');
    addFile('src/cache/store.ts');
    addFile('src/components/App.tsx');
    addFile('src/widgets/index.ts');
    addFile('src/lib/index.ts');
  });

  afterAll(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('extracts static named imports and resolves to the real file', () => {
    const contents = `import { Foo, Bar } from './module';`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/index.ts',
        target: 'src/module.ts',
        specifiers: ['Foo', 'Bar'],
        type: 'static',
      },
    ]);
  });

  it('resolves .js specifiers to the real .ts file', () => {
    const contents = `import { store } from './cache/store.js';`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/index.ts',
        target: 'src/cache/store.ts',
        specifiers: ['store'],
        type: 'static',
      },
    ]);
  });

  it('resolves .jsx specifiers to the real .tsx file', () => {
    const contents = `import { App } from './components/App.jsx';`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/index.ts',
        target: 'src/components/App.tsx',
        specifiers: ['App'],
        type: 'static',
      },
    ]);
  });

  it('resolves directory imports to the index file', () => {
    const contents = `import { widget } from './widgets';`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/index.ts',
        target: 'src/widgets/index.ts',
        specifiers: ['widget'],
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
        target: 'src/module.ts',
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
        target: 'src/utils.ts',
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
        target: 'src/polyfill.ts',
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
        target: 'src/types.ts',
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
        target: 'src/lazy.ts',
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
        target: 'src/module.ts',
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
        target: 'src/module.ts',
        specifiers: ['*'],
        type: 're-export',
      },
    ]);
  });

  it('tags package imports as external', () => {
    const contents = `import { z } from 'zod';\nimport sdk from '@modelcontextprotocol/sdk';`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result).toContainEqual({
      source: 'src/index.ts',
      target: 'zod',
      specifiers: ['z'],
      type: 'static',
      external: true,
    });
    expect(result).toContainEqual({
      source: 'src/index.ts',
      target: '@modelcontextprotocol/sdk',
      specifiers: ['sdk'],
      type: 'static',
      external: true,
    });
  });

  it('tags node builtins as external', () => {
    const contents = `import { createHash } from 'node:crypto';\nimport { join } from 'path';`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result).toHaveLength(2);
    for (const ref of result) {
      expect(ref.external).toBe(true);
    }
  });

  it('tags unresolvable relative imports as external, keeping the resolved path', () => {
    const contents = `import { ghost } from './does-not-exist.js';`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/index.ts',
        target: 'src/does-not-exist.js',
        specifiers: ['ghost'],
        type: 'static',
        external: true,
      },
    ]);
  });

  it('tags relative imports escaping the project root as external', () => {
    const contents = `import { x } from '../../outside';`;
    const result = extractImports('src/index.ts', contents, projectRoot);
    expect(result).toHaveLength(1);
    expect(result[0].external).toBe(true);
  });

  it('resolves relative imports to project-relative paths', () => {
    const contents = `import { helper } from '../utils/helper';`;
    const result = extractImports('src/lib/index.ts', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/lib/index.ts',
        target: 'src/utils/helper.ts',
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
    const moduleImports = result.filter((r) => r.target === 'src/module.ts');
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
      external: true,
    });
    expect(result).toContainEqual({
      source: 'src/index.ts',
      target: 'src/lib.ts',
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
