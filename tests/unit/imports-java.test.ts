import { describe, it, expect } from 'vitest';
import { extractImports } from '../../src/indexer/imports.js';

describe('extractImports — Java', () => {
  const projectRoot = '/project';

  it('extracts simple import', () => {
    const contents = `package com.example;

import java.util.List;`;
    const result = extractImports('src/main/java/App.java', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/main/java/App.java',
        target: 'java/util/List',
        specifiers: [],
        type: 'static',
        external: true,
      },
    ]);
  });

  it('extracts wildcard import with * specifier', () => {
    const contents = `package com.example;

import java.util.*;`;
    const result = extractImports('src/main/java/App.java', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/main/java/App.java',
        target: 'java/util',
        specifiers: ['*'],
        type: 'static',
        external: true,
      },
    ]);
  });

  it('extracts static import with the member as specifier', () => {
    const contents = `package com.example;

import static java.lang.Math.max;`;
    const result = extractImports('src/main/java/App.java', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/main/java/App.java',
        target: 'java/lang/Math',
        specifiers: ['max'],
        type: 'static',
        external: true,
      },
    ]);
  });

  it('extracts static wildcard import', () => {
    const contents = `package com.example;

import static java.lang.Math.*;`;
    const result = extractImports('src/main/java/App.java', contents, projectRoot);
    expect(result).toEqual([
      {
        source: 'src/main/java/App.java',
        target: 'java/lang/Math',
        specifiers: ['*'],
        type: 'static',
        external: true,
      },
    ]);
  });

  it('extracts multiple imports in order', () => {
    const contents = `package com.example;

import java.util.List;
import java.util.Map;
import com.example.game.Arrow;`;
    const result = extractImports('src/main/java/App.java', contents, projectRoot);
    expect(result.map((r) => r.target)).toEqual([
      'java/util/List',
      'java/util/Map',
      'com/example/game/Arrow',
    ]);
  });

  it('skips imports inside line comments', () => {
    const contents = `package com.example;

// import java.util.Unused;
import java.util.List;`;
    const result = extractImports('src/main/java/App.java', contents, projectRoot);
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('java/util/List');
  });

  it('skips imports inside block comments and strings', () => {
    const contents = `package com.example;

/*
import java.util.Unused;
*/
import java.util.List;

class App {
  String s = "import java.util.AlsoUnused;";
}`;
    const result = extractImports('src/main/java/App.java', contents, projectRoot);
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('java/util/List');
  });
});
