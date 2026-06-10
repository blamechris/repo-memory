import { describe, it, expect } from 'vitest';
import { extractImports } from '../../src/indexer/imports.js';

describe('extractImports — Kotlin', () => {
  const projectRoot = '/project';

  it('extracts simple dotted import', () => {
    const contents = `package com.example

import kotlin.math.max`;
    const result = extractImports('src/main/kotlin/App.kt', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/main/kotlin/App.kt',
        target: 'kotlin/math/max',
        specifiers: [],
        type: 'static',
      },
    ]);
  });

  it('extracts wildcard import with * specifier', () => {
    const contents = `package com.example

import com.example.util.*`;
    const result = extractImports('src/main/kotlin/App.kt', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/main/kotlin/App.kt',
        target: 'com/example/util',
        specifiers: ['*'],
        type: 'static',
      },
    ]);
  });

  it('extracts aliased import with the alias as specifier', () => {
    const contents = `package com.example

import com.example.io.Reader as R`;
    const result = extractImports('src/main/kotlin/App.kt', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/main/kotlin/App.kt',
        target: 'com/example/io/Reader',
        specifiers: ['R'],
        type: 'static',
      },
    ]);
  });

  it('extracts multiple imports and handles .kts files', () => {
    const contents = `import java.io.File
import kotlin.text.Regex

val f = File("x")`;
    const result = extractImports('scripts/deploy.kts', contents, projectRoot);
    expect(result.map((r) => r.target)).toEqual(['java/io/File', 'kotlin/text/Regex']);
  });

  it('skips imports inside line comments', () => {
    const contents = `package com.example

// import com.example.Unused
import kotlin.math.max`;
    const result = extractImports('src/main/kotlin/App.kt', contents, projectRoot);
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('kotlin/math/max');
  });

  it('skips imports inside block comments and strings', () => {
    const contents = `package com.example

/*
import com.example.Unused
*/
import kotlin.math.max

val s = """
import com.example.AlsoUnused
"""`;
    const result = extractImports('src/main/kotlin/App.kt', contents, projectRoot);
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('kotlin/math/max');
  });
});
