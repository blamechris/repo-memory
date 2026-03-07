import { describe, it, expect } from 'vitest';
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
      },
      {
        source: 'src/app.py',
        target: 'sys',
        specifiers: [],
        type: 'static',
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
});
