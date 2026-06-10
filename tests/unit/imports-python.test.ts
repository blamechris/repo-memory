import { describe, it, expect } from 'vitest';
import { closeDatabase } from '../../src/persistence/db.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractImports } from '../../src/indexer/imports.js';

describe('extractImports — Python', () => {
  const projectRoot = '/project';

  it('extracts simple "import foo"', () => {
    const contents = `import os`;
    const result = extractImports('src/app.py', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/app.py',
        target: 'os',
        specifiers: [],
        type: 'static',
        external: true,
      },
    ]);
  });

  it('extracts "import foo.bar" as target foo/bar', () => {
    const contents = `import os.path`;
    const result = extractImports('src/app.py', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/app.py',
        target: 'os/path',
        specifiers: [],
        type: 'static',
        external: true,
      },
    ]);
  });

  it('extracts multiple comma-separated imports', () => {
    const contents = `import os, sys`;
    const result = extractImports('src/app.py', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/app.py',
        target: 'os',
        specifiers: [],
        type: 'static',
        external: true,
      },
      {
        source: 'src/app.py',
        target: 'sys',
        specifiers: [],
        type: 'static',
        external: true,
      },
    ]);
  });

  it('extracts "from foo import bar, baz"', () => {
    const contents = `from os.path import join, dirname`;
    const result = extractImports('src/app.py', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/app.py',
        target: 'os/path',
        specifiers: ['join', 'dirname'],
        type: 'static',
        external: true,
      },
    ]);
  });

  it('extracts "from . import foo" (relative import)', () => {
    const contents = `from . import utils`;
    const result = extractImports('src/app.py', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/app.py',
        target: 'src',
        specifiers: ['utils'],
        type: 'static',
        external: true,
      },
    ]);
  });

  it('extracts "from ..bar import baz" (relative import)', () => {
    const contents = `from ..bar import baz`;
    const result = extractImports('src/lib/app.py', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/lib/app.py',
        target: 'src/bar',
        specifiers: ['baz'],
        type: 'static',
        external: true,
      },
    ]);
  });

  it('extracts "from .sibling import func"', () => {
    const contents = `from .sibling import func`;
    const result = extractImports('src/app.py', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/app.py',
        target: 'src/sibling',
        specifiers: ['func'],
        type: 'static',
        external: true,
      },
    ]);
  });

  it('handles aliased imports (strips alias)', () => {
    const contents = `from os.path import join as pjoin`;
    const result = extractImports('src/app.py', contents, projectRoot);
    expect(result[0].specifiers).toEqual(['join']);
  });

  it('skips imports inside line comments', () => {
    const contents = `# import os\nfrom sys import argv`;
    const result = extractImports('src/app.py', contents, projectRoot);
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('sys');
  });

  it('skips imports inside triple-quoted strings', () => {
    const contents = `"""
import os
from sys import argv
"""
import json`;
    const result = extractImports('src/app.py', contents, projectRoot);
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('json');
  });

  it('skips imports inside single-line string literals', () => {
    const contents = `x = "import os"\nimport json`;
    const result = extractImports('src/app.py', contents, projectRoot);
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('json');
  });

  it('handles multiple imports across lines', () => {
    const contents = `import os
import sys
from pathlib import Path
from collections import defaultdict, OrderedDict`;
    const result = extractImports('src/app.py', contents, projectRoot);
    expect(result).toHaveLength(4);
    expect(result.map((r) => r.target)).toEqual([
      'os',
      'sys',
      'pathlib',
      'collections',
    ]);
  });

  it('handles "from ... import" (triple dot relative)', () => {
    const contents = `from ...base import Config`;
    const result = extractImports('src/pkg/sub/app.py', contents, projectRoot);
    expect(result[0].target).toBe('src/base');
    expect(result[0].specifiers).toEqual(['Config']);
  });

  it('resolves relative imports to real .py files and packages', () => {
    const root = mkdtempSync(join(tmpdir(), 'imports-py-test-'));
    try {
      mkdirSync(join(root, 'src', 'pkg'), { recursive: true });
      writeFileSync(join(root, 'src', 'helpers.py'), '');
      writeFileSync(join(root, 'src', 'pkg', '__init__.py'), '');

      const contents = `from .helpers import slug\nfrom .pkg import thing`;
      const result = extractImports('src/app.py', contents, root);

      expect(result).toContainEqual({
        source: 'src/app.py',
        target: 'src/helpers.py',
        specifiers: ['slug'],
        type: 'static',
      });
      expect(result).toContainEqual({
        source: 'src/app.py',
        target: 'src/pkg/__init__.py',
        specifiers: ['thing'],
        type: 'static',
      });
    } finally {
      closeDatabase();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
