import { describe, it, expect } from 'vitest';
import { extractImports } from '../../src/indexer/imports.js';

describe('extractImports — Go', () => {
  const projectRoot = '/project';

  it('extracts single import', () => {
    const contents = `package main

import "fmt"`;
    const result = extractImports('main.go', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'main.go',
        target: 'fmt',
        specifiers: [],
        type: 'static',
      },
    ]);
  });

  it('extracts aliased import', () => {
    const contents = `package main

import f "fmt"`;
    const result = extractImports('main.go', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'main.go',
        target: 'fmt',
        specifiers: ['f'],
        type: 'static',
      },
    ]);
  });

  it('extracts grouped imports', () => {
    const contents = `package main

import (
	"fmt"
	"os"
	"path/to/pkg"
)`;
    const result = extractImports('main.go', contents, projectRoot);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.target)).toEqual(['fmt', 'os', 'path/to/pkg']);
  });

  it('extracts grouped imports with aliases', () => {
    const contents = `package main

import (
	"fmt"
	myalias "path/to/pkg"
)`;
    const result = extractImports('main.go', contents, projectRoot);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      source: 'main.go',
      target: 'path/to/pkg',
      specifiers: ['myalias'],
      type: 'static',
    });
  });

  it('skips imports inside line comments', () => {
    const contents = `package main

// import "unused"
import "fmt"`;
    const result = extractImports('main.go', contents, projectRoot);
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('fmt');
  });

  it('skips imports inside block comments', () => {
    const contents = `package main

/*
import "unused"
*/
import "fmt"`;
    const result = extractImports('main.go', contents, projectRoot);
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('fmt');
  });

  it('handles dot import for side-effects', () => {
    const contents = `package main

import (
	_ "net/http/pprof"
	"fmt"
)`;
    const result = extractImports('main.go', contents, projectRoot);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      source: 'main.go',
      target: 'net/http/pprof',
      specifiers: ['_'],
      type: 'static',
    });
  });

  it('handles multiple grouped import blocks', () => {
    const contents = `package main

import (
	"fmt"
)

import (
	"os"
)`;
    const result = extractImports('main.go', contents, projectRoot);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.target)).toEqual(['fmt', 'os']);
  });

  it('handles full package paths', () => {
    const contents = `package main

import "github.com/user/repo/pkg/utils"`;
    const result = extractImports('main.go', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'main.go',
        target: 'github.com/user/repo/pkg/utils',
        specifiers: [],
        type: 'static',
      },
    ]);
  });
});
